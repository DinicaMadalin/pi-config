import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import type { Api, Message, Model } from "@earendil-works/pi-ai";
import type { AutoRouteState } from "./implementation-handoff.ts";
import { ROUTE_DECISION_ENTRY_TYPE } from "./route-decision.ts";
import { DESIGN_REMINDER_ENTRY_TYPE } from "./design-first.ts";

const require = createRequire(resolve(process.cwd(), "agent/npm/package.json"));
const esbuild = require("esbuild");

type Handler = (...args: any[]) => unknown;
type VirtualModel = { route: (request: any, ctx: any) => Promise<any> | any };
interface FakePi {
	on: (event: string, handler: Handler) => void;
	registerVirtualModel: (_model: unknown) => void;
	registerCommand: (name: string, command: { handler: Handler }) => void;
	registerTool: (_tool: unknown) => void;
	appendEntry: (type: string, data?: unknown) => void;
	events: { emit: (...args: unknown[]) => void };
	sendUserMessage: (message: string) => void;
	exec: () => Promise<{ stdout: string; stderr: string; code: number }>;
}

const tempDirectories: string[] = [];
const originalHome = process.env.HOME;
const originalTierCeiling = process.env.PI_AUTO_MODEL_MAX_TIER;
delete process.env.PI_AUTO_MODEL_MAX_TIER;
let loadExtension: (() => (pi: FakePi) => void) | undefined;

async function bundledExtension(): Promise<(pi: FakePi) => void> {
	if (loadExtension) return loadExtension;
	const tempDirectory = await mkdtemp(join(tmpdir(), "auto-model-design-first-"));
	tempDirectories.push(tempDirectory);
	process.env.HOME = tempDirectory;
	await mkdir(join(tempDirectory, ".pi", "agent"), { recursive: true });
	await writeFile(join(tempDirectory, ".pi", "agent", "auto-model.json"), JSON.stringify({
		tiers: {
			trivial: { models: ["opencode-go/deepseek-v4.1-flash"], thinkingLevel: "medium" },
			standard: { models: ["gemini-app/gemini-neon", "opencode-go/gpt-6-luna"], thinkingLevel: "medium" },
			complex: { models: ["anthropic/claude-opus-5-5"], thinkingLevel: "high" },
			expert: { models: ["openai/gpt-6-astra"], thinkingLevel: "high" },
		},
	}));
	const bundled = await esbuild.build({
		entryPoints: [fileURLToPath(new URL("./index.ts", import.meta.url))],
		bundle: true,
		platform: "node",
		format: "esm",
		write: false,
		plugins: [{
			name: "pi-runtime-test-stubs",
			setup(build) {
				build.onResolve({ filter: /^@earendil-works\/pi-ai$/ }, () => ({ path: "pi-ai", namespace: "test-stub" }));
				build.onResolve({ filter: /^typebox$/ }, () => ({ path: "typebox", namespace: "test-stub" }));
				build.onLoad({ filter: /.*/, namespace: "test-stub" }, ({ path }) => ({
					loader: "js",
					contents: path === "pi-ai"
						? "export const isContextOverflow = () => false;"
						: "export const Type = { Object: (value) => value, String: (value) => value };",
				}));
			},
		}],
	});
	const modulePath = join(tempDirectory, "auto-model.mjs");
	await writeFile(modulePath, bundled.outputFiles[0].text);
	const loaded = await import(pathToFileURL(modulePath).href) as { default: (pi: FakePi) => void };
	loadExtension = loaded.default;
	return loadExtension;
}

test.after(async () => {
	if (originalHome === undefined) delete process.env.HOME;
	else process.env.HOME = originalHome;
	if (originalTierCeiling === undefined) delete process.env.PI_AUTO_MODEL_MAX_TIER;
	else process.env.PI_AUTO_MODEL_MAX_TIER = originalTierCeiling;
	await Promise.all(tempDirectories.map((directory) => rm(directory, { recursive: true, force: true })));
});

function fakeModel(provider: string, id: string, input: string[] = ["text", "image"]): Model<Api> {
	return { provider, id, input, contextWindow: 100_000, maxTokens: 10_000 } as unknown as Model<Api>;
}

