import assert from "node:assert/strict";
import { test } from "node:test";
import type { CommandResult, RunCommand } from "./github-issue.ts";
import { findPlanRepoRoots } from "./repo-files.ts";

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
