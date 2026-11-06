import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AgentTracker } from "./agent-activity.ts";
import { BuildOrchestrator, type PlannerSeat } from "./build-orchestrator.ts";
import type { Subagent, SubagentOptions } from "./subagent-process.ts";
import { IDLE_WORKFLOW, type StageRecord, type WorkflowState } from "./workflow-state.ts";

/** Stands in for a subagent process: records prompts, and the test settles or crashes it. */
class FakeSubagent implements Subagent {
	readonly name: string;
	readonly sessionPath: string;
	readonly tracker = new AgentTracker();
	readonly prompts: string[] = [];
	isRunning = false;
	isWorking = false;
	isAborted = false;
	private readonly options: SubagentOptions;

	constructor(options: SubagentOptions) {
		this.options = options;
		this.name = options.name;
		this.sessionPath = options.sessionPath;
	}

	start(): void {
		this.isRunning = true;
	}

	prompt(message: string): void {
		this.prompts.push(message);
		this.isWorking = true;
	}

	sendUserMessage(text: string): void {
		this.prompt(text);
	}

	abortTurn(): void {
		this.isAborted = true;
	}

	async stop(): Promise<void> {
		this.isRunning = false;
	}

	settle(answer: string, isAborted = false): void {
		this.isWorking = false;
		this.options.onSettled(answer, isAborted);
	}

	crash(reason: string): void {
		this.isRunning = false;
		this.options.onExit(reason);
	}
}

interface Deferred {
	promise: Promise<void>;
	resolve: () => void;
}

