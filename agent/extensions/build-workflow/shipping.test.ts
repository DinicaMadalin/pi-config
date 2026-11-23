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

test("the shipped commit uses the plan's public title, without local paths", async () => {
	const gitCalls: string[][] = [];
	const run = async (command: string, args: string[]) => {
		gitCalls.push([command, ...args]);
		if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return { code: 0, stdout: "/home/ann/shop\n", stderr: "" };
		if (args[0] === "rev-parse") return { code: 1, stdout: "", stderr: "" };
		if (args[0] === "status") return { code: 0, stdout: " M src/a.ts\0", stderr: "" };
		return { code: 0, stdout: "", stderr: "" };
	};
	const awaitingShip = { phase: "awaiting-ship", task: "t", planPath: "/p.md", baseCommit: "abc" } as unknown as WorkflowState;
	const session = {
		workflow: awaitingShip,
		hasUI: true,
		run,
		runInSessionDir: run,
		readPlan: () => "# Fix /home/ann/shop/src/a.ts\n\n## Goal\nBroken.",
		context: { ui: { confirm: async () => true } },
		notify: () => {},
		enterPhase: () => {},
	} as unknown as PlannerSession;
	await new Shipping(session, () => {}).confirmAndShip();
	const commit = gitCalls.find((call) => call[1] === "commit");
	assert.deepEqual(commit, ["git", "commit", "-m", "Fix src/a.ts"]);
});
