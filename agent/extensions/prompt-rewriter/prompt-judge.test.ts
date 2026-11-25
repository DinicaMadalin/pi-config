import assert from "node:assert/strict";
import { test } from "node:test";
import { fidelityProblems, planRewrite, type PromptClarity } from "./prompt-judge.ts";

test("a message Jev is sure is clear is rewritten without questions", () => {
	for (const confidence of [0.6, 0.8, 1]) {
		assert.deepEqual(planRewrite({ clarity: "clear", confidence, ambiguousProbability: 0.05 }), { kind: "rewrite", mayAskQuestions: false });
	}
});

test("a message Jev only half trusts as clear is still rewritten, without questions", () => {
	assert.deepEqual(planRewrite({ clarity: "clear", confidence: 0.5, ambiguousProbability: 0.1 }), { kind: "rewrite", mayAskQuestions: false });
});

test("questions are allowed only when ambiguity is likely enough", () => {
	assert.deepEqual(planRewrite({ clarity: "messy", confidence: 0.6, ambiguousProbability: 0.35 }), { kind: "rewrite", mayAskQuestions: true });
	assert.deepEqual(planRewrite({ clarity: "messy", confidence: 0.7, ambiguousProbability: 0.2 }), { kind: "rewrite", mayAskQuestions: false });
});

test("every clarity label rewrites and uses the same ambiguity boundary for questions", () => {
	const clarities: readonly PromptClarity[] = ["clear", "messy", "ambiguous"];
	for (const clarity of clarities) {
		for (const ambiguousProbability of [0, 0.349, 0.35, 1]) {
			assert.deepEqual(planRewrite({ clarity, confidence: 0.6, ambiguousProbability }), {
				kind: "rewrite",
				mayAskQuestions: ambiguousProbability >= 0.35,
			}, `${clarity} with ambiguity probability ${ambiguousProbability}`);
		}
	}
});

test("without Jev the rewriter decides whether to ask", () => {
	assert.deepEqual(planRewrite(undefined), { kind: "rewrite", mayAskQuestions: true });
});

test("each failed fidelity check names its problem; unanswered checks pass", () => {
	assert.deepEqual(fidelityProblems({ keepsEverything: 0.9, addsNothing: 0.2 }), ["may have added something you did not ask for"]);
	assert.deepEqual(fidelityProblems({ isReadyToSend: 0.2 }), ["may explain or summarize the request instead of rewriting it as a message to the agent"]);
	assert.deepEqual(fidelityProblems({ keepsEverything: 0.4, addsNothing: 0.9, keepsStance: 0.1 }), [
		"may have dropped a request or detail",
		"may have turned a maybe or a question into an order",
	]);
	assert.deepEqual(fidelityProblems({}), []);
});
