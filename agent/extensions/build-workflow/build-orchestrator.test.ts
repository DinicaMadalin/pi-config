import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { CheckResult } from "../quality-gate/check-baseline.ts";
import { AgentTracker } from "./agent-activity.ts";
import type { BuildCheckRun } from "./build-checks.ts";
import { BuildOrchestrator, type PlannerSeat } from "./build-orchestrator.ts";
import type { ReviewerLineup } from "./reviewer-lineup.ts";
import type { Subagent, SubagentOptions } from "./subagent-process.ts";
import type { StreamAssignment } from "./workflow-prompts.ts";
import type { ImplementerSeat } from "./work-streams.ts";
import { type FeatureWork, IDLE_WORKFLOW, type StageRecord, type WorkflowState } from "./workflow-state.ts";

/** Stands in for a subagent process: records prompts, and the test settles or crashes it. */
class FakeSubagent implements Subagent {
	readonly name: string;
	readonly sessionPath: string;
	readonly maxTier: SubagentOptions["maxTier"];
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
		this.maxTier = options.maxTier;
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
	/** The implementers of the session's earlier runs. */
	crew: ImplementerSeat[];
	/** What contract cleanup reports: undefined passes, a string blocks shipping. */
	cleanupFailure: string | undefined;
	cleanupCalls: number;
	cleanupGate: Deferred | undefined;
	/** Which reviewers the run gets; both vendors unless a test says otherwise. */
	lineup: ReviewerLineup;
	/** What each check run after the implementers returns, in order; no checks once the list is used up. */
	checkRuns: BuildCheckRun[];
	changedFiles: string[];
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
		crew: [],
		cleanupFailure: undefined,
		cleanupCalls: 0,
		cleanupGate: undefined,
		lineup: { ok: true, vendors: ["anthropic", "openai"] },
		checkRuns: [],
		changedFiles: [],
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
		crew: () => recorded.crew,
		ruleFiles: async () => {
			await recorded.ruleFilesGate?.promise;
			return ["/repo/AGENTS.md"];
		},
		describeChanges: async () => "+10 −2 in 2 files",
		askPlanner: (prompt) => recorded.plannerQuestions.push(prompt),
		postReport: (report) => recorded.reports.push(report),
		notify: (message) => recorded.notices.push(message),
		callUser: (message) => recorded.notices.push(message),
		isProjectTrusted: () => true,
		finalizeContracts: async () => {
			recorded.cleanupCalls++;
			await recorded.cleanupGate?.promise;
			return recorded.cleanupFailure;
		},
		finish: (next, summary) => {
			recorded.state = next;
			recorded.finished.push({ next, summary });
		},
		reviewerLineup: () => recorded.lineup,
		runChecks: async () => recorded.checkRuns.shift() ?? { kind: "no-checks" },
		changedFiles: async () => recorded.changedFiles,
		dialogs: { select: async () => undefined, confirm: async () => false, input: async () => undefined },
	};
}

const TWO_STREAM_PLAN = [
	"# Add export",
	"",
	"## Goal",
	"CSV export",
	"",
	"## Work streams",
	"### API",
	"src/export.ts",
	"### Tests",
	"test/export.test.ts",
	"",
	"## Files",
	"- src/export.ts",
].join("\n");

/** "BRIEF", or "BRIEF Implementer 2: Tests" for an implementer of one of several work streams. */
function briefFor(assignment: StreamAssignment | undefined): string {
	return assignment ? `BRIEF ${assignment.implementerName}: ${assignment.stream.name}` : "BRIEF";
}

/** A run whose designer has not finished yet. */
function designingRun(plan?: string, crew: ImplementerSeat[] = [], work: Partial<FeatureWork> = {}) {
	const recorded = newRecordedSession();
	if (plan) recorded.plan = plan;
	recorded.crew = crew;
	const launched: FakeSubagent[] = [];
	const launch = (options: SubagentOptions): FakeSubagent => {
		const subagent = new FakeSubagent(options);
		launched.push(subagent);
		return subagent;
	};
	const orchestrator = new BuildOrchestrator(fakeSeat(recorded), launch);
	orchestrator.startImplementation({ planPath: "/repo/plan.md", baseCommit: "abc123", ...work }, recorded.plan, briefFor);
	/** The latest process launched for the agent, e.g. "Implementer" or "Claude reviewer". */
	const agent = (name: string): FakeSubagent => {
		const subagent = launched.findLast((candidate) => candidate.name === name);
		assert.ok(subagent, `no ${name} was launched`);
		return subagent;
	};
	return { orchestrator, recorded, launched, launch, agent };
}

