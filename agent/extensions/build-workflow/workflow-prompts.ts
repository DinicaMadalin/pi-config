/**
 * The messages each /build phase sends. Pure text builders, so they can be read and tested in one place.
 */
import {
	IMPLEMENTATION_BLOCKED_MARKER,
	IMPLEMENTATION_DONE_MARKER,
	PLANNER_ANSWER_READY_MARKER,
	PLANNER_NEEDS_USER_MARKER,
	REVIEW_FIX_MARKER,
	REVIEW_PASS_MARKER,
	type IssueRef,
	REVIEWER_NAMES,
	type ReviewerVendor,
	type StageRecord,
	SUBAGENT_NAMES,
	type TrackedIssue,
} from "./workflow-state.ts";
import { MAX_IMPLEMENTERS, WORK_STREAMS_HEADING, type WorkStream } from "./work-streams.ts";
import { SAVE_PLAN_TOOL_NAME } from "../project-memory/agreed-plan-files.ts";
import type { GithubIssue } from "./github-issue.ts";

function listRuleFiles(ruleFilePaths: readonly string[]): string {
	if (ruleFilePaths.length === 0) return "- No AGENTS.md or CLAUDE.md was found; follow the conventions of the surrounding code.";
	return ruleFilePaths.map((path) => `- ${path}`).join("\n");
}

/** Steps 3 to 5 of planning: agreement, then a plan the implementer can follow without this conversation. */
const AGREE_AND_SAVE_PLAN_STEPS = [
	"3. Discuss with me until I explicitly agree with both the goal and the approach. Do not edit any file in this phase.",
	`4. Once I agree, call ${SAVE_PLAN_TOOL_NAME}. The plan is the implementer's only brief, so write it for a capable`,
	"   developer who has never seen this repo, and it may be posted as a GitHub issue, so it must stand on its own and",
	"   hold no secrets, tokens or personal data:",
	"   - Goal: start with the problem (what is wrong or missing, why it matters, how to see it), then the result we want.",
	"   - Approach: numbered steps in order, each naming the file, the functions or types to add or change with their",
	"     signatures, the data shapes, the error and edge cases, and the tests to add with their names.",
	"   - Constraints: the repo rules that matter here, and the local conventions to imitate (naming, error handling,",
	"     test style), each with an existing file to copy the style from.",
	"   - Acceptance criteria: the observable behavior plus the exact typecheck, lint and test commands.",
	"   - Files: every file to create or change, one line each.",
	`   - Work streams (optional): up to ${MAX_IMPLEMENTERS} implementers can build in parallel, in the same folder. When the work`,
	`     splits into parts that touch different files, add a \`${WORK_STREAMS_HEADING}\` section with one \`### <short name>\``,
	"     subsection per part: the files it owns and its Approach steps. No file may be in two streams. Use one stream",
	"     (no section) when the parts would share files or the work is small. In a later plan of this session, keep the",
	"     names of the streams that continue, so the implementer that built a stream keeps building it with its context.",
	"5. After saving, tell me the plan path. I then choose whether to post the plan as a GitHub issue, and the implementers",
	"   start on their own as subagents; if one gets stuck, its question comes back to you here.",
	`6. If I want the plan changed later, even while the implementer works, update it and call ${SAVE_PLAN_TOOL_NAME} again`,
	"   with the full updated plan. The run keeps one plan file and passes the change on; never edit files yourself.",
];

export function planningPrompt(task: string): string {
	return [
		"[/build, phase 1 of 3: PLAN] You are the expert planner. Another model will implement your plan in a fresh",
		"session with no access to this conversation, and you will review its work afterwards.",
		"",
		`Task: ${task}`,
		"",
		"1. Investigate the code first: find the existing seam, a similar feature to copy, the tests and the check commands.",
		"2. Propose the approach: what changes where and why, the decisions with their reasons, the risky cases.",
		"   Ask about every business rule you would otherwise guess.",
		...AGREE_AND_SAVE_PLAN_STEPS,
	].join("\n");
}

