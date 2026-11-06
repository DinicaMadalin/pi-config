import assert from "node:assert/strict";
import { test } from "node:test";
import { buildTimeline, type LiveStageView, type TimelineEntry } from "./build-timeline.ts";
import type { StageRecord, WorkflowState } from "./workflow-state.ts";

const START_MS = Date.parse("2026-11-04T08:00:00.000Z");

function at(seconds: number): string {
	return new Date(START_MS + seconds * 1000).toISOString();
}

function state(seconds: number, workflow: WorkflowState): TimelineEntry {
	return { type: "custom", customType: "build-workflow-state", data: workflow, timestamp: at(seconds) };
}

function userMessage(seconds: number): TimelineEntry {
	return { type: "message", timestamp: at(seconds), message: { role: "user" } };
}

function answer(seconds: number, model: string, costUsd: number, thinkingLevel = "high"): TimelineEntry {
	return {
		type: "message",
		timestamp: at(seconds),
		message: { role: "assistant", model, thinkingLevel, usage: { cost: { total: costUsd } } },
	};
}

function routeReason(seconds: number, reason: string): TimelineEntry {
	return { type: "custom", customType: "auto-model-route", data: { reason }, timestamp: at(seconds) };
}

function stageRecord(seconds: number, record: StageRecord): TimelineEntry {
	return { type: "custom", customType: "build-workflow-stage", data: record, timestamp: at(seconds) };
}

const PLAN_PATH = "/repo/.scratch/handoffs/plan.md";
const IMPLEMENTER_SESSION = "/sessions/implementer.jsonl";
const planningSession: TimelineEntry[] = [
	state(0, { phase: "plan", task: "Add device resolutions" }),
	userMessage(1),
	routeReason(2, "workflow phase pinned to the expert tier"),
	answer(61, "claude-opus-5-5", 1.5),
	userMessage(600),
	answer(660, "claude-opus-5-5", 0.5),
];
const implementing = state(700, {
	phase: "implement",
	planPath: PLAN_PATH,
	baseCommit: "abc1234",
	implementerSession: IMPLEMENTER_SESSION,
});
const liveImplementer: LiveStageView = {
	stage: "implement",
	model: "gpt-6-luna",
	thinkingLevel: "medium",
	routeReason: "rated complex (80%): multi-file or tricky change",
	activeMs: 30_000,
	costUsd: 0.5,
	isWorking: true,
};

function finishedStage(stage: StageRecord["stage"], model: string, costUsd: number): StageRecord {
	return { stage, model, thinkingLevel: "high", activeMs: 10_000, costUsd, report: `${stage} report` };
}

test("returns nothing when no build ever started", () => {
	assert.equal(buildTimeline([userMessage(0), answer(5, "m", 1)], START_MS, false), undefined);
});

test("shows the planner from its session and the implementer from its running process", () => {
	const timeline = buildTimeline([...planningSession, implementing], START_MS + 800_000, false, [liveImplementer]);
	assert.ok(timeline);
	assert.equal(timeline.task, "Add device resolutions");
	assert.equal(timeline.planPath, PLAN_PATH);
	assert.equal(timeline.baseCommit, "abc1234");
	assert.deepEqual(
		timeline.stages.map((stage) => [stage.role, stage.status, stage.model, stage.thinkingLevel]),
		[
			["Planner", "done", "claude-opus-5-5", "high"],
			["Implementer", "working", "gpt-6-luna", "medium"],
			["Claude reviewer", "waiting", undefined, undefined],
			["OpenAI reviewer", "waiting", undefined, undefined],
			["Ship", "waiting", undefined, undefined],
		],
	);
	assert.equal(timeline.stages[1].routeReason, "rated complex (80%): multi-file or tricky change");
	assert.equal(timeline.costUsd, 2.5);
});

test("an implementer that stopped working shows as paused", () => {
	const idleImplementer = { ...liveImplementer, isWorking: false };
	const timeline = buildTimeline([...planningSession, implementing], START_MS + 800_000, false, [idleImplementer]);
	assert.equal(timeline?.stages[1].status, "paused");
});

test("counts only the time the planner worked, not the time it waited for you", () => {
	const timeline = buildTimeline(planningSession, START_MS + 700_000, false);
	assert.ok(timeline);
	// 1s -> 61s, then 600s -> 660s; the 9 minutes before the second reply are yours.
	assert.equal(timeline.stages[0].activeMs, 120_000);
	assert.equal(timeline.stages[0].status, "your-turn");
});

test("adds the planner's running turn up to now", () => {
	const timeline = buildTimeline(planningSession.slice(0, 3), START_MS + 11_000, true);
	assert.equal(timeline?.stages[0].status, "working");
	assert.equal(timeline?.stages[0].activeMs, 10_000);
});

test("planner turns that answer the implementer count toward the planner", () => {
	const answeringPlanner = [userMessage(710), answer(720, "claude-opus-5-5", 0.25)];
	const timeline = buildTimeline([...planningSession, implementing, ...answeringPlanner], START_MS + 800_000, false);
	assert.equal(timeline?.stages[0].costUsd, 2.25);
	assert.equal(timeline?.stages[1].costUsd, 0);
});

