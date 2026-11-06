/**
 * Shipping a reviewed /build run after one confirmation: a new branch from HEAD, one commit, a normal push. Never
 * a merge or force push. A failed push keeps the commit; /build ship then only pushes.
 */
import { listFilesToShip, planTitle, shipBranchName, shipCommitMessage, shipWork } from "./github-issue.ts";
import type { PlannerSession } from "./planner-session.ts";

const MAX_SHIP_FILES_LISTED = 15;

function shipConfirmationText(branch: string, isCommitted: boolean, files: readonly string[]): string {
	const listed = files.slice(0, MAX_SHIP_FILES_LISTED).map((path) => `  ${path}`);
	const more = files.length > MAX_SHIP_FILES_LISTED ? [`  … and ${files.length - MAX_SHIP_FILES_LISTED} more`] : [];
	const action = isCommitted
		? `Pushes branch ${branch}, already committed${files.length > 0 ? `, after committing these ${files.length} changed files too` : ""}.`
		: `Creates branch ${branch} from the current HEAD, commits these ${files.length} files and pushes the branch to origin.`;
	return [action, "No merge, no force push.", "", ...listed, ...more].join("\n");
}

export class Shipping {
	private readonly session: PlannerSession;
	private readonly endRun: (summary: string) => void;
	private isShipping = false;

	constructor(session: PlannerSession, endRun: (summary: string) => void) {
		this.session = session;
		this.endRun = endRun;
	}

	async confirmAndShip(): Promise<void> {
		if (this.session.workflow.phase !== "awaiting-ship" || this.isShipping || !this.session.hasUI) return;
		this.isShipping = true;
		try {
			await this.ship();
		} finally {
			this.isShipping = false;
		}
	}

	private async ship(): Promise<void> {
		const workflow = this.session.workflow;
		if (workflow.phase !== "awaiting-ship") return;
		const { run, context } = this.session;
		const title = planTitle(this.session.readPlan(workflow.planPath) ?? "");
		const files = await listFilesToShip(run);
		const branch = workflow.committedBranch
			? { ok: true as const, value: workflow.committedBranch }
			: await shipBranchName(run, title, workflow.planIssue);
		if (!files.ok || !branch.ok) {
			this.session.notify(`${files.ok ? "" : files.error}${branch.ok ? "" : branch.error}. /build ship tries again.`, "error");
			return;
		}
		const isCommitted = workflow.committedBranch !== undefined;
		if (files.value.length === 0 && !isCommitted) {
			this.endRun("the review passed, but there are no changes to ship");
			return;
		}
		const isConfirmed = await context.ui.confirm("Review passed. Ship it?", shipConfirmationText(branch.value, isCommitted, files.value));
		if (!isConfirmed) {
			this.session.notify("Not shipped. /build ship when you are ready; /build stop ends the run.", "info");
			return;
		}
		if (this.session.workflow !== workflow) return;
		const commitMessage = shipCommitMessage(title, workflow.planIssue);
		const shipped = await shipWork(run, { branch: branch.value, commitMessage, isCommitted });
		switch (shipped.kind) {
			case "failed":
				this.session.notify(`${shipped.error}. Fix it and run /build ship again.`, "error");
				return;
			case "committed-not-pushed":
				this.session.enterPhase({ ...workflow, committedBranch: shipped.branch });
				this.session.notify(`${shipped.error}. The commit is on local branch ${shipped.branch}; /build ship pushes it.`, "error");
				return;
			case "shipped": {
				const closes = workflow.planIssue ? `; merging it closes issue #${workflow.planIssue.number}` : "";
				this.endRun(`shipped on branch ${shipped.branch}, pushed to origin${closes}`);
			}
		}
	}
}
