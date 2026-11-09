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
import { MAX_IMPLEMENTERS, STRONG_MODEL_MARKER, WORK_STREAMS_HEADING, type WorkStream } from "./work-streams.ts";
import { SAVE_PLAN_TOOL_NAME } from "../project-memory/agreed-plan-files.ts";
import type { GithubIssue } from "./github-issue.ts";

function listRuleFiles(ruleFilePaths: readonly string[]): string {
	if (ruleFilePaths.length === 0) return "- No AGENTS.md or CLAUDE.md was found; follow the conventions of the surrounding code.";
	return ruleFilePaths.map((path) => `- ${path}`).join("\n");
}

/** Steps 3 to 5 of planning: agreement, then a plan the implementer can follow without this conversation. */
const AGREE_AND_SAVE_PLAN_STEPS = [
	"3. Discuss with me until I explicitly agree with both the goal and the approach. Do not edit any file in this phase.",
	`4. Once I agree, call ${SAVE_PLAN_TOOL_NAME}. The plan is the implementers' only brief, and they run on cheaper models`,
	"   that follow instructions well but should not have to design anything. So you do the thinking: write the plan",
	"   implementation-ready, for a capable developer who has never seen this repo. It may be posted as a GitHub issue,",
	"   so it must stand on its own and hold no secrets, tokens or personal data:",
	"   - Goal: start with the problem (what is wrong or missing, why it matters, how to see it), then the result we want.",
	"   - Approach: small numbered steps in order, each one change an implementer can make and check on its own. Each",
	"     step names the file, the exact functions or types to add or change with their full signatures, the data shapes,",
	"     the behavior on each edge case and error (with the exact error messages), and where the logic is subtle, the",
	"     algorithm or a short code sketch. Leave no decision open: if you catch yourself writing \"decide\", \"choose\",",
	"     \"handle appropriately\" or \"as needed\", make the decision in the plan.",
	"   - Tests: each test with its name, its input and the exact expected result, including the edge cases and failures.",
	"   - Constraints: the repo rules that matter here, and the local conventions to imitate (naming, error handling,",
	"     test style), each with an existing file to copy the style from.",
	"   - Acceptance criteria: the observable behavior plus the exact typecheck, lint and test commands.",
	"   - Files: every file to create or change, one line each.",
	`   - Work streams (optional): up to ${MAX_IMPLEMENTERS} implementers can build in parallel, in the same folder. When the work`,
	`     splits into parts that touch different files, add a \`${WORK_STREAMS_HEADING}\` section with one \`### <short name>\``,
	"     subsection per part: the files it owns and its Approach steps. No file may be in two streams. Use one stream",
	"     (no section) when the parts would share files or the work is small. In a later plan of this session, keep the",
	"     names of the streams that continue, so the implementer that built a stream keeps building it with its context.",
	`   - Strong model (rare): an implementer gets a cheap model unless its stream's heading ends with \`${STRONG_MODEL_MARKER}\`.`,
	"     Mark a stream only when its steps still need real design work you cannot spell out (a tricky concurrency or",
	"     algorithm change); a hard task with exact steps does not need it. For a plan without streams, add the section",
	"     with a single stream to mark it.",
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

/**
 * What a careful reviewer checks. The implementer walks it over its own diff before reporting, and the reviewers walk
 * it over the work, so both sides aim at the same bar.
 */
const REVIEW_CHECKLIST = [
	"- Plan: every Approach step is done, nothing outside the plan changed, and the acceptance criteria hold.",
	"- Correctness: trace each changed path with the ugly inputs: empty, missing, duplicate, boundary values, wrong type,",
	"  a failing dependency, a repeated or concurrent call. Errors are never swallowed, and their messages name the",
	"  failed action and the useful detail.",
	"- Callers: every caller of a changed function, type or data shape still works (search for them). Public behavior,",
	"  APIs and stored data shapes change only where the plan says so.",
	"- Tests: each new test states a rule and would fail if the code were wrong (picture the likely bug: would a test",
	"  catch it?). They cover the happy path, an edge case and a failure, and assert behavior, not implementation lines.",
	"- Security: no secrets, tokens or personal data in code or logs; no SQL, shell commands or HTML built from raw",
	"  input; authorization checked where the plan needs it.",
	"- Clarity and rules: the repo's rule files, names that say what things are, no dead code, debug prints, unused",
	"  imports or comments that repeat the code.",
];

function indented(lines: readonly string[], indent: string): string[] {
	return lines.map((line) => `${indent}${line}`);
}

function ruleFileLines(ruleFilePaths: readonly string[]): string[] {
	return listRuleFiles(ruleFilePaths).split("\n");
}

const CODE_QUALITY_RULES = [
	"- Match the style of the surrounding code and of the files the plan points to.",
	"- Names say what the thing is in the domain, with the unit when it matters (`timeoutMs`, `priceCents`).",
	"  Never vague names like data, value, item, temp, res, handler, util. Functions are verb plus thing.",
	"- One function, one reason to change. Early returns and named steps over nested branches.",
	"- Parse unknown input at the edge into a domain type; after that, trust the type.",
	"- Never swallow an error. Error messages name the failed action and the useful detail.",
	"- No dead code, debug prints, unused imports, or comments that repeat the code. Comment only a hidden why.",
];

const HONEST_REPORTING = "Never claim a command you did not run or a result you did not see; say what you could not verify.";

export function implementationBrief(
	planPath: string,
	plan: string,
	ruleFilePaths: readonly string[],
	issue?: IssueRef,
	planIssue?: TrackedIssue,
	assignment?: StreamAssignment,
	baseCommit?: string,
): string {
	return [
		"[/build, phase 2 of 3: IMPLEMENT] You are the implementer: a senior engineer who owns this change end to end.",
		`An expert planned it with me and I agreed to the plan below (saved at ${planPath}). Afterwards two expert reviewers`,
		"from different AI vendors review your work against the plan, independently, and they verify every claim you make.",
		"Your goal: both pass it on the first round. That takes correct code, tests that prove it, and an honest report,",
		"not speed.",
		"",
		...issueLine(issue),
		...assignmentLines(assignment),
		"## What to implement",
		"",
		...planSourceLines(planPath, planIssue),
		plan.trim(),
		"",
		"## How to work",
		"",
		"1. Understand before you change. Read the whole plan, then every file it lists and the files it says to imitate.",
		"   For each function, type or data shape you will change, find its callers and its tests (`rg -n <name>`), so you",
		"   know what else depends on it.",
		"2. Take a baseline. Before your first edit, run the plan's typecheck, lint and test commands once and note what",
		"   already fails. Those failures are pre-existing: list them in your report, and fix them only if the plan says so.",
		"3. Turn the plan's Approach into a checklist and work through it in order. After each step run the narrowest check",
		"   that covers it (the typecheck, the one test file) before moving on: small verified steps, not one big leap.",
		"4. Write the tests the plan names. Each one states a rule and would fail if the code were wrong. A bug fix starts",
		"   with a test that fails before the fix. Never delete, skip or loosen a test to get green.",
		"5. When something surprises you (the code differs from the plan, a check fails for a reason you do not understand),",
		"   find the cause before working around it. Never special-case code for a test's inputs.",
		"6. Run the full typecheck, lint and test commands again and fix everything your change broke.",
		`7. Review yourself the way the reviewers will: run \`git status\` and ${diffCommand(baseCommit)}, read your whole diff,`,
		"   and walk the review checklist below over it. Fix what you find before you report.",
		"8. Do not commit. The reviewers diff your uncommitted changes.",
		"",
		"## Ask instead of guessing",
		"",
		"- First try to answer a doubt from the plan and the code. Ask when the plan is ambiguous, contradicts the code, or",
		"  would make you guess a business rule.",
		"- A good question lets the planner answer in one turn: what you found (with file:line), the options you see, and",
		"  the one you recommend and why. Write it, then end your reply with the line",
		`  \`${IMPLEMENTATION_BLOCKED_MARKER}: <your question>\`. The planner who wrote the plan answers you.`,
		"- Never deviate silently. If you must deviate from the plan, say where and why in your report.",
		"",
		"## Scope and rules",
		"",
		"- Change only what the plan needs: no drive-by refactors, renames, or reformatting. Mention other problems you",
		"  see in your report instead of fixing them.",
		"- The coding rules in these files apply in full. They are in your context; reread them if unsure:",
		...indented(ruleFileLines(ruleFilePaths), "  "),
		...CODE_QUALITY_RULES,
		"",
		"## Review checklist (yours before you report, the reviewers' after)",
		"",
		...REVIEW_CHECKLIST,
		"",
		"## Your report",
		"",
		"- Summary: one or two sentences.",
		"- Plan checklist: each Approach step as done, deviated (where and why) or not done (why).",
		"- Changes: per file, what changed and why.",
		"- Checks: each command you ran with its real result; the baseline failures separately.",
		"- Risks: what the reviewers should look at closely, and what you could not verify.",
		HONEST_REPORTING,
		`End your reply with the line \`${IMPLEMENTATION_DONE_MARKER}\`.`,
	].join("\n");
}

function diffCommand(baseCommit: string | undefined): string {
	return baseCommit ? `\`git diff ${baseCommit}\`` : "`git diff HEAD`";
}

/** What a reviewer may do: read the repo, run checks, and try to break the code from outside the repo. */
const REVIEWER_GROUND_RULES = [
	"- The repo is read-only for you: do not edit, create or format files in it, and run no command that rewrites them",
	"  (formatters in fix mode, code generators, git checkout or stash). To try to break the code you may write",
	"  throwaway scripts or tests under /tmp and run them against the repo. Make their folder with `mktemp -d` and leave",
	"  it there: deleting (rm -rf) asks the user for permission and stalls the review.",
	"- Every must-fix finding needs evidence: a command with its failing output, a reproduction you ran, or a code path",
	"  you traced step by step with file:line. A suspicion you could not confirm goes under Unverified concerns.",
	"- Do not take the implementer's report on trust. Check its claims; a claim that does not match what you see is a",
	"  finding.",
];

const REVIEW_SEVERITY = [
	"- Must fix: wrong or crashing behavior, a plan step missing or done differently without a good reason, a check",
	"  that fails because of the change, a test that does not test what it claims, a break of a hard rule in the rule",
	"  files, a security or data-loss risk.",
	"- Suggestion: everything else, including style the rules do not ask for. Suggestions never block.",
	"- Pre-existing: problems that were there before the change. Report them; they never block.",
];

function reviewReportFormat(verdictLine: string): string[] {
	return [
		`- Verdict: one line, ${verdictLine}.`,
		"- Plan coverage: each Approach step as done, missing or different.",
		"- Checks: each command you ran with its result.",
		"- Must fix: for each finding, file:line, what is wrong, the evidence, and the concrete fix.",
		"- Suggestions, then Pre-existing, then Unverified concerns (each may be empty).",
		HONEST_REPORTING,
	];
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
		? [`- Issue: the change fixes issue #${issue.number}'s root cause, and a test reproduces the issue and now passes.`]
		: [];
	return [
		"[/build, phase 3 of 3: REVIEW] You are an expert code reviewer and the last gate before this work ships. The",
		"implementer says it is done. Assume the work has bugs until you have looked; your job is to find every real",
		"problem, and to block only on real problems. An expert from another AI vendor reviews the same work in parallel:",
		"review on your own.",
		`Review it against ${planSource}.`,
		"",
		...issueLine(issue),
		"## Ground rules",
		"",
		...REVIEWER_GROUND_RULES,
		"",
		"## How to review",
		"",
		"1. Read the plan and turn its Approach steps and Acceptance criteria into a checklist.",
		`2. Run \`git status\` and ${diffCommand(baseCommit)}. Read every changed and new file in full, not only the diff`,
		"   hunks, and the callers of every changed function, type or data shape (`rg -n <name>`).",
		"3. Run the plan's typecheck, lint and test commands yourself.",
		"4. Walk the checklist below. Then pick the riskiest change and try to break it: a probe under /tmp that feeds it",
		"   the ugly inputs, or a quick test that would fail if the code were wrong.",
		"",
		"## Review checklist",
		"",
		...issueCheck,
		...REVIEW_CHECKLIST,
		"- The rules in these files:",
		...indented(ruleFileLines(ruleFilePaths), "  "),
		"",
		"## Severity",
		"",
		...REVIEW_SEVERITY,
		"",
		"## Your report",
		"",
		...reviewReportFormat("pass, or fix with the number of must-fix findings"),
		`End with the line \`${REVIEW_FIX_MARKER}\` if anything must be fixed, otherwise \`${REVIEW_PASS_MARKER}\`.`,
	].join("\n");
}

/** The implementers a fix round has, so the planner can address its fix steps to each. */
export interface FixCrewMember {
	implementerName: string;
	/** Empty when one implementer builds the whole plan. */
	streamName: string;
}

/**
 * Sent to the planner when the reviewers ask for fixes: the implementers run on cheap models, so the planner checks
 * the findings and writes the exact steps they follow.
 */
export function fixStepsPrompt(reviewReport: string, crew: readonly FixCrewMember[]): string {
	const isSeveral = crew.length > 1;
	const grouping = isSeveral
		? [
				"4. Group the steps under one `### <Implementer name>` heading per implementer that has work, using these names:",
				...crew.map(({ implementerName, streamName }) => `   - ${implementerName}: owns the files of the "${streamName}" stream`),
				"   A finding in a file no stream owns goes to the implementer whose work it touches most.",
			]
		: ["4. Write the steps as one ordered list for the implementer."];
	return [
		"[/build: FIX STEPS] Both expert reviewers reviewed the implementation and asked for fixes; their reviews are below.",
		"The implementers run on cheaper models: they follow your fix steps exactly and design nothing themselves, so the",
		"thinking is yours.",
		"",
		reviewReport.trim(),
		"",
		"1. Check each must-fix finding against the code yourself: read it, and run a command or a probe under /tmp when",
		"   that settles it. Do not edit any file. A finding is real, or wrong (say why, with the evidence).",
		"2. For each real finding, fix the root cause, not the symptom. Write small ordered steps, each naming the file and",
		"   function, the exact change (show the code when it is short), and for a behavior bug the test to add first with",
		"   its input and expected result.",
		"3. Add the command that proves each fix, and the full check commands to run at the end. Include a suggestion only",
		"   when it is cheap and inside the plan's scope.",
		...grouping,
		"",
		`If a finding needs a decision only I can make (a business rule, a change of scope), ask me and end with the line`,
		`\`${PLANNER_NEEDS_USER_MARKER}\`; once I reply, write the steps. Otherwise end with the line \`${PLANNER_ANSWER_READY_MARKER}\`.`,
	].join("\n");
}

/** The fix round for one implementer: the planner's steps for it, with the reviews for context. */
export function fixPrompt(reviewReport: string, fixSteps: string, assignment?: StreamAssignment): string {
	const scope = assignment
		? [`These are your steps for the "${assignment.stream.name}" work stream; the other implementers fix the rest.`]
		: [];
	return [
		"[/build: FIX] You are the implementer again. Two expert reviewers reviewed your work, and the planner who wrote",
		"the plan checked their findings and wrote the exact fix steps below. They are your brief for this round.",
		...scope,
		"",
		"## Fix steps",
		"",
		fixSteps.trim(),
		"",
		"## The reviews, for context",
		"",
		reviewReport.trim(),
		"",
		"## How to fix",
		"",
		"1. Follow the steps in order, exactly. For a behavior bug, add the test first and see it fail, then fix.",
		"2. If a step does not match the code (the file, function or line differs) or would break something, do not",
		`   improvise: say what you found and ask (end with \`${IMPLEMENTATION_BLOCKED_MARKER}: <your question>\`).`,
		"3. Change nothing else, follow the same rules and code style as in your original brief, and do not commit.",
		"4. Rerun the full typecheck, lint and test commands, read your new diff, and walk the review checklist of your",
		"   brief over it.",
		"",
		"Report each step as done (and the test that covers it) or not done (why), then the checks you ran with their",
		`results. ${HONEST_REPORTING}`,
		`End your reply with the line \`${IMPLEMENTATION_DONE_MARKER}\`.`,
	].join("\n");
}

/** The implementers' replies to the findings, so a re-reviewer judges a rejection by its reasons. */
function fixReplyLines(fixReplies: readonly { implementerName: string; reply: string }[]): string[] {
	if (fixReplies.length === 0) return [];
	return [
		"## The implementers' replies to the findings",
		"",
		...fixReplies.flatMap(({ implementerName, reply }) => [`### ${implementerName}`, "", quoteAnswerEnd(reply), ""]),
	];
}

export function reReviewPrompt(baseCommit: string | undefined, fixReplies: readonly { implementerName: string; reply: string }[] = []): string {
	return [
		"[/build: RE-REVIEW] You are the expert reviewer again. The implementer answered the must-fix findings of your",
		"review and of the other expert reviewer's: each is fixed or rejected with reasons.",
		"",
		...fixReplyLines(fixReplies),
		"1. For each must-fix finding, yours and the other reviewer's, decide with evidence: resolved, rightly rejected, or",
		`   still open. Use ${diffCommand(baseCommit)} and the changed files; rerun a reproduction when you had one.`,
		"2. Rerun the typecheck, lint and test commands.",
		"3. Look for regressions: read the lines the fixes changed and their callers.",
		"4. Do not raise new nitpicks. Something you did not flag before blocks now only if it is a must-fix bug with",
		"   evidence. The same ground rules and severity as your review apply: the repo is read-only, probes go under /tmp.",
		"",
		"Report: the verdict line, each earlier must-fix finding with its status and evidence, new must-fix findings,",
		`and the checks you ran with their results. ${HONEST_REPORTING}`,
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
		"Answer it from the plan and what we agreed. Check the code it points to before you answer, but do not edit files.",
		"- Be decisive: give one clear answer, with the file:line or the exact behavior it needs, so it can go on without",
		"  asking again. If it found a real gap in the plan, say how to fill it.",
		"- If your answer changes what the plan asks for, say so plainly and tell it to list the change in its report as",
		"  agreed with the planner, so the reviewers do not flag it. Do not save the plan while answering.",
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
		"Before you report, read your whole diff again and walk the review checklist of your brief over it.",
		"Report like in your brief: the plan checklist against the updated plan, what you changed for the update per file,",
		`and the checks you ran with their results. ${HONEST_REPORTING}`,
		`End your reply with \`${IMPLEMENTATION_DONE_MARKER}\`, or with`,
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
