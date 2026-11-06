/**
 * Pi's main screen around the chat:
 * - the strip above the editor: repo, branch, changed lines, checks, context, cost and model, plus one line
 *   per agent at work;
 * - on wide terminals, while agents work, a pane docked beside the chat with the /build overview; Alt+S
 *   gives it the keys (and opens it when idle), Esc gives them back;
 * - Alt+A or /agents: the same overview centered over the chat, at full size.
 * /dashboard picks the layout; it is saved for every session.
 */
import { join } from "node:path";
import {
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	getLanguageFromPath,
	highlightCode,
} from "@earendil-works/pi-coding-agent";
import type { Component, OverlayHandle, TUI } from "@earendil-works/pi-tui";
import { AgentsOverview, type OverviewActions } from "./agents-overview.ts";
import type { BuildOrchestrator } from "./build-orchestrator.ts";
import { SPINNER_FRAME_MS } from "./card-text.ts";
import { DashboardStrip, renderStrip } from "./dashboard-strip.ts";
import {
	canShowSidePanel,
	type DashboardLayout,
	DEFAULT_LAYOUT,
	LAYOUT_CHOICES,
	loadLayout,
	MIN_SIDE_PANEL_WIDTH,
	SIDE_PANEL_WIDTH,
	saveLayout,
} from "./dashboard-layout.ts";
import type { HighlightCode } from "./file-diff-view.ts";
import type { PlanChanges } from "./plan-changes.ts";
import type { PlannerSession } from "./planner-session.ts";
import { WorkspaceFeed } from "./workspace-feed.ts";

const OVERVIEW_SHORTCUT = "alt+a";
const FOCUS_PANEL_SHORTCUT = "alt+s";
const STRIP_WIDGET_KEY = "dashboard";
const FEED_REFRESH_MS = 500;
/** Share of the terminal the centered overview takes: it is the expanded side pane, so always wider. */
const OVERVIEW_SHARE = 0.95;
/** Top and bottom border plus the blank line inside each. */
const CARD_FRAME_ROWS = 4;
/** Below the docked pane: the editor's box and Pi's footer, which the pane must not cover. */
const EDITOR_AND_FOOTER_ROWS = 7;
const MIN_PANE_BODY_ROWS = 8;

const highlightForPath: HighlightCode = (codeLines, path) => {
	const language = getLanguageFromPath(path);
	if (!language) return [...codeLines];
	return highlightCode(codeLines.join("\n"), language);
};

/** The TUI class has getFocusedComponent; the type extensions get leaves it out. */
function focusedComponentOf(tui: TUI): Component | null {
	const tuiWithFocus = tui as TUI & { getFocusedComponent?: () => Component | null };
	return tuiWithFocus.getFocusedComponent?.() ?? null;
}

function layoutPath(): string {
	return join(getAgentDir(), "dashboard.json");
}

