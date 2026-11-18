/**
 * "Bring planner here": moves the pane this Pi (the planner) runs in into a "Planner" tab of the run's herdr
 * workspace, and back. herdr keeps the pane id and the running Pi across a move. Where it came from is saved
 * in a file, so it survives a /reload: removing the run's worktree closes its workspace, and with it any pane
 * still inside, so the run's end must move the planner back first.
 */
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HerdrCommandError, type HerdrClient } from "../herdr-tools/herdr-cli.ts";

export const PLANNER_TAB_LABEL = "Planner";

/** Where the planner's pane sat before it moved: its tab and a pane that shared it, if any. */
export interface PlannerHome {
	workspaceId: string;
	tabId: string;
	tabLabel: string;
	neighbourPaneId: string | undefined;
}

export type PlannerReturn =
	| { kind: "beside-neighbour"; tabId: string; neighbourPaneId: string }
	| { kind: "new-tab"; workspaceId: string; label: string };

/** Back beside a pane of its old tab while that tab still exists; a tab it left alone is gone, so a new one. */
export function plannerReturnFor(home: PlannerHome, existingPaneIds: ReadonlySet<string>): PlannerReturn {
	if (home.neighbourPaneId && existingPaneIds.has(home.neighbourPaneId)) {
		return { kind: "beside-neighbour", tabId: home.tabId, neighbourPaneId: home.neighbourPaneId };
	}
	return { kind: "new-tab", workspaceId: home.workspaceId, label: home.tabLabel };
}

export function plannerHomeFile(paneId: string, folder = tmpdir()): string {
	return join(folder, `pi-planner-home-${paneId.replace(/[^\w-]/g, "_")}.json`);
}

export class PlannerPane {
	private readonly client: HerdrClient;
	readonly paneId: string;
	private readonly homeFile: string;

	constructor(client: HerdrClient, paneId: string, homeFile = plannerHomeFile(paneId)) {
		this.client = client;
		this.paneId = paneId;
		this.homeFile = homeFile;
	}

	/** Moved into a build workspace and not back yet. */
	get isAway(): boolean {
		return this.readHome() !== undefined;
	}

	/** Moves the planner into a "Planner" tab of the workspace; returns an error to show, or undefined. */
	async bringTo(workspaceId: string): Promise<string | undefined> {
		if (this.isAway) return "The planner is already in the build space";
		const here = await this.client.paneLocation(this.paneId);
		if (here.workspaceId === workspaceId) return "The planner already is in the build space";
		const layout = await this.client.paneLayout(this.paneId);
		const tabs = await this.client.listTabs(here.workspaceId);
		const home: PlannerHome = {
			workspaceId: here.workspaceId,
			tabId: here.tabId,
			tabLabel: tabs.find((tab) => tab.tabId === here.tabId)?.label ?? "",
			neighbourPaneId: layout.panes.find((pane) => pane.paneId !== this.paneId)?.paneId,
		};
		writeFileSync(this.homeFile, JSON.stringify(home));
		try {
			await this.client.movePaneToNewTab(this.paneId, workspaceId, PLANNER_TAB_LABEL);
		} catch (error) {
			rmSync(this.homeFile, { force: true });
			throw error;
		}
		await this.client.focusAgent(this.paneId);
		return undefined;
	}

	/** Moves the planner back where it came from; does nothing when it never moved. */
	async sendBack(): Promise<void> {
		const home = this.readHome();
		if (!home) return;
		const homePanes = await this.client.listPanes(home.workspaceId).catch((error: unknown) => {
			if (error instanceof HerdrCommandError && error.code === "workspace_not_found") return undefined;
			throw error;
		});
		if (!homePanes) {
			// You closed the planner's old workspace meanwhile: it gets one of its own rather than closing with the run.
			await this.client.movePaneToNewWorkspace(this.paneId, PLANNER_TAB_LABEL);
		} else {
			const destination = plannerReturnFor(home, new Set(homePanes.map((pane) => pane.paneId)));
			if (destination.kind === "beside-neighbour") {
				await this.client.movePaneBeside(this.paneId, destination.tabId, destination.neighbourPaneId, "right");
			} else {
				await this.client.movePaneToNewTab(this.paneId, destination.workspaceId, destination.label);
			}
		}
		rmSync(this.homeFile, { force: true });
		await this.client.focusAgent(this.paneId);
	}

	/** Whether the planner sits in that workspace now: the run must not remove it with the planner inside. */
	async isIn(workspaceId: string): Promise<boolean> {
		return (await this.client.paneLocation(this.paneId)).workspaceId === workspaceId;
	}

	private readHome(): PlannerHome | undefined {
		try {
			return JSON.parse(readFileSync(this.homeFile, "utf8")) as PlannerHome;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw new Error(`Failed to read planner home ${this.homeFile}: ${(error as Error).message}`);
		}
	}
}