const expertModel = fakeModel("openai", "gpt-6-astra");
const complexModel = fakeModel("anthropic", "claude-opus-5-5");
const preferredStandardModel = fakeModel("gemini-app", "gemini-neon");
const standardModel = fakeModel("opencode-go", "gpt-6-luna");
const normalModels = [expertModel, complexModel, standardModel];

function setup(classification: { taskKind: string; tier?: string } = { taskKind: "other", tier: "standard" }, available = normalModels) {
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, { handler: Handler }>();
	const entries: Array<{ type: string; data?: any }> = [];
	const decisions: Array<{ type: string; data: any }> = [];
	const sentMessages: string[] = [];
	let classifierCalls = 0;
	let virtualModel: VirtualModel | undefined;
	const pi: FakePi = {
		on(event, handler) { handlers.set(event, [...(handlers.get(event) ?? []), handler]); },
		registerVirtualModel(model) { virtualModel = model as VirtualModel; },
		registerCommand(name, command) { commands.set(name, command); },
		registerTool() {},
		appendEntry(type, data) {
			entries.push({ type, data });
			if (type === ROUTE_DECISION_ENTRY_TYPE) decisions.push({ type, data });
		},
		events: { emit() {} },
		sendUserMessage(message) { sentMessages.push(message); },
		async exec() { return { stdout: "", stderr: "not used", code: 1 }; },
	};
	const branch: any[] = [];
	const context: any = {
		cwd: process.cwd(),
		model: { provider: "auto", id: "auto" },
		hasUI: false,
		modelRegistry: {
			getAvailable: () => available,
			findOfType: () => ({ provider: "typesafe", id: "jev-latest" }),
			async classify() {
				classifierCalls++;
				return {
					stopReason: "stop",
					answers: {
						difficulty: { type: "choice", choice: classification.tier ?? "standard", confidence: 0.9 },
						thinkingDepth: { type: "choice", choice: "medium", confidence: 0.9 },
						taskKind: { type: "choice", choice: classification.taskKind, confidence: 0.9 },
					},
				};
			},
			find: () => undefined,
		},
		sessionManager: { getBranch: () => branch },
		isIdle: () => true,
		hasPendingMessages: () => false,
		ui: { notify() {} },
	};
	return {
		async initialize() { (await bundledExtension())(pi); },
		get route() { assert.ok(virtualModel); return virtualModel.route; },
		handler(name: string) { return handlers.get(name)?.[0]; },
		command(name: string) { return commands.get(name); },
		context,
		branch,
		decisions,
		entries,
		sentMessages,
		classifierCalls: () => classifierCalls,
	};
}

function request(prompt: string, extra: Partial<Record<string, unknown>> = {}): any {
	return {
		reason: "user",
		messages: [{ role: "user", content: prompt } as Message],
		thinkingLevel: "medium",
		...extra,
	};
}

async function beginNewInput(harness: ReturnType<typeof setup>): Promise<void> {
	await harness.handler("input")?.({ text: "prompt", source: "interactive" }, harness.context);
}

test("a standard-rated agreed-plan implementation routes to expert and persists a new design task", async () => {
	const harness = setup({ taskKind: "plan_implementation", tier: "standard" });
	await harness.initialize();
	await beginNewInput(harness);
	const routed = await harness.route(request("implement the plan"), harness.context);
	assert.equal(routed.model, expertModel);
	assert.equal(routed.state.tier, "expert");
	assert.equal(routed.state.designTask.source, "plan_implementation");
	assert.ok(routed.state.designTask.id);
});

test("direct feature builds use expert, while ordinary small edits remain normally rated", async () => {
	const feature = setup({ taskKind: "feature_build", tier: "standard" });
	await feature.initialize();
	await beginNewInput(feature);
	assert.equal((await feature.route(request("build feature"), feature.context)).model, expertModel);
	const ordinary = setup({ taskKind: "other", tier: "standard" });
	await ordinary.initialize();
	await beginNewInput(ordinary);
	const result = await ordinary.route(request("rename one label"), ordinary.context);
	assert.equal(result.model, standardModel);
	assert.equal(result.state.designTask, undefined);
});

