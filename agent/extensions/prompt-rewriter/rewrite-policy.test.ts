import assert from "node:assert/strict";
import { test } from "node:test";
import { decideRewrite } from "./rewrite-policy.ts";

test("a rambling task description is rewritten", () => {
	assert.equal(decideRewrite("so uh can we make the dashboard show the cost of each agent too please").kind, "rewrite");
});

test("short replies, commands and shell commands go as typed", () => {
	assert.equal(decideRewrite("yes, go with 2").kind, "skip");
	assert.equal(decideRewrite("/build add a flag to the export command so it can write json as well").kind, "skip");
	assert.equal(decideRewrite("!git status and then git log for the last ten commits please now").kind, "skip");
});

test("a prompt that is already structured goes as typed", () => {
	const structured = "## Goal\nAdd a JSON export to the report command\n## Constraints\nNo new dependencies at all please";
	assert.deepEqual(decideRewrite(structured), { kind: "skip", reason: "already structured" });
});
