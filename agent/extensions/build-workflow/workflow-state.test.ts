import assert from "node:assert/strict";
import { test } from "node:test";
import { canEditFiles, WORKFLOW_STATE_ENTRY_TYPE, findWorkflowState, routeForPhase, stepAfterTurn } from "./workflow-state.ts";

const work = { planPath: "/repo/.scratch/handoffs/plan.md", baseCommit: "abc123" };

test("plans and reviews on the expert tier; implementing and fixing are routed by difficulty", () => {
	const expert = { route: "tier", tier: "expert" };
	assert.deepEqual(routeForPhase("plan"), expert);
	assert.deepEqual(routeForPhase("review"), expert);
	assert.deepEqual(routeForPhase("re-review"), expert);
	assert.deepEqual(routeForPhase("implement"), { route: "difficulty" });
	assert.deepEqual(routeForPhase("fix"), { route: "difficulty" });
	assert.deepEqual(routeForPhase("idle"), { route: "normal" });
});

test("only the implementer may edit files", () => {
	assert.equal(canEditFiles("plan"), false);
	assert.equal(canEditFiles("review"), false);
	assert.equal(canEditFiles("implement"), true);
	assert.equal(canEditFiles("fix"), true);
});

test("restores the latest workflow state from the session, idle when there is none", () => {
	assert.deepEqual(findWorkflowState([{ type: "message" }]), { phase: "idle" });
	const entries = [
		{ type: "custom", customType: WORKFLOW_STATE_ENTRY_TYPE, data: { phase: "plan", task: "x" } },
		{ type: "custom", customType: WORKFLOW_STATE_ENTRY_TYPE, data: { phase: "implement", ...work } },
	];
	assert.deepEqual(findWorkflowState(entries), { phase: "implement", ...work });
});

test("the plan phase never advances on its own: it waits for the user's agreement", () => {
	assert.equal(stepAfterTurn({ phase: "plan", task: "x" }, "IMPLEMENTATION: done").kind, "wait");
});

test("a finished implementation goes to review", () => {
	const step = stepAfterTurn({ phase: "implement", ...work }, "Changed 3 files.\n\nIMPLEMENTATION: done");
	assert.deepEqual(step, { kind: "advance", next: { phase: "review", ...work } });
});

test("an implementer with a question waits for the user", () => {
	assert.equal(stepAfterTurn({ phase: "implement", ...work }, "IMPLEMENTATION: blocked: which currency?").kind, "wait");
	assert.equal(stepAfterTurn({ phase: "implement", ...work }, "Half done, continuing").kind, "wait");
});

test("the last marker wins and markdown around it is ignored", () => {
	const answer = "I will end with `IMPLEMENTATION: done` later.\n**IMPLEMENTATION: blocked: need the API key name**";
	assert.equal(stepAfterTurn({ phase: "implement", ...work }, answer).kind, "wait");
	assert.equal(stepAfterTurn({ phase: "implement", ...work }, "Done.\n`IMPLEMENTATION: done`").kind, "advance");
});

test("a passing review finishes the workflow", () => {
	assert.equal(stepAfterTurn({ phase: "review", ...work }, "All good.\nREVIEW_VERDICT: pass").kind, "finish");
});

test("review findings get exactly one fix round and a re-review", () => {
	assert.deepEqual(stepAfterTurn({ phase: "review", ...work }, "REVIEW_VERDICT: fix"), {
		kind: "advance",
		next: { phase: "fix", ...work },
	});
	assert.deepEqual(stepAfterTurn({ phase: "fix", ...work }, "IMPLEMENTATION: done"), {
		kind: "advance",
		next: { phase: "re-review", ...work },
	});
	const stillFailing = stepAfterTurn({ phase: "re-review", ...work }, "REVIEW_VERDICT: fix");
	assert.equal(stillFailing.kind, "finish");
});

test("a review without a verdict waits instead of guessing", () => {
	assert.equal(stepAfterTurn({ phase: "review", ...work }, "Looks mostly fine").kind, "wait");
});

const issue = { number: 42, title: "Crash on empty cart", url: "https://github.com/o/r/issues/42", branch: "issue-42-crash-on-empty-cart", baseBranch: "main" };

test("a passing review of issue work waits for the user to open the PR", () => {
	assert.deepEqual(stepAfterTurn({ phase: "review", ...work, issue }, "REVIEW_VERDICT: pass"), {
		kind: "advance",
		next: { phase: "awaiting-pr", ...work, issue },
	});
	assert.equal(stepAfterTurn({ phase: "re-review", ...work, issue }, "REVIEW_VERDICT: pass").kind, "advance");
});

test("issue work keeps its issue through implement, review and fix", () => {
	const reviewStep = stepAfterTurn({ phase: "implement", ...work, issue }, "IMPLEMENTATION: done");
	assert.deepEqual(reviewStep, { kind: "advance", next: { phase: "review", ...work, issue } });
	const fixStep = stepAfterTurn({ phase: "review", ...work, issue }, "REVIEW_VERDICT: fix");
	assert.deepEqual(fixStep, { kind: "advance", next: { phase: "fix", ...work, issue } });
});

test("issue work whose re-review still fails does not open a PR", () => {
	assert.equal(stepAfterTurn({ phase: "re-review", ...work, issue }, "REVIEW_VERDICT: fix").kind, "finish");
});

test("awaiting the PR lets the user still ask for edits", () => {
	assert.equal(canEditFiles("awaiting-pr"), true);
	assert.deepEqual(routeForPhase("awaiting-pr"), { route: "normal" });
});