test("expert model exhaustion falls back to complex; no configured designer produces a clear error", async () => {
	const fallback = setup({ taskKind: "feature_build" }, [complexModel, standardModel]);
	await fallback.initialize();
	await beginNewInput(fallback);
	const routed = await fallback.route(request("build feature"), fallback.context);
	assert.equal(routed.model, complexModel);
	assert.equal(routed.state.tier, "complex");
	assert.match(harnessReason(fallback), /complex designer fallback/);
	const unavailable = setup({ taskKind: "feature_build" }, [standardModel]);
	await unavailable.initialize();
	await beginNewInput(unavailable);
	await assert.rejects(() => unavailable.route(request("build feature"), unavailable.context), /no available configured designer in expert or complex/);
});

function harnessReason(harness: ReturnType<typeof setup>): string {
	return harness.decisions.at(-1)?.data.reason ?? "";
}

test("a tier ceiling keeps default feature routing cheap and omits design-first metadata", async () => {
	const originalCeiling = process.env.PI_AUTO_MODEL_MAX_TIER;
	process.env.PI_AUTO_MODEL_MAX_TIER = "standard";
	try {
		const harness = setup({ taskKind: "feature_build", tier: "standard" });
		await harness.initialize();
		await beginNewInput(harness);
		const routed = await harness.route(request("build a substantial feature"), harness.context);
		assert.equal(routed.model, standardModel);
		assert.equal(routed.state.designTask, undefined);
	} finally {
		if (originalCeiling === undefined) delete process.env.PI_AUTO_MODEL_MAX_TIER;
		else process.env.PI_AUTO_MODEL_MAX_TIER = originalCeiling;
	}
});

test("standard handoff and designer review preserve the task identity", async () => {
	const harness = setup();
	await harness.initialize();
	const state: AutoRouteState = {
		tier: "expert",
		modelKey: "openai/gpt-6-astra",
		designTask: { id: "design-keep", source: "plan_implementation" },
	};
	const handoffRequest: any = {
		reason: "user",
		state,
		previous: { model: expertModel, thinkingLevel: "high" },
		messages: [
			{ role: "assistant", content: [{ type: "text", text: "Contracts are ready." }] },
			{ role: "toolResult", toolName: "hand_off_implementation", isError: false },
		],
	};
	const implementer = await harness.route(handoffRequest, harness.context);
	assert.equal(implementer.model, standardModel);
	assert.equal(implementer.state.designTask.id, "design-keep");
	const reviewer = await harness.route({
		...handoffRequest,
		state: implementer.state,
		previous: { model: standardModel, thinkingLevel: "medium" },
		messages: [
			{ role: "assistant", content: [{ type: "text", text: "Implementation complete." }] },
			{ role: "user", content: "[auto-model: review the implementation] Please review." },
		],
	}, harness.context);
	assert.equal(reviewer.model, expertModel);
	assert.equal(reviewer.state.designTask.id, "design-keep");
});

test("a user answer to DESIGN-BLOCKED continues with the current designer", async () => {
	const harness = setup();
	await harness.initialize();
	harness.branch.push(
		{
			type: "custom",
			customType: "pi.virtual-model-state",
			data: { provider: "auto", modelId: "auto", state: { tier: "expert", modelKey: "openai/gpt-6-astra", designTask: { id: "design-question", source: "feature_build" } } },
		},
		{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "DESIGN-BLOCKED: Which API should I use?" }] } },
	);
	await harness.handler("input")?.({ text: "Use the existing REST API" }, harness.context);
	const routed = await harness.route({
		...request("Use the existing REST API"),
		previous: { model: expertModel, thinkingLevel: "high" },
		state: { tier: "expert", modelKey: "openai/gpt-6-astra", designTask: { id: "design-question", source: "feature_build" } },
	}, harness.context);
	assert.equal(routed.model, expertModel);
	assert.equal(routed.state, undefined, "an unchanged virtual-model state is retained by Pi when the route omits state");
	assert.equal(harness.classifierCalls(), 0);
});

