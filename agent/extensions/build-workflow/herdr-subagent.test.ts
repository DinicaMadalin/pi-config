import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { HerdrClient } from "../herdr-tools/herdr-cli.ts";
import { ROUTE_DECISION_ENTRY_TYPE } from "../auto-model/route-decision.ts";
import { AppendedLines, herdrSubagentLauncher, readSessionStep, subagentCommandLine } from "./herdr-subagent.ts";
import { createSubagentSessionFile, moveSessionToCwd } from "./subagent-process.ts";

test("the pane's command line starts Pi on the session with the subagent marker and the tier ceiling", () => {
	const line = subagentCommandLine({ command: "/usr/bin/node", args: ["/opt/pi/cli.js"] }, "/tmp/my session.jsonl", "standard", true);
	const printEnv = "printenv PI_BUILD_SUBAGENT PI_BUILD_PROJECT_TRUSTED PI_AUTO_MODEL_MAX_TIER; echo";
	const printed = execFileSync("sh", ["-c", line.replace("/usr/bin/node", printEnv)], {
		encoding: "utf8",
		env: { ...process.env, PI_AUTO_MODEL_MAX_TIER: "expert" },
	});
	assert.equal(printed, "1\n1\nstandard\n/opt/pi/cli.js --session /tmp/my session.jsonl --model auto/auto\n");
});

test("without a tier ceiling the pane's Pi does not inherit the parent's", () => {
	const line = subagentCommandLine({ command: "pi", args: [] }, "/tmp/s.jsonl", undefined, false);
	const printed = execFileSync("sh", ["-c", line.replace(" pi ", " printenv PI_BUILD_SUBAGENT PI_AUTO_MODEL_MAX_TIER; true ")], {
		encoding: "utf8",
		env: { ...process.env, PI_AUTO_MODEL_MAX_TIER: "expert" },
	});
	assert.equal(printed, "1\n");
	assert.ok(line.includes("PI_BUILD_PROJECT_TRUSTED=0"));
});

test("an assistant entry of the session file is an answer with its tool calls and stop reason", () => {
	const line = JSON.stringify({
		type: "message",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "Reading" }, { type: "toolCall", name: "read", arguments: { path: "a.ts" } }],
			stopReason: "toolUse",
		},
	});
	const step = readSessionStep(line);
	assert.equal(step.kind, "answer");
	if (step.kind !== "answer") return;
	assert.equal(step.stopReason, "toolUse");
	assert.deepEqual(step.toolCalls, [{ name: "read", args: { path: "a.ts" } }]);
});

test("tool results, route decisions and anything else in the session file", () => {
	assert.deepEqual(readSessionStep(JSON.stringify({ type: "message", message: { role: "toolResult", isError: true } })), {
		kind: "tool-result",
		isError: true,
	});
	const route = JSON.stringify({ type: "custom", customType: ROUTE_DECISION_ENTRY_TYPE, data: { reason: "complex refactor" } });
	assert.deepEqual(readSessionStep(route), { kind: "route-reason", reason: "complex refactor" });
	assert.deepEqual(readSessionStep(JSON.stringify({ type: "message", message: { role: "user", content: "hi" } })), { kind: "other" });
	assert.deepEqual(readSessionStep('{"type":"mess'), { kind: "other" });
});

test("appended lines come whole: a line Pi is still writing waits for the next read", (t) => {
	const folder = mkdtempSync(join(tmpdir(), "appended-lines-"));
	t.after(() => rmSync(folder, { recursive: true, force: true }));
	const path = join(folder, "session.jsonl");
	writeFileSync(path, '{"old":1}\n');
	const lines = new AppendedLines(path);
	lines.skipExisting();
	appendFileSync(path, '{"a":1}\n{"b":"é');
	assert.deepEqual(lines.read(), ['{"a":1}']);
	appendFileSync(path, 'e"}\n');
	assert.deepEqual(lines.read(), ['{"b":"ée"}']);
	assert.deepEqual(lines.read(), []);
});

function helperTabTest(t: TestContext, options: { beforeCreate?: () => Promise<void>; failStart?: boolean; failCreate?: boolean; failClose?: boolean } = {}) {
	const folder = mkdtempSync(join(tmpdir(), "helper-tabs-"));
	const calls: string[][] = [];
	const exits: string[] = [];
	let tabCount = 0;
	let nextId = 0;
	const client = new HerdrClient(async (args) => {
		calls.push([...args]);
		const action = args.slice(0, 2).join(" ");
		const success = (result: unknown) => ({ code: 0, stdout: JSON.stringify({ result }), stderr: "" });
		const failure = (message: string) => ({ code: 1, stdout: "", stderr: JSON.stringify({ error: { code: "failed", message } }) });
		if (action === "tab create") {
			const tabNumber = ++tabCount;
			await options.beforeCreate?.();
			if (options.failCreate) return failure("cannot create tab");
			return success({ tab: { tab_id: `w9:t${tabNumber}` }, root_pane: { pane_id: `w9:p${++nextId}`, workspace_id: "w9" } });
		}
		if (action === "pane split") return success({ pane: { pane_id: `w9:p${++nextId}`, workspace_id: "w9" } });
		if (action === "pane layout") return success({ layout: { panes: [], splits: [] } });
		if (action === "pane run" && options.failStart) return failure("cannot start Pi");
		if ((action === "tab close" || action === "pane close") && options.failClose) return failure("cannot close tab");
		if (action === "agent wait" || action === "agent get") return success({ agent: { pane_id: args[2], agent_status: "idle" } });
		if (["pane run", "pane close", "agent prompt", "agent focus", "agent send-keys", "agent rename", "tab close"].includes(action)) return success({});
		throw new Error(`Unexpected herdr command: ${args.join(" ")}`);
	});
	const launch = herdrSubagentLauncher(client, () => "w9");
	const helpers: ReturnType<typeof launch>[] = [];
	t.after(async () => {
		await Promise.all(helpers.map((helper) => helper.stop()));
		rmSync(folder, { recursive: true, force: true });
	});
	const create = (name: string, agentName?: string) => {
		const sessionPath = join(folder, `${helpers.length}.jsonl`);
		createSubagentSessionFile(sessionPath, folder, undefined, []);
		const helper = launch({ name, agentName, cwd: folder, sessionPath, isProjectTrusted: true,
			dialogs: { select: async () => undefined, confirm: async () => false, input: async () => undefined },
			onSettled: () => {}, onExit: (reason) => exits.push(reason),
		});
		helpers.push(helper);
		helper.start();
		return helper;
	};
	return { create, calls, exits, folder };
}

