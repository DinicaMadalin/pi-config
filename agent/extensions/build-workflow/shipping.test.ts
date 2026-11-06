import assert from "node:assert/strict";
import { test } from "node:test";
import type { PlannerSession } from "./planner-session.ts";
import { Shipping } from "./shipping.ts";
import type { WorkflowState } from "./workflow-state.ts";

function sessionIn(workflow: WorkflowState): PlannerSession {
	return { workflow, hasUI: true } as unknown as PlannerSession;
}

test("asking to ship while the reviewers still work says what the run waits for and ships nothing", async () => {
	const endedRuns: string[] = [];
	const reReviewing = { phase: "re-review", task: "t", planPath: "/p.md", baseCommit: "abc" } as unknown as WorkflowState;
	const outcome = await new Shipping(sessionIn(reReviewing), (summary) => endedRuns.push(summary)).confirmAndShip();
	assert.match(outcome, /re-review phase/);
	assert.deepEqual(endedRuns, []);
});

test("asking to ship with no run says so", async () => {
	const outcome = await new Shipping(sessionIn({ phase: "idle" } as WorkflowState), () => {}).confirmAndShip();
	assert.equal(outcome, "No /build run is waiting to ship");
});