test("first-answer system guidance is available before routing and is removed from non-auto sessions", async () => {
	const harness = setup();
	await harness.initialize();
	const hook = harness.handler("before_agent_start");
	const sections: Record<string, string> = {};
	await hook?.({ systemPromptOptions: { sections } }, harness.context);
	assert.match(sections.auto_model_design_first, /hand_off_implementation/);
	assert.match(sections.auto_model_design_first, /@handoff-contract/);
	harness.context.model = { provider: "openai", id: "gpt-6-astra" };
	await hook?.({ systemPromptOptions: { sections } }, harness.context);
	assert.equal(sections.auto_model_design_first, undefined);
});

test("a premature design finish gets one reminder and persists a task-scoped guard", async () => {
	const harness = setup();
	await harness.initialize();
	harness.branch.push({
		type: "custom",
		customType: "pi.virtual-model-state",
		data: { provider: "auto", modelId: "auto", state: { tier: "expert", modelKey: "openai/gpt-6-astra", designTask: { id: "design-1", source: "feature_build" } } satisfies AutoRouteState },
	}, { type: "message", message: { role: "toolResult", toolName: "edit", isError: false } });
	const event: any = {
		outcome: "completed",
		continue: false,
		entries: [],
		context: { contextEntries: [{ messages: [{ role: "assistant", content: [{ type: "text", text: "I reviewed the plan." }] }] }] },
	};
	const handler = harness.handler("agent_before_settle");
	const result = await handler?.(event, harness.context) as any;
	assert.equal(result.continue, true);
	assert.ok(result.entries.some((entry: any) => entry.type === "custom" && entry.customType === DESIGN_REMINDER_ENTRY_TYPE));
	harness.branch.push(result.entries.find((entry: any) => entry.type === "custom"));
	assert.equal(await handler?.(event, harness.context), undefined);
});

test("a design blocker and an existing handoff do not trigger the initial-design reminder", async () => {
	const harness = setup();
	await harness.initialize();
	const handler = harness.handler("agent_before_settle");
	const stateEntry = (handoff?: AutoRouteState["handoff"]) => ({
		type: "custom",
		customType: "pi.virtual-model-state",
		data: { provider: "auto", modelId: "auto", state: { tier: "expert", modelKey: "openai/gpt-6-astra", designTask: { id: "design-1", source: "feature_build" }, handoff } },
	});
	const event = (answer: string): any => ({ outcome: "completed", continue: false, entries: [], context: { contextEntries: [{ messages: [{ role: "assistant", content: [{ type: "text", text: answer }] }] }] } });
	harness.branch.push(stateEntry());
	assert.equal(await handler?.(event("DESIGN-BLOCKED: Which API?"), harness.context), undefined);
	harness.branch.splice(0, harness.branch.length, stateEntry({ phase: "reviewing", designer: { tier: "expert", modelKey: "openai/gpt-6-astra" }, handoffCount: 1 }));
	assert.equal(await handler?.(event("Implemented"), harness.context), undefined);
});

function designTaskEntry(handoff?: AutoRouteState["handoff"]) {
	return {
		type: "custom",
		customType: "pi.virtual-model-state",
		data: { provider: "auto", modelId: "auto", state: { tier: "expert", modelKey: "openai/gpt-6-astra", designTask: { id: "design-1", source: "plan_implementation" }, handoff } satisfies AutoRouteState },
	};
}

function settledEvent(answer: string): any {
	return { outcome: "completed", continue: false, entries: [], context: { contextEntries: [{ messages: [{ role: "assistant", content: [{ type: "text", text: answer }] }] }] } };
}

test("a designer that edited no file is not reminded to hand off", async () => {
	const harness = setup();
	await harness.initialize();
	harness.branch.push(designTaskEntry(), { type: "message", message: { role: "user", content: "implement the plan" } });
	assert.equal(await harness.handler("agent_before_settle")?.(settledEvent("Here is how I would do it."), harness.context), undefined);
});

