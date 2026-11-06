import assert from "node:assert/strict";
import { test } from "node:test";
import { loadFileDiff, MAX_DIFF_LINES, parseUnifiedDiff } from "./file-diff.ts";
import type { CommandResult } from "./github-issue.ts";

const TRACKED_DIFF = [
	"diff --git a/src/calc.ts b/src/calc.ts",
	"index 1111111..2222222 100644",
	"--- a/src/calc.ts",
	"+++ b/src/calc.ts",
	"@@ -10,3 +10,4 @@ export function add(a, b) {",
	" \treturn a + b;",
	"-}",
	"+}",
	"+export const subtract = (a, b) => a - b;",
	"\\ No newline at end of file",
	"",
].join("\n");

test("numbers old and new lines from the hunk header and drops the file headers", () => {
	assert.deepEqual(parseUnifiedDiff(TRACKED_DIFF), [
		{ kind: "hunk", text: "@@ -10,3 +10,4 @@ export function add(a, b) {" },
		{ kind: "context", oldNumber: 10, newNumber: 10, text: "    return a + b;" },
		{ kind: "removed", oldNumber: 11, text: "}" },
		{ kind: "added", newNumber: 11, text: "}" },
		{ kind: "added", newNumber: 12, text: "export const subtract = (a, b) => a - b;" },
		{ kind: "note", text: "No newline at end of file" },
	]);
});

test("keeps the binary-file note, since a binary diff has no hunks", () => {
	assert.deepEqual(parseUnifiedDiff("diff --git a/logo.png b/logo.png\nBinary files a/logo.png and b/logo.png differ\n"), [
		{ kind: "note", text: "Binary files a/logo.png and b/logo.png differ" },
	]);
});

test("cuts a huge diff and says so", () => {
	const hugeDiff = ["@@ -0,0 +1,9000 @@", ...Array.from({ length: 9000 }, (_, index) => `+line ${index}`)].join("\n");
	const lines = parseUnifiedDiff(hugeDiff);
	assert.equal(lines.length, MAX_DIFF_LINES + 1);
	assert.deepEqual(lines.at(-1), { kind: "note", text: `diff cut at ${MAX_DIFF_LINES} lines` });
});

function fakeGit(diffResult: CommandResult): { run: (command: string, args: string[]) => Promise<CommandResult>; calls: string[][] } {
	const calls: string[][] = [];
	const run = async (_command: string, args: string[]): Promise<CommandResult> => {
		calls.push(args);
		if (args[0] === "rev-parse") return { code: 0, stdout: "/repo\n", stderr: "" };
		return diffResult;
	};
	return { run, calls };
}

test("diffs a tracked file against the base commit", async () => {
	const git = fakeGit({ code: 0, stdout: TRACKED_DIFF, stderr: "" });
	const file = { path: "src/calc.ts", added: 2, removed: 1, isBinary: false, isNew: false };
	const result = await loadFileDiff(git.run, "abc1234", file);
	assert.ok(result.ok);
	assert.deepEqual(git.calls[1], ["-C", "/repo", "diff", "--no-color", "--no-ext-diff", "abc1234", "--", "src/calc.ts"]);
});

test("diffs a new untracked file against /dev/null, where exit code 1 means it differs", async () => {
	const git = fakeGit({ code: 1, stdout: "@@ -0,0 +1 @@\n+hello\n", stderr: "" });
	const file = { path: "notes.md", added: 1, removed: 0, isBinary: false, isNew: true };
	const result = await loadFileDiff(git.run, "abc1234", file);
	assert.deepEqual(result, { ok: true, value: { path: "notes.md", lines: [{ kind: "hunk", text: "@@ -0,0 +1 @@" }, { kind: "added", newNumber: 1, text: "hello" }] } });
	assert.ok(git.calls[1].includes("--no-index"));
});

test("reports a failed git diff with the file and git's message", async () => {
	const git = fakeGit({ code: 128, stdout: "", stderr: "fatal: bad revision 'abc1234'" });
	const file = { path: "src/calc.ts", added: 2, removed: 1, isBinary: false, isNew: false };
	assert.deepEqual(await loadFileDiff(git.run, "abc1234", file), {
		ok: false,
		error: "git diff of src/calc.ts failed: fatal: bad revision 'abc1234'",
	});
});
