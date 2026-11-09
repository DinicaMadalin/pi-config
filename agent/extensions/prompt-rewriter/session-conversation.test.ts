import assert from "node:assert/strict";
import { test } from "node:test";
import { conversationOf } from "./session-conversation.ts";

test("keeps user and assistant text, drops tool calls, tool results, thinking and other entries", () => {
	const entries = [
		{ type: "model_change" },
		{ type: "message", message: { role: "user", content: "add an export" } },
		{
			type: "message",
			message: {
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "hmm" },
					{ type: "text", text: "Which format?" },
					{ type: "toolCall", name: "read" },
				],
			},
		},
		{ type: "message", message: { role: "toolResult", content: [{ type: "text", text: "file body" }] } },
		{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "bash" }] } },
	];
	assert.deepEqual(conversationOf(entries), [
		{ role: "user", text: "add an export" },
		{ role: "assistant", text: "Which format?" },
	]);
});
