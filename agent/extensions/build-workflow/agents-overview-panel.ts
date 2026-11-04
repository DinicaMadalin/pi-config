/**
 * Opens and feeds the agents overview: Alt+A or /agents toggles a centered card for the current /build or
 * /issue run, refreshed live while it is open (spinner, stage times, running tool, changed lines).
 */
import { existsSync, readFileSync } from "node:fs";
import { type ExtensionAPI, type ExtensionContext, SessionManager } from "@earendil-works/pi-coding-agent";
import { type TUI } from "@earendil-works/pi-tui";
import { AgentsOverview, type ChangesView, type OverviewSnapshot, type RunningTool, SPINNER_FRAME_MS } from "./agents-overview.ts";
import { type BuildTimeline, buildTimeline, type TimelineEntry } from "./build-timeline.ts";
import type { RunCommand } from "./github-issue.ts";
import { loadWorkChanges } from "./work-changes.ts";
import { WORKFLOW_STATE_ENTRY_TYPE } from "./workflow-state.ts";

const TOGGLE_SHORTCUT = "alt+a";
const TIMELINE_REFRESH_MS = 500;
const CHANGES_REFRESH_MS = 3000;
const MAX_OVERVIEW_WIDTH = 96;
/** The "No build running" card has two hint lines; a full-width card would be mostly empty. */
const NO_BUILD_WIDTH = 64;
const MAX_TOOL_DETAIL_CHARS = 160;

interface OpenOverview {
	close: () => void;
}

function summarizeToolArgs(toolName: string, args: unknown): string {
	const fields = (args ?? {}) as Record<string, unknown>;
	const preferredField = { bash: "command", read: "path", edit: "path", write: "path", grep: "pattern", find: "pattern" }[toolName];
	const preferred = preferredField ? fields[preferredField] : undefined;
	const firstString = Object.values(fields).find((field) => typeof field === "string");
	const detail = typeof preferred === "string" ? preferred : typeof firstString === "string" ? firstString : "";
	return detail.replace(/\s+/g, " ").trim().slice(0, MAX_TOOL_DETAIL_CHARS);
}

/** First "# heading" of the agreed plan; undefined while there is no plan file. */
function readPlanTitle(planPath: string | undefined): string | undefined {
	if (!planPath || !existsSync(planPath)) return undefined;
	const heading = readFileSync(planPath, "utf8")
		.split("\n")
		.find((line) => line.startsWith("# "));
	return heading?.slice(2).trim();
}

function hasWorkflowEntries(entries: readonly TimelineEntry[]): boolean {
	return entries.some((entry) => entry.type === "custom" && entry.customType === WORKFLOW_STATE_ENTRY_TYPE);
}

export function registerAgentsOverview(pi: ExtensionAPI): void {
	let sessionCtx: ExtensionContext | undefined;
	let runningTool: RunningTool | undefined;
	let openOverview: OpenOverview | undefined;
	/** The planning session never changes once the implementer runs, so read it once per path. */
	const parentEntriesByPath = new Map<string, TimelineEntry[]>();

	function readParentEntries(ctx: ExtensionContext): TimelineEntry[] {
		const parentPath = ctx.sessionManager.getHeader()?.parentSession;
		if (!parentPath || !existsSync(parentPath)) return [];
		let parentEntries = parentEntriesByPath.get(parentPath);
		if (!parentEntries) {
			parentEntries = SessionManager.open(parentPath).getBranch() as TimelineEntry[];
			parentEntriesByPath.set(parentPath, parentEntries);
		}
		return parentEntries;
	}

	/** The planner works in the parent session; the implementer and reviewers in the one /build implement opened. */
	function readTimeline(ctx: ExtensionContext): BuildTimeline | undefined {
		const sessionEntries = ctx.sessionManager.getBranch() as TimelineEntry[];
		if (!hasWorkflowEntries(sessionEntries)) return undefined;
		return buildTimeline([...readParentEntries(ctx), ...sessionEntries], Date.now(), !ctx.isIdle());
	}

	function showOverview(ctx: ExtensionContext): void {
		let timeline = readTimeline(ctx);
		let changes: ChangesView = { kind: "not-started" };
		let isLoadingChanges = false;

		const refreshChanges = (): void => {
			const activeCtx = sessionCtx ?? ctx;
			const baseCommit = timeline?.baseCommit;
			if (!baseCommit || isLoadingChanges) return;
			if (changes.kind === "not-started") changes = { kind: "loading" };
			isLoadingChanges = true;
			const run: RunCommand = (command, args) => pi.exec(command, args, { cwd: activeCtx.cwd });
			void loadWorkChanges(run, baseCommit)
				.then((result) => {
					changes = { kind: "loaded", result };
				})
				.catch((error: unknown) => {
					changes = { kind: "loaded", result: { ok: false, error: `Failed to count changes: ${(error as Error).message}` } };
				})
				.finally(() => {
					isLoadingChanges = false;
				});
		};
		const planTitleByPath = new Map<string, string | undefined>();
		const planTitleOf = (planPath: string | undefined): string | undefined => {
			if (!planPath) return undefined;
			if (!planTitleByPath.has(planPath)) planTitleByPath.set(planPath, readPlanTitle(planPath));
			return planTitleByPath.get(planPath);
		};
		const readSnapshot = (): OverviewSnapshot => ({
			timeline,
			planTitle: planTitleOf(timeline?.planPath),
			changes,
			runningTool,
			nowMs: Date.now(),
		});

		void ctx.ui.custom<void>(
			(tui: TUI, theme, _keybindings, done) => {
				const intervals: ReturnType<typeof setInterval>[] = [];
				const close = (): void => {
					for (const interval of intervals) clearInterval(interval);
					openOverview = undefined;
					done();
				};
				const overview = new AgentsOverview(theme, readSnapshot, close);
				intervals.push(
					setInterval(() => {
						overview.advanceSpinner();
						tui.requestRender();
					}, SPINNER_FRAME_MS),
					setInterval(() => {
						timeline = readTimeline(sessionCtx ?? ctx);
					}, TIMELINE_REFRESH_MS),
					setInterval(refreshChanges, CHANGES_REFRESH_MS),
				);
				openOverview = { close };
				refreshChanges();
				return overview;
			},
			{
				overlay: true,
				overlayOptions: () => ({
					anchor: "center",
					width: Math.min(
						timeline ? MAX_OVERVIEW_WIDTH : NO_BUILD_WIDTH,
						Math.max(40, (process.stdout.columns ?? MAX_OVERVIEW_WIDTH) - 4),
					),
					maxHeight: "90%",
				}),
			},
		);
	}

	function toggleOverview(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		if (openOverview) {
			openOverview.close();
			return;
		}
		showOverview(ctx);
	}

	pi.on("session_start", (_event, ctx) => {
		sessionCtx = ctx;
		runningTool = undefined;
	});

	pi.on("tool_execution_start", (event) => {
		if (event.parentToolCallId) return;
		runningTool = { name: event.toolName, detail: summarizeToolArgs(event.toolName, event.args), startedAtMs: Date.now() };
	});

	pi.on("tool_execution_end", (event) => {
		if (!event.parentToolCallId) runningTool = undefined;
	});

	pi.on("agent_end", () => {
		runningTool = undefined;
	});

	pi.registerShortcut(TOGGLE_SHORTCUT, {
		description: "Show or hide the /build agents overview",
		handler: async (ctx) => toggleOverview(ctx),
	});

	pi.registerCommand("agents", {
		description: "Overview of the /build or /issue agents: models, time, cost and changed lines (also Alt+A)",
		handler: async (_args, ctx) => toggleOverview(ctx),
	});
}
