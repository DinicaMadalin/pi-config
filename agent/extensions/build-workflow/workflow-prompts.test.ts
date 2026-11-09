import assert from "node:assert/strict";
import { test } from "node:test";
import {
	fixPrompt,
	fixStepsPrompt,
	implementationBrief,
	issueInvestigationPrompt,
	plannerQuestionPrompt,
	planningPrompt,
	reReviewPrompt,
	reviewPrompt,
	runReport,
} from "./workflow-prompts.ts";

test("the planner is told not to edit and to save the plan only after agreement", () => {
	const prompt = planningPrompt("add rate limiting");
	assert.match(prompt, /Task: add rate limiting/);
	assert.match(prompt, /Do not edit any file/);
	assert.match(prompt, /save_agreed_plan/);
});

test("the implementation brief carries the plan, the rule files, the code style, and the done marker", () => {
	const brief = implementationBrief("/r/.scratch/handoffs/p.md", "# Rate limiting\n## Goal\nLimit it", ["/r/AGENTS.md"]);
	assert.match(brief, /## What to implement\n\n# Rate limiting/);
	assert.match(brief, /- \/r\/AGENTS\.md/);
	assert.match(brief, /## Scope and rules/);
	assert.match(brief, /IMPLEMENTATION: done`\.$/);
});

test("the implementer takes a baseline, self-reviews its diff against the run's start, and reports honestly", () => {
	const brief = implementationBrief("p.md", "plan", [], undefined, undefined, undefined, "abc123");
	assert.match(brief, /Take a baseline/);
	assert.match(brief, /`git diff abc123`, read your whole diff/);
	assert.match(brief, /## Review checklist \(yours before you report, the reviewers' after\)/);
	assert.match(brief, /Never claim a command you did not run/);
});

test("reviewers keep the repo read-only, need evidence to block, and never block on suggestions", () => {
	const prompt = reviewPrompt("p.md", "abc123", []);
	assert.match(prompt, /The repo is read-only for you/);
	assert.match(prompt, /under \/tmp/);
	assert.match(prompt, /Every must-fix finding needs evidence/);
	assert.match(prompt, /Suggestions never block/);
});

test("the re-review sees each implementer's reply and blocks no new nitpicks", () => {
	const prompt = reReviewPrompt("abc123", [{ implementerName: "Implementer 2", reply: "Rejected 2: the caller already checks it" }]);
	assert.match(prompt, /### Implementer 2\n\nRejected 2: the caller already checks it/);
	assert.match(prompt, /Do not raise new nitpicks/);
	assert.doesNotMatch(reReviewPrompt("abc123"), /replies to the findings/);
});

test("the planner answers questions decisively without saving the plan mid-answer", () => {
	const prompt = plannerQuestionPrompt("Which currency?\nIMPLEMENTATION: blocked: EUR or USD?", "Implementer 2");
	assert.match(prompt, /Implementer 2 stopped before finishing/);
	assert.match(prompt, /Be decisive/);
	assert.match(prompt, /Do not save the plan while answering/);
});

test("the brief still names a fallback when the repo has no rule files", () => {
	assert.match(implementationBrief("p.md", "plan", []), /No AGENTS\.md or CLAUDE\.md was found/);
});

test("the review diffs against the commit implementation started from", () => {
	const prompt = reviewPrompt("p.md", "abc123", []);
	assert.match(prompt, /git diff abc123/);
	assert.match(prompt, /REVIEW_VERDICT: pass/);
});

test("the fix request gives the planner's fix steps and quotes the review for context", () => {
	const prompt = fixPrompt("Must fix\n1. price.js:4 rounds wrong\nREVIEW_VERDICT: fix", "1. In price.js:4 use Math.round on cents");
	assert.match(prompt, /Math\.round on cents/);
	assert.match(prompt, /price\.js:4 rounds wrong/);
	assert.match(prompt, /IMPLEMENTATION: done`\.$/);
});

test("the planner is asked to verify the findings and write steps per implementer", () => {
	const prompt = fixStepsPrompt("a.ts:3 off by one", [
		{ implementerName: "Implementer", streamName: "API" },
		{ implementerName: "Implementer 2", streamName: "Tests" },
	]);
	assert.match(prompt, /a\.ts:3 off by one/);
	assert.match(prompt, /Implementer 2: owns the files of the "Tests" stream/);
	assert.match(prompt, /IMPLEMENTER_ANSWER: ready/);
});

test("issue prompts carry the issue to the investigator, implementer and reviewer", () => {
	const githubIssue = { number: 42, title: "Crash", url: "https://x/42", body: "Steps...", labels: ["bug"], comments: [{ author: "ann", body: "Me too" }] };
	const investigation = issueInvestigationPrompt(githubIssue, "issue-42-crash");
	for (const expected of ["#42: Crash", "Steps...", "Labels: bug", "Comment by ann", "issue-42-crash", "save_agreed_plan"]) {
		assert.ok(investigation.includes(expected), expected);
	}
	const issueRef = { number: 42, title: "Crash", url: "https://x/42", branch: "issue-42-crash", baseBranch: "main" };
	assert.ok(implementationBrief("/p.md", "# plan", [], issueRef).includes("GitHub issue #42"));
	assert.ok(reviewPrompt("/p.md", "abc", [], issueRef).includes("a test reproduces the issue"));
	assert.ok(!reviewPrompt("/p.md", "abc", []).includes("GitHub issue"));
});

test("with a plan issue, the implementer and reviewer read the plan from GitHub", () => {
	const planIssue = { number: 9, title: "Add CSV export", url: "https://github.com/acme/shop/issues/9" };
	const brief = implementationBrief("/p.md", "# Add CSV export", [], undefined, planIssue);
	assert.ok(brief.includes("`gh issue view 9 --json title,body,comments`"));
	assert.ok(brief.includes("# Add CSV export"), "keeps the plan inline for when gh is unavailable");
	assert.ok(reviewPrompt("/p.md", "abc", [], undefined, planIssue).includes("Review it against GitHub issue #9"));
	assert.ok(!implementationBrief("/p.md", "# plan", []).includes("gh issue view"));
});

test("the planner writes the problem first and nothing secret, since the plan may become an issue", () => {
	const prompt = planningPrompt("add export");
	assert.ok(prompt.includes("Goal: start with the problem"));
	assert.ok(prompt.includes("no secrets"));
});

test("the run report names each reviewer and quotes both reports of the last review", () => {
	const record = { thinkingLevel: "high", activeMs: 60_000, costUsd: 0.5 };
	const report = runReport("both reviewers passed it", [
		{ ...record, stage: "implement", model: "gpt-6-luna", report: "done" },
		{ ...record, stage: "review", reviewer: "anthropic", model: "claude-opus-5-5", report: "old claude" },
		{ ...record, stage: "review", reviewer: "openai", model: "gpt-6-astra", report: "old openai" },
		{ ...record, stage: "re-review", reviewer: "openai", model: "gpt-6-astra", report: "openai ok" },
		{ ...record, stage: "re-review", reviewer: "anthropic", model: "claude-opus-5-5", report: "claude ok" },
	], undefined);
	assert.ok(report.includes("| Claude reviewer | claude-opus-5-5 · high |"), report);
	assert.ok(report.includes("### OpenAI re-reviewer's report\n\nopenai ok"), report);
	assert.ok(report.includes("### Claude re-reviewer's report\n\nclaude ok"), report);
	assert.ok(!report.includes("old claude"), report);
});
