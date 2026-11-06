/**
 * Opens and feeds the agents overview: Alt+A or /agents toggles a centered card for the current /build or
 * /issue run, refreshed live while it is open (spinner, stage times, activity, changed lines), from which you
 * can message any agent. While subagents work, a one-line widget above the editor shows who is doing what.
 */
import { existsSync, readFileSync } from "node:fs";
import { type ExtensionAPI, type ExtensionContext, getLanguageFromPath, highlightCode } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { activeMsOf, AgentTracker, type AssistantMessageLike } from "./agent-activity.ts";
import {
	type AgentFeed,
	type AgentKey,
	AgentsOverview,
	type ChangesView,
	type DelegateRow,
	formatDuration,
	type OverviewSnapshot,
	type RepoLocation,
	SPINNER_FRAME_MS,
} from "./agents-overview.ts";
import { type BuildOrchestrator, type SubagentRole, stageStats } from "./build-orchestrator.ts";
import { type BuildTimeline, buildTimeline, type LiveStageView, type TimelineEntry } from "./build-timeline.ts";
import {
	cancelDelegate,
	type DelegateLaunch,
	DelegateSessionReader,
	delegateStatus,
	findDelegateRuns,
	findLiveDelegateProcesses,
} from "./delegate-runs.ts";
import { loadFileDiff } from "./file-diff.ts";
import type { HighlightCode } from "./file-diff-view.ts";
import type { RunCommand } from "./github-issue.ts";
import { loadWorkChanges } from "./work-changes.ts";
import { REVIEWER_VENDORS, reviewerRole, WORKFLOW_STATE_ENTRY_TYPE } from "./workflow-state.ts";

const TOGGLE_SHORTCUT = "alt+a";
const WIDGET_KEY = "build-agents";
const TIMELINE_REFRESH_MS = 500;
const WIDGET_REFRESH_MS = 1000;
const CHANGES_REFRESH_MS = 3000;
const MAX_OVERVIEW_WIDTH = 180;
/** Share of the terminal width the card takes, up to MAX_OVERVIEW_WIDTH. */
const OVERVIEW_WIDTH_SHARE = 0.95;
/** The "No build running" card has two hint lines; a full-width card would be mostly empty. */
const NO_BUILD_WIDTH = 64;
/** Share of the terminal height the card may take; the overlay's maxHeight. */
const OVERVIEW_HEIGHT_SHARE = 0.95;
/** Top and bottom border plus the blank line inside each. */
const CARD_FRAME_ROWS = 4;
const SUBAGENT_ROLES: readonly SubagentRole[] = ["implementer", ...REVIEWER_VENDORS.map(reviewerRole)];
/** Scanning /proc for delegate processes costs more than reading entries, so it runs less often. */
const DELEGATE_PROCESS_REFRESH_MS = 2000;
const DELEGATE_MESSAGE_BLOCKER = "Delegates take no messages; x cancels a running one";

interface OpenOverview {
	close: () => void;
}

/** First "# heading" of the agreed plan; undefined while there is no plan file. */
function readPlanTitle(planPath: string | undefined): string | undefined {
	if (!planPath || !existsSync(planPath)) return undefined;
	const heading = readFileSync(planPath, "utf8")
		.split("\n")
		.find((line) => line.startsWith("# "));
	return heading?.slice(2).trim();
}

const highlightForPath: HighlightCode = (codeLines, path) => {
	const language = getLanguageFromPath(path);
	if (!language) return [...codeLines];
	return highlightCode(codeLines.join("\n"), language);
};

function hasWorkflowEntries(entries: readonly TimelineEntry[]): boolean {
	return entries.some((entry) => entry.type === "custom" && entry.customType === WORKFLOW_STATE_ENTRY_TYPE);
}