function deferred(): Deferred {
	let resolve = () => {};
	const promise = new Promise<void>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

/** What the planner's session holds; ruleFilesGate lets a test hold the run while it reads the rule files. */
interface RecordedSession {
	sessionDirectory: string;
	state: WorkflowState;
	stages: StageRecord[];
	plannerQuestions: string[];
	reports: string[];
	notices: string[];
	finished: { next: WorkflowState; summary: string }[];
	ruleFilesGate: Deferred | undefined;
	plan: string;
}

function newRecordedSession(): RecordedSession {
	return {
		sessionDirectory: mkdtempSync(join(tmpdir(), "build-orchestrator-test-")),
		state: IDLE_WORKFLOW,
		stages: [],
		plannerQuestions: [],
		reports: [],
		notices: [],
		finished: [],
		ruleFilesGate: undefined,
		plan: "# Add export\n\n## Goal\nCSV export",
	};
}

/** The planner's side kept in memory; a second seat over the same record is the session after a reload. */
function fakeSeat(recorded: RecordedSession): PlannerSeat {
	const { sessionDirectory } = recorded;
	return {
		cwd: () => sessionDirectory,
		sessionDirectory: () => sessionDirectory,
		plannerSessionPath: () => undefined,
		state: () => recorded.state,
		enterPhase: (next) => {
			recorded.state = next;
		},
		appendStage: (record) => recorded.stages.push(record),
		runStageRecords: () => recorded.stages,
		currentStageRecords: () => recorded.stages.filter((record) => record.stage === phaseOf(recorded)),
		readPlan: () => recorded.plan,
		ruleFiles: async () => {
			await recorded.ruleFilesGate?.promise;
			return ["/repo/AGENTS.md"];
		},
		describeChanges: async () => "+10 −2 in 2 files",
		askPlanner: (prompt) => recorded.plannerQuestions.push(prompt),
		postReport: (report) => recorded.reports.push(report),
		notify: (message) => recorded.notices.push(message),
		finish: (next, summary) => {
			recorded.state = next;
			recorded.finished.push({ next, summary });
		},
		dialogs: { select: async () => undefined, confirm: async () => false, input: async () => undefined },
	};
}

function startedRun() {
	const recorded = newRecordedSession();
	const launched: FakeSubagent[] = [];
	const launch = (options: SubagentOptions): FakeSubagent => {
		const subagent = new FakeSubagent(options);
		launched.push(subagent);
		return subagent;
	};
	const orchestrator = new BuildOrchestrator(fakeSeat(recorded), launch);
	orchestrator.startImplementation({ planPath: "/repo/plan.md", baseCommit: "abc123" }, "BRIEF");
	/** The latest process launched for the agent, e.g. "Implementer" or "Claude reviewer". */
	const agent = (name: string): FakeSubagent => {
		const subagent = launched.findLast((candidate) => candidate.name === name);
		assert.ok(subagent, `no ${name} was launched`);
		return subagent;
	};
	return { orchestrator, recorded, launched, launch, agent };
}

/** Read through a call, so TypeScript does not narrow the phase across the steps of one test. */
const phaseOf = (recorded: RecordedSession): WorkflowState["phase"] => recorded.state.phase;

const settleAsync = () => new Promise((resolve) => setImmediate(resolve));

test("a finished implementation goes to both reviewers, and two passes wait for you to ship", async () => {
	const { recorded, agent } = startedRun();
	assert.deepEqual(agent("Implementer").prompts, ["BRIEF"]);
	agent("Implementer").settle("Added it.\nIMPLEMENTATION: done");
	await settleAsync();
	assert.equal(phaseOf(recorded), "review");
	assert.equal(agent("Claude reviewer").prompts.length, 1);
	assert.equal(agent("OpenAI reviewer").prompts.length, 1);
	agent("Claude reviewer").settle("Fine.\nREVIEW_VERDICT: pass");
	assert.equal(recorded.finished.length, 0, "waits for the second reviewer");
	agent("OpenAI reviewer").settle("Fine.\nREVIEW_VERDICT: pass");
	await settleAsync();
	assert.equal(recorded.finished[0]?.next.phase, "awaiting-ship");
	assert.equal(recorded.reports.length, 1);
	assert.ok(!agent("Implementer").isRunning && !agent("Claude reviewer").isRunning, "the subagents are stopped");
});

test("the implementer's question goes to the planner, and the planner's answer back to it", () => {
	const { orchestrator, recorded, agent } = startedRun();
	agent("Implementer").settle("IMPLEMENTATION: blocked: which currency?");
	assert.equal(recorded.plannerQuestions.length, 1);
	assert.ok(orchestrator.isWaitingForPlanner);
	orchestrator.handlePlannerReply("Use EUR cents.\nIMPLEMENTER_ANSWER: ready");
	assert.ok(agent("Implementer").prompts.at(-1)?.includes("Use EUR cents."));
	assert.ok(!orchestrator.isWaitingForPlanner);
});

test("a crashed implementer is shown as crashed and a restart continues it on a new process", async () => {
	const { orchestrator, recorded, launched, agent } = startedRun();
	const crashed = agent("Implementer");
	crashed.crash("exit code 1");
	assert.equal(orchestrator.liveStages()[0]?.condition, "crashed");
	assert.ok(recorded.notices.some((notice) => notice.includes("r restarts it")));
	assert.equal(await orchestrator.restartAgent("implementer"), undefined);
	const restarted = agent("Implementer");
	assert.notEqual(restarted, crashed);
	assert.equal(launched.length, 2);
	assert.ok(restarted.prompts[0]?.startsWith("[/build: RESUME]"));
	assert.equal(orchestrator.liveStages()[0]?.condition, "running");
});

test("a settle from a replaced process is ignored", async () => {
	const { orchestrator, recorded, agent } = startedRun();
	const replaced = agent("Implementer");
	await orchestrator.restartAgent("implementer");
	replaced.settle("IMPLEMENTATION: done");
	await settleAsync();
	assert.equal(phaseOf(recorded), "implement");
});

test("stopping the run while it reads the rule files starts no reviewers", async () => {
	const { orchestrator, recorded, launched, agent } = startedRun();
	recorded.ruleFilesGate = deferred();
	agent("Implementer").settle("IMPLEMENTATION: done");
	orchestrator.stop();
	recorded.ruleFilesGate.resolve();
	await settleAsync();
	assert.equal(phaseOf(recorded), "implement");
	assert.equal(launched.length, 1);
	assert.deepEqual(orchestrator.liveStages(), []);
});

test("a re-review that still finds problems waits for your call, and fixing again starts the implementer", async () => {
	const { orchestrator, recorded, agent } = startedRun();
	agent("Implementer").settle("IMPLEMENTATION: done");
	await settleAsync();
	agent("Claude reviewer").settle("a.ts:3 off by one\nREVIEW_VERDICT: fix");
	agent("OpenAI reviewer").settle("REVIEW_VERDICT: pass");
	await settleAsync();
	assert.equal(phaseOf(recorded), "fix");
	agent("Implementer").settle("IMPLEMENTATION: done");
	await settleAsync();
	assert.equal(phaseOf(recorded), "re-review");
	agent("Claude reviewer").settle("still off by one\nREVIEW_VERDICT: fix");
	agent("OpenAI reviewer").settle("REVIEW_VERDICT: pass");
	await settleAsync();
	assert.equal(recorded.finished.at(-1)?.next.phase, "review-failed");
	assert.equal(orchestrator.fixAgain(), undefined);
	assert.equal(phaseOf(recorded), "fix");
	assert.ok(agent("Implementer").prompts.at(-1)?.includes("still off by one"));
});

test("accepting a failed re-review releases the work for shipping", async () => {
	const { orchestrator, recorded } = startedRun();
	recorded.state = { phase: "review-failed", planPath: "/repo/plan.md", findings: "x" };
	assert.equal(orchestrator.acceptAnyway(), undefined);
	assert.equal(recorded.finished.at(-1)?.next.phase, "awaiting-ship");
});

test("a plan change while implementing reaches the implementer at once as a new revision", () => {
	const { orchestrator, recorded, agent } = startedRun();
	recorded.plan = "# Add export\n\n## Goal\nCSV and JSON export";
	assert.equal(orchestrator.tellImplementerAboutPlanChange(), undefined);
	assert.ok(agent("Implementer").prompts.at(-1)?.includes("CSV and JSON export"));
	assert.equal(recorded.state.phase === "implement" && recorded.state.planRevision, 2);
});

test("a plan change after shipping was offered runs the implementer and both reviewers again", async () => {
	const { orchestrator, recorded, agent } = startedRun();
	agent("Implementer").settle("IMPLEMENTATION: done");
	await settleAsync();
	agent("Claude reviewer").settle("REVIEW_VERDICT: pass");
	agent("OpenAI reviewer").settle("REVIEW_VERDICT: pass");
	await settleAsync();
	assert.equal(phaseOf(recorded), "awaiting-ship");
	assert.equal(await orchestrator.startChangeRound(), undefined);
	assert.equal(phaseOf(recorded), "implement");
	assert.ok(agent("Implementer").prompts.at(-1)?.includes("CSV export"));
});

test("resuming a review after a reload asks only the reviewer that had not answered", async () => {
	const { orchestrator, recorded, launch, agent } = startedRun();
	agent("Implementer").settle("IMPLEMENTATION: done");
	await settleAsync();
	agent("Claude reviewer").settle("Fine.\nREVIEW_VERDICT: pass");
	orchestrator.stop();
	const reloaded = new BuildOrchestrator(fakeSeat(recorded), launch);
	assert.equal(reloaded.resume(), undefined);
	assert.deepEqual(agent("Claude reviewer").prompts, [], "the Claude reviewer is not asked again");
	assert.ok(agent("OpenAI reviewer").prompts[0]?.startsWith("[/build: RESUME]"));
	agent("OpenAI reviewer").settle("REVIEW_VERDICT: pass");
	await settleAsync();
	assert.equal(recorded.finished.at(-1)?.next.phase, "awaiting-ship");
});

test("stopping an agent's turn keeps its process for a message or a restart", () => {
	const { orchestrator, agent } = startedRun();
	assert.equal(orchestrator.stopAgentTurn("implementer"), undefined);
	assert.ok(agent("Implementer").isAborted && agent("Implementer").isRunning);
	agent("Implementer").settle("", true);
	assert.equal(orchestrator.liveStages()[0]?.condition, "stopped");
	assert.equal(orchestrator.sendToSubagent("implementer", "go on"), undefined);
	assert.equal(orchestrator.liveStages()[0]?.condition, "running");
});