function formatIssue(issue: GithubIssue): string {
	const labels = issue.labels.length > 0 ? `Labels: ${issue.labels.join(", ")}` : "Labels: none";
	const comments = issue.comments.map((comment) => `### Comment by ${comment.author}\n\n${comment.body.trim()}`);
	return [`## #${issue.number}: ${issue.title}`, issue.url, labels, "", issue.body.trim() || "(no description)", ...comments].join(
		"\n",
	);
}

export function issueInvestigationPrompt(issue: GithubIssue, branch: string): string {
	return [
		"[/issue, phase 1 of 3: INVESTIGATE] You are the expert investigator and planner. Another model will implement",
		"your plan in a fresh session with no access to this conversation, and you will review its work afterwards.",
		`We are on branch ${branch}, fresh from the default branch. The issue to fix:`,
		"",
		formatIssue(issue),
		"",
		"1. Investigate: reproduce the problem when you can (a command, a failing test), trace it to the root cause and",
		"   cite file:line. If the issue is not reproducible, unclear, or not a bug, say so and ask me before planning.",
		"2. Propose the fix: the root cause, what changes where and why, and a test that fails before the fix and passes",
		"   after it. Ask about every business rule you would otherwise guess. The plan's Goal must restate the issue",
		"   (symptom, expected behavior, how to reproduce), because the implementer will not see this conversation.",
		...AGREE_AND_SAVE_PLAN_STEPS,
	].join("\n");
}

function issueLine(issue: IssueRef | undefined): string[] {
	if (!issue) return [];
	return [`This fixes GitHub issue #${issue.number} (${issue.url}): ${issue.title}`, ""];
}

function readPlanIssueCommand(planIssue: TrackedIssue): string {
	return `\`gh issue view ${planIssue.number} --json title,body,comments\``;
}

function planSourceLines(planPath: string, planIssue: TrackedIssue | undefined): string[] {
	if (!planIssue) return [];
	return [
		`The plan is GitHub issue #${planIssue.number} (${planIssue.url}). Read it first with ${readPlanIssueCommand(planIssue)}:`,
		"it is the source of truth, including comments added after planning. The text below is the plan as agreed, also",
		`saved at ${planPath}, for when gh is unavailable.`,
		"",
	];
}

/** An implementer's part when the plan has several work streams; undefined when one implementer builds it all. */
export interface StreamAssignment {
	/** "Implementer 2". */
	implementerName: string;
	stream: WorkStream;
	/** The streams the other implementers build at the same time. */
	otherStreams: { implementerName: string; streamName: string }[];
}

function assignmentLines(assignment: StreamAssignment | undefined): string[] {
	if (!assignment) return [];
	const others = assignment.otherStreams.map((other) => `- ${other.implementerName}: "${other.streamName}"`);
	return [
		"## Your part",
		"",
		`You are ${assignment.implementerName}. You build only the work stream "${assignment.stream.name}" of the plan's`,
		`${WORK_STREAMS_HEADING} section. Other implementers build the other streams at the same time, in this same folder:`,
		...others,
		"Change only the files of your stream. Their files may be half done while you work: do not edit them, and checks",
		"that fail in their files are not yours to fix; mention them in your report.",
		"",
	];
}

