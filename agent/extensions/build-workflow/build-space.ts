/**
 * The run's herdr workspace as the home of the whole run: the Diff tab (diff-tab.ts) and the planner moved in on
 * request (planner-pane.ts). Only exists inside herdr; the Diff tab's timer and the run's end talk to this one door.
 */
import { type HerdrClient, isInsideHerdr } from "../herdr-tools/herdr-cli.ts";
import { BuildDiffTab, type ScreenView } from "./diff-tab.ts";
import { PlannerPane } from "./planner-pane.ts";
import type { RunWorktree } from "./workflow-state.ts";

export class BuildSpace {
	private readonly diffTab: BuildDiffTab;
	private readonly plannerPane: PlannerPane | undefined;
	private readonly currentWorktree: () => RunWorktree | undefined;
	private readonly reportError: (message: string) => void;
	private failedWorkspaceId: string | undefined;

	constructor(client: HerdrClient, currentWorktree: () => RunWorktree | undefined, reportError: (message: string) => void, ownPaneId: string | undefined) {
		this.diffTab = new BuildDiffTab(client);
		this.plannerPane = ownPaneId ? new PlannerPane(client, ownPaneId) : undefined;
		this.currentWorktree = currentWorktree;
		this.reportError = reportError;
	}


	/** Returns an error to show, or undefined once the planner sits in the run's "Planner" tab. */
	async bringPlannerHere(): Promise<string | undefined> {
		const worktree = this.currentWorktree();
		if (!this.plannerPane) return "The planner can only move inside herdr";
		if (!worktree) return "This run has no herdr workspace of its own to move the planner into";
		try {
			return await this.plannerPane.bringTo(worktree.workspaceId);
		} catch (error) {
			return `Could not move the planner: ${(error as Error).message}`;
		}
	}

	async sendPlannerBack(): Promise<string | undefined> {
		if (!this.plannerPane?.isAway) return "The planner is not in a build space";
		try {
			await this.plannerPane.sendBack();
			return undefined;
		} catch (error) {
			return `Could not move the planner back: ${(error as Error).message}`;
		}
	}

	/** Opens the run's Diff tab and draws its next frame; called on each Diff tab tick once the review passed. */
	refreshDiff(view: ScreenView): void {
		const worktree = this.currentWorktree();
		if (!worktree) return;
		if (this.diffTab.workspaceId !== worktree.workspaceId && this.failedWorkspaceId !== worktree.workspaceId) {
			this.diffTab.open(worktree).catch((error: unknown) => {
				this.failedWorkspaceId = worktree.workspaceId;
				this.reportError(`Could not set up the Diff tab: ${(error as Error).message}`);
			});
		}
		try {
			this.diffTab.draw(view);
		} catch (error) {
			this.reportError(`Could not draw the Diff tab: ${(error as Error).message}`);
		}
	}

	/** Closes the Diff tab while the run is not past its review, e.g. after a failed cleanup went back to a fix round. */
	hideDiff(): void {
		if (this.diffTab.workspaceId === undefined) return;
		this.diffTab.close().catch((error: unknown) => this.reportError(`Could not close the Diff tab: ${(error as Error).message}`));
	}

	/** Pi reloads or quits: stop serving the tabs; their clients wait for the next planner. */
	async detach(): Promise<void> {
		await this.diffTab.detach();
	}

	/**
	 * Before the run's end touches its workspace: the planner goes back and the overview stops. Resolves to
	 * whether the workspace may be removed; never with the planner still inside, since that would close it.
	 */
	async leave(worktree: RunWorktree): Promise<boolean> {
		const sendBackError = this.plannerPane?.isAway ? await this.sendPlannerBack() : undefined;
		if (sendBackError) this.reportError(sendBackError);
		await this.diffTab.close().catch((error: unknown) => this.reportError(`Could not close the Diff tab: ${(error as Error).message}`));
		if (!this.plannerPane) return true;
		try {
			return !(await this.plannerPane.isIn(worktree.workspaceId));
		} catch (error) {
			this.reportError(`Could not tell where the planner is: ${(error as Error).message}`);
			return false;
		}
	}
}

/** Only inside herdr; the planner can move only when herdr told it which pane it runs in. */
export function createBuildSpace(
	client: HerdrClient | undefined,
	currentWorktree: () => RunWorktree | undefined,
	reportError: (message: string) => void,
	env: NodeJS.ProcessEnv = process.env,
): BuildSpace | undefined {
	if (!client || !isInsideHerdr(env)) return undefined;
	return new BuildSpace(client, currentWorktree, reportError, env.HERDR_PANE_ID);
}
