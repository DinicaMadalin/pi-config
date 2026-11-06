/**
 * The GitHub and git side of /issue and /build: reading or creating issues with gh, branching, opening the draft
 * pull request, and shipping a reviewed build. Commands run through an injected runner, so the steps can be tested
 * without git or gh.
 */
import type { IssueRef, TrackedIssue } from "./workflow-state.ts";

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

function branchSlug(title: string): string {
	return title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.slice(0, MAX_BRANCH_SLUG_LENGTH)
		.replace(/^-+|-+$/g, "");
}

export function issueBranchName(issueNumber: number, title: string): string {
	const slug = branchSlug(title);
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

const ISSUE_NUMBER_IN_URL_PATTERN = /\/issues\/(\d+)\s*$/;
const UNTITLED_PLAN = "Agreed plan";
const MAX_BRANCH_SUFFIX = 20;

/** The plan's "# " heading, which becomes the issue title and the commit subject. */
export function planTitle(plan: string): string {
	const heading = plan.split("\n").find((line) => line.startsWith("# "));
	return heading?.slice(2).trim() || UNTITLED_PLAN;
}

/** The issue is the plan itself: its sections already state the problem, the steps and how to verify. */
export function planIssueText(plan: string): { title: string; body: string } {
	const title = planTitle(plan);
	const body = plan
		.split("\n")
		.filter((line) => line.trim() !== `# ${title}`)
		.join("\n")
		.trim();
	return { title, body: `${body}\n\n---\nPlanned with /build; an implementer agent works from this issue.` };
}

export async function isGithubRepo(run: RunCommand): Promise<boolean> {
	return (await currentRepo(run)).ok;
}

export async function createPlanIssue(run: RunCommand, plan: string): Promise<StepResult<TrackedIssue>> {
	const { title, body } = planIssueText(plan);
	const result = await run("gh", ["issue", "create", "--title", title, "--body", body]);
	if (result.code !== 0) return { ok: false, error: commandError("create the GitHub issue", result) };
	const url = result.stdout.trim().split("\n").at(-1) ?? "";
	const numberMatch = ISSUE_NUMBER_IN_URL_PATTERN.exec(url);
	if (!numberMatch) return { ok: false, error: `Created the issue, but gh printed no issue URL: ${url || "(empty)"}` };
	return { ok: true, value: { number: Number(numberMatch[1]), title, url } };
}

/** Changed and untracked paths, as git status lists them; these are what shipping commits. */
export async function listFilesToShip(run: RunCommand): Promise<StepResult<string[]>> {
	const status = await run("git", ["status", "--porcelain", "--untracked-files=all"]);
	if (status.code !== 0) return { ok: false, error: commandError("read git status", status) };
	const paths = status.stdout
		.split("\n")
		.filter((line) => line.trim())
		.map((line) => line.slice(3));
	return { ok: true, value: paths };
}

function shipBaseName(title: string, planIssue: TrackedIssue | undefined): string {
	if (planIssue) return issueBranchName(planIssue.number, planIssue.title);
	const slug = branchSlug(title);
	return slug ? `build-${slug}` : "build";
}

/** A branch name no local branch uses yet: the base name, then -2, -3, ... */
export async function shipBranchName(run: RunCommand, title: string, planIssue?: TrackedIssue): Promise<StepResult<string>> {
	const baseName = shipBaseName(title, planIssue);
	for (let suffix = 1; suffix <= MAX_BRANCH_SUFFIX; suffix++) {
		const candidate = suffix === 1 ? baseName : `${baseName}-${suffix}`;
		const existing = await run("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${candidate}`]);
		if (existing.code !== 0) return { ok: true, value: candidate };
	}
	return { ok: false, error: `Branches ${baseName} to ${baseName}-${MAX_BRANCH_SUFFIX} all exist; delete some or ship by hand` };
}

export function shipCommitMessage(title: string, planIssue?: TrackedIssue): string {
	return planIssue ? `${title}\n\nCloses #${planIssue.number}` : title;
}

export interface ShipRequest {
	branch: string;
	commitMessage: string;
}

/**
 * Ships a reviewed build: a new branch from the current HEAD (keeping the changes), one commit, and a normal push.
 * Never merges, rebases or force pushes.
 */
export async function shipWork(run: RunCommand, request: ShipRequest): Promise<StepResult<string>> {
	const files = await listFilesToShip(run);
	if (!files.ok) return files;
	if (files.value.length === 0) return { ok: false, error: "Nothing to ship: the working tree has no changes" };

	const create = await run("git", ["switch", "-c", request.branch]);
	if (create.code !== 0) return { ok: false, error: commandError(`create branch ${request.branch}`, create) };
	const add = await run("git", ["add", "--all"]);
	if (add.code !== 0) return { ok: false, error: commandError("stage the changes", add) };
	const commit = await run("git", ["commit", "-m", request.commitMessage]);
	if (commit.code !== 0) return { ok: false, error: commandError("commit the changes", commit) };
	const push = await run("git", ["push", "--set-upstream", "origin", request.branch]);
	if (push.code !== 0) {
		return { ok: false, error: `${commandError(`push ${request.branch}`, push)}; the commit is on local branch ${request.branch}` };
	}
	return { ok: true, value: request.branch };
}