export function implementationBrief(
	planPath: string,
	plan: string,
	ruleFilePaths: readonly string[],
	issue?: IssueRef,
	planIssue?: TrackedIssue,
	assignment?: StreamAssignment,
): string {
	return [
		"[/build, phase 2 of 3: IMPLEMENT] You are the implementer. An expert planned this work with me and I agreed to the",
		`plan below (saved at ${planPath}). Implement exactly this plan. An expert reviews your work against it afterwards.`,
		"",
		...issueLine(issue),
		...assignmentLines(assignment),
		"## What to implement",
		"",
		...planSourceLines(planPath, planIssue),
		plan.trim(),
		"",
		"## How to implement it",
		"",
		"1. Read every file listed in the plan, and the files it says to imitate, before changing anything.",
		"2. Work through the Approach steps in order. After each step, make sure it still typechecks.",
		"3. Add the tests the plan names. A bug fix starts with a failing test that reproduces the bug.",
		"4. Run the typecheck, lint and test commands from the Acceptance criteria and fix what you broke. Errors that were",
		"   already in the repo before your changes: list them in your report, do not fix them unless the plan says to.",
		"   Never delete, skip or loosen a test to get green.",
		"5. Do not commit. The reviewer diffs your uncommitted changes.",
		"",
		"## Rules you must follow",
		"",
		"The coding rules in these files apply in full. They are in your context; reread them if unsure:",
		listRuleFiles(ruleFilePaths),
		"",
		"- Change only what the plan needs: no drive-by refactors, renames, or reformatting. Mention other problems you",
		"  see in your report instead of fixing them.",
		"- If the plan is ambiguous, contradicts the code, or would make you guess a business rule, do not guess: stop,",
		"  ask your question, and end your reply with the line",
		`  \`${IMPLEMENTATION_BLOCKED_MARKER}: <your question>\`. The planner who wrote the plan answers you.`,
		"- If you must deviate from the plan, say where and why in your report.",
		"",
		"## How to write the code",
		"",
		"- Match the style of the surrounding code and of the files the plan points to.",
		"- Names say what the thing is in the domain, with the unit when it matters (`timeoutMs`, `priceCents`).",
		"  Never vague names like data, value, item, temp, res, handler, util. Functions are verb plus thing.",
		"- One function, one reason to change. Early returns and named steps over nested branches.",
		"- Parse unknown input at the edge into a domain type; after that, trust the type.",
		"- Never swallow an error. Error messages name the failed action and the useful detail.",
		"- No dead code, debug prints, unused imports, or comments that repeat the code. Comment only a hidden why.",
		"",
		"## When you are done",
		"",
		"Report what you changed per file, the commands you ran with their results, and any deviation from the plan.",
		`End your reply with the line \`${IMPLEMENTATION_DONE_MARKER}\`.`,
	].join("\n");
}

function diffCommand(baseCommit: string | undefined): string {
	return baseCommit ? `\`git diff ${baseCommit}\`` : "`git diff HEAD`";
}

export function reviewPrompt(
	planPath: string,
	baseCommit: string | undefined,
	ruleFilePaths: readonly string[],
	issue?: IssueRef,
	planIssue?: TrackedIssue,
): string {
	const planSource = planIssue
		? `GitHub issue #${planIssue.number} (${planIssue.url}; read it with ${readPlanIssueCommand(planIssue)}, local copy at ${planPath})`
		: `the agreed plan at ${planPath}`;
	const issueCheck = issue
		? [`   - Issue: the change fixes issue #${issue.number}'s root cause, and a test reproduces the issue and now passes.`]
		: [];
	return [
		"[/build, phase 3 of 3: REVIEW] You are an expert reviewer. The implementer says the work is done.",
		"An expert from another AI vendor reviews the same work in parallel; review on your own, and only read the",
		"working tree (no commands that rewrite files, such as formatters in fix mode).",
		`Review it against ${planSource}. Do not edit any file.`,
		"",
		...issueLine(issue),
		`1. Read the plan. Run \`git status\` and ${diffCommand(baseCommit)}, and read new untracked files and every changed`,
		"   file in full, not only the diff hunks.",
		"2. Run the typecheck, lint and test commands from the plan's Acceptance criteria.",
		"3. Check, in this order:",
		"   - Plan: every Approach step is done, nothing outside the plan changed, the acceptance criteria hold.",
		...issueCheck,
		"   - Correctness: edge cases, error handling, missing or wrong tests.",
		"   - Rules: the coding rules in these files:",
		listRuleFiles(ruleFilePaths)
			.split("\n")
			.map((line) => `     ${line}`)
			.join("\n"),
		"",
		"Report findings grouped as must fix and suggestions. Each finding has file:line, what is wrong, and the concrete fix.",
		"Report only real problems; style preferences the rules do not ask for are suggestions at most.",
		`End with the line \`${REVIEW_FIX_MARKER}\` if anything must be fixed, otherwise \`${REVIEW_PASS_MARKER}\`.`,
	].join("\n");
}

