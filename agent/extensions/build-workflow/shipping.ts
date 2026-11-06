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

	/** Asks you, then ships; resolves to what happened, for the planner when it shipped on your request. */
	async confirmAndShip(): Promise<string> {
		const phase = this.session.workflow.phase;
		if (phase !== "awaiting-ship") return notReadyToShip(phase);
		if (this.isShipping) return "Shipping is already waiting for the user's confirmation";
		if (!this.session.hasUI) return "Shipping needs the user's confirmation, and this session has no UI";
		this.isShipping = true;
		try {
			return await this.ship();
		} finally {
			this.isShipping = false;
		}
	}

	private async ship(): Promise<string> {
		const workflow = this.session.workflow;
		if (workflow.phase !== "awaiting-ship") return notReadyToShip(workflow.phase);
		const { run, context } = this.session;
		const title = planTitle(this.session.readPlan(workflow.planPath) ?? "");
		const files = await listFilesToShip(run);
		const branch = workflow.committedBranch
			? { ok: true as const, value: workflow.committedBranch }
			: await shipBranchName(run, title, workflow.planIssue);
		if (!files.ok || !branch.ok) {
			const error = `${files.ok ? "" : files.error}${branch.ok ? "" : branch.error}`;
			this.session.notify(`${error}. /build ship tries again.`, "error");
			return `Not shipped: ${error}`;
		}
		const isCommitted = workflow.committedBranch !== undefined;
		if (files.value.length === 0 && !isCommitted) {
			this.endRun("the review passed, but there are no changes to ship");
			return "Nothing to ship: the working tree has no changes (were they committed already?). The run is finished.";
		}
		const isConfirmed = await context.ui.confirm("Review passed. Ship it?", shipConfirmationText(branch.value, isCommitted, files.value));
		if (!isConfirmed) {
			this.session.notify("Not shipped. /build ship when you are ready; /build stop ends the run.", "info");
			return "The user declined shipping for now. Do not commit or push yourself.";
		}
		if (this.session.workflow !== workflow) return "Not shipped: the run changed while the user was deciding";
		const commitMessage = shipCommitMessage(title, workflow.planIssue);
		const shipped = await shipWork(run, { branch: branch.value, commitMessage, isCommitted });
		switch (shipped.kind) {
			case "failed":
				this.session.notify(`${shipped.error}. Fix it and run /build ship again.`, "error");
				return `Shipping failed: ${shipped.error}`;
			case "committed-not-pushed":
				this.session.enterPhase({ ...workflow, committedBranch: shipped.branch });
				this.session.notify(`${shipped.error}. The commit is on local branch ${shipped.branch}; /build ship pushes it.`, "error");
				return `Committed on local branch ${shipped.branch}, but the push failed: ${shipped.error}`;
			case "shipped": {
				const closes = workflow.planIssue ? `; merging it closes issue #${workflow.planIssue.number}` : "";
				const summary = `shipped on branch ${shipped.branch}, pushed to origin${closes}`;
				this.endRun(summary);
				return `Shipped: ${summary}. The run is finished.`;
			}
		}
	}
}

function notReadyToShip(phase: string): string {
	if (phase === "idle") return "No /build run is waiting to ship";
	return `Not ready to ship: the /build run is in its ${phase} phase; it can ship once both reviewers pass`;
}
