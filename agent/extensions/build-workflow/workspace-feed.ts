/**
 * Everything the dashboard shows, gathered in one place so the strip, the side panel and the full overview
 * agree: the /build run and its subagents, acp_delegate runs, the changed files, the repo, the session's
 * cost, context and model, and the quality gate's checks. refresh() re-reads the cheap parts; git and /proc
 * are read less often. It also carries out what the panels ask: messages, controls and diffs.
 */
import { existsSync, readFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CHECK_STATUS_EVENT, type CheckStatus } from "../quality-gate/check-events.ts";
import { activeMsOf, AgentTracker, type AssistantMessageLike } from "./agent-activity.ts";
import type { ControlCommand } from "./agent-controls.ts";
import type { AgentFeed, AgentKey, ChangesView, DelegateRow, OverviewSnapshot, RepoLocation } from "./agents-overview.ts";
import { type AgentCondition, type BuildOrchestrator, type LiveStage, type SubagentRole, stageStats } from "./build-orchestrator.ts";
import { type BuildTimeline, buildTimeline, type LiveStageView, type TimelineEntry } from "./build-timeline.ts";
import type { StripAgent, StripAgentState, StripSnapshot } from "./dashboard-strip.ts";
import {
	cancelDelegate,
	type DelegateLaunch,
	DelegateSessionReader,
	delegateStatus,
	findDelegateRuns,
	findLiveDelegateProcesses,
} from "./delegate-runs.ts";
import { type FileDiffResult, loadFileDiff } from "./file-diff.ts";
import type { PlannerSession } from "./planner-session.ts";
import { findRepoRoot } from "./repo-files.ts";
import { type GaugeEntry, readSessionGauge, type SessionGauge } from "./session-gauge.ts";
import { type FileChange, loadWorkChanges } from "./work-changes.ts";
import { SUBAGENT_ROLES, WORKFLOW_STATE_ENTRY_TYPE } from "./workflow-state.ts";

/** While agents work the files change all the time; otherwise edits and turn ends mark the count stale. */
const BUSY_CHANGES_REFRESH_MS = 3000;
const IDLE_CHANGES_REFRESH_MS = 15_000;
const REPO_REFRESH_MS = 5000;
/** Scanning /proc for delegate processes costs more than reading entries, so it runs less often. */
const DELEGATE_PROCESS_REFRESH_MS = 2000;
const DELEGATE_MESSAGE_BLOCKER = "Delegates take no messages; x cancels a running one";
/** Outside a run the changes are the uncommitted work. */
const UNCOMMITTED_BASE = "HEAD";
const FILE_CHANGING_TOOLS = new Set(["edit", "write", "bash"]);

/** The agreed plan's text; undefined while there is no plan file. */
function readPlanText(planPath: string | undefined): string | undefined {
	if (!planPath || !existsSync(planPath)) return undefined;
	return readFileSync(planPath, "utf8");
}

/** First "# heading" of the plan. */
function planHeading(planText: string | undefined): string | undefined {
	const heading = planText?.split("\n").find((line) => line.startsWith("# "));
	return heading?.slice(2).trim();
}

function hasWorkflowEntries(entries: readonly TimelineEntry[]): boolean {
	return entries.some((entry) => entry.type === "custom" && entry.customType === WORKFLOW_STATE_ENTRY_TYPE);
}

function stripStateOf(live: LiveStage): StripAgentState {
	if (live.process.isWorking) return "working";
	const condition: AgentCondition = live.condition;
	switch (condition) {
		case "waiting-for-planner":
			return "waiting";
		case "answered":
			return "done";
		case "crashed":
			return "crashed";
		case "running":
		case "stopped":
			return "paused";
	}
}

export class WorkspaceFeed {
	private readonly pi: ExtensionAPI;
	private readonly session: PlannerSession;
	private readonly orchestrator: BuildOrchestrator;
	private ctx: ExtensionContext | undefined;
	private planner = new AgentTracker();
	private timeline: BuildTimeline | undefined;
	private planText: string | undefined;
	private delegates: DelegateRow[] = [];
	private gauge: SessionGauge = { costUsd: 0, contextPercent: undefined, model: undefined, thinkingLevel: undefined, tier: undefined };
	private checks: CheckStatus | undefined;
	private repo: RepoLocation | undefined;
	private repoReadAtMs = 0;
	private changes: ChangesView = { kind: "not-started" };
	private changesBase: string | undefined;
	private isLoadingChanges = false;
	private changesLoadedAtMs = 0;
	private readonly delegateSessions = new DelegateSessionReader();
	private liveDelegateProcesses: Map<string, number> | undefined = new Map();
	private delegateProcessesReadAtMs = 0;