/** Quotes the review so the fix request is self-contained: the router rates its difficulty from this prompt. */
export function fixPrompt(reviewReport: string, assignment?: StreamAssignment): string {
	const scope = assignment
		? [
				`Fix the must-fix findings in the files of your work stream "${assignment.stream.name}"; the other implementers fix`,
				`the findings in theirs.${assignment.implementerName === SUBAGENT_NAMES.implementer ? " Findings in files no stream owns are yours." : ""}`,
			]
		: ["Fix every must-fix finding of their reviews:"];
	return [
		"[/build: FIX] You are the implementer again. Two expert reviewers reviewed the work.",
		...scope,
		"",
		reviewReport.trim(),
		"",
		"Follow the same rules and code style as in your original brief. Change nothing else, do not commit,",
		"and rerun the typecheck, lint and test commands.",
		"Report each finding with what you changed. If a finding is wrong, explain why instead of changing the code.",
		`End your reply with the line \`${IMPLEMENTATION_DONE_MARKER}\`.`,
	].join("\n");
}

export function reReviewPrompt(baseCommit: string | undefined): string {
	return [
		"[/build: RE-REVIEW] You are the expert reviewer again. The implementer addressed the must-fix findings of your",
		"review and of the other expert reviewer's.",
		`Check each of your must-fix findings is resolved (or rightly rejected), using ${diffCommand(baseCommit)} and the changed files,`,
		"rerun the checks, and look for new problems the fixes introduced. Do not edit any file.",
		"Use the same report format as your review.",
		`End with the line \`${REVIEW_FIX_MARKER}\` if anything must still be fixed, otherwise \`${REVIEW_PASS_MARKER}\`.`,
	].join("\n");
}

const MAX_QUOTED_ANSWER_CHARS = 6000;

/** Keeps the end of a long answer, where the question and the marker are. */
function quoteAnswerEnd(answer: string): string {
	const trimmed = answer.trim();
	if (trimmed.length <= MAX_QUOTED_ANSWER_CHARS) return trimmed;
	return `…${trimmed.slice(trimmed.length - MAX_QUOTED_ANSWER_CHARS)}`;
}

/** Sent to the planner when an implementer stops without finishing; asker names it when several work in parallel. */
export function plannerQuestionPrompt(implementerAnswer: string, asker?: string): string {
	return [
		`[/build: IMPLEMENTER QUESTION] ${asker ?? "The implementer"} stopped before finishing. Its last reply:`,
		"",
		quoteAnswerEnd(implementerAnswer),
		"",
		"Answer it from the plan and what we agreed. Investigate the code if needed, but do not edit files.",
		`- If you can answer, write the answer for the implementer and end with the line \`${PLANNER_ANSWER_READY_MARKER}\`.`,
		"- If it needs a decision only I can make (a business rule, a production target, a change of scope), ask me,",
		`  and end with the line \`${PLANNER_NEEDS_USER_MARKER}\`. Once I reply, answer the implementer as above.`,
	].join("\n");
}

export function plannerAnswerPrompt(answer: string): string {
	return [
		"[/build: ANSWER FROM THE PLANNER]",
		"",
		answer.trim(),
		"",
		`Continue the implementation. End your reply with \`${IMPLEMENTATION_DONE_MARKER}\` when done, or with`,
		`\`${IMPLEMENTATION_BLOCKED_MARKER}: <your question>\` if you are stuck again.`,
	].join("\n");
}

/** Sent to a subagent restarted on its session: after Pi was reloaded, it crashed, or you restarted it. */
export function resumePrompt(): string {
	return [
		"[/build: RESUME] Your previous run was interrupted (stopped, crashed or Pi reloaded). Check the current state of the work,",
		"continue where you left off, and end your reply with the marker line your instructions ask for.",
	].join("\n");
}

/**
 * Sent to the implementer when the plan changed during the run: the full new plan, and the findings of a review
 * of the previous version when there was one.
 */