/** A run past its design: the designer finished, and the implementers work. */
function startedRun(plan?: string, crew: ImplementerSeat[] = [], work: Partial<FeatureWork> = {}) {
	const run = designingRun(plan, crew, work);
	run.agent("Designer").settle("Signatures, contracts and tests written.\nDESIGN: done");
	return run;
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
	assert.ok(recorded.notices.some((notice) => notice.includes("/build implement restarts it")));
	assert.equal(await orchestrator.resumeOrRestart(), undefined);
	const restarted = agent("Implementer");
	assert.notEqual(restarted, crashed);
	assert.equal(launched.length, 3, "designer, crashed implementer, restarted implementer");
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
	assert.equal(launched.length, 2, "only the designer and the implementer");
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
	assert.ok(recorded.plannerQuestions.at(-1)?.includes("a.ts:3 off by one"), "the planner writes the fix steps");
	assert.equal(agent("Implementer").prompts.length, 1, "the implementer waits for the fix steps");
	orchestrator.handlePlannerReply("1. Use <= in a.ts:3 and add a boundary test\nIMPLEMENTER_ANSWER: ready");
	assert.ok(agent("Implementer").prompts.at(-1)?.includes("Use <= in a.ts:3"));
	agent("Implementer").settle("Fixed a.ts:3 with a boundary test\nIMPLEMENTATION: done");
	await settleAsync();
	assert.equal(phaseOf(recorded), "re-review");
	assert.ok(agent("Claude reviewer").prompts.at(-1)?.includes("Fixed a.ts:3 with a boundary test"), "re-reviewers see the fix reply");
	agent("Claude reviewer").settle("still off by one\nREVIEW_VERDICT: fix");
	agent("OpenAI reviewer").settle("REVIEW_VERDICT: pass");
	await settleAsync();
	assert.equal(recorded.finished.at(-1)?.next.phase, "review-failed");
	assert.equal(orchestrator.fixAgain(), undefined);
	assert.equal(phaseOf(recorded), "fix");
	assert.ok(recorded.plannerQuestions.at(-1)?.includes("still off by one"));
	orchestrator.handlePlannerReply("1. Also cover n = 0\nIMPLEMENTER_ANSWER: ready");
	assert.ok(agent("Implementer").prompts.at(-1)?.includes("Also cover n = 0"));
});

test("accepting a failed re-review releases the work for shipping", async () => {
	const { orchestrator, recorded } = startedRun();
	recorded.state = { phase: "review-failed", planPath: "/repo/plan.md", findings: "x" };
	assert.equal(orchestrator.acceptAnyway(), undefined);
	assert.equal(recorded.finished.at(-1)?.next.phase, "awaiting-ship");
});

