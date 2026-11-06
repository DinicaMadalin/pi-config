import assert from "node:assert/strict";
import { test } from "node:test";
import {
	canEditFiles,
	canPlannerEditFiles,
	type FeatureWork,
	findCrew,
	findLastRunPlan,
	findPlannerWorkflowState,
	findWorkflowState,
	mergeReviews,
	planChangeReaction,
	plannerRouteForPhase,
	readPlannerAnswer,
	reviewerRoute,
	routeForPhase,
	stepAfterTurn,
	WORKFLOW_STATE_ENTRY_TYPE,
	withPlanRevision,
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

test("a stored state with a bad shape reads as idle instead of breaking the run", () => {
	const broken = [{ type: "custom", customType: WORKFLOW_STATE_ENTRY_TYPE, data: { phase: "implement" } }];
	assert.deepEqual(findWorkflowState(broken), { phase: "idle" });
	assert.deepEqual(findWorkflowState([{ type: "custom", customType: WORKFLOW_STATE_ENTRY_TYPE, data: { phase: "dancing" } }]), { phase: "idle" });
});

test("the last agreed plan of the session is found after the run went idle", () => {
	const entries = [
		{ type: "custom", customType: WORKFLOW_STATE_ENTRY_TYPE, data: { phase: "awaiting-implementation", task: "x", planPath: "/p.md" } },
		{ type: "custom", customType: WORKFLOW_STATE_ENTRY_TYPE, data: { phase: "idle" } },
	];
	assert.deepEqual(findLastRunPlan(entries), { task: "x", planPath: "/p.md" });
	assert.equal(findLastRunPlan([]), undefined);
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
	const implementers = [{ role: "implementer" as const, stream: "", sessionPath: "/s/impl.jsonl" }];
	const sessions = { implementers, reviewerSessions: { anthropic: "/s/claude-review.jsonl", openai: "/s/openai-review.jsonl" } };
	const step = stepAfterTurn({ phase: "review", ...work, ...sessions }, "REVIEW_VERDICT: fix");
	assert.deepEqual(step, { kind: "advance", next: { phase: "fix", ...work, ...sessions } });
});

test("the planner stays on the expert and never edits while the subagents work", () => {
	assert.deepEqual(plannerRouteForPhase("implement"), { route: "tier", tier: "expert" });
	assert.deepEqual(plannerRouteForPhase("idle"), { route: "normal" });
	assert.equal(canPlannerEditFiles("implement"), false);
	assert.equal(canPlannerEditFiles("fix"), false);
	assert.equal(canPlannerEditFiles("idle"), true);
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
	const stillFailing = stepAfterTurn({ phase: "re-review", ...work }, "a.ts:3 still wrong\nREVIEW_VERDICT: fix");
	assert.deepEqual(stillFailing, {
		kind: "advance",
		next: { phase: "review-failed", ...work, findings: "a.ts:3 still wrong\nREVIEW_VERDICT: fix" },
	});
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

test("issue work whose re-review still fails waits for your decision instead of opening a PR", () => {
	const step = stepAfterTurn({ phase: "re-review", ...work, issue }, "REVIEW_VERDICT: fix");
	assert.equal(step.kind === "advance" && step.next.phase, "review-failed");
});

test("reviewed work waiting for you is not edited behind the reviewers' back: changes go through a plan change", () => {
	for (const phase of ["review-failed", "awaiting-pr", "awaiting-ship"] as const) {
		assert.equal(canEditFiles(phase), false, phase);
		assert.equal(canPlannerEditFiles(phase), false, phase);
		assert.equal(planChangeReaction(phase), "change-round", phase);
	}
	assert.deepEqual(routeForPhase("awaiting-pr"), { route: "normal" });
});

test("a plan saved again reacts to the phase the run is in", () => {
	assert.equal(planChangeReaction("plan"), "ask-to-start");
	assert.equal(planChangeReaction("awaiting-implementation"), "ask-to-start");
	assert.equal(planChangeReaction("implement"), "tell-implementer");
	assert.equal(planChangeReaction("fix"), "tell-implementer");
	assert.equal(planChangeReaction("review"), "ask-about-review");
	assert.equal(planChangeReaction("re-review"), "ask-about-review");
	assert.equal(planChangeReaction("idle"), "offer-new-run");
});

test("a plan change held for after the review sends the work back to the implementer, whatever the verdict", () => {
	const step = stepAfterTurn({ phase: "review", ...work, planChangeAfterReview: true }, "REVIEW_VERDICT: pass");
	assert.deepEqual(step, { kind: "advance", next: { phase: "implement", ...work } });
});

test("each plan change counts a new revision", () => {
	assert.equal(withPlanRevision<FeatureWork>(work).planRevision, 2);
	assert.equal(withPlanRevision<FeatureWork>({ ...work, planRevision: 2 }).planRevision, 3);
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

const stateEntry = (data: unknown) => ({ type: "custom", customType: WORKFLOW_STATE_ENTRY_TYPE, data });
const userEntry = { type: "message" };

test("a resumed subagent session is not a stuck /build run, so the planner rules do not apply in it", () => {
	const implementerSession = [stateEntry({ phase: "implement", ...work }), userEntry, userEntry];
	assert.deepEqual(findPlannerWorkflowState(implementerSession), { phase: "idle" });
	const reviewerSession = [stateEntry({ phase: "review", ...work })];
	assert.deepEqual(findPlannerWorkflowState(reviewerSession), { phase: "idle" });
});

test("a /build started later in a resumed subagent session is followed like any run", () => {
	const entries = [stateEntry({ phase: "implement", ...work }), userEntry, stateEntry({ phase: "plan", task: "next" })];
	assert.deepEqual(findPlannerWorkflowState(entries), { phase: "plan", task: "next" });
});

test("the planner's own session keeps its run, including an interrupted one", () => {
	const entries = [stateEntry({ phase: "plan", task: "x" }), userEntry, stateEntry({ phase: "implement", ...work })];
	assert.equal(findPlannerWorkflowState(entries).phase, "implement");
});

test("the session's crew is the implementers of its latest run, also from states written before parallel implementers", () => {
	const legacy = stateEntry({ phase: "implement", ...work, implementerSession: "/s/old.jsonl" });
	assert.deepEqual(findCrew([legacy]), [{ role: "implementer", stream: "", sessionPath: "/s/old.jsonl" }]);
	assert.deepEqual(findWorkflowState([legacy]), { phase: "implement", ...work, implementers: [{ role: "implementer", stream: "", sessionPath: "/s/old.jsonl" }] });
	const two = [
		{ role: "implementer", stream: "API", sessionPath: "/s/1.jsonl" },
		{ role: "implementer-2", stream: "Tests", sessionPath: "/s/2.jsonl" },
	];
	const entries = [legacy, stateEntry({ phase: "fix", ...work, implementers: two }), stateEntry({ phase: "idle" })];
	assert.deepEqual(findCrew(entries), two);
	assert.deepEqual(findCrew([stateEntry({ phase: "plan", task: "x" })]), []);
});
