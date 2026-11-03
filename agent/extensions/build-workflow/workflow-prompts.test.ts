import assert from "node:assert/strict";
import { test } from "node:test";
import { fixPrompt, implementationBrief, issueInvestigationPrompt, planningPrompt, reviewPrompt } from "./workflow-prompts.ts";

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
	assert.match(brief, /## How to write the code/);
	assert.match(brief, /IMPLEMENTATION: done`\.$/);
});

test("the brief still names a fallback when the repo has no rule files", () => {
	assert.match(implementationBrief("p.md", "plan", []), /No AGENTS\.md or CLAUDE\.md was found/);
});

test("the review diffs against the commit implementation started from", () => {
	const prompt = reviewPrompt("p.md", "abc123", []);
	assert.match(prompt, /git diff abc123/);
	assert.match(prompt, /REVIEW_VERDICT: pass/);
});

test("the fix request quotes the review findings", () => {
	const prompt = fixPrompt("Must fix\n1. price.js:4 rounds wrong\nREVIEW_VERDICT: fix");
	assert.match(prompt, /price\.js:4 rounds wrong/);
	assert.match(prompt, /IMPLEMENTATION: done`\.$/);
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