test("a review shows a row per reviewer: one done while the other still works", () => {
	const reviewing: TimelineEntry[] = [
		stageRecord(760, finishedStage("implement", "gpt-6-luna", 0.5)),
		state(761, { phase: "review", planPath: PLAN_PATH, baseCommit: "abc1234" }),
		stageRecord(800, { ...finishedStage("review", "claude-opus-5-5", 1), reviewer: "anthropic" }),
	];
	const liveOpenaiReviewer: LiveStageView = {
		stage: "review",
		reviewer: "openai",
		model: "gpt-6-astra",
		thinkingLevel: "high",
		activeMs: 50_000,
		costUsd: 0.75,
		isWorking: true,
	};
	const timeline = buildTimeline([...planningSession, implementing, ...reviewing], START_MS + 820_000, false, [liveOpenaiReviewer]);
	assert.deepEqual(
		timeline?.stages.map((stage) => [stage.role, stage.agent, stage.status, stage.model]),
		[
			["Planner", "planner", "done", "claude-opus-5-5"],
			["Implementer", "implementer", "done", "gpt-6-luna"],
			["Claude reviewer", "anthropic-reviewer", "done", "claude-opus-5-5"],
			["OpenAI reviewer", "openai-reviewer", "working", "gpt-6-astra"],
			["Ship", undefined, "waiting", undefined],
		],
	);
});

test("runs from before two reviewers keep their single reviewer row", () => {
	const legacyReview: TimelineEntry[] = [
		state(761, { phase: "review", planPath: PLAN_PATH, baseCommit: "abc1234" }),
		stageRecord(830, finishedStage("review", "claude-opus-5-5", 1)),
		state(831, { phase: "idle" }),
	];
	const timeline = buildTimeline([...planningSession, implementing, ...legacyReview], START_MS + 900_000, false);
	assert.deepEqual(
		timeline?.stages.map((stage) => stage.role),
		["Planner", "Implementer", "Reviewer"],
	);
});

test("shows fix rounds from stage records and marks a finished run", () => {
	const reviewAndFix: TimelineEntry[] = [
		stageRecord(760, finishedStage("implement", "gpt-6-luna", 0.5)),
		state(761, { phase: "review", planPath: PLAN_PATH, baseCommit: "abc1234" }),
		stageRecord(830, finishedStage("review", "claude-opus-5-5", 1)),
		state(831, { phase: "fix", planPath: PLAN_PATH, baseCommit: "abc1234" }),
		stageRecord(850, finishedStage("fix", "gpt-6-luna", 0.1)),
		state(851, { phase: "re-review", planPath: PLAN_PATH, baseCommit: "abc1234" }),
		stageRecord(870, finishedStage("re-review", "claude-opus-5-5", 0.5)),
		state(871, { phase: "idle" }),
	];
	const timeline = buildTimeline([...planningSession, implementing, ...reviewAndFix], START_MS + 900_000, false);
	assert.ok(timeline);
	assert.equal(timeline.isFinished, true);
	assert.deepEqual(
		timeline.stages.map((stage) => [stage.role, stage.status, stage.model]),
		[
			["Planner", "done", "claude-opus-5-5"],
			["Implementer", "done", "gpt-6-luna"],
			["Reviewer", "done", "claude-opus-5-5"],
			["Fixer", "done", "gpt-6-luna"],
			["Re-reviewer", "done", "claude-opus-5-5"],
		],
	);
	assert.equal(timeline.costUsd, 4.1);
});

test("a stopped run marks the stages it never reached as skipped, and a new run replaces it", () => {
	const stopped = [...planningSession.slice(0, 4), state(70, { phase: "idle" })];
	const stoppedTimeline = buildTimeline(stopped, START_MS + 100_000, false);
	assert.deepEqual(
		stoppedTimeline?.stages.map((stage) => stage.status),
		["done", "skipped", "skipped", "skipped"],
	);
	const reachedShip = [...stopped.slice(0, -1), state(60, { phase: "awaiting-ship", planPath: PLAN_PATH }), state(70, { phase: "idle" })];
	assert.deepEqual(
		buildTimeline(reachedShip, START_MS + 100_000, false)?.stages.map((stage) => [stage.role, stage.status]),
		[
			["Planner", "done"],
			["Implementer", "skipped"],
			["Claude reviewer", "skipped"],
			["OpenAI reviewer", "skipped"],
			["Ship", "done"],
		],
	);
	const restarted = buildTimeline([...stopped, state(80, { phase: "plan", task: "Second try" })], START_MS + 100_000, true);
	assert.equal(restarted?.task, "Second try");
	assert.equal(restarted?.stages[0].status, "working");
});

test("an issue run names the investigator and waits on you for the pull request", () => {
	const issue = { number: 42, title: "Crash", url: "https://github.com/o/r/issues/42", branch: "issue-42-crash", baseBranch: "main" };
	const timeline = buildTimeline(
		[
			state(0, { phase: "plan", task: "Fix issue #42: Crash", issue }),
			state(10, { phase: "awaiting-pr", planPath: PLAN_PATH, baseCommit: "abc1234", issue }),
		],
		START_MS + 20_000,
		false,
	);
	assert.equal(timeline?.issue?.number, 42);
	assert.deepEqual(
		timeline?.stages.map((stage) => [stage.role, stage.status]),
		[
			["Investigator", "done"],
			["Implementer", "waiting"],
			["Claude reviewer", "waiting"],
			["OpenAI reviewer", "waiting"],
			["Pull request", "your-turn"],
		],
	);
});

test("a passing build review waits on you to ship, and names the plan issue", () => {
	const planIssue = { number: 9, title: "Add CSV export", url: "https://github.com/o/r/issues/9" };
	const timeline = buildTimeline(
		[...planningSession, state(900, { phase: "awaiting-ship", planPath: PLAN_PATH, baseCommit: "abc1234", planIssue })],
		START_MS + 950_000,
		false,
	);
	assert.deepEqual(timeline?.planIssue, { number: 9, url: planIssue.url });
	assert.equal(timeline?.stages.at(-1)?.role, "Ship");
	assert.equal(timeline?.stages.at(-1)?.status, "your-turn");
});