	constructor(pi: ExtensionAPI, session: PlannerSession, orchestrator: BuildOrchestrator) {
		this.pi = pi;
		this.session = session;
		this.orchestrator = orchestrator;
		this.watchPlanner(pi);
		pi.events.on(CHECK_STATUS_EVENT, (status) => {
			this.checks = status as CheckStatus;
		});
	}

	/** A new session: nothing carries over from the last one. */
	attach(ctx: ExtensionContext): void {
		this.ctx = ctx;
		this.planner = new AgentTracker();
		this.changes = { kind: "not-started" };
		this.changesBase = undefined;
		this.changesLoadedAtMs = 0;
		this.repoReadAtMs = 0;
		this.checks = undefined;
		this.refresh();
	}

	refresh(): void {
		const ctx = this.ctx;
		if (!ctx) return;
		const nowMs = Date.now();
		const entries = ctx.sessionManager.getBranch() as TimelineEntry[];
		this.timeline = hasWorkflowEntries(entries) ? buildTimeline(entries, nowMs, !ctx.isIdle(), this.liveStageViews(nowMs)) : undefined;
		this.planText = readPlanText(this.timeline?.planPath);
		this.delegates = this.readDelegates(entries, nowMs);
		const sessionModel = ctx.model ? { provider: ctx.model.provider, id: ctx.model.id, thinkingLevel: this.pi.getThinkingLevel() } : undefined;
		this.gauge = readSessionGauge(ctx.sessionManager.getEntries() as GaugeEntry[], sessionModel, ctx.getContextUsage()?.percent);
		this.refreshChangesWhenStale(nowMs);
		if (nowMs - this.repoReadAtMs >= REPO_REFRESH_MS) this.refreshRepo(nowMs);
	}

	/** Something animates: the strip's spinner only needs frames then. */
	get isBusy(): boolean {
		return (
			this.orchestrator.liveStages().some((live) => live.process.isWorking) ||
			this.delegates.some((delegate) => delegate.status === "running") ||
			this.checks?.kind === "running"
		);
	}

	/**
	 * A subagent working or waiting for the planner, or a delegate running: worth a pane beside the chat.
	 * A run that waits on you (to ship, or after a failed re-review) is not; the strip and Alt+A show it.
	 */
	get hasAgentsAtWork(): boolean {
		return (
			this.orchestrator.liveStages().some((live) => live.process.isWorking || live.condition === "waiting-for-planner") ||
			this.delegates.some((delegate) => delegate.status === "running")
		);
	}

	overviewSnapshot(): OverviewSnapshot {
		return {
			timeline: this.timeline,
			repo: this.repo,
			planTitle: planHeading(this.planText),
			planText: this.planText,
			changes: this.changes,
			changesBase: this.changesBase,
			feeds: { ...this.buildFeeds(), ...this.delegateFeeds() },
			delegates: this.delegates,
			nowMs: Date.now(),
		};
	}

	stripSnapshot(): StripSnapshot {
		const nowMs = Date.now();
		return {
			repo: this.repo,
			changes: this.changes,
			gauge: this.gauge,
			checks: this.checks,
			agents: [...this.subagentStrips(nowMs), ...this.delegateStrips()],
			nowMs,
		};
	}

	/** Sends a message to an agent; returns an error to show, or undefined when sent. */
	sendMessage(agent: AgentKey, text: string): string | undefined {
		if (agent.startsWith("delegate:")) return DELEGATE_MESSAGE_BLOCKER;
		const subagentRole = SUBAGENT_ROLES.find((role) => role === agent);
		if (subagentRole) return this.orchestrator.sendToSubagent(subagentRole, text);
		this.planner.activity.add("you", text, Date.now());
		this.session.sendToPlanner(text);
		return undefined;
	}

