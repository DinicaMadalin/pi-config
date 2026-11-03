/**
 * The messages each /build phase sends. Pure text builders, so they can be read and tested in one place.
 */
import {
	IMPLEMENTATION_BLOCKED_MARKER,
	IMPLEMENTATION_DONE_MARKER,
	REVIEW_FIX_MARKER,
	REVIEW_PASS_MARKER,
} from "./workflow-state.ts";

const SAVE_PLAN_TOOL_NAME = "save_agreed_plan";

function listRuleFiles(ruleFilePaths: readonly string[]): string {
	if (ruleFilePaths.length === 0) return "- No AGENTS.md or CLAUDE.md was found; follow the conventions of the surrounding code.";
	return ruleFilePaths.map((path) => `- ${path}`).join("\n");
}

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
		"3. Discuss with me until I explicitly agree with both the goal and the approach. Do not edit any file in this phase.",
		`4. Once I agree, call ${SAVE_PLAN_TOOL_NAME}. The plan is the implementer's only brief, so write it for a capable`,
		"   developer who has never seen this repo:",
		"   - Approach: numbered steps in order, each naming the file, the functions or types to add or change with their",
		"     signatures, the data shapes, the error and edge cases, and the tests to add with their names.",
		"   - Constraints: the repo rules that matter here, and the local conventions to imitate (naming, error handling,",
		"     test style), each with an existing file to copy the style from.",
		"   - Acceptance criteria: the observable behavior plus the exact typecheck, lint and test commands.",
		"   - Files: every file to create or change, one line each.",
		"5. After saving, tell me the plan path and that `/build implement` starts the implementation.",
	].join("\n");
}

export function implementationBrief(planPath: string, plan: string, ruleFilePaths: readonly string[]): string {
	return [
		"[/build, phase 2 of 3: IMPLEMENT] You are the implementer. An expert planned this work with me and I agreed to the",
		`plan below (saved at ${planPath}). Implement exactly this plan. An expert reviews your work against it afterwards.`,
		"",
		"## What to implement",
		"",
		plan.trim(),
		"",
		"## How to implement it",
		"",
		"1. Read every file listed in the plan, and the files it says to imitate, before changing anything.",
		"2. Work through the Approach steps in order. After each step, make sure it still typechecks.",
		"3. Add the tests the plan names. A bug fix starts with a failing test that reproduces the bug.",
		"4. Run the typecheck, lint and test commands from the Acceptance criteria and fix what you broke.",
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
		`  ask me, and end your reply with the line \`${IMPLEMENTATION_BLOCKED_MARKER}: <your question>\`.`,
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

export function reviewPrompt(planPath: string, baseCommit: string | undefined, ruleFilePaths: readonly string[]): string {
	return [
		"[/build, phase 3 of 3: REVIEW] You are the expert reviewer. The implementer says the work is done.",
		`Review it against the agreed plan at ${planPath}. Do not edit any file.`,
		"",
		`1. Read the plan. Run \`git status\` and ${diffCommand(baseCommit)}, and read new untracked files and every changed`,
		"   file in full, not only the diff hunks.",
		"2. Run the typecheck, lint and test commands from the plan's Acceptance criteria.",
		"3. Check, in this order:",
		"   - Plan: every Approach step is done, nothing outside the plan changed, the acceptance criteria hold.",
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
export function fixPrompt(reviewReport: string): string {
	return [
		"[/build: FIX] You are the implementer again. Fix every must-fix finding of this review:",
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
		"[/build: RE-REVIEW] You are the expert reviewer again. The implementer addressed your review.",
		`Check each must-fix finding is resolved (or rightly rejected), using ${diffCommand(baseCommit)} and the changed files,`,
		"rerun the checks, and look for new problems the fixes introduced. Do not edit any file.",
		"Use the same report format as your review.",
		`End with the line \`${REVIEW_FIX_MARKER}\` if anything must still be fixed, otherwise \`${REVIEW_PASS_MARKER}\`.`,
	].join("\n");
}
