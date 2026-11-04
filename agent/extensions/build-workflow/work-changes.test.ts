import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { RunCommand } from "./github-issue.ts";
import { loadWorkChanges, parseNumstat } from "./work-changes.ts";

test("parses numstat lines, including binary files", () => {
	assert.deepEqual(parseNumstat("12\t3\tsrc/a.ts\n-\t-\tlogo.png\n"), [
		{ path: "src/a.ts", added: 12, removed: 3, isBinary: false, isNew: false },
		{ path: "logo.png", added: 0, removed: 0, isBinary: true, isNew: false },
	]);
});

test("adds untracked files as new, counted by lines, biggest change first", async () => {
	const repoRoot = mkdtempSync(join(tmpdir(), "work-changes-"));
	writeFileSync(join(repoRoot, "new.ts"), "one\ntwo\nthree\n");
	const run: RunCommand = async (_command, args) => {
		if (args[0] === "rev-parse") return { code: 0, stdout: `${repoRoot}\n`, stderr: "" };
		if (args.includes("diff")) return { code: 0, stdout: "1\t1\tsrc/a.ts\n", stderr: "" };
		return { code: 0, stdout: "new.ts\n", stderr: "" };
	};
	const changes = await loadWorkChanges(run, "abc1234");
	assert.deepEqual(changes, {
		ok: true,
		value: {
			files: [
				{ path: "new.ts", added: 3, removed: 0, isBinary: false, isNew: true },
				{ path: "src/a.ts", added: 1, removed: 1, isBinary: false, isNew: false },
			],
			added: 4,
			removed: 1,
		},
	});
});

test("reports a failing git diff with the base commit", async () => {
	const run: RunCommand = async (_command, args) => {
		if (args[0] === "rev-parse") return { code: 0, stdout: "/repo\n", stderr: "" };
		if (args.includes("diff")) return { code: 128, stdout: "", stderr: "bad object abc1234" };
		return { code: 0, stdout: "", stderr: "" };
	};
	assert.deepEqual(await loadWorkChanges(run, "abc1234ffff"), {
		ok: false,
		error: "git diff against abc1234 failed: bad object abc1234",
	});
});