test("a turn that saved the agreed plan is not reminded to hand off, even after edits", async () => {
	const harness = setup();
	await harness.initialize();
	harness.branch.push(
		designTaskEntry(),
		{ type: "message", message: { role: "toolResult", toolName: "edit", isError: false } },
		{ type: "message", message: { role: "user", content: "okay, this is the plan, let's implement it" } },
		{ type: "message", message: { role: "toolResult", toolName: "save_agreed_plan", isError: false } },
	);
	assert.equal(await harness.handler("agent_before_settle")?.(settledEvent("Plan saved; you are asked whether to start /build."), harness.context), undefined);
});

const designerAfterTakeOver: AutoRouteState = {
	tier: "expert",
	modelKey: "openai/gpt-6-astra",
	thinkingLevel: "high",
	designTask: { id: "design-1", source: "plan_implementation" },
	handoff: { phase: "taking-over", designer: { tier: "expert", modelKey: "openai/gpt-6-astra", thinkingLevel: "high" }, handoffCount: 1 },
};

function requestAfterImplementer(reason: "continuation" | "user", state: AutoRouteState): any {
	return {
		reason,
		state,
		thinkingLevel: "medium",
		previous: { model: standardModel, thinkingLevel: "medium" },
		messages: [
			{ role: "assistant", content: [{ type: "text", text: "Reading the contracts." }] },
			{ role: "toolResult", toolName: "read", isError: false },
		],
	};
}

test("a continuation after the designer took over stays with the designer, not the implementer's model", async () => {
	const harness = setup();
	await harness.initialize();
	const continued = await harness.route(requestAfterImplementer("continuation", designerAfterTakeOver), harness.context);
	assert.equal(continued.model, expertModel);
	const reviewing: AutoRouteState = { ...designerAfterTakeOver, handoff: { ...designerAfterTakeOver.handoff!, phase: "reviewing" } };
	const steered = await harness.route(requestAfterImplementer("user", reviewing), harness.context);
	assert.equal(steered.model, expertModel);
});

test("when the designer's model is gone, failover picks a designer fallback, never the implementer's model", async () => {
	const harness = setup({ taskKind: "other", tier: "standard" }, [complexModel, standardModel]);
	await harness.initialize();
	const continued = await harness.route(requestAfterImplementer("continuation", designerAfterTakeOver), harness.context);
	assert.equal(continued.model, complexModel);
	assert.equal(continued.state.tier, "complex");
	assert.equal(continued.state.designTask.id, "design-1");
	assert.equal(continued.state.handoff.phase, "taking-over");
});

test("a new task on the same tier switches back to the tier's first available model instead of staying on a fallback", async () => {
	const harness = setup({ taskKind: "other", tier: "standard" }, [expertModel, complexModel, preferredStandardModel, standardModel]);
	await harness.initialize();
	const fallbackState: AutoRouteState = { tier: "standard", modelKey: "opencode-go/gpt-6-luna", thinkingLevel: "medium" };
	const continued = await harness.route({
		reason: "continuation",
		state: fallbackState,
		thinkingLevel: "medium",
		previous: { model: standardModel, thinkingLevel: "medium" },
		messages: [{ role: "user", content: "implement the brief" }, { role: "assistant", content: [{ type: "text", text: "Working." }] }],
	}, harness.context);
	assert.equal(continued.model, standardModel, "mid-task continuations stay on the fallback to keep the prompt cache");

	await beginNewInput(harness);
	const nextTask = await harness.route({
		...request("implement the next plan"),
		state: fallbackState,
		previous: { model: standardModel, thinkingLevel: "medium" },
	}, harness.context);
	assert.equal(nextTask.model, preferredStandardModel);
	assert.equal(nextTask.state.modelKey, "gemini-app/gemini-neon");

	await beginNewInput(harness);
	const samePreferred = await harness.route({
		...request("another ordinary edit"),
		state: nextTask.state,
		previous: { model: preferredStandardModel, thinkingLevel: "medium" },
	}, harness.context);
	assert.equal(samePreferred.model, preferredStandardModel);
	assert.equal(samePreferred.state, nextTask.state, "keeps the same state reference when tier, model and thinking did not change");
});