	async runControl(command: ControlCommand): Promise<string | undefined> {
		switch (command.kind) {
			case "cancel-delegate":
				return this.cancelDelegateRun(command.runId);
			case "agent":
				return command.control === "stop-turn" ? this.orchestrator.stopAgentTurn(command.role) : this.orchestrator.restartAgent(command.role);
			case "run":
				switch (command.control) {
					case "fix-again":
						return this.orchestrator.fixAgain();
					case "re-review":
						return this.orchestrator.reReview();
					case "accept":
						return this.orchestrator.acceptAnyway();
				}
		}
	}

	async loadFileDiff(file: FileChange): Promise<FileDiffResult> {
		if (!this.changesBase) return { ok: false, error: "The changes are still being counted" };
		return loadFileDiff(this.session.run, this.changesBase, file);
	}

	/** The planner's own work, for its row and activity; subagents report through the orchestrator. */
	private watchPlanner(pi: ExtensionAPI): void {
		pi.on("agent_start", () => this.planner.startTurn(Date.now()));
		pi.on("agent_end", () => {
			this.planner.endTurn(Date.now());
			this.changesLoadedAtMs = 0;
		});
		pi.on("tool_execution_start", (event) => {
			if (!event.parentToolCallId) this.planner.startTool(event.toolName, event.args, Date.now());
		});
		pi.on("tool_execution_end", (event) => {
			if (!event.parentToolCallId) this.planner.endTool(event.isError, Date.now());
			if (FILE_CHANGING_TOOLS.has(event.toolName)) this.changesLoadedAtMs = 0;
		});
		pi.on("message_end", (event) => {
			const message = event.message as AssistantMessageLike;
			if (message.role === "assistant") this.planner.recordAnswer(message, Date.now());
		});
	}

	private liveStageViews(nowMs: number): LiveStageView[] {
		return this.orchestrator.liveStages().map((live): LiveStageView => {
			const stats = live.process.tracker.stats;
			return {
				stage: live.stage,
				agent: live.role,
				reviewer: live.reviewer,
				model: stats.model,
				thinkingLevel: stats.thinkingLevel,
				routeReason: stats.routeReason,
				...stageStats(live, nowMs),
				isWorking: live.process.isWorking,
			};
		});
	}

	/** The run's changes while it is going; the uncommitted work otherwise. */
	private currentChangesBase(): string {
		const timeline = this.timeline;
		return timeline && !timeline.isFinished && timeline.baseCommit ? timeline.baseCommit : UNCOMMITTED_BASE;
	}

	private refreshChangesWhenStale(nowMs: number): void {
		const base = this.currentChangesBase();
		if (base !== this.changesBase) {
			this.changesBase = base;
			this.changes = { kind: "loading" };
			this.changesLoadedAtMs = 0;
		}
		const refreshMs = this.isBusy ? BUSY_CHANGES_REFRESH_MS : IDLE_CHANGES_REFRESH_MS;
		if (this.isLoadingChanges || nowMs - this.changesLoadedAtMs < refreshMs) return;
		this.isLoadingChanges = true;
		void loadWorkChanges(this.session.run, base)
			.then((result) => {
				if (base === this.changesBase) this.changes = { kind: "loaded", result };
			})
			.catch((error: unknown) => {
				this.changes = { kind: "loaded", result: { ok: false, error: `Failed to count changes: ${(error as Error).message}` } };
			})
			.finally(() => {
				this.isLoadingChanges = false;
				this.changesLoadedAtMs = Date.now();
			});
	}

	private refreshRepo(nowMs: number): void {
		this.repoReadAtMs = nowMs;
		void this.readRepoLocation()
			.then((location) => {
				this.repo = location;
			})
			.catch(() => {
				// git is missing or failed: the dashboard leaves the repo out until the next read.
				this.repo = undefined;
			});
	}

	private async readRepoLocation(): Promise<RepoLocation | undefined> {
		const repoRoot = await findRepoRoot(this.session.run);
		if (!repoRoot) return undefined;
		const branch = await this.session.run("git", ["branch", "--show-current"]);
		const repoName = repoRoot.split("/").at(-1) ?? repoRoot;
		return { repoName, branch: branch.code === 0 && branch.stdout.trim() !== "" ? branch.stdout.trim() : undefined };
	}