async function waitUntil(condition: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 100 && !condition(); attempt++) await delay(10);
	assert.ok(condition(), "expected lifecycle transition within one second");
}

test("implementers share an Implementers tab and reviewers a Reviewers tab, one named pane each", async (t) => {
	const { create, calls, folder } = helperTabTest(t);
	const implementer = create("Implementer", "implementer");
	const secondImplementer = create("Implementer 2", "implementer-2");
	const reviewer = create("OpenAI reviewer", "openai-reviewer");
	implementer.prompt("implement the plan");
	await waitUntil(() => calls.some((args) => args[1] === "prompt"));
	await waitUntil(() => reviewer.pane?.status === "idle" && secondImplementer.pane?.status === "idle");
	assert.deepEqual(calls.filter((args) => args[0] === "tab"), [
		["tab", "create", "--workspace", "w9", "--cwd", folder, "--label", "Implementers", "--no-focus"],
		["tab", "create", "--workspace", "w9", "--cwd", folder, "--label", "Reviewers", "--no-focus"],
	]);
	assert.deepEqual(calls.filter((args) => args[1] === "split").map((args) => args.slice(0, 5)), [["pane", "split", implementer.pane?.id ?? "", "--direction", "right"]]);
	assert.equal(calls.some((args) => args[0] === "workspace"), false);
	assert.deepEqual(calls.filter((args) => args[1] === "rename").map((args) => args[3]).sort(), ["implementer", "implementer-2", "openai-reviewer"]);
	await Promise.all([implementer.stop(), implementer.stop()]);
	assert.deepEqual(calls.filter((args) => args[1] === "close"), [["pane", "close", implementer.pane?.id]], "a teammate keeps the tab open");
	await Promise.all([secondImplementer.stop(), reviewer.stop()]);
	assert.deepEqual(calls.filter((args) => args[0] === "tab" && args[1] === "close").sort(), [["tab", "close", "w9:t1"], ["tab", "close", "w9:t2"]]);
});

test("stopping while a tab opens waits for cleanup and never starts Pi", async (t) => {
	let releaseCreate!: () => void;
	const opening = new Promise<void>((resolve) => { releaseCreate = resolve; });
	const { create, calls } = helperTabTest(t, { beforeCreate: () => opening });
	const helper = create("Implementer");
	const stopped = helper.stop();
	releaseCreate();
	await stopped;
	assert.equal(calls.some((args) => args[0] === "pane" && args[1] === "run"), false);
	assert.deepEqual(calls.filter((args) => args[1] === "close"), [["tab", "close", "w9:t1"]]);
});

test("failed Pi startup closes its owned tab and reports the failure", async (t) => {
	const { create, calls, exits } = helperTabTest(t, { failStart: true });
	create("Claude reviewer");
	await waitUntil(() => exits.length === 1);
	assert.match(exits[0], /cannot start Pi/);
	assert.deepEqual(calls.filter((args) => args[1] === "close"), [["tab", "close", "w9:t1"]]);
});

test("cleanup failures stay visible in the helper's activity instead of closing unrelated tabs", async (t) => {
	const { create, calls, exits } = helperTabTest(t, { failStart: true, failClose: true });
	const helper = create("Implementer");
	await waitUntil(() => exits.length === 1);
	assert.ok(helper.tracker.activity.recent(10).some((line) => line.kind === "error" && line.text.includes("cannot close tab")));
	assert.deepEqual(calls.filter((args) => args[1] === "close"), [["tab", "close", "w9:t1"]]);
});

test("failed tab creation reports the error without closing another tab", async (t) => {
	const { create, calls, exits } = helperTabTest(t, { failCreate: true });
	create("Implementer");
	await waitUntil(() => exits.length === 1);
	assert.match(exits[0], /cannot create tab/);
	assert.equal(calls.some((args) => args[1] === "close"), false);
});

test("without agentName the agent name comes from the helper's display name", async (t) => {
	const { create, calls } = helperTabTest(t);
	const reviewer = create("Claude reviewer");
	await waitUntil(() => reviewer.pane?.status === "idle");
	assert.deepEqual(calls.filter((args) => args[1] === "rename"), [["agent", "rename", "w9:p1", "claude-reviewer"]]);
});

test("a reused session moves to the run's current folder, keeping its entries", (t) => {
	const folder = mkdtempSync(join(tmpdir(), "session-cwd-"));
	t.after(() => rmSync(folder, { recursive: true, force: true }));
	const path = join(folder, "session.jsonl");
	createSubagentSessionFile(path, "/gone/worktree", undefined, [{ customType: "state", data: { phase: "implement" } }]);
	moveSessionToCwd(path, "/new/worktree");
	const [header, entry] = readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line));
	assert.equal(header.cwd, "/new/worktree");
	assert.equal(header.type, "session");
	assert.deepEqual(entry.data, { phase: "implement" });
});