export function planChangePrompt(
	planPath: string,
	plan: string,
	planIssue: TrackedIssue | undefined,
	reviewFindings?: string,
	assignment?: StreamAssignment,
): string {
	const findings = reviewFindings?.trim()
		? [
				"",
				"## Review of the previous version",
				"",
				"The reviewers checked the work against the old plan. Fix their must-fix findings that still apply to the new plan:",
				"",
				reviewFindings.trim(),
			]
		: [];
	return [
		`[/build: PLAN CHANGED] I agreed to a change of the plan (saved at ${planPath}${planIssue ? `, and in issue #${planIssue.number}` : ""}).`,
		"Bring the implementation in line with the updated plan below: change what the update changes, keep the work that",
		"still matches it. Follow the same rules and code style as in your original brief, do not commit, and rerun the",
		"typecheck, lint and test commands. Then both expert reviewers review the work against the new plan.",
		"",
		...assignmentLines(assignment),
		"## Updated plan",
		"",
		plan.trim(),
		...findings,
		"",
		`Report what you changed for the update. End your reply with \`${IMPLEMENTATION_DONE_MARKER}\`, or with`,
		`\`${IMPLEMENTATION_BLOCKED_MARKER}: <your question>\` if the change is unclear.`,
	].join("\n");
}

const STAGE_ROLES: Record<StageRecord["stage"], string> = {
	implement: "Implementer",
	review: "Reviewer",
	fix: "Fixer",
	"re-review": "Re-reviewer",
};

/** "Claude reviewer", "OpenAI re-reviewer", "Implementer", "Implementer 2 (fix)". */
export function stageRoleName(stage: StageRecord["stage"], reviewer: ReviewerVendor | undefined, agent?: StageRecord["agent"]): string {
	if (agent && !reviewer) return stage === "fix" ? `${SUBAGENT_NAMES[agent]} (fix)` : SUBAGENT_NAMES[agent];
	if (!reviewer) return STAGE_ROLES[stage];
	const vendorName = REVIEWER_NAMES[reviewer].replace(/ reviewer$/, "");
	return `${vendorName} ${STAGE_ROLES[stage].toLowerCase()}`;
}

function isReview(stage: StageRecord): boolean {
	return stage.stage === "review" || stage.stage === "re-review";
}

/** Each reviewer's report from the last review stage (a single reviewer's in runs from before two reviewers). */
function lastReviews(stages: readonly StageRecord[]): StageRecord[] {
	const lastReview = stages.findLast(isReview);
	if (!lastReview) return [];
	const latestByReviewer = new Map<string, StageRecord>();
	for (const stage of stages) {
		if (stage.stage === lastReview.stage) latestByReviewer.set(stage.reviewer ?? "", stage);
	}
	return [...latestByReviewer.values()];
}

function formatMinutes(durationMs: number): string {
	const totalSeconds = Math.round(durationMs / 1000);
	return totalSeconds < 60 ? `${totalSeconds}s` : `${Math.floor(totalSeconds / 60)}m ${totalSeconds % 60}s`;
}

/** Posted in the planner's session when a run ends: who did what, the changes, and the last review. */
export function runReport(summary: string, stages: readonly StageRecord[], changes: string | undefined): string {
	const rows = stages.map((stage) => {
		const model = stage.model ? `${stage.model}${stage.thinkingLevel ? ` · ${stage.thinkingLevel}` : ""}` : "unknown";
		return `| ${stageRoleName(stage.stage, stage.reviewer, stage.agent)} | ${model} | ${formatMinutes(stage.activeMs)} | $${stage.costUsd.toFixed(2)} |`;
	});
	const reviewReports = lastReviews(stages).flatMap((review) => [
		"",
		`### ${stageRoleName(review.stage, review.reviewer)}'s report`,
		"",
		review.report.trim(),
	]);
	return [
		`**/build finished: ${summary}.**`,
		...(changes ? ["", `Changes: ${changes}`] : []),
		"",
		"| Agent | Model | Time | Cost |",
		"| --- | --- | --- | --- |",
		...rows,
		...reviewReports,
	].join("\n");
}
