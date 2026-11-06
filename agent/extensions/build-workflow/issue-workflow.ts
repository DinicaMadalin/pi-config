/**
 * /issue: work on a GitHub issue on a new branch from the default branch. The expert investigates instead of
 * planning; after a passing review, /issue pr commits, pushes and opens a draft PR that fixes the issue.
 */
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { createIssueBranch, fetchIssue, openDraftPullRequest, parseIssueArgument } from "./github-issue.ts";
import { useAutoModel } from "./planner-model.ts";
import type { PlannerSession } from "./planner-session.ts";
import { issueInvestigationPrompt } from "./workflow-prompts.ts";

export const ISSUE_USAGE = "Usage: /issue <github issue url | #123 | 123> | /issue pr";

export async function startIssueWorkflow(session: PlannerSession, issueText: string, ctx: ExtensionCommandContext): Promise<void> {
	const issueArgument = parseIssueArgument(issueText);
	if (!issueArgument) {
		ctx.ui.notify(ISSUE_USAGE, "warning");
		return;
	}
	const issue = await fetchIssue(session.run, issueArgument);
	if (!issue.ok) {
		ctx.ui.notify(issue.error, "error");
		return;
	}
	if (!(await useAutoModel(session.pi, ctx))) return;
	const issueRef = await createIssueBranch(session.run, issue.value);
	if (!issueRef.ok) {
		ctx.ui.notify(issueRef.error, "error");
		return;
	}
	ctx.ui.notify(`On new branch ${issueRef.value.branch} from origin/${issueRef.value.baseBranch}`, "info");
	session.enterPhase({ phase: "plan", task: `Fix issue #${issue.value.number}: ${issue.value.title}`, issue: issueRef.value });
	session.pi.sendUserMessage(issueInvestigationPrompt(issue.value, issueRef.value.branch));
}

/** Prefills /issue pr, so opening the PR is one Enter away but still your decision. */
export function promptForPullRequest(session: PlannerSession): void {
	const workflow = session.workflow;
	if (!session.hasUI || workflow.phase !== "awaiting-pr") return;
	session.context.ui.setEditorText("/issue pr");
	session.notify(`Review passed. Press Enter to commit, push ${workflow.issue.branch} and open a draft PR fixing #${workflow.issue.number}.`, "info");
}

export async function openPullRequest(session: PlannerSession, ctx: ExtensionCommandContext, endRun: (summary: string) => void): Promise<void> {
	const workflow = session.workflow;
	if (workflow.phase !== "awaiting-pr") {
		ctx.ui.notify("No reviewed issue fix to open a PR for; /issue <issue> starts one", "warning");
		return;
	}
	const plan = session.readPlan(workflow.planPath);
	if (plan === undefined) return;
	const pullRequest = await openDraftPullRequest(session.run, workflow.issue, plan);
	if (!pullRequest.ok) {
		ctx.ui.notify(`${pullRequest.error}. Fix it and run /issue pr again.`, "error");
		return;
	}
	endRun(`draft PR opened: ${pullRequest.value}`);
}
