import assert from "node:assert/strict";
import { test } from "node:test";
import { buildTimeline, type TimelineEntry } from "./build-timeline.ts";
import type { WorkflowState } from "./workflow-state.ts";

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

const PLAN_PATH = "/repo/.scratch/handoffs/plan.md";
const planningSession: TimelineEntry[] = [
	state(0, { phase: "plan", task: "Add device resolutions" }),
	userMessage(1),
	routeReason(2, "workflow phase pinned to the expert tier"),
	answer(61, "claude-opus-5-5", 1.5),
	state(62, { phase: "awaiting-implementation", task: "Add device resolutions", planPath: PLAN_PATH }),
	userMessage(600),
	answer(660, "claude-opus-5-5", 0.5),
];
const implementSession: TimelineEntry[] = [
	state(700, { phase: "implement", planPath: PLAN_PATH, baseCommit: "abc1234" }),
	userMessage(701),
	routeReason(702, "rated complex (80%): multi-file or tricky change"),
	answer(731, "gpt-6-luna", 0.25, "medium"),
	answer(761, "gpt-6-luna", 0.25, "medium"),
];

test("returns nothing when no build ever started", () => {
	assert.equal(buildTimeline([userMessage(0), answer(5, "m", 1)], START_MS, false), undefined);
});

test("joins the planning and implementation sessions into one row per role", () => {
	const timeline = buildTimeline([...planningSession, ...implementSession], START_MS + 800_000, false);
	assert.ok(timeline);
	assert.equal(timeline.task, "Add device resolutions");
	assert.equal(timeline.planPath, PLAN_PATH);
	assert.equal(timeline.baseCommit, "abc1234");
	assert.deepEqual(
		timeline.stages.map((stage) => [stage.role, stage.status, stage.model, stage.thinkingLevel]),
		[
			["Planner", "done", "claude-opus-5-5", "high"],
			["Implementer", "paused", "gpt-6-luna", "medium"],
			["Reviewer", "waiting", undefined, undefined],
		],
	);
	assert.equal(timeline.stages[1].routeReason, "rated complex (80%): multi-file or tricky change");
	assert.equal(timeline.costUsd, 2.5);
});

test("counts only the time the agent worked, not the time it waited for you", () => {
	const timeline = buildTimeline(planningSession, START_MS + 700_000, false);
	assert.ok(timeline);
	// 1s -> 61s, then 600s -> 660s; the 9 minutes before the second reply are yours.
	assert.equal(timeline.stages[0].activeMs, 120_000);
	assert.equal(timeline.stages[0].status, "your-turn");
});

test("adds the running turn up to now while the agent works", () => {
	const timeline = buildTimeline(implementSession.slice(0, 3), START_MS + 711_000, true);
	assert.ok(timeline);
	const implementer = timeline.stages[1];
	assert.equal(implementer.status, "working");
	assert.equal(implementer.activeMs, 10_000);
	assert.equal(timeline.stages[0].status, "waiting");
});

test("shows fix rounds and marks a finished run", () => {
	const reviewAndFix: TimelineEntry[] = [
		state(800, { phase: "review", planPath: PLAN_PATH, baseCommit: "abc1234" }),
		userMessage(801),
		answer(830, "claude-opus-5-5", 1),
		state(831, { phase: "fix", planPath: PLAN_PATH, baseCommit: "abc1234" }),
		userMessage(832),
		answer(850, "gpt-6-luna", 0.1),
		state(851, { phase: "re-review", planPath: PLAN_PATH, baseCommit: "abc1234" }),
		userMessage(852),
		answer(870, "claude-opus-5-5", 0.5),
		state(871, { phase: "idle" }),
	];
	const timeline = buildTimeline([...planningSession, ...implementSession, ...reviewAndFix], START_MS + 900_000, false);
	assert.ok(timeline);
	assert.equal(timeline.isFinished, true);
	assert.deepEqual(
		timeline.stages.map((stage) => [stage.role, stage.status]),
		[
			["Planner", "done"],
			["Implementer", "done"],
			["Reviewer", "done"],
			["Fixer", "done"],
			["Re-reviewer", "done"],
		],
	);
});

test("a stopped run marks the stages it never reached as skipped, and a new run replaces it", () => {
	const stopped = [...planningSession.slice(0, 4), state(70, { phase: "idle" })];
	const stoppedTimeline = buildTimeline(stopped, START_MS + 100_000, false);
	assert.deepEqual(
		stoppedTimeline?.stages.map((stage) => stage.status),
		["done", "skipped", "skipped"],
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
			["Reviewer", "waiting"],
			["Pull request", "your-turn"],
		],
	);
});
