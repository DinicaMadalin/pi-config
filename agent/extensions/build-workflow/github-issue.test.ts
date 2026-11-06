import assert from "node:assert/strict";
import { test } from "node:test";
import {
	type CommandResult,
	createIssueBranch,
	createPlanIssue,
	fetchIssue,
	issueBranchName,
	openDraftPullRequest,
	parseIssueArgument,
	planIssueText,
	pullRequestBody,
	type RunCommand,
	shipBranchName,
	shipCommitMessage,
	parseStatusPaths,
	shipWork,
	updatePlanIssue,
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

const plan = "# Add CSV export\n\n## Goal\nProblem: users cannot export.\n\n## Approach\n1. Add exportCsv in src/export.ts";
const planIssue = { number: 9, title: "Add CSV export", url: "https://github.com/acme/shop/issues/9" };

test("the issue is the plan: its heading becomes the title and the rest the body", () => {
	const { title, body } = planIssueText(plan);
	assert.equal(title, "Add CSV export");
	assert.ok(body.startsWith("## Goal\nProblem: users cannot export."));
	assert.ok(!body.includes("# Add CSV export"));
	assert.equal(planIssueText("no heading").title, "Agreed plan");
});

test("creating the plan issue reads its number from the URL gh prints", async () => {
	const { run, calls } = fakeRunner([["gh issue create", ok("Creating issue in acme/shop\n\nhttps://github.com/acme/shop/issues/9\n")]]);
	assert.deepEqual(await createPlanIssue(run, plan), { ok: true, value: planIssue });
	assert.ok(calls[0].startsWith("gh issue create --title Add CSV export --body ## Goal"));
	const { run: failing } = fakeRunner([["gh issue create", failed("not logged in")]]);
	assert.deepEqual(await createPlanIssue(failing, plan), {
		ok: false,
		error: "Failed to create the GitHub issue (exit 1): not logged in",
	});
});

test("the ship branch skips names that already exist", async () => {
	const { run } = fakeRunner([
		["git rev-parse --verify --quiet refs/heads/issue-9-add-csv-export-2", failed("")],
		["git rev-parse --verify --quiet refs/heads/", ok("abc")],
	]);
	assert.deepEqual(await shipBranchName(run, "Add CSV export", planIssue), { ok: true, value: "issue-9-add-csv-export-2" });
	const { run: noneExist } = fakeRunner([["git rev-parse", failed("")]]);
	assert.deepEqual(await shipBranchName(noneExist, "Add CSV export"), { ok: true, value: "build-add-csv-export" });
});

test("the ship commit closes the plan issue", () => {
	assert.equal(shipCommitMessage("Add CSV export", planIssue), "Add CSV export\n\nCloses #9");
	assert.equal(shipCommitMessage("Add CSV export"), "Add CSV export");
});

test("shipping branches, commits and pushes, never merging or forcing", async () => {
	const { run, calls } = fakeRunner([["git status", ok(" M src/export.ts\0?? src/export.test.ts\0")]]);
	const result = await shipWork(run, { branch: "build-x", commitMessage: "Add x", isCommitted: false });
	assert.deepEqual(result, { kind: "shipped", branch: "build-x" });
	assert.deepEqual(calls.slice(1), ["git switch -c build-x", "git add --all", "git commit -m Add x", "git push --set-upstream origin build-x"]);
	assert.ok(!calls.some((call) => /--force|merge|rebase/.test(call)));
});

test("shipping with no changes does nothing", async () => {
	const { run, calls } = fakeRunner([["git status", ok("")]]);
	assert.deepEqual(await shipWork(run, { branch: "build-x", commitMessage: "Add x", isCommitted: false }), {
		kind: "failed",
		error: "Nothing to ship: the working tree has no changes",
	});
	assert.equal(calls.length, 1);
});

test("a failed push keeps the commit, and shipping again only pushes it", async () => {
	const firstTry = fakeRunner([["git status", ok(" M a.ts\0")], ["git push", failed("rejected")]]);
	assert.deepEqual(await shipWork(firstTry.run, { branch: "build-x", commitMessage: "Add x", isCommitted: false }), {
		kind: "committed-not-pushed",
		branch: "build-x",
		error: "Failed to push build-x (exit 1): rejected",
	});
	const retry = fakeRunner([["git branch --show-current", ok("build-x\n")], ["git status", ok("")]]);
	assert.deepEqual(await shipWork(retry.run, { branch: "build-x", commitMessage: "Add x", isCommitted: true }), {
		kind: "shipped",
		branch: "build-x",
	});
	assert.deepEqual(retry.calls, [
		"git branch --show-current",
		"git status --porcelain -z --untracked-files=all",
		"git push --set-upstream origin build-x",
	]);
});

test("shipping again refuses when you switched away from the committed branch", async () => {
	const { run, calls } = fakeRunner([["git branch --show-current", ok("main\n")]]);
	const result = await shipWork(run, { branch: "build-x", commitMessage: "Add x", isCommitted: true });
	assert.deepEqual(result, { kind: "failed", error: "Switch back to branch build-x (git switch build-x), then ship again" });
	assert.ok(!calls.some((call) => call.startsWith("git push")));
});

test("the files to ship keep spaces in paths and list a rename once, by its new path", () => {
	assert.deepEqual(parseStatusPaths(" M src/a b.ts\0R  new.ts\0old.ts\0?? notes.md\0"), ["src/a b.ts", "new.ts", "notes.md"]);
});

test("a plan change updates the plan issue's body and comments on it", async () => {
	const { run, calls } = fakeRunner([]);
	const planIssue = { number: 7, title: "Add export", url: "https://github.com/o/r/issues/7" };
	assert.deepEqual(await updatePlanIssue(run, planIssue, "# Add export\n\n## Goal\nCSV", 2), { ok: true, value: undefined });
	assert.ok(calls[0].startsWith("gh issue edit 7 --body ## Goal"), calls[0]);
	assert.ok(calls[1].startsWith("gh issue comment 7 --body The plan changed (revision 2)"), calls[1]);
});