	private buildFeeds(): Partial<Record<AgentKey, AgentFeed>> {
		const result: Partial<Record<AgentKey, AgentFeed>> = {
			planner: { activity: this.planner.activity.recent(50), runningTool: this.planner.stats.runningTool, messageBlocker: undefined },
		};
		for (const role of SUBAGENT_ROLES) {
			const subagent = this.orchestrator.process(role);
			if (!subagent) continue;
			result[role] = {
				activity: subagent.tracker.activity.recent(50),
				runningTool: subagent.tracker.stats.runningTool,
				messageBlocker: subagent.isRunning ? undefined : `The ${subagent.name} is not running; r restarts it`,
			};
		}
		return result;
	}

	private subagentStrips(nowMs: number): StripAgent[] {
		return this.orchestrator.liveStages().map((live) => {
			const stats = live.process.tracker.stats;
			const { costUsd } = stageStats(live, nowMs);
			return {
				name: live.process.name,
				state: stripStateOf(live),
				model: stats.model,
				thinkingLevel: stats.thinkingLevel,
				runningTool: stats.runningTool,
				elapsedMs: activeMsOf(stats, nowMs),
				costUsd,
			};
		});
	}

	private delegateStrips(): StripAgent[] {
		return this.delegates
			.filter((delegate) => delegate.status === "running")
			.map((delegate) => ({
				name: `${delegate.role.charAt(0).toUpperCase()}${delegate.role.slice(1)} ${delegate.runId.slice(-4)}`,
				state: "working",
				model: delegate.model,
				thinkingLevel: delegate.thinkingLevel,
				runningTool: this.delegateSessions.read(delegate.runId)?.pendingTool,
				elapsedMs: delegate.elapsedMs,
				costUsd: delegate.costUsd,
			}));
	}

	private refreshLiveDelegateProcesses(): void {
		if (Date.now() - this.delegateProcessesReadAtMs < DELEGATE_PROCESS_REFRESH_MS) return;
		this.liveDelegateProcesses = findLiveDelegateProcesses();
		this.delegateProcessesReadAtMs = Date.now();
	}

	private readDelegates(entries: readonly TimelineEntry[], nowMs: number): DelegateRow[] {
		const launches = findDelegateRuns(entries as Parameters<typeof findDelegateRuns>[0]);
		if (launches.length === 0) return [];
		this.refreshLiveDelegateProcesses();
		return launches.map((launch) => this.delegateRow(launch, nowMs));
	}

	private delegateRow(launch: DelegateLaunch, nowMs: number): DelegateRow {
		const delegateSession = this.delegateSessions.read(launch.runId);
		const status = delegateStatus(launch, this.liveDelegateProcesses);
		const startedAtMs = delegateSession?.startedAtMs ?? nowMs;
		const endedAtMs = status === "running" ? nowMs : (delegateSession?.lastEntryAtMs ?? nowMs);
		return {
			key: `delegate:${launch.runId}`,
			runId: launch.runId,
			role: launch.agent,
			task: launch.task,
			status,
			model: delegateSession?.model,
			thinkingLevel: delegateSession?.thinkingLevel,
			routeReason: delegateSession?.routeReason,
			elapsedMs: status === "running" ? nowMs - startedAtMs : (launch.durationMs ?? endedAtMs - startedAtMs),
			costUsd: delegateSession?.costUsd ?? 0,
		};
	}

	private delegateFeeds(): Partial<Record<AgentKey, AgentFeed>> {
		const result: Partial<Record<AgentKey, AgentFeed>> = {};
		for (const delegate of this.delegates) {
			const delegateSession = this.delegateSessions.read(delegate.runId);
			result[delegate.key] = {
				activity: delegateSession?.activity ?? [],
				runningTool: delegate.status === "running" ? delegateSession?.pendingTool : undefined,
				messageBlocker: DELEGATE_MESSAGE_BLOCKER,
			};
		}
		return result;
	}

	private cancelDelegateRun(runId: string): string | undefined {
		this.delegateProcessesReadAtMs = 0;
		this.refreshLiveDelegateProcesses();
		const error = cancelDelegate(runId, this.liveDelegateProcesses);
		this.delegateProcessesReadAtMs = 0;
		return error;
	}
}
