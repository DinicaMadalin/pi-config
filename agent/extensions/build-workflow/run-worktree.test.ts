import assert from "node:assert/strict";
import { test } from "node:test";
import { worktreePathFor } from "./run-worktree.ts";

test("a run's worktree goes in a hidden folder beside the repository, named after the run", () => {
	assert.equal(worktreePathFor("/home/me/shop", "issue-42", () => false), "/home/me/.shop-worktrees/issue-42");
});

test("a taken worktree folder gets the next free number", () => {
	const taken = new Set(["/home/me/.shop-worktrees/build-x", "/home/me/.shop-worktrees/build-x-2"]);
	assert.equal(worktreePathFor("/home/me/shop", "build-x", (path) => taken.has(path)), "/home/me/.shop-worktrees/build-x-3");
});

test("no worktree folder when every numbered name is taken", () => {
	assert.equal(worktreePathFor("/home/me/shop", "build-x", () => true), undefined);
});