export function registerAgentsOverview(
	pi: ExtensionAPI,
	orchestrator: BuildOrchestrator,
	sendToPlanner: (message: string) => void,
): void {
	let sessionCtx: ExtensionContext | undefined;
	let planner = new AgentTracker();
	let openOverview: OpenOverview | undefined;
	let changes: ChangesView = { kind: "not-started" };
	let isLoadingChanges = false;
	let changesLoadedAtMs = 0;
	let widgetTimer: ReturnType<typeof setInterval> | undefined;

	function liveStageViews(nowMs: number): LiveStageView[] {
		return orchestrator.liveStages().map((live): LiveStageView => {
			const stats = live.process.tracker.stats;
			return {
				stage: live.stage,
				reviewer: live.reviewer,
				model: stats.model,
				thinkingLevel: stats.thinkingLevel,
				routeReason: stats.routeReason,
				...stageStats(live, nowMs),
				isWorking: live.process.isWorking,
			};
		});
	}

	function readTimeline(ctx: ExtensionContext): BuildTimeline | undefined {
		const entries = ctx.sessionManager.getBranch() as TimelineEntry[];
		if (!hasWorkflowEntries(entries)) return undefined;
		const nowMs = Date.now();
		return buildTimeline(entries, nowMs, !ctx.isIdle(), liveStageViews(nowMs));
	}

	function refreshChanges(baseCommit: string | undefined): void {
		if (!baseCommit || isLoadingChanges || !sessionCtx) return;
		if (changes.kind === "not-started") changes = { kind: "loading" };
		isLoadingChanges = true;
		const cwd = sessionCtx.cwd;
		const run: RunCommand = (command, args) => pi.exec(command, args, { cwd });
		void loadWorkChanges(run, baseCommit)
			.then((result) => {
				changes = { kind: "loaded", result };
			})
			.catch((error: unknown) => {
				changes = { kind: "loaded", result: { ok: false, error: `Failed to count changes: ${(error as Error).message}` } };
			})
			.finally(() => {
				isLoadingChanges = false;
				changesLoadedAtMs = Date.now();
			});
	}

	function refreshChangesWhenStale(baseCommit: string | undefined): void {
		if (Date.now() - changesLoadedAtMs >= CHANGES_REFRESH_MS) refreshChanges(baseCommit);
	}

	const delegateSessions = new DelegateSessionReader();
	let liveDelegateProcesses: Map<string, number> | undefined = new Map();
	let delegateProcessesReadAtMs = 0;

	function refreshLiveDelegateProcesses(): void {
		if (Date.now() - delegateProcessesReadAtMs < DELEGATE_PROCESS_REFRESH_MS) return;
		liveDelegateProcesses = findLiveDelegateProcesses();
		delegateProcessesReadAtMs = Date.now();
	}

	function delegateRow(launch: DelegateLaunch, nowMs: number): DelegateRow {
		const session = delegateSessions.read(launch.runId);
		const status = delegateStatus(launch, liveDelegateProcesses);
		const startedAtMs = session?.startedAtMs ?? nowMs;
		const endedAtMs = status === "running" ? nowMs : (session?.lastEntryAtMs ?? nowMs);
		return {
			key: `delegate:${launch.runId}`,
			runId: launch.runId,
			role: launch.agent,
			task: launch.task,
			status,
			model: session?.model,
			thinkingLevel: session?.thinkingLevel,
			routeReason: session?.routeReason,
			elapsedMs: status === "running" ? nowMs - startedAtMs : (launch.durationMs ?? endedAtMs - startedAtMs),
			costUsd: session?.costUsd ?? 0,
		};
	}

	function readDelegates(ctx: ExtensionContext): DelegateRow[] {
		refreshLiveDelegateProcesses();
		const nowMs = Date.now();
		return findDelegateRuns(ctx.sessionManager.getBranch() as Parameters<typeof findDelegateRuns>[0]).map((launch) => delegateRow(launch, nowMs));
	}

	function delegateFeeds(delegates: readonly DelegateRow[]): Partial<Record<AgentKey, AgentFeed>> {
		const result: Partial<Record<AgentKey, AgentFeed>> = {};
		for (const delegate of delegates) {
			const session = delegateSessions.read(delegate.runId);
			result[delegate.key] = {
				activity: session?.activity ?? [],
				runningTool: delegate.status === "running" ? session?.pendingTool : undefined,
				messageBlocker: DELEGATE_MESSAGE_BLOCKER,
			};
		}
		return result;
	}

	function feeds(): Partial<Record<AgentKey, AgentFeed>> {
		const result: Partial<Record<AgentKey, AgentFeed>> = {
			planner: { activity: planner.activity.recent(50), runningTool: planner.stats.runningTool, messageBlocker: undefined },
		};
		for (const role of SUBAGENT_ROLES) {
			const subagent = orchestrator.process(role);
			if (!subagent) continue;
			result[role] = {
				activity: subagent.tracker.activity.recent(50),
				runningTool: subagent.tracker.stats.runningTool,
				messageBlocker: subagent.isRunning ? undefined : `The ${subagent.name} is not running; /build implement restarts it`,
			};
		}
		return result;
	}

	function sendMessage(agent: AgentKey, text: string): string | undefined {
		if (agent.startsWith("delegate:")) return DELEGATE_MESSAGE_BLOCKER;
		const subagentRole = SUBAGENT_ROLES.find((role) => role === agent);
		if (subagentRole) return orchestrator.sendToSubagent(subagentRole, text);
		planner.activity.add("you", text, Date.now());
		sendToPlanner(text);
		return undefined;
	}

	async function readRepoLocation(cwd: string): Promise<RepoLocation | undefined> {
		const topLevel = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd });
		if (topLevel.code !== 0) return undefined;
		const branch = await pi.exec("git", ["branch", "--show-current"], { cwd });
		const repoName = topLevel.stdout.trim().split("/").at(-1) ?? topLevel.stdout.trim();
		return { repoName, branch: branch.code === 0 && branch.stdout.trim() !== "" ? branch.stdout.trim() : undefined };
	}

	function showOverview(ctx: ExtensionContext): void {
		let timeline = readTimeline(ctx);
		let delegates = readDelegates(ctx);
		let repo: RepoLocation | undefined;
		const refreshRepo = (): void => {
			void readRepoLocation(ctx.cwd)
				.then((location) => {
					repo = location;
				})
				.catch(() => {
					// Not a git repository or git missing: the card just leaves the repo line out.
					repo = undefined;
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
			repo,
			planTitle: planTitleOf(timeline?.planPath),
			changes,
			feeds: { ...feeds(), ...delegateFeeds(delegates) },
			delegates,
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
				const run: RunCommand = (command, args) => pi.exec(command, args, { cwd: ctx.cwd });
				const overview = new AgentsOverview(
					theme,
					readSnapshot,
					{
						close,
						sendMessage,
						loadFileDiff: async (file) => {
							const baseCommit = timeline?.baseCommit;
							if (!baseCommit) return { ok: false, error: "The run has no base commit to diff against yet" };
							return loadFileDiff(run, baseCommit, file);
						},
						cancelDelegate: (runId) => {
							delegateProcessesReadAtMs = 0;
							refreshLiveDelegateProcesses();
							const error = cancelDelegate(runId, liveDelegateProcesses);
							delegateProcessesReadAtMs = 0;
							return error;
						},
					},
					{
						bodyRows: () => Math.floor(tui.terminal.rows * OVERVIEW_HEIGHT_SHARE) - CARD_FRAME_ROWS,
						highlight: highlightForPath,
					},
				);
				intervals.push(
					setInterval(() => {
						overview.advanceSpinner();
						tui.requestRender();
					}, SPINNER_FRAME_MS),
					setInterval(() => {
						timeline = readTimeline(sessionCtx ?? ctx);
						delegates = readDelegates(sessionCtx ?? ctx);
						refreshChangesWhenStale(timeline?.baseCommit);
					}, TIMELINE_REFRESH_MS),
					setInterval(refreshRepo, CHANGES_REFRESH_MS),
				);
				openOverview = { close };
				refreshRepo();
				refreshChanges(timeline?.baseCommit);
				return overview;
			},
			{
				overlay: true,
				overlayOptions: () => ({
					anchor: "center",
					width: Math.min(
						timeline || delegates.length > 0 ? MAX_OVERVIEW_WIDTH : NO_BUILD_WIDTH,
						Math.max(40, Math.floor((process.stdout.columns ?? MAX_OVERVIEW_WIDTH) * OVERVIEW_WIDTH_SHARE)),
					),
					maxHeight: `${OVERVIEW_HEIGHT_SHARE * 100}%`,
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

	/**
	 * "◆ Implementer working 2m gpt-6-luna · bash pnpm test · +312 −48 · Alt+A" while a subagent runs;
	 * during a review one part per reviewer, without the running tool to keep the line short.
	 */
	function widgetLine(ctx: ExtensionContext): string | undefined {
		const liveStages = orchestrator.liveStages();
		if (liveStages.length === 0) return undefined;
		const theme = ctx.ui.theme;
		const nowMs = Date.now();
		const agentParts = liveStages.map((live) => {
			const stats = live.process.tracker.stats;
			const name = live.process.name;
			const state = live.process.isWorking
				? theme.fg("accent", `${name} working ${formatDuration(activeMsOf(stats, nowMs))}`)
				: theme.fg("warning", orchestrator.isWaitingForPlanner ? `${name} waits for the planner` : `${name} paused`);
			const model = stats.model ? theme.fg("muted", ` ${stats.model}`) : "";
			const tool =
				liveStages.length === 1 && stats.runningTool
					? theme.fg("dim", ` · ${stats.runningTool.name} ${stats.runningTool.detail}`.slice(0, 60))
					: "";
			return `${state}${model}${tool}`;
		});
		const changeCounts =
			changes.kind === "loaded" && changes.result.ok
				? ` · ${theme.fg("toolDiffAdded", `+${changes.result.value.added}`)} ${theme.fg("toolDiffRemoved", `−${changes.result.value.removed}`)}`
				: "";
		return `${theme.fg("accent", "◆")} ${agentParts.join(theme.fg("dim", " · "))}${changeCounts} ${theme.fg("dim", "· Alt+A")}`;
	}

	function refreshWidget(): void {
		const ctx = sessionCtx;
		if (!ctx?.hasUI) return;
		const line = widgetLine(ctx);
		ctx.ui.setWidget(WIDGET_KEY, line ? [line] : undefined);
		if (!line) return;
		const timeline = openOverview ? undefined : readTimeline(ctx);
		refreshChangesWhenStale(timeline?.baseCommit);
	}

	pi.on("session_start", (_event, ctx) => {
		sessionCtx = ctx;
		planner = new AgentTracker();
		changes = { kind: "not-started" };
		changesLoadedAtMs = 0;
		if (!widgetTimer) {
			widgetTimer = setInterval(refreshWidget, WIDGET_REFRESH_MS);
			widgetTimer.unref();
		}
	});

	pi.on("session_shutdown", () => {
		if (widgetTimer) clearInterval(widgetTimer);
		widgetTimer = undefined;
		openOverview?.close();
	});

	pi.on("agent_start", () => planner.startTurn(Date.now()));
	pi.on("agent_end", () => planner.endTurn(Date.now()));

	pi.on("tool_execution_start", (event) => {
		if (!event.parentToolCallId) planner.startTool(event.toolName, event.args, Date.now());
	});

	pi.on("tool_execution_end", (event) => {
		if (!event.parentToolCallId) planner.endTool(event.isError, Date.now());
	});

	pi.on("message_end", (event) => {
		const message = event.message as AssistantMessageLike;
		if (message.role === "assistant") planner.recordAnswer(message, Date.now());
	});

	pi.registerShortcut(TOGGLE_SHORTCUT, {
		description: "Show or hide the agents overview (/build agents and acp_delegate runs)",
		handler: async (ctx) => toggleOverview(ctx),
	});

	pi.registerCommand("agents", {
		description: "The /build or /issue agents and acp_delegate runs: models, time, cost, activity and changed lines (also Alt+A)",
		handler: async (_args, ctx) => toggleOverview(ctx),
	});
}
