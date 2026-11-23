import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { CheckResult } from "../quality-gate/check-baseline.ts";
import { finalizeBuildContracts } from "./contract-verification.ts";

type Exec = Parameters<typeof finalizeBuildContracts>[0];

/** Pi's exec, run for real: the gate needs git and the project's check commands. */
const realExec = {
	exec: async (command: string, args: string[], options: { cwd?: string } = {}) => {
		const result = spawnSync(command, args, { cwd: options.cwd, encoding: "utf8" });
		return { code: result.status ?? 1, stdout: result.stdout, stderr: result.stderr, killed: false };
	},
} as unknown as Exec;

function git(repo: string, ...args: string[]): void {
	const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
	assert.equal(result.status, 0, result.stderr);
}

/** A repo whose lint already fails on old.ts, and also on src/a.ts once that file says BAD. */
function repoWithFailingLint(): { repo: string; baseCommit: string } {
	const repo = mkdtempSync(join(tmpdir(), "contract-verification-"));
	git(repo, "init", "-q");
	git(repo, "config", "user.email", "test@example.com");
	git(repo, "config", "user.name", "Test");
	mkdirSync(join(repo, ".pi"));
	mkdirSync(join(repo, "src"));
	const lint = "grep -q BAD src/a.ts && echo 'src/a.ts: e2'; echo 'old.ts'': e1'; exit 1";
	writeFileSync(join(repo, ".pi", "checks.json"), JSON.stringify({ checks: [{ name: "lint", command: lint }] }));
	writeFileSync(join(repo, "src", "a.ts"), "export const a = 1;\n");
	git(repo, "add", ".");
	git(repo, "commit", "-q", "-m", "base");
	const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).stdout.trim();
	return { repo, baseCommit: head };
}

const lintBaseline: CheckResult[] = [{ name: "lint", command: "x", passed: false, outputTail: "old.ts: e1" }];

test("a check that failed the same way when the run began does not block shipping", async () => {
	const { repo, baseCommit } = repoWithFailingLint();
	writeFileSync(join(repo, "src", "a.ts"), "export const a = 2;\n");
	assert.equal(await finalizeBuildContracts(realExec, repo, baseCommit, lintBaseline, new AbortController().signal, () => {}), undefined);
});

test("a failure the run added blocks shipping and names only the new lines", async () => {
	const { repo, baseCommit } = repoWithFailingLint();
	writeFileSync(join(repo, "src", "a.ts"), "export const a = 'BAD';\n");
	const failure = await finalizeBuildContracts(realExec, repo, baseCommit, lintBaseline, new AbortController().signal, () => {});
	assert.ok(failure?.startsWith("New check failures since the run began:"), failure);
	assert.ok(failure?.includes("src/a.ts: e2"));
	assert.ok(!failure?.includes("old.ts: e1"));
});

test("without configured checks the contracts are removed and the run finishes with a notice", async () => {
	const repo = mkdtempSync(join(tmpdir(), "contract-verification-"));
	git(repo, "init", "-q");
	git(repo, "config", "user.email", "test@example.com");
	git(repo, "config", "user.name", "Test");
	mkdirSync(join(repo, "src"));
	writeFileSync(join(repo, "src", "a.ts"), "export const a = 1;\n");
	git(repo, "add", ".");
	git(repo, "commit", "-q", "-m", "base");
	const baseCommit = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).stdout.trim();
	const contracted = ["// @handoff-contract" + " begin", "// a is 2.", "// @handoff-contract" + " end", "export const a = 2;", ""].join("\n");
	writeFileSync(join(repo, "src", "a.ts"), contracted);
	const notices: string[] = [];
	const failure = await finalizeBuildContracts(realExec, repo, baseCommit, undefined, new AbortController().signal, (notice) => notices.push(notice));
	assert.equal(failure, undefined);
	assert.equal(readFileSync(join(repo, "src", "a.ts"), "utf8"), "export const a = 2;\n");
	assert.equal(notices.length, 1, notices.join("\n"));
	assert.match(notices[0], /Removed temporary contracts from 1 files; no project checks are configured/);
	assert.match(notices[0], /post-cleanup checks were skipped/);
});

test("without a baseline every failing check blocks shipping", async () => {
	const { repo, baseCommit } = repoWithFailingLint();
	writeFileSync(join(repo, "src", "a.ts"), "export const a = 2;\n");
	const failure = await finalizeBuildContracts(realExec, repo, baseCommit, undefined, new AbortController().signal, () => {});
	assert.ok(failure?.includes("old.ts: e1"), failure);
});
