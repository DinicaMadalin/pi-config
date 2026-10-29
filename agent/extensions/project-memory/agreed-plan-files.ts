/**
 * Agreed plan files: once the user and the agent agree on the goal and how to reach it, the plan
 * is saved as a final markdown file under `<repo>/.scratch/handoffs/`. It can then seed a fresh
 * session that executes it without the discussion that led to it.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { excludeScratchFromGit } from "./project-notes.ts";

export const HANDOFFS_RELATIVE_DIR = join(".scratch", "handoffs");
export const SAVE_PLAN_TOOL_NAME = "save_agreed_plan";
const MAX_SLUG_CHARS = 48;

export const AGREED_PLAN_SECTIONS = `## Goal
What the user wants and why, in their terms. Quote short user requirements exactly.
## Approach
How it will be done, as ordered steps.
## Decisions
Each decision with its reason, including options that were rejected and why.
## Constraints
Hard limits: compatibility, no new dependencies, style rules, things never to touch.
## Out of scope
What was explicitly left out.
## Acceptance criteria
How to tell it is done: behavior, tests, and commands that must pass.
## Files
Files to create or change, full paths, one line each on what changes.
## Open questions
Anything still undecided; "None" when everything is settled.`;

/** The newest plan the agent saved in this conversation, if its file still exists. */
export function findSavedPlanPath(messages: AgentMessage[]): string | undefined {
	for (const message of [...messages].reverse()) {
		if (message.role !== "toolResult" || message.toolName !== SAVE_PLAN_TOOL_NAME || message.isError) continue;
		const planPath = (message.details as { planPath?: unknown } | undefined)?.planPath;
		if (typeof planPath === "string" && existsSync(planPath)) return planPath;
	}
	return undefined;
}

export function slugFromTitle(title: string): string {
	const slug = title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, MAX_SLUG_CHARS)
		.replace(/-+$/, "");
	return slug || "plan";
}

/** "# Title" on the first line names the file; the timestamp keeps names unique and sorted. */
export function planFileName(plan: string, savedAt: Date): string {
	const title = /^#\s+(.+)$/m.exec(plan)?.[1] ?? "plan";
	const fileStamp = savedAt.toISOString().slice(0, 16).replace(/[:T]/g, "-");
	return `${fileStamp}-${slugFromTitle(title)}.md`;
}

export function saveAgreedPlan(projectRoot: string, plan: string, savedAt: Date): string {
	const handoffsDir = join(projectRoot, HANDOFFS_RELATIVE_DIR);
	mkdirSync(handoffsDir, { recursive: true });
	excludeScratchFromGit(projectRoot);
	const planPath = join(handoffsDir, planFileName(plan, savedAt));
	writeFileSync(planPath, `${plan.trim()}\n`);
	return planPath;
}

export function readPlan(planPath: string): string {
	return readFileSync(planPath, "utf8");
}

export function updatePlan(planPath: string, plan: string): void {
	writeFileSync(planPath, `${plan.trim()}\n`);
}

export function executePlanPrompt(planPath: string, plan: string): string {
	return `Execute this agreed plan (${planPath}). It is final: follow it, and stop to ask before deviating. Check the current state of the files first.\n\n${plan}`;
}
