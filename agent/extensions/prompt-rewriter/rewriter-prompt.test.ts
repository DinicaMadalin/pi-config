import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_CLARIFYING_QUESTIONS, parseRewriterReply, rewriteRequestText } from "./rewriter-prompt.ts";

test("reads a rewrite, ignoring text around the tags", () => {
	assert.deepEqual(parseRewriterReply("Sure.\n<rewrite>\nAdd a --json flag.\n</rewrite>"), { kind: "rewrite", prompt: "Add a --json flag." });
});

test("a rewrite cut off before its closing tag still counts", () => {
	assert.deepEqual(parseRewriterReply("<rewrite>Add a --json flag."), { kind: "rewrite", prompt: "Add a --json flag." });
});

test("reads at most three clarifying questions, without their bullets or numbers", () => {
	const reply = parseRewriterReply("<questions>\n- Which file?\n2. CSV or JSON?\n* Keep the old flag?\n- One too many?\n</questions>");
	assert.deepEqual(reply, { kind: "questions", questions: ["Which file?", "CSV or JSON?", "Keep the old flag?"] });
	assert.equal(MAX_CLARIFYING_QUESTIONS, 3);
});

test("a reply without either tag is unreadable", () => {
	assert.equal(parseRewriterReply("Here is your prompt: do the thing").kind, "unreadable");
	assert.equal(parseRewriterReply("<rewrite>  </rewrite>").kind, "unreadable");
});

test("the request keeps only the recent conversation and cuts long messages", () => {
	const conversation = Array.from({ length: 10 }, (_, index) => ({ role: "user" as const, text: `message ${index}` }));
	conversation.push({ role: "user", text: "x".repeat(3000) });
	const text = rewriteRequestText({ prompt: "fix it", recentConversation: conversation, workspaceName: "pi-config" });
	assert.ok(!text.includes("message 4"));
	assert.ok(text.includes("message 5"));
	assert.ok(text.includes(`${"x".repeat(1500)}…`) && !text.includes("x".repeat(1501)));
	assert.ok(text.endsWith("fix it"));
});

test("with answers, the request forbids more questions and marks empty answers as the rewriter's pick", () => {
	const text = rewriteRequestText({
		prompt: "export it",
		recentConversation: [],
		workspaceName: "app",
		answers: [{ question: "CSV or JSON?", answer: "JSON" }, { question: "Which command?", answer: "" }],
	});
	assert.match(text, /Q: CSV or JSON\?\nA: JSON/);
	assert.match(text, /A: \(no answer: pick the most likely reading/);
	assert.match(text, /do not ask more questions/);
});
