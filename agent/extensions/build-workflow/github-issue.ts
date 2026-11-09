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
/** A branch without an issue is named after the first few meaningful words of the plan title: `fix-eslint`. */
const MAX_BRANCH_WORDS = 3;
const MAX_BRANCH_NAME_LENGTH = 24;
const FILLER_WORDS = new Set([
	"a", "an", "the", "and", "or", "in", "on", "of", "to", "for", "with", "from", "by", "into", "at", "as",
	"is", "are", "be", "it", "its", "this", "that", "all", "some", "tiny", "small", "simple", "new", "existing",
]);

export function parseIssueArgument(text: string): IssueArgument | undefined {
	const trimmed = text.trim();
	const urlMatch = ISSUE_URL_PATTERN.exec(trimmed);
	if (urlMatch) return { kind: "url", url: trimmed, repo: urlMatch[1], number: Number(urlMatch[2]) };
	const numberMatch = ISSUE_NUMBER_PATTERN.exec(trimmed);
	if (numberMatch) return { kind: "number", number: Number(numberMatch[1]) };
	return undefined;
}

/** The title's first meaningful words, lowercase and dash-joined; empty when it has none in a-z/0-9. */
function shortBranchSlug(title: string): string {
	const meaningfulWords = title
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((word) => word && !FILLER_WORDS.has(word));
	let slug = "";
	for (const word of meaningfulWords.slice(0, MAX_BRANCH_WORDS)) {
		const longer = slug ? `${slug}-${word}` : word;
		if (longer.length > MAX_BRANCH_NAME_LENGTH) break;
		slug = longer;
	}
	return slug || (meaningfulWords[0]?.slice(0, MAX_BRANCH_NAME_LENGTH) ?? "");
}

export function issueBranchName(issueNumber: number): string {
	return `issue-${issueNumber}`;
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

	const branch = issueBranchName(issue.number);
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

/**
 * Paths in `git status --porcelain -z` output: "XY path\0", with renames and copies as "XY new\0old\0".
 * -z keeps paths with spaces or quotes as they are.
 */
export function parseStatusPaths(statusOutput: string): string[] {
	const records = statusOutput.split("\0");
	const paths: string[] = [];
	for (let index = 0; index < records.length; index++) {
		const record = records[index];
		if (record.length < 4) continue;
		paths.push(record.slice(3));
		if (record[0] === "R" || record[0] === "C") index++;
	}
	return paths;
}

/** Changed and untracked paths, as git status lists them; these are what shipping commits. */
export async function listFilesToShip(run: RunCommand): Promise<StepResult<string[]>> {
	const status = await run("git", ["status", "--porcelain", "-z", "--untracked-files=all"]);
	if (status.code !== 0) return { ok: false, error: commandError("read git status", status) };
	return { ok: true, value: parseStatusPaths(status.stdout) };
}

function shipBaseName(title: string, planIssue: TrackedIssue | undefined): string {
	if (planIssue) return issueBranchName(planIssue.number);
	return shortBranchSlug(title) || "build";
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
	/** An earlier attempt committed on this branch but its push failed: commit what changed since, then push. */
	isCommitted: boolean;
}

export type ShipResult =
	| { kind: "shipped"; branch: string }
	/** The work is committed on the branch, but the push failed; shipping again only pushes. */
	| { kind: "committed-not-pushed"; branch: string; error: string }
	| { kind: "failed"; error: string };

async function commitAll(run: RunCommand, commitMessage: string): Promise<string | undefined> {
	const add = await run("git", ["add", "--all"]);
	if (add.code !== 0) return commandError("stage the changes", add);
	const commit = await run("git", ["commit", "-m", commitMessage]);
	if (commit.code !== 0) return commandError("commit the changes", commit);
	return undefined;
}

/** On the first attempt: a new branch from the current HEAD (keeping the changes) and one commit. */
async function commitOnNewBranch(run: RunCommand, request: ShipRequest): Promise<string | undefined> {
	const files = await listFilesToShip(run);
	if (!files.ok) return files.error;
	if (files.value.length === 0) return "Nothing to ship: the working tree has no changes";
	const create = await run("git", ["switch", "-c", request.branch]);
	if (create.code !== 0) return commandError(`create branch ${request.branch}`, create);
	return commitAll(run, request.commitMessage);
}

/** After a failed push: still on the committed branch, with anything changed since committed too. */
async function commitOnCommittedBranch(run: RunCommand, request: ShipRequest): Promise<string | undefined> {
	const current = await run("git", ["branch", "--show-current"]);
	if (current.code !== 0) return commandError("read the current branch", current);
	if (current.stdout.trim() !== request.branch) return `Switch back to branch ${request.branch} (git switch ${request.branch}), then ship again`;
	const files = await listFilesToShip(run);
	if (!files.ok) return files.error;
	return files.value.length === 0 ? undefined : commitAll(run, request.commitMessage);
}

/**
 * Ships a reviewed build: a new branch from the current HEAD, one commit, and a normal push.
 * Never merges, rebases or force pushes. A failed push keeps the commit, and shipping again only pushes.
 */
export async function shipWork(run: RunCommand, request: ShipRequest): Promise<ShipResult> {
	const commitError = request.isCommitted ? await commitOnCommittedBranch(run, request) : await commitOnNewBranch(run, request);
	if (commitError) return { kind: "failed", error: commitError };
	const push = await run("git", ["push", "--set-upstream", "origin", request.branch]);
	if (push.code !== 0) return { kind: "committed-not-pushed", branch: request.branch, error: commandError(`push ${request.branch}`, push) };
	return { kind: "shipped", branch: request.branch };
}

/** After a plan change: the plan issue shows the new plan, and a comment tells its readers it changed. */
export async function updatePlanIssue(run: RunCommand, planIssue: TrackedIssue, plan: string, planRevision: number): Promise<StepResult<void>> {
	const { body } = planIssueText(plan);
	const edit = await run("gh", ["issue", "edit", String(planIssue.number), "--body", body]);
	if (edit.code !== 0) return { ok: false, error: commandError(`update issue #${planIssue.number}`, edit) };
	const note = `The plan changed (revision ${planRevision}); the issue body now holds the updated plan.`;
	const comment = await run("gh", ["issue", "comment", String(planIssue.number), "--body", note]);
	if (comment.code !== 0) return { ok: false, error: commandError(`comment on issue #${planIssue.number}`, comment) };
	return { ok: true, value: undefined };
}
