/**
 * The "Diff" tab of a run's herdr worktree workspace: the changed files, and a file's diff on Enter. The planner
 * draws the screen and pushes it to a small client in the tab's pane (pane-screen.ts); the keys typed there come
 * back. The worktree's own first tab stays the plain shell it was. When the run ends the client exits and the
 * tab closes. Replaces build-overview.ts, which also drew a view-only Overview tab.
 */
import type { HerdrClient } from "../herdr-tools/herdr-cli.ts";
import { type PaneSize, PaneScreen, screenClientCommand, screenSocketPath } from "./pane-screen.ts";
import type { RunWorktree } from "./workflow-state.ts";

export type { PaneSize };

export const DIFF_TAB_LABEL = "Diff";

/** A screen drawn into a tab: its lines for the pane's size, and the keys typed there. */
export interface ScreenView {
	render(size: PaneSize): string[];
	handleInput(keys: string): void;
}

export class BuildDiffTab {
	private readonly client: HerdrClient;
	private shown: { worktree: RunWorktree; screen: PaneScreen } | undefined;
	private opening: Promise<void> | undefined;
	private view: ScreenView | undefined;

	constructor(client: HerdrClient) {
		this.client = client;
	}

	get workspaceId(): string | undefined {
		return this.shown?.worktree.workspaceId;
	}

	open(worktree: RunWorktree): Promise<void> {
		if (this.shown?.worktree.workspaceId === worktree.workspaceId) return this.opening ?? Promise.resolve();
		const shown = { worktree, screen: new PaneScreen(screenSocketPath(worktree.workspaceId, "diff")) };
		this.shown = shown;
		this.opening = this.setUp(shown);
		return this.opening;
	}

	private async setUp(shown: { worktree: RunWorktree; screen: PaneScreen }): Promise<void> {
		await shown.screen.listen(
			(keys) => {
				this.view?.handleInput(keys);
				this.drawView(shown);
			},
			() => this.drawView(shown),
		);
		const { worktree } = shown;
		const labels = new Set((await this.client.listTabs(worktree.workspaceId)).map((tab) => tab.label));
		if (labels.has(DIFF_TAB_LABEL)) return;
		const diffTab = await this.client.createTab(worktree.workspaceId, worktree.path, DIFF_TAB_LABEL);
		await this.client.runInPane(diffTab.rootPaneId, screenClientCommand(shown.screen.socketPath));
	}

	private drawView(shown: { worktree: RunWorktree; screen: PaneScreen }): void {
		const size = shown.screen.size;
		if (!size || !this.view) return;
		shown.screen.show(this.view.render(size).slice(0, size.rows));
	}

	draw(view: ScreenView): void {
		this.view = view;
		if (this.shown) this.drawView(this.shown);
	}

	async detach(): Promise<void> {
		const shown = this.shown;
		this.shown = undefined;
		this.opening = undefined;
		this.view = undefined;
		if (shown) await shown.screen.stopListening();
	}

	async close(): Promise<void> {
		let setupError: unknown;
		try {
			await this.opening;
		} catch (error) {
			setupError = error;
		}
		const shown = this.shown;
		this.shown = undefined;
		this.opening = undefined;
		this.view = undefined;
		if (!shown) return;
		await shown.screen.end();
		const diffTab = (await this.client.listTabs(shown.worktree.workspaceId)).find((tab) => tab.label === DIFF_TAB_LABEL);
		if (diffTab) await this.client.closeTab(diffTab.tabId);
		if (setupError) throw setupError;
	}
}
