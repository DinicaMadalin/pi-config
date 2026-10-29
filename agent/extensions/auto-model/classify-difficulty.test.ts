import assert from "node:assert/strict";
import { test } from "node:test";
import type { Message } from "@earendil-works/pi-ai";
import { findPreviousExchange } from "./classify-difficulty.ts";

const user = (text: string) => ({ role: "user", content: text, timestamp: 0 }) as Message;
const assistant = (content: unknown[]) => ({ role: "assistant", content, timestamp: 0 }) as unknown as Message;

test("has no previous exchange on the first prompt", () => {
	assert.equal(findPreviousExchange([user("fix the bug")], "standard"), undefined);
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
