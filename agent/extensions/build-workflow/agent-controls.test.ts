import assert from "node:assert/strict";
import { test } from "node:test";
import { controlsFor } from "./agent-controls.ts";
import type { BuildTimeline, StageRow } from "./build-timeline.ts";

function row(agent: StageRow["agent"], status: StageRow["status"]): StageRow {
	return { key: "implement", agent, role: "Implementer", status, activeMs: 0, costUsd: 0, upcomingHint: "" };
}

function timeline(phase: BuildTimeline["phase"], stages: StageRow[], isFinished = false): BuildTimeline {
	return { task: "x", phase, planRevision: 1, isFinished, steps: [], stages, activeMs: 0, costUsd: 0 };
}

const keysOf = (controls: ReturnType<typeof controlsFor>) => controls.map((control) => control.key);

test("a working subagent can be stopped or restarted, and only the restart asks twice", () => {
	const controls = controlsFor(timeline("implement", [row("implementer", "working")]), { kind: "build", agent: "implementer" });
	assert.deepEqual(keysOf(controls), ["s", "r"]);
	assert.equal(controls[0].confirmation, undefined);
	assert.ok(controls[1].confirmation?.includes("current turn is lost"));
});

test("a paused or crashed subagent restarts at once; there is no turn to stop", () => {
	const controls = controlsFor(timeline("implement", [row("implementer", "paused")]), { kind: "build", agent: "implementer" });
	assert.deepEqual(keysOf(controls), ["r"]);
	assert.equal(controls[0].confirmation, undefined);
});

test("the planner and finished agents have no agent controls", () => {
	assert.deepEqual(controlsFor(timeline("implement", [row("planner", "done")]), { kind: "build", agent: "planner" }), []);
	assert.deepEqual(controlsFor(timeline("review", [row("implementer", "done")]), { kind: "build", agent: "implementer" }), []);
});

test("a failed re-review offers fix again, review again and accept, where accept asks twice", () => {
	const controls = controlsFor(timeline("review-failed", []), { kind: "none" });
	assert.deepEqual(keysOf(controls), ["F", "R", "A"]);
	assert.ok(controls[2].confirmation);
});

test("passed work waiting to ship or for its PR can be reviewed again, after a second R so a stray key starts nothing", () => {
	const shipControls = controlsFor(timeline("awaiting-ship", []), { kind: "none" });
	assert.deepEqual(keysOf(shipControls), ["R"]);
	assert.ok(shipControls[0].confirmation);
	assert.deepEqual(keysOf(controlsFor(timeline("awaiting-pr", []), { kind: "none" })), ["R"]);
});

test("a finished run offers nothing; a running delegate can be cancelled after a second x", () => {
	assert.deepEqual(controlsFor(timeline("review-failed", [], true), { kind: "none" }), []);
	const delegate = controlsFor(undefined, { kind: "delegate", runId: "del_1", role: "reviewer", isRunning: true });
	assert.deepEqual(delegate.map((control) => [control.key, control.command]), [["x", { kind: "cancel-delegate", runId: "del_1" }]]);
	assert.deepEqual(controlsFor(undefined, { kind: "delegate", runId: "del_1", role: "reviewer", isRunning: false }), []);
});
