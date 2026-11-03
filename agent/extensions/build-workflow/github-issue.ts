/**
 * The GitHub side of /issue: reading the issue with gh, branching from the default branch, and opening the
 * draft pull request. Commands run through an injected runner, so the steps can be tested without git or gh.
 */
import type { IssueRef } from "./workflow-state.ts";

export interface CommandResult {
	stdout: string;
	stderr: string;
	code: number;
}

export type RunCommand = (command: string, args: string[]) => Promise<CommandResult>;

/** What the user typed after /issue: a full URL, or a number (with or without #) in the current repo. */
export type IssueArgument = { kind: "url"; url: string; repo: string; number: number } | { kind: "number"; number: number };

export interface GithubIssue {
	number: number;
	title: string;
	url: string;
	body: string;
	labels: string[];
	comments: { author: string; body: string }[];
}

export type StepResult<T> = { ok: true; value: T } | { ok: false; error: string };

const ISSUE_URL_PATTERN = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/(\d+)\/?(?:[?#].*)?$/;
const ISSUE_NUMBER_PATTERN = /^#?(\d+)$/;
const MAX_BRANCH_SLUG_LENGTH = 40;

export function parseIssueArgument(text: string): IssueArgument | undefined {
	const trimmed = text.trim();
	const urlMatch = ISSUE_URL_PATTERN.exec(trimmed);
	if (urlMatch) return { kind: "url", url: trimmed, repo: urlMatch[1], number: Number(urlMatch[2]) };
	const numberMatch = ISSUE_NUMBER_PATTERN.exec(trimmed);
	if (numberMatch) return { kind: "number", number: Number(numberMatch[1]) };
	return undefined;
}

export function issueBranchName(issueNumber: number, title: string): string {
	const slug = title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.slice(0, MAX_BRANCH_SLUG_LENGTH)
		.replace(/^-+|-+$/g, "");
	return slug ? `issue-${issueNumber}-${slug}` : `issue-${issueNumber}`;
}

export function pullRequestTitle(issue: Pick<IssueRef, "number" | "title">): string {
	return `Fix #${issue.number}: ${issue.title}`;
}

/** The text under a "## <heading>" line of a markdown plan, up to the next "## " heading. */
export function planSection(plan: string, heading: string): string | undefined {
	const lines = plan.split("\n");
	const start = lines.findIndex((line) => line.trim() === `## ${heading}`);
	if (start === -1) return undefined;
	const nextHeading = lines.findIndex((line, index) => index > start && line.startsWith("## "));
	const section = lines.slice(start + 1, nextHeading === -1 ? undefined : nextHeading).join("\n").trim();
	return section || undefined;
}

/** "Fixes #N" makes GitHub close the issue when the PR merges. */
export function pullRequestBody(issueNumber: number, plan: string): string {
	const sections = ["Goal", "Approach"]
		.map((heading) => [heading, planSection(plan, heading)] as const)
		.filter((section): section is readonly [string, string] => section[1] !== undefined)
		.map(([heading, text]) => `## ${heading}\n\n${text}`);
	return [`Fixes #${issueNumber}`, ...sections, "Planned and reviewed by the expert model with /issue."].join("\n\n");
}

function commandError(action: string, result: CommandResult): string {
	const detail = (result.stderr || result.stdout).trim().split("\n").slice(-3).join(" ");
	return `Failed to ${action} (exit ${result.code})${detail ? `: ${detail}` : ""}`;
}

interface GhIssueJson {
	number: number;
	title: string;
	url: string;
	body: string;
	labels: { name: string }[];
	comments: { author: { login: string } | null; body: string }[];
}

async function currentRepo(run: RunCommand): Promise<StepResult<string>> {
	const result = await run("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]);
	if (result.code !== 0) return { ok: false, error: commandError("find the GitHub repo of this directory", result) };
	return { ok: true, value: result.stdout.trim() };
}

export async function fetchIssue(run: RunCommand, issueArgument: IssueArgument): Promise<StepResult<GithubIssue>> {
	const repo = await currentRepo(run);
	if (!repo.ok) return repo;
	if (issueArgument.kind === "url" && issueArgument.repo.toLowerCase() !== repo.value.toLowerCase()) {
		return { ok: false, error: `Issue is in ${issueArgument.repo}, but this directory is ${repo.value}; cd into that repo first` };
	}
	const fields = "number,title,url,body,labels,comments";
	const result = await run("gh", ["issue", "view", String(issueArgument.number), "--json", fields]);
	if (result.code !== 0) return { ok: false, error: commandError(`load issue #${issueArgument.number} with gh`, result) };
	const issue = JSON.parse(result.stdout) as GhIssueJson;
	return {
		ok: true,
		value: {
			number: issue.number,
			title: issue.title,
			url: issue.url,
			body: issue.body,
			labels: issue.labels.map((label) => label.name),
			comments: issue.comments.map((comment) => ({ author: comment.author?.login ?? "ghost", body: comment.body })),
		},
	};
}

async function defaultBranch(run: RunCommand): Promise<StepResult<string>> {
	const result = await run("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
	if (result.code === 0) return { ok: true, value: result.stdout.trim().replace(/^origin\//, "") };
	const viaGh = await run("gh", ["repo", "view", "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"]);
	if (viaGh.code !== 0) return { ok: false, error: commandError("find the default branch", viaGh) };
	return { ok: true, value: viaGh.stdout.trim() };
}

/** Fresh branch from the up-to-date default branch; refuses a dirty tree so no unrelated change rides along. */
export async function createIssueBranch(run: RunCommand, issue: GithubIssue): Promise<StepResult<IssueRef>> {
	const status = await run("git", ["status", "--porcelain"]);
	if (status.code !== 0) return { ok: false, error: commandError("read git status", status) };
	if (status.stdout.trim()) return { ok: false, error: "The working tree has uncommitted changes; commit or stash them before /issue" };

	const baseBranch = await defaultBranch(run);
	if (!baseBranch.ok) return baseBranch;
	const fetch = await run("git", ["fetch", "origin", baseBranch.value]);
	if (fetch.code !== 0) return { ok: false, error: commandError(`fetch origin/${baseBranch.value}`, fetch) };

	const branch = issueBranchName(issue.number, issue.title);
	const create = await run("git", ["switch", "-c", branch, "--no-track", `origin/${baseBranch.value}`]);
	if (create.code !== 0) return { ok: false, error: commandError(`create branch ${branch} from origin/${baseBranch.value}`, create) };
	return { ok: true, value: { number: issue.number, title: issue.title, url: issue.url, branch, baseBranch: baseBranch.value } };
}

/** Commits everything on the issue branch, pushes it, and opens a draft PR; returns the PR URL. */
export async function openDraftPullRequest(run: RunCommand, issue: IssueRef, plan: string): Promise<StepResult<string>> {
	const currentBranch = await run("git", ["branch", "--show-current"]);
	if (currentBranch.stdout.trim() !== issue.branch) {
		return { ok: false, error: `Expected to be on branch ${issue.branch}, but HEAD is ${currentBranch.stdout.trim() || "detached"}` };
	}
	const add = await run("git", ["add", "--all"]);
	if (add.code !== 0) return { ok: false, error: commandError("stage the changes", add) };
	const staged = await run("git", ["diff", "--cached", "--quiet"]);
	if (staged.code !== 0) {
		const commit = await run("git", ["commit", "-m", pullRequestTitle(issue)]);
		if (commit.code !== 0) return { ok: false, error: commandError("commit the changes", commit) };
	}
	const push = await run("git", ["push", "--set-upstream", "origin", issue.branch]);
	if (push.code !== 0) return { ok: false, error: commandError(`push ${issue.branch}`, push) };

	const create = await run("gh", [
		"pr",
		"create",
		"--draft",
		"--base",
		issue.baseBranch,
		"--head",
		issue.branch,
		"--title",
		pullRequestTitle(issue),
		"--body",
		pullRequestBody(issue.number, plan),
	]);
	if (create.code !== 0) return { ok: false, error: commandError("open the draft pull request", create) };
	return { ok: true, value: create.stdout.trim().split("\n").at(-1) ?? "" };
}
