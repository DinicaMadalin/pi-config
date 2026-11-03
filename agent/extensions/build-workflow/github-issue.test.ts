import assert from "node:assert/strict";
import { test } from "node:test";
import {
	type CommandResult,
	createIssueBranch,
	fetchIssue,
	issueBranchName,
	openDraftPullRequest,
	parseIssueArgument,
	pullRequestBody,
	type RunCommand,
} from "./github-issue.ts";

const ok = (stdout = ""): CommandResult => ({ stdout, stderr: "", code: 0 });
const failed = (stderr: string): CommandResult => ({ stdout: "", stderr, code: 1 });

/** Answers commands by their joined text prefix and records every call. */
function fakeRunner(answers: [string, CommandResult][]): { run: RunCommand; calls: string[] } {
	const calls: string[] = [];
	const run: RunCommand = async (command, args) => {
		const line = [command, ...args].join(" ");
		calls.push(line);
		return answers.find(([prefix]) => line.startsWith(prefix))?.[1] ?? ok();
	};
	return { run, calls };
}

const issue = { number: 7, title: "Crash", url: "u", body: "b", labels: [], comments: [] };
const issueRef = { number: 7, title: "Crash on empty cart", url: "u", branch: "issue-7-crash", baseBranch: "main" };

test("reads an issue as a URL, #number or number", () => {
	assert.deepEqual(parseIssueArgument("https://github.com/acme/shop/issues/12"), {
		kind: "url",
		url: "https://github.com/acme/shop/issues/12",
		repo: "acme/shop",
		number: 12,
	});
	assert.deepEqual(parseIssueArgument("#12"), { kind: "number", number: 12 });
	assert.deepEqual(parseIssueArgument("12"), { kind: "number", number: 12 });
	assert.equal(parseIssueArgument("fix the cart"), undefined);
	assert.equal(parseIssueArgument("https://github.com/acme/shop/pull/12"), undefined);
});

test("branch names are issue-<number>-<slug of the title>", () => {
	assert.equal(issueBranchName(42, "Crash on EMPTY cart!"), "issue-42-crash-on-empty-cart");
	assert.equal(issueBranchName(42, "日本"), "issue-42");
	assert.ok(issueBranchName(42, "a ".repeat(100)).length <= "issue-42-".length + 40);
});

test("refuses an issue URL from another repo", async () => {
	const { run } = fakeRunner([["gh repo view", ok("acme/other\n")]]);
	const result = await fetchIssue(run, { kind: "url", url: "x", repo: "acme/shop", number: 1 });
	assert.equal(result.ok, false);
});

test("refuses to branch from a dirty working tree", async () => {
	const { run, calls } = fakeRunner([["git status --porcelain", ok(" M src/cart.ts\n")]]);
	const result = await createIssueBranch(run, issue);
	assert.equal(result.ok, false);
	assert.ok(!calls.some((call) => call.startsWith("git switch")));
});

test("branches from the fetched default branch", async () => {
	const { run, calls } = fakeRunner([["git symbolic-ref", ok("origin/main\n")]]);
	const result = await createIssueBranch(run, issue);
	assert.deepEqual(result, { ok: true, value: { number: 7, title: "Crash", url: "u", branch: "issue-7-crash", baseBranch: "main" } });
	assert.ok(calls.includes("git fetch origin main"));
	assert.ok(calls.includes("git switch -c issue-7-crash --no-track origin/main"));
});

test("reports a failed push and does not open a PR", async () => {
	const { run, calls } = fakeRunner([
		["git branch --show-current", ok("issue-7-crash\n")],
		["git diff --cached --quiet", failed("")],
		["git push", failed("rejected")],
	]);
	const result = await openDraftPullRequest(run, issueRef, "# plan");
	assert.deepEqual(result, { ok: false, error: "Failed to push issue-7-crash (exit 1): rejected" });
	assert.ok(!calls.some((call) => call.startsWith("gh pr create")));
});

test("opens a draft PR against the base branch after committing", async () => {
	const { run, calls } = fakeRunner([
		["git branch --show-current", ok("issue-7-crash\n")],
		["git diff --cached --quiet", failed("")],
		["gh pr create", ok("https://github.com/acme/shop/pull/9\n")],
	]);
	const result = await openDraftPullRequest(run, issueRef, "# plan");
	assert.deepEqual(result, { ok: true, value: "https://github.com/acme/shop/pull/9" });
	assert.ok(calls.includes("git commit -m Fix #7: Crash on empty cart"));
	assert.ok(calls.some((call) => call.startsWith("gh pr create --draft --base main --head issue-7-crash")));
});

test("refuses to open a PR from another branch", async () => {
	const { run } = fakeRunner([["git branch --show-current", ok("main\n")]]);
	assert.equal((await openDraftPullRequest(run, issueRef, "# plan")).ok, false);
});

test("the PR body closes the issue and carries the plan's goal and approach", () => {
	const plan = "# Fix\n## Goal\nNo crash.\n## Approach\n1. Guard.\n## Files\n- a.ts";
	assert.equal(
		pullRequestBody(7, plan),
		"Fixes #7\n\n## Goal\n\nNo crash.\n\n## Approach\n\n1. Guard.\n\nPlanned and reviewed by the expert model with /issue.",
	);
});