export function registerDashboard(pi: ExtensionAPI, session: PlannerSession, orchestrator: BuildOrchestrator, planChanges: PlanChanges): void {
	const feed = new WorkspaceFeed(pi, session, orchestrator);
	let sessionCtx: ExtensionContext | undefined;
	let layout: DashboardLayout = DEFAULT_LAYOUT;
	let strip: DashboardStrip | undefined;
	let renderer: TUI | undefined;
	let dockedPane:
		| {
				handle: OverlayHandle | undefined;
				overview: AgentsOverview;
				tui: TUI;
				close: () => void;
		  }
		| undefined;
	/** Alt+S opened the pane while no agent works; it stays until Esc. */
	let isPaneOpenedByHand = false;
	/**
	 * What had the keys in the chat (the editor) before the pane or the overview took them. Pi's overlays
	 * remember it themselves, but after /reload that memory points at the old editor and the keys went nowhere.
	 */
	let chatFocus: Component | null = null;
	let fullOverview: { close: () => void } | undefined;
	let refreshTimer: ReturnType<typeof setInterval> | undefined;
	let spinnerTimer: ReturnType<typeof setInterval> | undefined;

	/** Rows the strip draws now, so the docked pane ends right above it. */
	function stripRows(width: number): number {
		const theme = sessionCtx?.ui.theme;
		if (!theme) return 0;
		return renderStrip(feed.stripSnapshot(), layout.strip, theme, 0, width).length;
	}

	function overviewActions(ctx: ExtensionContext, close: () => void): OverviewActions {
		return {
			close,
			sendMessage: (agent, text) => feed.sendMessage(agent, text),
			loadFileDiff: (file) => feed.loadFileDiff(file),
			control: async (command) => {
				if (command.kind === "run" && command.control === "accept") close();
				return feed.runControl(command);
			},
			editPlan: () => {
				close();
				void planChanges.editPlanByHand((sessionCtx ?? ctx).isIdle());
			},
		};
	}

	function showStrip(ctx: ExtensionContext): void {
		ctx.ui.setWidget(
			STRIP_WIDGET_KEY,
			(tui, theme) => {
				renderer = tui;
				strip = new DashboardStrip(theme, () => feed.stripSnapshot(), () => layout.strip);
				return strip;
			},
			{ placement: "aboveEditor" },
		);
	}

	function showDockedPane(ctx: ExtensionContext): void {
		if (dockedPane || layout.sidePanel === "off") return;
		const sidePanel = layout.sidePanel;
		void ctx.ui.custom<void>(
			(tui, theme, _keybindings, done) => {
				let isClosed = false;
				const close = (): void => {
					if (isClosed) return;
					isClosed = true;
					dockedPane = undefined;
					done();
				};
				const giveKeysBack = (): void => {
					isPaneOpenedByHand = false;
					returnKeys();
				};
				const overview = new AgentsOverview(
					theme,
					() => feed.overviewSnapshot(),
					{ ...overviewActions(ctx, giveKeysBack), expand: () => toggleFullOverview(ctx) },
					{
						bodyRows: () =>
							Math.max(MIN_PANE_BODY_ROWS, tui.terminal.rows - stripRows(tui.terminal.columns) - EDITOR_AND_FOOTER_ROWS - CARD_FRAME_ROWS),
						highlight: highlightForPath,
						placement: "docked",
					},
				);
				dockedPane = { handle: undefined, overview, tui, close };
				return overview;
			},
			{
				overlay: true,
				overlayOptions: {
					anchor: sidePanel === "left" ? "top-left" : "top-right",
					width: SIDE_PANEL_WIDTH,
					minWidth: MIN_SIDE_PANEL_WIDTH,
					nonCapturing: true,
					visible: (terminalColumns) =>
						canShowSidePanel(layout, terminalColumns) && (feed.hasAgentsAtWork || isPaneOpenedByHand || dockedPane?.handle?.isFocused() === true),
				},
				onHandle: (handle) => {
					if (dockedPane) dockedPane.handle = handle;
				},
			},
		);
	}

	function returnKeys(): void {
		dockedPane?.handle?.unfocus(chatFocus ? { target: chatFocus } : undefined);
	}

	function toggleDockedFocus(): void {
		const pane = dockedPane;
		const handle = pane?.handle;
		if (!pane || !handle || handle.isHidden()) return;
		if (handle.isFocused()) {
			isPaneOpenedByHand = false;
			returnKeys();
			return;
		}
		isPaneOpenedByHand = true;
		chatFocus = focusedComponentOf(pane.tui);
		handle.focus();
	}

	function toggleFullOverview(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		if (fullOverview) {
			fullOverview.close();
			return;
		}
		// Before hiding the pane: hiding it moves the keys, possibly to a stale component.
		if (renderer && !dockedPane?.handle?.isFocused()) chatFocus = focusedComponentOf(renderer);
		dockedPane?.handle?.setHidden(true);
		void ctx.ui.custom<void>(
			(tui, theme, _keybindings, done) => {
				const close = (): void => {
					fullOverview = undefined;
					isPaneOpenedByHand = false;
					done();
					dockedPane?.handle?.setHidden(false);
					if (chatFocus) tui.setFocus(chatFocus);
				};
				const overview = new AgentsOverview(theme, () => feed.overviewSnapshot(), overviewActions(ctx, close), {
					bodyRows: () => Math.floor(tui.terminal.rows * OVERVIEW_SHARE) - CARD_FRAME_ROWS,
					highlight: highlightForPath,
				});
				fullOverview = { close };
				return overview;
			},
			{
				overlay: true,
				overlayOptions: {
					anchor: "center",
					width: `${OVERVIEW_SHARE * 100}%`,
					maxHeight: `${OVERVIEW_SHARE * 100}%`,
				},
			},
		);
	}

	function tick(): void {
		feed.refresh();
		renderer?.requestRender();
	}

	/** The spinners only move while something works; an idle screen does not redraw ten times a second. */
	function animate(): void {
		if (!feed.isBusy) return;
		strip?.advanceSpinner();
		dockedPane?.overview.advanceSpinner();
		renderer?.requestRender();
	}

	function stopTimers(): void {
		if (refreshTimer) clearInterval(refreshTimer);
		if (spinnerTimer) clearInterval(spinnerTimer);
		refreshTimer = undefined;
		spinnerTimer = undefined;
	}

	function applyLayout(ctx: ExtensionContext): void {
		dockedPane?.close();
		showDockedPane(ctx);
		tick();
	}

	async function chooseLayout(ctx: ExtensionContext): Promise<void> {
		const label = await ctx.ui.select(
			"Dashboard layout",
			LAYOUT_CHOICES.map((choice) => choice.label),
		);
		const choice = LAYOUT_CHOICES.find((candidate) => candidate.label === label);
		if (!choice) return;
		layout = choice.layout;
		try {
			saveLayout(layoutPath(), layout);
		} catch (error) {
			ctx.ui.notify(`Failed to save the dashboard layout: ${(error as Error).message}`, "warning");
		}
		applyLayout(ctx);
	}

	pi.on("session_start", (_event, ctx) => {
		sessionCtx = ctx;
		feed.attach(ctx);
		if (!ctx.hasUI || ctx.mode !== "tui") return;
		try {
			layout = loadLayout(layoutPath());
		} catch (error) {
			layout = DEFAULT_LAYOUT;
			ctx.ui.notify(`${(error as Error).message}; using the default layout`, "warning");
		}
		showStrip(ctx);
		showDockedPane(ctx);
		stopTimers();
		refreshTimer = setInterval(tick, FEED_REFRESH_MS);
		spinnerTimer = setInterval(animate, SPINNER_FRAME_MS);
		refreshTimer.unref();
		spinnerTimer.unref();
	});

	pi.on("session_shutdown", () => {
		stopTimers();
		fullOverview?.close();
		dockedPane?.close();
		strip = undefined;
		renderer = undefined;
	});

	pi.registerShortcut(OVERVIEW_SHORTCUT, {
		description: "Show or hide the full agents overview (/build agents, acp_delegate runs, changes)",
		handler: async (ctx) => toggleFullOverview(ctx),
	});

	pi.registerShortcut(FOCUS_PANEL_SHORTCUT, {
		description: "Move the keys between the chat and the docked dashboard pane",
		handler: async () => toggleDockedFocus(),
	});

	pi.registerCommand("agents", {
		description: "The /build or /issue agents and acp_delegate runs: models, time, cost, activity and changed lines (also Alt+A)",
		handler: async (_args, ctx) => toggleFullOverview(ctx),
	});

	pi.registerCommand("dashboard", {
		description: "Choose the dashboard layout: strip size and where the side pane docks",
		handler: async (_args, ctx) => chooseLayout(ctx),
	});
}
