import assert from "node:assert/strict";
import { test } from "node:test";
import type { Message } from "@earendil-works/pi-ai";
import { findPreviousExchange, rateTaskDifficulty } from "./classify-difficulty.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const user = (text: string) => ({ role: "user", content: text, timestamp: 0 }) as Message;
const assistant = (content: unknown[]) => ({ role: "assistant", content, timestamp: 0 }) as unknown as Message;

test("has no previous exchange on the first prompt", () => {
	assert.equal(findPreviousExchange([user("fix the bug")], "standard"), undefined);
});

test("sends a bounded previous assistant plan and plan-implementation criteria to Jev", async () => {
	let classificationInput: unknown;
	const jev = { provider: "typesafe", id: "jev-latest" };
	const context = {
		modelRegistry: {
			findOfType: () => jev,
			classify: async (_model: unknown, input: unknown) => {
				classificationInput = input;
				return {
					stopReason: "stop",
					answers: {
						difficulty: { type: "choice", choice: "standard", confidence: 0.8 },
						thinkingDepth: { type: "choice", choice: "medium", confidence: 0.8 },
						taskKind: { type: "choice", choice: "plan_implementation", confidence: 0.9 },
					},
				};
			},
		},
	} as unknown as ExtensionContext;
	const plan = "Plan paragraph. ".repeat(300);
	const rating = await rateTaskDifficulty([assistant([{ type: "text", text: plan }]), user("implement it")], [], undefined, context, undefined);
	assert.equal(rating.kind, "rated");
	if (rating.kind !== "rated") return;
	assert.equal(rating.taskKind, "plan_implementation");
	const captured = classificationInput as { state: { previousAssistantPlan?: string }; questions: { taskKind: { instructions: string; criteria: Record<string, string> } } };
	assert.equal(captured.state.previousAssistantPlan?.length, 2000);
	assert.ok(captured.state.previousAssistantPlan?.endsWith("Plan paragraph. "));
	assert.match(captured.questions.taskKind.instructions, /implementing a previously discussed nontrivial plan/);
	assert.match(captured.questions.taskKind.criteria.plan_implementation, /short approvals/);
	assert.match(captured.questions.taskKind.criteria.other, /Do not choose this for implementing/);
});

test("summarizes the previous task: its prompt, tool calls, and the agent's last answer", () => {
	const messages = [
		user("old task"),
		user("rename the label"),
		assistant([{ type: "text", text: "Looking." }, { type: "toolCall", id: "1", name: "read", arguments: {} }]),
		assistant([{ type: "toolCall", id: "2", name: "edit", arguments: {} }]),
		assistant([{ type: "text", text: "Renamed it in one file." }]),
		user("you missed the other files"),
	];
	assert.deepEqual(findPreviousExchange(messages, "trivial"), {
		prompt: "rename the label",
		routedTier: "trivial",
		answerTail: "Renamed it in one file.",
		toolCallCount: 2,
	});
});
