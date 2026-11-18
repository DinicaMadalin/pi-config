import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { listFilesChangedSince, runBuildChecks } from "./build-checks.ts";

type Exec = Parameters<typeof runBuildChecks>[0];

function fakeExec(answer: (command: string, args: string[]) => { code: number; stdout: string; stderr?: string }): { pi: Exec; calls: string[][] } {
	const calls: string[][] = [];
	const pi = {
		exec: async (command: string, args: string[]) => {
			calls.push([command, ...args]);
			const { code, stdout, stderr = "" } = answer(command, args);
			return { code, stdout, stderr, killed: false };
		},
	} as unknown as Exec;
	return { pi, calls };
}

function projectWithChecks(): string {
	const dir = mkdtempSync(join(tmpdir(), "build-checks-"));
	writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { lint: "eslint .", test: "vitest" } }));
	return dir;
}

test("an untrusted project runs nothing", async () => {
	const { pi, calls } = fakeExec(() => ({ code: 0, stdout: "" }));
	assert.deepEqual(await runBuildChecks(pi, projectWithChecks(), false, new AbortController().signal, () => {}), { kind: "untrusted" });
	assert.equal(calls.length, 0);
});

test("a project without checks says so", async () => {
	const { pi } = fakeExec(() => ({ code: 0, stdout: "" }));
	const emptyDir = mkdtempSync(join(tmpdir(), "build-checks-empty-"));
	assert.deepEqual(await runBuildChecks(pi, emptyDir, true, new AbortController().signal, () => {}), { kind: "no-checks" });
});

test("every check runs, failing ones keep their output, and each start is announced", async () => {
	const { pi } = fakeExec((_command, args) => (args[1].includes("lint") ? { code: 1, stdout: "src/a.ts: bad" } : { code: 0, stdout: "ok" }));
	const notices: string[] = [];
	const run = await runBuildChecks(pi, projectWithChecks(), true, new AbortController().signal, (message) => notices.push(message));
	assert.equal(run.kind, "ran");
	if (run.kind !== "ran") return;
	assert.deepEqual(run.results.map((result) => [result.name, result.passed]), [["lint", false], ["test", true]]);
	assert.match(run.results[0].outputTail, /src\/a\.ts: bad/);
	assert.deepEqual(notices, ["Checking: lint", "Checking: test"]);
});

test("changed files are the tracked diff plus new untracked files, once each", async () => {
	const { pi, calls } = fakeExec((_command, args) => (args[0] === "diff" ? { code: 0, stdout: "a.ts\nb.ts\n" } : { code: 0, stdout: "b.ts\nnew.ts\n" }));
	assert.deepEqual(await listFilesChangedSince(pi, "/repo", "abc123", new AbortController().signal), ["a.ts", "b.ts", "new.ts"]);
	assert.deepEqual(calls[0], ["git", "diff", "--name-only", "abc123", "--"]);
	assert.deepEqual(calls[1], ["git", "ls-files", "--others", "--exclude-standard", "--full-name"]);
});

test("a failing git command names what failed", async () => {
	const { pi } = fakeExec(() => ({ code: 128, stdout: "", stderr: "bad revision" }));
	await assert.rejects(listFilesChangedSince(pi, "/repo", undefined, new AbortController().signal), /Failed to list the run's changed files: git diff bad revision/);
});