test("a plan change while implementing stops the implementer and redesigns the contracts first, as a new revision", async () => {
	const { orchestrator, recorded, agent } = startedRun();
	const firstImplementer = agent("Implementer");
	recorded.plan = "# Add export\n\n## Goal\nCSV and JSON export";
	assert.equal(await orchestrator.tellImplementersAboutPlanChange(), undefined);
	assert.ok(!firstImplementer.isRunning, "no implementer races the changed contracts");
	assert.equal(phaseOf(recorded), "design");
	assert.equal(recorded.state.phase === "design" && recorded.state.planRevision, 2);
	assert.ok(agent("Designer").prompts.at(-1)?.includes("CSV and JSON export"));
	agent("Designer").settle("DESIGN: done");
	assert.equal(phaseOf(recorded), "implement");
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
	assert.equal(phaseOf(recorded), "design");
	agent("Designer").settle("DESIGN: done");
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

test("a stopped implementer restarts on /build implement", async () => {
	const { orchestrator, agent } = startedRun();
	const stopped = agent("Implementer");
	stopped.settle("", true);
	assert.equal(orchestrator.liveStages()[0]?.condition, "stopped");
	assert.equal(await orchestrator.resumeOrRestart(), undefined);
	assert.equal(orchestrator.liveStages()[0]?.condition, "running");
	assert.ok(agent("Implementer").prompts.at(-1)?.startsWith("[/build: RESUME]"));
});

const implementersOf = (recorded: RecordedSession): ImplementerSeat[] =>
	"implementers" in recorded.state ? (recorded.state.implementers ?? []) : [];

test("a plan with two work streams starts two implementers, and the review waits until both are done", async () => {
	const { recorded, agent } = startedRun(TWO_STREAM_PLAN);
	assert.deepEqual(agent("Implementer").prompts, ["BRIEF Implementer: API"]);
	assert.deepEqual(agent("Implementer 2").prompts, ["BRIEF Implementer 2: Tests"]);
	agent("Implementer 2").settle("IMPLEMENTATION: done");
	await settleAsync();
	assert.equal(phaseOf(recorded), "implement", "waits for the API implementer");
	agent("Implementer").settle("IMPLEMENTATION: done");
	await settleAsync();
	assert.equal(phaseOf(recorded), "review");
	assert.deepEqual(
		recorded.stages.map((record) => record.agent),
		["designer", "implementer-2", "implementer"],
	);
});

test("the planner answers parallel questions one at a time, each back to the implementer that asked", () => {
	const { orchestrator, recorded, agent } = startedRun(TWO_STREAM_PLAN);
	agent("Implementer 2").settle("IMPLEMENTATION: blocked: which test runner?");
	agent("Implementer").settle("IMPLEMENTATION: blocked: which currency?");
	assert.equal(recorded.plannerQuestions.length, 1, "the second question waits");
	assert.ok(recorded.plannerQuestions[0].includes("Implementer 2"));
	orchestrator.handlePlannerReply("Use node:test.\nIMPLEMENTER_ANSWER: ready");
	assert.ok(agent("Implementer 2").prompts.at(-1)?.includes("Use node:test."));
	assert.ok(!agent("Implementer").prompts.at(-1)?.includes("Use node:test."));
	assert.equal(recorded.plannerQuestions.length, 2);
	assert.ok(recorded.plannerQuestions[1].includes("which currency?"));
	orchestrator.handlePlannerReply("EUR cents.\nIMPLEMENTER_ANSWER: ready");
	assert.ok(agent("Implementer").prompts.at(-1)?.includes("EUR cents."));
	assert.ok(!orchestrator.isWaitingForPlanner);
});

test("each implementer gets its own section of the planner's fix steps", async () => {
	const { orchestrator, recorded, agent } = startedRun(TWO_STREAM_PLAN);
	agent("Implementer").settle("IMPLEMENTATION: done");
	agent("Implementer 2").settle("IMPLEMENTATION: done");
	await settleAsync();
	agent("Claude reviewer").settle("test/export.test.ts:3 weak assert\nREVIEW_VERDICT: fix");
	agent("OpenAI reviewer").settle("REVIEW_VERDICT: pass");
	await settleAsync();
	assert.equal(phaseOf(recorded), "fix");
	assert.ok(orchestrator.isWaitingForPlanner);
	orchestrator.handlePlannerReply("### Implementer 2\n1. Assert the CSV header in test/export.test.ts:3\n### Implementer\nNothing to change.\nIMPLEMENTER_ANSWER: ready");
	const testsPrompt = agent("Implementer 2").prompts.at(-1) ?? "";
	assert.ok(testsPrompt.includes("Assert the CSV header"));
	assert.ok(testsPrompt.includes('the "Tests" work stream'));
	assert.ok(!(agent("Implementer").prompts.at(-1) ?? "").includes("Assert the CSV header"));
	assert.ok(!orchestrator.isWaitingForPlanner);
});

test("implementers run under the cheap tier ceiling unless their stream needs a strong model", () => {
	const strongPlan = TWO_STREAM_PLAN.replace("### Tests", "### Tests (needs a strong model)");
	const { agent } = startedRun(strongPlan);
	assert.equal(agent("Implementer").maxTier, "standard");
	assert.equal(agent("Implementer 2").maxTier, "complex");
});

test("reviewers have no tier ceiling", async () => {
	const { agent } = startedRun();
	agent("Implementer").settle("IMPLEMENTATION: done");
	await settleAsync();
	assert.equal(agent("Claude reviewer").maxTier, undefined);
});

test("a later run of the session gives its streams to the implementers that built them, with their sessions", () => {
	const first = startedRun(TWO_STREAM_PLAN);
	const crew = implementersOf(first.recorded);
	const reordered = TWO_STREAM_PLAN.replace("### API\nsrc/export.ts\n### Tests\ntest/export.test.ts", "### Tests\nmore tests\n### API\nmore API");
	const second = startedRun(reordered, crew);
	assert.deepEqual(
		implementersOf(second.recorded).map((seat) => [seat.role, seat.stream, seat.sessionPath]),
		[
			["implementer-2", "Tests", crew[1].sessionPath],
			["implementer", "API", crew[0].sessionPath],
		],
	);
	assert.equal(second.agent("Implementer").sessionPath, crew[0].sessionPath);
});

test("a plan change that adds a work stream starts a third implementer; one that drops a stream stops its implementer", async () => {
	const { orchestrator, recorded, agent } = startedRun(TWO_STREAM_PLAN);
	recorded.plan = TWO_STREAM_PLAN.replace("## Files", "### Docs\nREADME.md\n\n## Files");
	assert.equal(await orchestrator.tellImplementersAboutPlanChange(), undefined);
	agent("Designer").settle("DESIGN: done");
	assert.deepEqual(agent("Implementer 3").prompts.length, 1);
	assert.ok(agent("Implementer 3").prompts[0].includes('work stream "Docs"'));
	assert.ok(agent("Implementer").prompts.at(-1)?.includes('work stream "API"'));
	recorded.plan = TWO_STREAM_PLAN.replace("### Tests\ntest/export.test.ts\n", "");
	assert.equal(await orchestrator.tellImplementersAboutPlanChange(), undefined);
	agent("Designer").settle("DESIGN: done");
	assert.equal(implementersOf(recorded).length, 1);
	assert.ok(!agent("Implementer 2").isRunning && !agent("Implementer 3").isRunning);
	agent("Implementer").settle("IMPLEMENTATION: done");
	await settleAsync();
	assert.equal(phaseOf(recorded), "review", "the dropped implementers are not waited for");
});

test("a plan change that marks a finished stream as needing a strong model relaunches its implementer under the higher ceiling", async () => {
	const { orchestrator, recorded, agent, launched } = startedRun(TWO_STREAM_PLAN);
	const firstTestsImplementer = agent("Implementer 2");
	firstTestsImplementer.settle("IMPLEMENTATION: done");
	recorded.plan = TWO_STREAM_PLAN.replace("### Tests", "### Tests (needs a strong model)");
	assert.equal(await orchestrator.tellImplementersAboutPlanChange(), undefined);
	agent("Designer").settle("DESIGN: done");
	const relaunched = agent("Implementer 2");
	assert.notEqual(relaunched, firstTestsImplementer);
	assert.equal(relaunched.maxTier, "complex");
	assert.equal(relaunched.sessionPath, firstTestsImplementer.sessionPath, "it keeps its session");
	assert.ok(!firstTestsImplementer.isRunning);
	assert.equal(agent("Implementer").maxTier, "standard", "the API stream stays on the cheap ceiling");
	assert.equal(launched.filter((subagent) => subagent.name === "Designer").length, 2, "the designer updates the contracts first");
});

/** Drives a started run through implementation and two passing reviews, into contract cleanup. */
async function passBothReviews(run: ReturnType<typeof startedRun>): Promise<void> {
	run.agent("Implementer").settle("IMPLEMENTATION: done");
	await settleAsync();
	run.agent("Claude reviewer").settle("REVIEW_VERDICT: pass");
	run.agent("OpenAI reviewer").settle("REVIEW_VERDICT: pass");
	await settleAsync();
}

test("the expert designer works first; implementers start only after its design is done", () => {
	const { recorded, launched, agent } = designingRun();
	assert.equal(phaseOf(recorded), "design");
	assert.deepEqual(launched.map((subagent) => subagent.name), ["Designer"]);
	assert.ok(agent("Designer").prompts[0]?.startsWith("[/build: DESIGN]"));
	assert.equal(agent("Designer").maxTier, undefined, "the designer has no cheap ceiling");
	const designerSession = recorded.state.phase === "design" ? recorded.state.designerSession : undefined;
	assert.ok(designerSession);
	assert.match(readFileSync(designerSession, "utf8"), /"route":"tier","tier":"expert"/, "the designer's session is pinned to the expert tier");
	agent("Designer").settle("DESIGN: done");
	assert.equal(phaseOf(recorded), "implement");
	assert.deepEqual(agent("Implementer").prompts, ["BRIEF"]);
	assert.equal(agent("Implementer").maxTier, "standard");
});

test("the designer's question goes to the planner, and the answer back to the designer", () => {
	const { orchestrator, recorded, agent } = designingRun();
	agent("Designer").settle("DESIGN: blocked: round per line or per order?");
	assert.ok(recorded.plannerQuestions.at(-1)?.includes("round per line or per order?"));
	orchestrator.handlePlannerReply("Per order.\nIMPLEMENTER_ANSWER: ready");
	assert.ok(agent("Designer").prompts.at(-1)?.includes("Per order."));
	assert.equal(phaseOf(recorded), "design");
});

test("two passing reviews remove the contracts and run the checks before shipping is offered", async () => {
	const run = startedRun();
	await passBothReviews(run);
	assert.equal(run.recorded.cleanupCalls, 1);
	assert.equal(run.recorded.finished.at(-1)?.next.phase, "awaiting-ship");
	assert.ok(run.recorded.finished.at(-1)?.summary.includes("temporary contracts removed"));
});

test("shipping stays blocked while contract cleanup runs", async () => {
	const run = startedRun();
	run.recorded.cleanupGate = deferred();
	await passBothReviews(run);
	assert.equal(phaseOf(run.recorded), "cleanup");
	assert.equal(run.recorded.finished.length, 0);
	assert.equal(await run.orchestrator.startChangeRound(), "Contract cleanup is running; retry the plan change when it finishes");
	run.recorded.cleanupGate.resolve();
	await settleAsync();
	assert.equal(phaseOf(run.recorded), "awaiting-ship");
});

test("a malformed contract or a failing check blocks shipping and waits for you; a retry can then release the work", async () => {
	const run = startedRun();
	run.recorded.cleanupFailure = "src/export.ts:12 has a begin marker without an end marker";
	await passBothReviews(run);
	assert.equal(phaseOf(run.recorded), "cleanup-failed");
	assert.equal(run.recorded.finished.length, 0, "nothing is released");
	assert.ok(run.recorded.notices.at(-1)?.includes("src/export.ts:12"));
	run.recorded.cleanupFailure = undefined;
	assert.equal(run.orchestrator.retryCleanup(), undefined);
	await settleAsync();
	assert.equal(run.recorded.cleanupCalls, 2);
	assert.equal(run.recorded.finished.at(-1)?.next.phase, "awaiting-ship");
});

test("a failed cleanup can go to a fix round on the failure", async () => {
	const run = startedRun();
	run.recorded.cleanupFailure = "npm test failed: export.test.ts expected 3 rows";
	await passBothReviews(run);
	assert.equal(run.orchestrator.fixAgain(), undefined);
	assert.equal(phaseOf(run.recorded), "fix");
	assert.ok(run.recorded.plannerQuestions.at(-1)?.includes("expected 3 rows"), "the planner writes fix steps for the failure");
});

test("a cleanup interrupted by a reload runs again on resume", async () => {
	const run = startedRun();
	run.recorded.cleanupGate = deferred();
	await passBothReviews(run);
	run.orchestrator.stop();
	run.recorded.cleanupGate.resolve();
	await settleAsync();
	assert.equal(phaseOf(run.recorded), "cleanup", "the stopped cleanup releases nothing");
	run.recorded.cleanupGate = undefined;
	const reloaded = new BuildOrchestrator(fakeSeat(run.recorded), run.launch);
	assert.equal(reloaded.resume(), undefined);
	await settleAsync();
	assert.equal(run.recorded.cleanupCalls, 2);
	assert.equal(run.recorded.finished.at(-1)?.next.phase, "awaiting-ship");
});

test("work with contracts cannot be accepted past a failed re-review", () => {
	const { orchestrator, recorded } = startedRun();
	recorded.state = { phase: "review-failed", planPath: "/repo/plan.md", findings: "x", designerSession: "/s/designer.jsonl" };
	assert.match(orchestrator.acceptAnyway() ?? "", /every reviewer to pass/);
	assert.equal(recorded.finished.length, 0);
});

const lintBaseline: CheckResult[] = [{ name: "lint", command: "npm run lint", passed: false, outputTail: "old.ts: e1" }];
const lintRun = (outputTail: string): BuildCheckRun => ({ kind: "ran", results: [{ name: "lint", command: "npm run lint", passed: false, outputTail }] });

test("only the vendor with a usable complex model reviews, and its pass is enough to ship", async () => {
	const run = startedRun();
	run.recorded.lineup = { ok: true, vendors: ["openai"] };
	run.agent("Implementer").settle("Added it.\nIMPLEMENTATION: done");
	await settleAsync();
	assert.equal(phaseOf(run.recorded), "review");
	assert.ok(!run.launched.some((subagent) => subagent.name === "Claude reviewer"), "no Claude reviewer without a Claude model");
	assert.deepEqual(Object.keys((run.recorded.state as FeatureWork).reviewerSessions ?? {}), ["openai"]);
	run.agent("OpenAI reviewer").settle("Fine.\nREVIEW_VERDICT: pass");
	await settleAsync();
	assert.equal(run.recorded.finished[0]?.next.phase, "awaiting-ship");
});

test("without any usable reviewer model the run pauses before the review, and resuming starts it once one is there", async () => {
	const run = startedRun();
	run.recorded.lineup = { ok: false, error: "No expert-tier reviewer model is available" };
	run.agent("Implementer").settle("Added it.\nIMPLEMENTATION: done");
	await settleAsync();
	assert.equal(phaseOf(run.recorded), "review");
	assert.ok(!run.launched.some((subagent) => subagent.name.endsWith("reviewer")), "no reviewer started");
	assert.ok(run.recorded.notices.some((notice) => notice.includes("No expert-tier reviewer model is available") && notice.includes("/build implement")));
	run.recorded.lineup = { ok: true, vendors: ["anthropic"] };
	assert.equal(run.orchestrator.resume(), undefined);
	await settleAsync();
	assert.equal(run.agent("Claude reviewer").prompts.length, 1);
});

test("new check failures get one fix round before the review, and the reviewers see what still fails", async () => {
	const run = startedRun(undefined, [], { checkBaseline: lintBaseline });
	run.recorded.changedFiles = ["src/a.ts"];
	run.recorded.checkRuns = [lintRun("old.ts: e1\nsrc/a.ts: e2"), lintRun("old.ts: e1\nsrc/a.ts: e2")];
	run.agent("Implementer").settle("Added it.\nIMPLEMENTATION: done");
	await settleAsync();
	assert.equal(phaseOf(run.recorded), "implement");
	assert.equal((run.recorded.state as { checksFixRequested?: boolean }).checksFixRequested, true);
	const fixPrompt = run.agent("Implementer").prompts.at(-1) ?? "";
	assert.ok(fixPrompt.startsWith("[/build: CHECKS]") && fixPrompt.includes("src/a.ts: e2") && !fixPrompt.includes("old.ts: e1"));
	run.agent("Implementer").settle("Tried.\nIMPLEMENTATION: done");
	await settleAsync();
	assert.equal(phaseOf(run.recorded), "review");
	assert.ok(run.agent("Claude reviewer").prompts[0]?.includes("src/a.ts: e2"));
});

test("failures already in the baseline do not hold up the review", async () => {
	const run = startedRun(undefined, [], { checkBaseline: lintBaseline });
	run.recorded.changedFiles = ["src/a.ts"];
	run.recorded.checkRuns = [lintRun("old.ts: e1")];
	run.agent("Implementer").settle("Added it.\nIMPLEMENTATION: done");
	await settleAsync();
	assert.equal(phaseOf(run.recorded), "review");
	assert.deepEqual(run.agent("Implementer").prompts, ["BRIEF"]);
	assert.ok(!run.agent("Claude reviewer").prompts[0]?.includes("old.ts: e1"));
});

test("checks the planner may not run are skipped with a notice", async () => {
	const run = startedRun();
	run.recorded.checkRuns = [{ kind: "untrusted" }];
	run.agent("Implementer").settle("Added it.\nIMPLEMENTATION: done");
	await settleAsync();
	assert.equal(phaseOf(run.recorded), "review");
	assert.ok(run.recorded.notices.some((notice) => notice.includes("not trusted")));
});
