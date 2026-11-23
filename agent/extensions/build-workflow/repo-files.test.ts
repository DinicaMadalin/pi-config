import assert from "node:assert/strict";
import { test } from "node:test";
import type { CommandResult, RunCommand } from "./github-issue.ts";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findDiffBase, findPlanRepoRoots } from "./repo-files.ts";

const toplevel = (stdout: string, code = 0): RunCommand => async (): Promise<CommandResult> => ({ stdout, stderr: "", code });

test("a plan may name the planner's checkout and the run's worktree, each once", async () => {
	assert.deepEqual(await findPlanRepoRoots(toplevel("/home/ann/shop\n"), toplevel("/home/ann/.shop-worktrees/build-x\n")), [
		"/home/ann/shop",
		"/home/ann/.shop-worktrees/build-x",
	]);
	assert.deepEqual(await findPlanRepoRoots(toplevel("/home/ann/shop\n"), toplevel("/home/ann/shop\n")), ["/home/ann/shop"]);
});

test("outside a git repo no root is named", async () => {
	assert.deepEqual(await findPlanRepoRoots(toplevel("", 128), toplevel("", 128)), []);
});

function gitIn(repo: string): RunCommand {
	return async (command, args) => {
		const result = spawnSync(command, args, { cwd: repo, encoding: "utf8" });
		return { code: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
	};
}

test("the diff base is HEAD once the repo has a commit", async () => {
	const repo = mkdtempSync(join(tmpdir(), "diff-base-"));
	const run = gitIn(repo);
	await run("git", ["init", "-q"]);
	await run("git", ["-c", "user.email=t@example.com", "-c", "user.name=T", "commit", "-q", "--allow-empty", "-m", "base"]);
	const head = (await run("git", ["rev-parse", "HEAD"])).stdout.trim();
	assert.equal(await findDiffBase(run), head);
});

test("a repo with no commit yet diffs against the empty tree, which git can diff", async () => {
	const repo = mkdtempSync(join(tmpdir(), "diff-base-unborn-"));
	const run = gitIn(repo);
	await run("git", ["init", "-q"]);
	const base = await findDiffBase(run);
	assert.equal(base, (await run("git", ["hash-object", "-t", "tree", "/dev/null"])).stdout.trim());
	assert.equal((await run("git", ["diff", "--name-only", base ?? "", "--"])).code, 0);
});

test("outside a git repo there is no diff base", async () => {
	assert.equal(await findDiffBase(toplevel("", 128)), undefined);
});
