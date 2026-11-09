import assert from "node:assert/strict";
import { test } from "node:test";
import { fidelityProblems, planRewrite } from "./prompt-judge.ts";

test("a message Jev is sure is clear goes as typed", () => {
	assert.deepEqual(planRewrite({ clarity: "clear", confidence: 0.8, ambiguousProbability: 0.05 }), { kind: "send-as-typed" });
});

test("a message Jev only half trusts as clear is still rewritten, without questions", () => {
	assert.deepEqual(planRewrite({ clarity: "clear", confidence: 0.5, ambiguousProbability: 0.1 }), { kind: "rewrite", mayAskQuestions: false });
});

test("questions are allowed only when ambiguity is likely enough", () => {
	assert.deepEqual(planRewrite({ clarity: "messy", confidence: 0.6, ambiguousProbability: 0.35 }), { kind: "rewrite", mayAskQuestions: true });
	assert.deepEqual(planRewrite({ clarity: "messy", confidence: 0.7, ambiguousProbability: 0.2 }), { kind: "rewrite", mayAskQuestions: false });
});

test("without Jev the rewriter decides whether to ask", () => {
	assert.deepEqual(planRewrite(undefined), { kind: "rewrite", mayAskQuestions: true });
});

test("each failed fidelity check names its problem; unanswered checks pass", () => {
	assert.deepEqual(fidelityProblems({ keepsEverything: 0.9, addsNothing: 0.2 }), ["may have added something you did not ask for"]);
	assert.deepEqual(fidelityProblems({ keepsEverything: 0.4, addsNothing: 0.9, keepsStance: 0.1 }), [
		"may have dropped a request or detail",
		"may have turned a maybe or a question into an order",
	]);
	assert.deepEqual(fidelityProblems({}), []);
});
