/**
 * Where build helpers sit inside herdr: one tab per role group ("Implementers", "Reviewers") in the run's
 * workspace, one full-height pane per helper, side by side in equal-width columns. The first helper of a group
 * opens the tab, later ones split the rightmost pane, and the columns are evened out after every change.
 */
import { HerdrCommandError, type HerdrClient, type PaneLayout, type ResizeDirection } from "../herdr-tools/herdr-cli.ts";

export type HelperGroup = "designers" | "implementers" | "reviewers";

const GROUP_LABELS: Record<HelperGroup, string> = { designers: "Designer", implementers: "Implementers", reviewers: "Reviewers" };

/** Differences below this share of a split are rounding of terminal cells, not worth a resize. */
const RATIO_TOLERANCE = 0.01;

export function helperGroupOf(agentName: string): HelperGroup {
	if (agentName === "designer") return "designers";
	return agentName.startsWith("implementer") ? "implementers" : "reviewers";
}

export interface PaneResize {
	paneId: string;
	direction: ResizeDirection;
	amount: number;
}

/**
 * The resizes that give every column the same width. Columns made by always splitting the rightmost pane form
 * a chain: the split starting at column i holds columns i..n-1, so column i should keep 1/(n-i) of it.
 * A pane's `right` resize moves the split on its right edge up; the next pane's `left` resize moves it down.
 */
export function equalizingResizes(layout: PaneLayout): PaneResize[] {
	const columns = [...layout.panes].sort((left, right) => left.x - right.x);
	const columnSplits = layout.splits.filter((split) => split.direction === "right");
	const resizes: PaneResize[] = [];
	for (let index = 0; index < columns.length - 1; index++) {
		const split = columnSplits.find((candidate) => candidate.x === columns[index].x);
		if (!split) continue;
		const shortfall = 1 / (columns.length - index) - split.ratio;
		if (Math.abs(shortfall) < RATIO_TOLERANCE) continue;
		resizes.push(
			shortfall > 0
				? { paneId: columns[index].paneId, direction: "right", amount: shortfall }
				: { paneId: columns[index + 1].paneId, direction: "left", amount: -shortfall },
		);
	}
	return resizes;
}

interface GroupTab {
	tabId: string;
	/** Left to right. */
	paneIds: string[];
}

export type ReportLayoutError = (error: unknown) => void;

export class HelperPaneGroups {
	private readonly client: HerdrClient;
	private readonly tabs = new Map<string, GroupTab>();
	/** Per group, so two helpers starting together cannot both open a tab or split the same pane. */
	private readonly pending = new Map<string, Promise<unknown>>();

	constructor(client: HerdrClient) {
		this.client = client;
	}

	/** A new pane for one helper in its group's tab of the workspace; returns its pane id. */
	openPane(workspaceId: string, group: HelperGroup, cwd: string, reportError: ReportLayoutError): Promise<string> {
		const key = `${workspaceId}/${group}`;
		return this.inOrder(key, () => this.addPane(key, workspaceId, group, cwd, reportError));
	}

	/** Closes the helper's pane, or the whole tab when it was the group's last one. */
	closePane(paneId: string, reportError: ReportLayoutError): Promise<void> {
		const key = this.keyOf(paneId);
		if (!key) return this.client.closePane(paneId);
		return this.inOrder(key, () => this.removePane(key, paneId, reportError));
	}

	private keyOf(paneId: string): string | undefined {
		return [...this.tabs].find(([, tab]) => tab.paneIds.includes(paneId))?.[0];
	}

	private inOrder<T>(key: string, step: () => Promise<T>): Promise<T> {
		const next = (this.pending.get(key) ?? Promise.resolve()).catch(() => undefined).then(step);
		this.pending.set(key, next);
		return next;
	}

	private async addPane(key: string, workspaceId: string, group: HelperGroup, cwd: string, reportError: ReportLayoutError): Promise<string> {
		const tab = this.tabs.get(key);
		if (tab) {
			try {
				const pane = await this.client.splitPane({ targetPaneId: tab.paneIds[tab.paneIds.length - 1], direction: "right", cwd });
				tab.paneIds.push(pane.paneId);
				await this.equalize(tab, reportError);
				return pane.paneId;
			} catch (error) {
				// You closed the group's tab or its last pane by hand: the helper starts a fresh tab.
				if (!(error instanceof HerdrCommandError && error.code === "pane_not_found")) throw error;
				this.tabs.delete(key);
			}
		}
		const created = await this.client.createTab(workspaceId, cwd, GROUP_LABELS[group]);
		this.tabs.set(key, { tabId: created.tabId, paneIds: [created.rootPaneId] });
		return created.rootPaneId;
	}

	private async removePane(key: string, paneId: string, reportError: ReportLayoutError): Promise<void> {
		const tab = this.tabs.get(key);
		if (!tab?.paneIds.includes(paneId)) {
			await this.client.closePane(paneId);
			return;
		}
		tab.paneIds = tab.paneIds.filter((id) => id !== paneId);
		if (tab.paneIds.length === 0) {
			this.tabs.delete(key);
			await this.client.closeTab(tab.tabId);
			return;
		}
		await this.client.closePane(paneId);
		await this.equalize(tab, reportError);
	}

	/** Uneven columns stay readable, so a failed resize is reported, not fatal. */
	private async equalize(tab: GroupTab, reportError: ReportLayoutError): Promise<void> {
		try {
			const layout = await this.client.paneLayout(tab.paneIds[0]);
			for (const resize of equalizingResizes(layout)) await this.client.resizePane(resize.paneId, resize.direction, resize.amount);
		} catch (error) {
			reportError(error);
		}
	}
}
