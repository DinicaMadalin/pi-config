import assert from "node:assert/strict";
import { test } from "node:test";
import {
	type CommandResult,
	createIssueBranch,
	createPlanIssue,
	droppedLinesNotice,
	fetchIssue,
	issueBranchName,
	openDraftPullRequest,
	parseIssueArgument,
	publicPlanText,
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

test("an issue's branch is just issue-<number>", () => {
	assert.equal(issueBranchName(42), "issue-42");
});

test("a branch without an issue is named after the plan title's first meaningful words", async () => {
	const { run } = fakeRunner([["git rev-parse", failed("")]]);
	const cases: [string, string][] = [
		["Fix ESLint", "fix-eslint"],
		["Fix the ESLint errors in the dashboard", "fix-eslint-errors"],
		["Add tiny string and numeric utilities", "add-string-numeric"],
		["Internationalization of the configuration subsystem", "internationalization"],
		["Supercalifragilisticexpialidocious-word-here", "supercalifragilisticexpi"],
		["日本", "build"],
	];
	for (const [title, expected] of cases) assert.deepEqual(await shipBranchName(run, title), { ok: true, value: expected }, title);
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
	assert.deepEqual(result, { ok: true, value: { number: 7, title: "Crash", url: "u", branch: "issue-7", baseBranch: "main" } });
	assert.ok(calls.includes("git fetch origin main"));
	assert.ok(calls.includes("git switch -c issue-7 --no-track origin/main"));
});

test("reports a failed push and does not open a PR", async () => {
	const { run, calls } = fakeRunner([
		["git branch --show-current", ok("issue-7-crash\n")],
		["git diff --cached --quiet", failed("")],
		["git push", failed("rejected")],
	]);
	const result = await openDraftPullRequest(run, issueRef, "# plan", ["/r"]);
	assert.deepEqual(result, { ok: false, error: "Failed to push issue-7-crash (exit 1): rejected" });
	assert.ok(!calls.some((call) => call.startsWith("gh pr create")));
});

test("opens a draft PR against the base branch after committing", async () => {
	const { run, calls } = fakeRunner([
		["git branch --show-current", ok("issue-7-crash\n")],
		["git diff --cached --quiet", failed("")],
		["gh pr create", ok("https://github.com/acme/shop/pull/9\n")],
	]);
	const result = await openDraftPullRequest(run, issueRef, "# plan", ["/r"]);
	assert.deepEqual(result, { ok: true, value: { url: "https://github.com/acme/shop/pull/9", droppedLines: [] } });
	assert.ok(calls.includes("git commit -m Fix #7: Crash on empty cart"));
	assert.ok(calls.some((call) => call.startsWith("gh pr create --draft --base main --head issue-7-crash")));
});

test("refuses to open a PR from another branch", async () => {
	const { run } = fakeRunner([["git branch --show-current", ok("main\n")]]);
	assert.equal((await openDraftPullRequest(run, issueRef, "# plan", ["/r"])).ok, false);
});

test("the PR body closes the issue and carries the plan's public text, without a footer", () => {
	assert.equal(pullRequestBody(7, "## Problem\n\nNo crash."), "Fixes #7\n\n## Problem\n\nNo crash.");
	assert.equal(pullRequestBody(7, ""), "Fixes #7");
});

test("the draft PR body is the public text: repo paths relative, local lines left out and reported", async () => {
	const { run, calls } = fakeRunner([
		["git branch --show-current", ok("issue-7-crash\n")],
		["gh pr create", ok("https://github.com/acme/shop/pull/9\n")],
	]);
	const issuePlan = "# Fix crash\n## Goal\nNo crash.\n## Approach\n1. Guard /r/src/cart.ts\n2. Notes in .scratch/handoffs/p.md";
	const result = await openDraftPullRequest(run, issueRef, issuePlan, ["/r"]);
	assert.deepEqual(result, { ok: true, value: { url: "https://github.com/acme/shop/pull/9", droppedLines: ["2. Notes in .scratch/handoffs/p.md"] } });
	const create = calls.find((call) => call.startsWith("gh pr create")) ?? "";
	assert.ok(create.includes("--body Fixes #7\n\n## Problem\n\nNo crash.\n\n## Proposed change\n\n1. Guard src/cart.ts"), create);
	assert.ok(!create.includes(".scratch/") && !create.includes("/r/") && !create.includes("/issue."), create);
});

const repoRoot = "/home/dnk/Work/shop";
const plan = [
	"# Add CSV export",
	"",
	"## Goal",
	"Problem: users cannot export.",
	"Planned with /build; see .scratch/handoffs/2026-11-23-add-csv-export.md",
	"",
	"## Approach",
	`1. Add exportCsv in ${repoRoot}/src/export.ts`,
	"2. Copy the style of /home/dnk/Work/other/src/report.ts",
	"",
	"3. Wire it into the menu.",
	"",
	"## Decisions",
	"- CSV over XLSX, because no new dependency.",
	"",
	"## Acceptance criteria",
	"- `npm test` passes.",
	"",
	"## Files",
	`- ${repoRoot}/src/export.ts`,
	"",
	"## Open questions",
	"None",
].join("\n");
const planIssue = { number: 9, title: "Add CSV export", url: "https://github.com/acme/shop/issues/9" };

test("the public plan keeps the problem, the proposed change and the acceptance criteria, nothing else", () => {
	const { title, body } = publicPlanText(plan, [repoRoot]);
	assert.equal(title, "Add CSV export");
	assert.equal(
		body,
		"## Problem\n\nProblem: users cannot export.\n\n## Proposed change\n\n1. Add exportCsv in src/export.ts\n\n3. Wire it into the menu.\n\n## Acceptance criteria\n\n- `npm test` passes.",
	);
	for (const hidden of ["# Add CSV export", "## Goal", "## Decisions", "## Files", "## Open questions", "Planned with /build", "/home/", ".scratch/"]) {
		assert.ok(!body.includes(hidden), hidden);
	}
});

test("the public plan omits a local title and reports it before body lines", () => {
	const privateTitle = "# Fix /home/ann/private.txt\n\n## Goal\nBroken.";
	const filteredTitle = publicPlanText(privateTitle, [repoRoot]);
	assert.equal(filteredTitle.title, "Agreed plan");
	assert.equal(filteredTitle.droppedLines[0], "Fix /home/ann/private.txt");
	assert.ok(!filteredTitle.body.includes("/home/"));

	const fallbackTitle = publicPlanText("# Fix /home/ann/private.txt\n\nUseful body", [repoRoot]);
	assert.equal(fallbackTitle.body, "Useful body");
	assert.deepEqual(fallbackTitle.droppedLines, ["Fix /home/ann/private.txt"]);

	const repoTitle = publicPlanText("# Fix /home/dnk/Work/shop/src/a.ts", [repoRoot]);
	assert.equal(repoTitle.title, "Fix src/a.ts");
	assert.deepEqual(repoTitle.droppedLines, []);
});

test("the public plan lists every line it left out because it named local material", () => {
	assert.deepEqual(publicPlanText(plan, [repoRoot]).droppedLines, [
		"Planned with /build; see .scratch/handoffs/2026-11-23-add-csv-export.md",
		"2. Copy the style of /home/dnk/Work/other/src/report.ts",
	]);
	const markers = "## Goal\nA\n/Users/ann/x.ts\n~/notes.md\n/home/ann/y.ts\nB";
	assert.deepEqual(publicPlanText(markers, []), {
		title: "Agreed plan",
		body: "## Problem\n\nA\nB",
		droppedLines: ["/Users/ann/x.ts", "~/notes.md", "/home/ann/y.ts"],
	});
});

test("only paths under a repo root become relative, and every given root counts", () => {
	const roots = ["/home/dnk/Work/shop/", "/home/dnk/..shop-worktrees/build-x"];
	const approach = "## Approach\n1. Edit /home/dnk/Work/shop/a.ts\n2. Edit /home/dnk/..shop-worktrees/build-x/b.ts\n3. Not /home/dnk/Work/shop-old/c.ts";
	const { body, droppedLines } = publicPlanText(`# T\n${approach}`, roots);
	assert.equal(body, "## Proposed change\n\n1. Edit a.ts\n2. Edit b.ts");
	assert.deepEqual(droppedLines, ["3. Not /home/dnk/Work/shop-old/c.ts"]);
});

test("a plan without the public sections falls back to its whole body, still stripped", () => {
	assert.deepEqual(publicPlanText("no heading", []), { title: "Agreed plan", body: "no heading", droppedLines: [] });
	assert.deepEqual(publicPlanText("# Tidy\n\nRename a in /r/x.ts\n\nsee ~/todo.md\n\n## Open questions\nNone", ["/r"]), {
		title: "Tidy",
		body: "Rename a in x.ts\n\n## Open questions\nNone",
		droppedLines: ["see ~/todo.md"],
	});
});

test("the dropped-lines notice names each line, shortening long ones", () => {
	assert.equal(droppedLinesNotice([], "issue #12"), undefined);
	assert.equal(
		droppedLinesNotice(["see .scratch/p.md"], "issue #12"),
		'Left 1 line out of issue #12 because it names local files: "see .scratch/p.md"',
	);
	const longLine = `/home/ann/${"x".repeat(100)}`;
	assert.equal(
		droppedLinesNotice(["~/a", longLine], "the draft pull request"),
		`Left 2 lines out of the draft pull request because they name local files: "~/a"; "${longLine.slice(0, 79)}…"`,
	);
});

test("creating the plan issue posts the public text and reads its number from the URL gh prints", async () => {
	const { run, calls } = fakeRunner([["gh issue create", ok("Creating issue in acme/shop\n\nhttps://github.com/acme/shop/issues/9\n")]]);
	assert.deepEqual(await createPlanIssue(run, plan, [repoRoot]), {
		ok: true,
		value: { issue: planIssue, droppedLines: publicPlanText(plan, [repoRoot]).droppedLines },
	});
	assert.ok(calls[0].startsWith("gh issue create --title Add CSV export --body ## Problem\n\nProblem: users cannot export."), calls[0]);
	assert.ok(calls[0].endsWith("- `npm test` passes."), "no footer after the acceptance criteria");
	const { run: failing } = fakeRunner([["gh issue create", failed("not logged in")]]);
	assert.deepEqual(await createPlanIssue(failing, plan, [repoRoot]), {
		ok: false,
		error: "Failed to create the GitHub issue (exit 1): not logged in",
	});
});

test("the ship branch skips names that already exist", async () => {
	const { run } = fakeRunner([
		["git rev-parse --verify --quiet refs/heads/issue-9-2", failed("")],
		["git rev-parse --verify --quiet refs/heads/", ok("abc")],
	]);
	assert.deepEqual(await shipBranchName(run, "Add CSV export", planIssue), { ok: true, value: "issue-9-2" });
	const { run: noneExist } = fakeRunner([["git rev-parse", failed("")]]);
	assert.deepEqual(await shipBranchName(noneExist, "Add CSV export"), { ok: true, value: "add-csv-export" });
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

test("a plan change updates the plan issue's public body and comments briefly", async () => {
	const { run, calls } = fakeRunner([]);
	const planIssue = { number: 7, title: "Add export", url: "https://github.com/o/r/issues/7" };
	const changedPlan = "# Add export\n\n## Goal\nCSV\nsee .scratch/handoffs/p.md";
	assert.deepEqual(await updatePlanIssue(run, planIssue, changedPlan, ["/r"]), {
		ok: true,
		value: { droppedLines: ["see .scratch/handoffs/p.md"] },
	});
	assert.equal(calls[0], "gh issue edit 7 --body ## Problem\n\nCSV");
	assert.equal(calls[1], "gh issue comment 7 --body Plan updated.");
	const { run: failing, calls: failingCalls } = fakeRunner([["gh issue edit", failed("gone")]]);
	assert.deepEqual(await updatePlanIssue(failing, planIssue, changedPlan, ["/r"]), { ok: false, error: "Failed to update issue #7 (exit 1): gone" });
	assert.equal(failingCalls.length, 1, "no comment after a failed edit");
});
