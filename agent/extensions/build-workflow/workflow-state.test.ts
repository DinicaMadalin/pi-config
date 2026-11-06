import assert from "node:assert/strict";
import { test } from "node:test";
import {
	canEditFiles,
	canPlannerEditFiles,
	findWorkflowState,
	mergeReviews,
	plannerRouteForPhase,
	readPlannerAnswer,
	reviewerRoute,
	routeForPhase,
	stepAfterTurn,
	WORKFLOW_STATE_ENTRY_TYPE,
} from "./workflow-state.ts";

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

test("an implementer with a question, or one that stops without a marker, goes to the planner", () => {
	const question = "IMPLEMENTATION: blocked: which currency?";
	assert.deepEqual(stepAfterTurn({ phase: "implement", ...work }, question), { kind: "ask-planner", implementerAnswer: question });
	assert.equal(stepAfterTurn({ phase: "fix", ...work }, "Half done, continuing").kind, "ask-planner");
});

test("the planner's answer goes to the implementer without its marker; needs-user waits for you", () => {
	assert.deepEqual(readPlannerAnswer("Use EUR cents.\n\nIMPLEMENTER_ANSWER: ready"), { kind: "ready", answer: "Use EUR cents." });
	assert.deepEqual(readPlannerAnswer("Which currency do you bill in?\n**IMPLEMENTER_ANSWER: needs-user**"), { kind: "needs-user" });
	assert.deepEqual(readPlannerAnswer("Sure, here is the plan status."), { kind: "none" });
});

test("the subagents keep their session files when the run moves on", () => {
	const sessions = { implementerSession: "/s/impl.jsonl", reviewerSessions: { anthropic: "/s/claude-review.jsonl", openai: "/s/openai-review.jsonl" } };
	const step = stepAfterTurn({ phase: "review", ...work, ...sessions }, "REVIEW_VERDICT: fix");
	assert.deepEqual(step, { kind: "advance", next: { phase: "fix", ...work, ...sessions } });
});

test("the planner stays on the expert and never edits while the subagents work", () => {
	assert.deepEqual(plannerRouteForPhase("implement"), { route: "tier", tier: "expert" });
	assert.deepEqual(plannerRouteForPhase("idle"), { route: "normal" });
	assert.equal(canPlannerEditFiles("implement"), false);
	assert.equal(canPlannerEditFiles("fix"), false);
	assert.equal(canPlannerEditFiles("awaiting-pr"), true);
});

test("the last marker wins and markdown around it is ignored", () => {
	const answer = "I will end with `IMPLEMENTATION: done` later.\n**IMPLEMENTATION: blocked: need the API key name**";
	assert.equal(stepAfterTurn({ phase: "implement", ...work }, answer).kind, "ask-planner");
	assert.equal(stepAfterTurn({ phase: "implement", ...work }, "Done.\n`IMPLEMENTATION: done`").kind, "advance");
});

test("a passing review waits for the user to ship", () => {
	assert.deepEqual(stepAfterTurn({ phase: "review", ...work }, "All good.\nREVIEW_VERDICT: pass"), {
		kind: "advance",
		next: { phase: "awaiting-ship", ...work },
	});
	assert.deepEqual(routeForPhase("awaiting-ship"), { route: "normal" });
	assert.equal(stepAfterTurn({ phase: "awaiting-ship", ...work }, "anything").kind, "wait");
});

test("the plan issue is carried to the next phase", () => {
	const planIssue = { number: 7, title: "Add export", url: "https://github.com/o/r/issues/7" };
	const next = stepAfterTurn({ phase: "implement", ...work, planIssue }, "IMPLEMENTATION: done");
	assert.deepEqual(next, { kind: "advance", next: { phase: "review", ...work, planIssue } });
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

test("two passing reviews pass together, with both reports under the reviewers' names", () => {
	const merged = mergeReviews([
		{ vendor: "anthropic", answer: "No findings.\nREVIEW_VERDICT: pass" },
		{ vendor: "openai", answer: "Looks right.\n`REVIEW_VERDICT: pass`" },
	]);
	assert.ok(merged.includes("## Claude reviewer\n\nNo findings.") && merged.includes("## OpenAI reviewer\n\nLooks right."), merged);
	assert.equal(merged.trim().split("\n").at(-1), "REVIEW_VERDICT: pass");
	assert.equal(stepAfterTurn({ phase: "review", ...work }, merged).kind, "advance");
});

test("one reviewer asking for fixes sends the work to the fixer with both reviews", () => {
	const merged = mergeReviews([
		{ vendor: "anthropic", answer: "Fine.\nREVIEW_VERDICT: pass" },
		{ vendor: "openai", answer: "a.ts:3 off by one.\nREVIEW_VERDICT: fix" },
	]);
	assert.equal(merged.match(/REVIEW_VERDICT/g)?.length, 1);
	assert.deepEqual(stepAfterTurn({ phase: "review", ...work }, merged), { kind: "advance", next: { phase: "fix", ...work } });
});

test("a reviewer without a verdict holds the review even when the other passed", () => {
	const merged = mergeReviews([
		{ vendor: "anthropic", answer: "Fine.\nREVIEW_VERDICT: pass" },
		{ vendor: "openai", answer: "I ran out of time." },
	]);
	assert.equal(stepAfterTurn({ phase: "review", ...work }, merged).kind, "wait");
});

test("each reviewer routes to the expert tier with its own vendor's models first", () => {
	assert.deepEqual(reviewerRoute("openai"), { route: "tier", tier: "expert", preferredProvider: "openai" });
	assert.deepEqual(reviewerRoute("anthropic"), { route: "tier", tier: "expert", preferredProvider: "anthropic" });
});
