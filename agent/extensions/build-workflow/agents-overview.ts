/**
 * The Alt+A agents overview: a centered card with four tabs. Agents: one row per /build role (model, thinking,
 * time, cost, why that model), the selected agent's live activity, a message line and the controls for the
 * agent and the run. Changes: the lines changed since implementation began, with a diff per file. Plan and
 * Report: the run's plan and its last report. Renders and handles keys; agents-overview-panel.ts feeds it.
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, type Focusable, Input, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ActivityLine, RunningTool } from "./agent-activity.ts";
import { type ControlCommand, type ControlKey, controlsFor, type SelectedAgent } from "./agent-controls.ts";
import type { BuildAgentKey, BuildTimeline, StageKey, StageRow, StageStatus } from "./build-timeline.ts";
import type { DelegateStatus } from "./delegate-runs.ts";
import type { FileDiffResult } from "./file-diff.ts";
import { FileDiffView, type HighlightCode } from "./file-diff-view.ts";
import { markdownLines, TextPager } from "./text-pager.ts";
import type { FileChange, WorkChangesResult } from "./work-changes.ts";

export type { BuildAgentKey };
export type DelegateKey = `delegate:${string}`;
/** A /build agent, or a background run started with acp_delegate. */
export type AgentKey = BuildAgentKey | DelegateKey;

/** One acp_delegate run of this session: view-only, but a running one can be cancelled. */
export interface DelegateRow {
	key: DelegateKey;
	runId: string;
	/** reviewer, researcher, worker, planner or oracle. */
	role: string;
	task: string;
	status: DelegateStatus;
	model: string | undefined;
	thinkingLevel: string | undefined;
	routeReason: string | undefined;
	elapsedMs: number;
	costUsd: number;
}

/** What one agent is doing now, for its activity section and its row's tool line. */
export interface AgentFeed {
	activity: readonly ActivityLine[];
	runningTool: RunningTool | undefined;
	/** Why a message cannot be sent now, e.g. the subagent is not running; undefined when it can. */
	messageBlocker: string | undefined;
}

export type ChangesView = { kind: "not-started" } | { kind: "loading" } | { kind: "loaded"; result: WorkChangesResult };

/** Where the run works: the repository folder name and the checked-out branch. */
export interface RepoLocation {
	repoName: string;
	/** Undefined on a detached HEAD. */
	branch: string | undefined;
}

export interface OverviewSnapshot {
	timeline: BuildTimeline | undefined;
	repo: RepoLocation | undefined;
	/** The agreed plan's "# heading"; the task's first line until a plan exists. */
	planTitle: string | undefined;
	/** The plan file's text, for the Plan tab; undefined until there is a plan. */
	planText: string | undefined;
	changes: ChangesView;
	feeds: Partial<Record<AgentKey, AgentFeed>>;
	delegates: readonly DelegateRow[];
	nowMs: number;
}

export interface OverviewActions {
	close(): void;
	/** Sends a message to an agent; returns an error to show, or undefined when sent. */
	sendMessage(agent: AgentKey, text: string): string | undefined;
	loadFileDiff(file: FileChange): Promise<FileDiffResult>;
	/** Stops or restarts an agent, steers the run, or cancels a delegate; resolves to an error to show, or undefined. */
	control(command: ControlCommand): Promise<string | undefined>;
	/** Opens the plan in an editor; saving it is a plan change, like the planner saving it. */
	editPlan(): void;
}

export interface OverviewLayout {
	/** Rows the card may use between its top and bottom borders; the diff view fills them. */
	bodyRows: () => number;
	/** Syntax colors for the diff view; plain text without it. */
	highlight?: HighlightCode;
}

export type OverviewTab = "agents" | "changes" | "plan" | "report";

/** In the order of their number keys. */
const TABS: readonly { tab: OverviewTab; key: string }[] = [
	{ tab: "agents", key: "1" },
	{ tab: "changes", key: "2" },
	{ tab: "plan", key: "3" },
	{ tab: "report", key: "4" },
];

const AGENT_NAMES: Record<BuildAgentKey, string> = {
	planner: "Planner",
	implementer: "Implementer",
	"anthropic-reviewer": "Claude reviewer",
	"openai-reviewer": "OpenAI reviewer",
};

/** When the stepper merges the rows of one stage (both reviewers), the first status here wins. */
const MERGED_STATUS_ORDER: readonly StageStatus[] = ["working", "paused", "your-turn", "done", "skipped", "waiting"];

/** One stepper step per stage: the rows of the two reviewers become one step. */
function stepsOf(stages: readonly StageRow[]): { key: StageKey; status: StageStatus }[] {
	const steps: { key: StageKey; status: StageStatus }[] = [];
	for (const stage of stages) {
		const previous = steps.at(-1);
		if (previous?.key !== stage.key) {
			steps.push({ key: stage.key, status: stage.status });
			continue;
		}
		const rank = (status: StageStatus) => MERGED_STATUS_ORDER.indexOf(status);
		if (rank(stage.status) < rank(previous.status)) previous.status = stage.status;
	}
	return steps;
}
const ACTIVITY_LINES_SHOWN = 12;

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
export const SPINNER_FRAME_MS = 100;
/** The tab bar and the blank line under it. */
const TAB_BAR_ROWS = 2;
/** The Plan and Report tabs' line above the text: file name and position. */
const PAGER_HEADING_ROWS = 2;
/** The file list shows at least this many files, and grows to fill the card's height. */
const MIN_FILES_SHOWN = 3;
/** The Changes heading plus the "↑ more" and "↓ more" lines around the file list. */
const FILE_LIST_FRAME_ROWS = 3;
const CHANGE_BAR_CELLS = 16;
/** Fits "OpenAI re-reviewer" plus a space. */
const ROLE_COLUMN_WIDTH = 19;
const TIME_COLUMN_WIDTH = 9;
const COST_COLUMN_WIDTH = 8;
const DETAIL_INDENT = "       ";

const STAGE_SHORT_NAMES: Record<StageKey, string> = {
	plan: "Plan",
	implement: "Implement",
	review: "Review",
	fix: "Fix",
	"re-review": "Re-review",
	pr: "PR",
	ship: "Ship",
};

type ThinkingColor = Parameters<Theme["fg"]>[0];
const THINKING_COLORS: Record<string, ThinkingColor> = {
	off: "thinkingOff",
	minimal: "thinkingMinimal",
	low: "thinkingLow",
	medium: "thinkingMedium",
	high: "thinkingHigh",
	xhigh: "thinkingXhigh",
	max: "thinkingMax",
};

function isDelegateKey(agent: AgentKey): agent is DelegateKey {
	return agent.startsWith("delegate:");
}

function capitalize(word: string): string {
	return word.charAt(0).toUpperCase() + word.slice(1);
}

function changedFiles(changes: ChangesView): FileChange[] {
	return changes.kind === "loaded" && changes.result.ok ? changes.result.value.files : [];
}

export function formatDuration(durationMs: number): string {
	const totalSeconds = Math.floor(durationMs / 1000);
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const totalMinutes = Math.floor(totalSeconds / 60);
	if (totalMinutes < 60) return `${totalMinutes}m ${String(totalSeconds % 60).padStart(2, "0")}s`;
	return `${Math.floor(totalMinutes / 60)}h ${String(totalMinutes % 60).padStart(2, "0")}m`;
}

function taskHeadline(task: string): string {
	const firstLine = task.split("\n").find((line) => line.trim() !== "") ?? task;
	return firstLine.replace(/^#+\s*/, "").trim();
}

function formatCost(costUsd: number): string {
	return costUsd > 0 ? `$${costUsd.toFixed(2)}` : "";
}

/** Keeps the end of a path, where the file name is. */
function truncatePathStart(path: string, maxWidth: number): string {
	if (visibleWidth(path) <= maxWidth) return path;
	return `…${path.slice(path.length - maxWidth + 1)}`;
}

function padStartToWidth(text: string, width: number): string {
	return " ".repeat(Math.max(0, width - visibleWidth(text))) + text;
}

function padEndToWidth(text: string, width: number): string {
	const fitted = truncateToWidth(text, width, "…");
	return fitted + " ".repeat(Math.max(0, width - visibleWidth(fitted)));
}

/** Left text, then right text flush right; the left side gives way when both do not fit. */
function spread(left: string, right: string, width: number): string {
	const rightWidth = visibleWidth(right);
	const fittedLeft = truncateToWidth(left, Math.max(0, width - rightWidth - 1), "…");
	return fittedLeft + " ".repeat(Math.max(1, width - visibleWidth(fittedLeft) - rightWidth)) + right;
}

export class AgentsOverview implements Component, Focusable {
	private frameIndex = 0;
	private readonly theme: Theme;
	private readonly readSnapshot: () => OverviewSnapshot;
	private readonly actions: OverviewActions;
	/** Undefined until the user moves the selection: then the working agent is shown. */
	private selectedAgent: AgentKey | undefined;
	private composer: Input | undefined;
	/** Why the last message or control did not go through. */
	private actionError: string | undefined;
	private isFocused = false;
	private readonly layout: OverviewLayout;
	private tab: OverviewTab = "agents";
	private selectedFileIndex = 0;
	private diffView: FileDiffView | undefined;
	/** A control that waits for its key a second time, so one stray key does not throw work away. */
	private armedControl: ControlKey | undefined;
	private readonly planPager = new TextPager();
	private readonly reportPager = new TextPager();
	/** The plan version last shown in the Plan tab; a newer one marks the tab. */
	private seenPlanRevision = 1;

	constructor(
		theme: Theme,
		readSnapshot: () => OverviewSnapshot,
		actions: OverviewActions,
		layout: OverviewLayout = { bodyRows: () => 30 },
	) {
		this.theme = theme;
		this.readSnapshot = readSnapshot;
		this.actions = actions;
		this.layout = layout;
	}

	get focused(): boolean {
		return this.isFocused;
	}

	set focused(isFocused: boolean) {
		this.isFocused = isFocused;
		if (this.composer) this.composer.focused = isFocused;
	}

	advanceSpinner(): void {
		this.frameIndex = (this.frameIndex + 1) % SPINNER_FRAMES.length;
	}

	handleInput(data: string): void {
		if (this.composer) {
			this.composer.handleInput(data);
			return;
		}
		if (this.diffView) {
			if (matchesKey(data, "alt+a")) this.actions.close();
			else if (this.diffView.handleInput(data) === "close") this.diffView = undefined;
			return;
		}
		if (matchesKey(data, "escape") || matchesKey(data, "q") || matchesKey(data, "alt+a")) {
			this.actions.close();
			return;
		}
		const snapshot = this.readSnapshot();
		const armedControl = this.armedControl;
		this.armedControl = undefined;
		if (this.switchTab(data, snapshot)) return;
		if (data === "p" && snapshot.timeline?.planPath) {
			this.actions.editPlan();
			return;
		}
		switch (this.currentTab(snapshot)) {
			case "changes":
				this.handleFilesInput(data, changedFiles(snapshot.changes));
				return;
			case "plan":
				this.planPager.handleInput(data, this.pagerRows());
				return;
			case "report":
				this.reportPager.handleInput(data, this.pagerRows());
				return;
			case "agents":
				this.handleAgentsInput(data, snapshot, armedControl);
		}
	}

	/** 1–4 pick a tab, Tab and Shift+Tab step through them; only a build has tabs. */
	private switchTab(data: string, snapshot: OverviewSnapshot): boolean {
		if (!snapshot.timeline) return false;
		const picked = TABS.find((entry) => entry.key === data);
		if (picked) {
			this.tab = picked.tab;
			return true;
		}
		const step = matchesKey(data, "tab") ? 1 : matchesKey(data, "shift+tab") ? -1 : 0;
		if (step === 0) return false;
		const index = TABS.findIndex((entry) => entry.tab === this.tab);
		this.tab = TABS[(index + step + TABS.length) % TABS.length].tab;
		return true;
	}

	private currentTab(snapshot: OverviewSnapshot): OverviewTab {
		return snapshot.timeline ? this.tab : "agents";
	}

	private handleAgentsInput(data: string, snapshot: OverviewSnapshot, armedControl: ControlKey | undefined): void {
		const agents = this.selectableAgents(snapshot);
		const current = this.currentAgent(snapshot);
		const index = current ? agents.indexOf(current) : -1;
		if (agents.length > 0 && (matchesKey(data, "up") || matchesKey(data, "k"))) {
			this.selectedAgent = agents[Math.max(0, index - 1)];
			return;
		}
		if (agents.length > 0 && (matchesKey(data, "down") || matchesKey(data, "j"))) {
			this.selectedAgent = agents[Math.min(agents.length - 1, index + 1)];
			return;
		}
		if (current && (matchesKey(data, "enter") || matchesKey(data, "m"))) {
			this.openComposer(current);
			return;
		}
		const control = this.controls(snapshot).find((candidate) => candidate.key === data);
		if (!control) return;
		this.actionError = undefined;
		if (control.confirmation && armedControl?.key !== control.key) {
			this.armedControl = control;
			return;
		}
		void this.actions.control(control.command).then((error) => {
			this.actionError = error;
		});
	}

	private controls(snapshot: OverviewSnapshot): ControlKey[] {
		return controlsFor(snapshot.timeline, this.selectedOf(this.currentAgent(snapshot), snapshot));
	}

	private selectedOf(agent: AgentKey | undefined, snapshot: OverviewSnapshot): SelectedAgent {
		if (!agent) return { kind: "none" };
		if (!isDelegateKey(agent)) return { kind: "build", agent };
		const delegate = snapshot.delegates.find((row) => row.key === agent);
		if (!delegate) return { kind: "none" };
		return { kind: "delegate", runId: delegate.runId, role: delegate.role, isRunning: delegate.status === "running" };
	}

	/** Rows of text the Plan and Report tabs show at once. */
	private pagerRows(): number {
		return Math.max(3, this.layout.bodyRows() - TAB_BAR_ROWS - PAGER_HEADING_ROWS - 3);
	}

	private handleFilesInput(data: string, files: readonly FileChange[]): void {
		if (files.length === 0) return;
		const lastIndex = files.length - 1;
		if (matchesKey(data, "up") || matchesKey(data, "k")) this.selectedFileIndex = Math.max(0, this.selectedFileIndex - 1);
		else if (matchesKey(data, "down") || matchesKey(data, "j")) this.selectedFileIndex = Math.min(lastIndex, this.selectedFileIndex + 1);
		else if (matchesKey(data, "enter") || matchesKey(data, "space")) this.openDiff(files);
	}

	private openDiff(files: readonly FileChange[]): void {
		this.diffView = new FileDiffView({
			theme: this.theme,
			files,
			fileIndex: Math.min(this.selectedFileIndex, files.length - 1),
			loadDiff: (file) => this.actions.loadFileDiff(file),
			highlight: this.layout.highlight,
			bodyRows: this.layout.bodyRows,
		});
	}

	invalidate(): void {
		this.composer?.invalidate();
	}

	render(width: number): string[] {
		const snapshot = this.readSnapshot();
		const innerWidth = Math.max(10, width - 4);
		const body = this.diffView
			? this.diffView.render(innerWidth)
			: snapshot.timeline
				? this.renderBuild(snapshot.timeline, snapshot, innerWidth)
				: snapshot.delegates.length > 0
					? this.renderDelegatesOnly(snapshot, innerWidth)
					: this.renderNoBuild();
		const lines = [
			this.topBorder(snapshot.timeline, width),
			this.frame("", innerWidth),
			...body.map((line) => this.frame(line, innerWidth)),
			this.frame("", innerWidth),
			this.bottomBorder(snapshot, width),
		];
		return lines.map((line) => truncateToWidth(line, width));
	}

	private openComposer(agent: AgentKey): void {
		const feed = this.readSnapshot().feeds[agent];
		if (feed?.messageBlocker) {
			this.actionError = feed.messageBlocker;
			return;
		}
		const composer = new Input({ prompt: "› " });
		composer.focused = this.isFocused;
		composer.onSubmit = (text) => {
			if (text.trim() === "") return;
			this.actionError = this.actions.sendMessage(agent, text.trim());
			this.composer = undefined;
		};
		composer.onEscape = () => {
			this.composer = undefined;
		};
		this.selectedAgent = agent;
		this.actionError = undefined;
		this.composer = composer;
	}

	/** The live /build agents, then every delegate run, in the order the card lists them. */
	private selectableAgents(snapshot: OverviewSnapshot): AgentKey[] {
		const timeline = snapshot.timeline;
		const buildAgents =
			!timeline || timeline.isFinished
				? []
				: timeline.stages
						.filter((stage) => stage.status !== "waiting" && stage.status !== "skipped")
						.map((stage) => stage.agent)
						.filter((agent): agent is BuildAgentKey => agent !== undefined);
		return [...new Set<AgentKey>(buildAgents), ...snapshot.delegates.map((delegate) => delegate.key)];
	}

	/** The agent the user picked, else the build agent working now, else a running delegate, else the first. */
	private currentAgent(snapshot: OverviewSnapshot): AgentKey | undefined {
		const agents = this.selectableAgents(snapshot);
		if (this.selectedAgent && agents.includes(this.selectedAgent)) return this.selectedAgent;
		const timeline = snapshot.timeline;
		const busiest = timeline?.isFinished
			? undefined
			: (timeline?.stages.find((stage) => stage.status === "working" && stage.key !== "plan") ??
				timeline?.stages.find((stage) => stage.status === "working" || stage.status === "paused" || stage.status === "your-turn"));
		const busyBuildAgent = busiest?.agent;
		const runningDelegate = snapshot.delegates.find((delegate) => delegate.status === "running")?.key;
		return busyBuildAgent ?? runningDelegate ?? agents[0];
	}

	private agentName(agent: AgentKey, snapshot: OverviewSnapshot): string {
		if (!isDelegateKey(agent)) return AGENT_NAMES[agent];
		const delegate = snapshot.delegates.find((row) => row.key === agent);
		return delegate ? `${capitalize(delegate.role)} ${delegate.runId}` : agent;
	}

	private frame(content: string, innerWidth: number): string {
		const border = this.theme.fg("borderMuted", "│");
		return `${border} ${padEndToWidth(content, innerWidth)} ${border}`;
	}

	private topBorder(timeline: BuildTimeline | undefined, width: number): string {
		const theme = this.theme;
		const name = timeline?.issue
			? `Issue #${timeline.issue.number}`
			: timeline?.planIssue
				? `Build · issue #${timeline.planIssue.number}`
				: timeline
					? "Build"
					: "Agents";
		const title = `${theme.fg("accent", "◆")} ${theme.bold(name)}`;
		const totals = timeline ? [formatDuration(timeline.activeMs), formatCost(timeline.costUsd)].filter(Boolean).join(" · ") : "";
		const state = timeline?.isFinished ? "finished" : "";
		const right = [state, totals].filter(Boolean).join(" · ");
		const rightPart = right ? ` ${theme.fg("muted", right)} ` : "";
		const fillWidth = Math.max(1, width - 5 - visibleWidth(title) - visibleWidth(rightPart));
		return theme.fg("borderMuted", "╭─ ") + title + theme.fg("borderMuted", ` ${"─".repeat(fillWidth)}`) + rightPart + theme.fg("borderMuted", "╮");
	}

	/** The bottom border's keys: how to move around; the agent's and run's controls get their own line. */
	private keyHint(snapshot: OverviewSnapshot): string {
		if (this.composer) return "enter send · esc cancel";
		if (this.diffView) return this.diffView.keyHint();
		const tabs = snapshot.timeline ? "1-4 tab · " : "";
		const plan = snapshot.timeline?.planPath ? "p edit plan · " : "";
		switch (this.currentTab(snapshot)) {
			case "changes":
				return `${tabs}↑↓ file · enter diff · ${plan}esc close`;
			case "plan":
			case "report":
				return `${tabs}↑↓ space b scroll · ${plan}esc close`;
			case "agents": {
				const current = this.currentAgent(snapshot);
				const canMessage = current !== undefined && !isDelegateKey(current);
				return `${tabs}↑↓ agent · ${canMessage ? "enter message · " : ""}${plan}esc close`;
			}
		}
	}

	private bottomBorder(snapshot: OverviewSnapshot, width: number): string {
		const theme = this.theme;
		const timeline = snapshot.timeline;
		const hint = this.keyHint(snapshot);
		const keys = ` ${theme.fg("dim", hint)} `;
		const planName = timeline?.planPath?.split("/").at(-1);
		const maxPlanWidth = Math.max(0, width - 10 - visibleWidth(keys));
		const plan = planName ? ` ${theme.fg("dim", truncatePathStart(`plan ${planName}`, maxPlanWidth))} ` : "";
		const fillWidth = Math.max(1, width - 3 - visibleWidth(keys) - visibleWidth(plan));
		return theme.fg("borderMuted", "╰─") + keys + theme.fg("borderMuted", "─".repeat(fillWidth)) + plan + theme.fg("borderMuted", "╯");
	}

	private renderNoBuild(): string[] {
		const theme = this.theme;
		return [
			theme.bold("No build running"),
			"",
			`${theme.fg("accent", "/build <task>")}   ${theme.fg("muted", "plan → implement → review")}`,
			`${theme.fg("accent", "/issue #123")}     ${theme.fg("muted", "GitHub issue → fix → draft PR")}`,
		];
	}

	private renderBuild(timeline: BuildTimeline, snapshot: OverviewSnapshot, innerWidth: number): string[] {
		const header = [
			this.theme.bold(snapshot.planTitle ?? taskHeadline(timeline.task)),
			...this.repoLines(snapshot.repo),
			this.tabBar(timeline, snapshot),
			"",
		];
		const rowsLeft = this.layout.bodyRows() - header.length;
		switch (this.currentTab(snapshot)) {
			case "agents":
				return [...header, ...this.agentsTab(timeline, snapshot, innerWidth)];
			case "changes":
				return [...header, ...this.changesLines(snapshot, timeline.baseCommit, innerWidth, Math.max(MIN_FILES_SHOWN, rowsLeft - FILE_LIST_FRAME_ROWS))];
			case "plan":
				this.seenPlanRevision = Math.max(this.seenPlanRevision, timeline.planRevision);
				return [...header, ...this.planTab(timeline, snapshot, innerWidth)];
			case "report":
				return [...header, ...this.reportTab(timeline, innerWidth)];
		}
	}

	/** " 1 Agents   2 Changes 26   3 Plan v2 ●   4 Report ", the open tab highlighted. */
	private tabBar(timeline: BuildTimeline, snapshot: OverviewSnapshot): string {
		const theme = this.theme;
		const fileCount = changedFiles(snapshot.changes).length;
		const planVersion = timeline.planRevision > 1 ? ` v${timeline.planRevision}` : "";
		const planChanged = timeline.planRevision > this.seenPlanRevision ? ` ${theme.fg("warning", "●")}` : "";
		const labels: Record<OverviewTab, string> = {
			agents: "Agents",
			changes: fileCount > 0 ? `Changes ${theme.fg("muted", String(fileCount))}` : "Changes",
			plan: `Plan${planVersion}${planChanged}`,
			report: timeline.report ? "Report" : theme.fg("dim", "Report"),
		};
		const openTab = this.currentTab(snapshot);
		return TABS.map(({ tab, key }) => {
			if (tab === openTab) return theme.bg("selectedBg", ` ${theme.fg("accent", key)} ${theme.bold(labels[tab])} `);
			return ` ${theme.fg("dim", key)} ${labels[tab]} `;
		}).join(" ");
	}

	private agentsTab(timeline: BuildTimeline, snapshot: OverviewSnapshot, innerWidth: number): string[] {
		const selectedAgent = this.currentAgent(snapshot);
		return [
			this.stepper(timeline.stages),
			"",
			...timeline.stages.flatMap((stage) => this.stageLines(stage, snapshot, innerWidth, selectedAgent)),
			...this.delegateSection(snapshot, innerWidth, selectedAgent),
			...(selectedAgent ? ["", ...this.activityLines(selectedAgent, snapshot, innerWidth)] : []),
			...this.controlLines(snapshot, innerWidth),
			...this.composerLines(selectedAgent, snapshot, innerWidth),
			"",
			this.changesSummary(snapshot, timeline.baseCommit, innerWidth),
		];
	}

	/** "keys  s stop turn · r restart · R review again" for the selected agent and the run. */
	private controlLines(snapshot: OverviewSnapshot, innerWidth: number): string[] {
		const controls = this.controls(snapshot);
		if (controls.length === 0) return [];
		const theme = this.theme;
		const keys = controls.map((control) => `${theme.fg("accent", control.key)} ${theme.fg("muted", control.label)}`).join(theme.fg("dim", " · "));
		return ["", truncateToWidth(`${theme.fg("dim", "keys")}  ${keys}`, innerWidth, "…")];
	}

	/** The Agents tab's one line about the changes: "Changes +140 −12 · 2 files   2 lists them". */
	private changesSummary(snapshot: OverviewSnapshot, baseCommit: string | undefined, innerWidth: number): string {
		const changes = snapshot.changes;
		if (changes.kind !== "loaded" || !changes.result.ok || changes.result.value.files.length === 0) {
			return this.changesLines(snapshot, baseCommit, innerWidth, 0)[0];
		}
		const theme = this.theme;
		return spread(`${theme.bold("Changes")}  ${this.changeTotals(changes.result.value)}`, theme.fg("dim", "2 lists them"), innerWidth);
	}

	/** "+140 −12 · 2 files" */
	private changeTotals(changes: { added: number; removed: number; files: readonly FileChange[] }): string {
		const theme = this.theme;
		const fileCount = `${changes.files.length} file${changes.files.length === 1 ? "" : "s"}`;
		return `${theme.fg("toolDiffAdded", `+${changes.added}`)} ${theme.fg("toolDiffRemoved", `−${changes.removed}`)} ${theme.fg("muted", `· ${fileCount}`)}`;
	}

	private planTab(timeline: BuildTimeline, snapshot: OverviewSnapshot, innerWidth: number): string[] {
		const theme = this.theme;
		if (!timeline.planPath || snapshot.planText === undefined) return [theme.fg("dim", "No plan yet: the planner writes it with you, then saves it")];
		// The file name is in the bottom border already.
		const version = timeline.planRevision > 1 ? theme.fg("warning", ` · changed, version ${timeline.planRevision}`) : "";
		return this.pagedText(this.planPager, `${theme.bold("Plan")}${version}`, snapshot.planText, innerWidth);
	}

	private reportTab(timeline: BuildTimeline, innerWidth: number): string[] {
		if (!timeline.report) return [this.theme.fg("dim", "No report yet: the run posts it when the review ends")];
		return this.pagedText(this.reportPager, this.theme.bold("Run report"), timeline.report, innerWidth);
	}

	private pagedText(pager: TextPager, heading: string, text: string, innerWidth: number): string[] {
		const lines = markdownLines(text, innerWidth, this.theme);
		const { shown, firstLine, lastLine } = pager.page(lines, this.pagerRows());
		const position = this.theme.fg("dim", `${firstLine}–${lastLine} of ${lines.length}`);
		return [spread(heading, position, innerWidth), "", ...shown];
	}

	/** Only acp_delegate runs, no /build: the delegates and the selected one's activity. */
	private renderDelegatesOnly(snapshot: OverviewSnapshot, innerWidth: number): string[] {
		const selectedAgent = this.currentAgent(snapshot);
		return [
			...this.repoLines(snapshot.repo),
			...this.delegateSection(snapshot, innerWidth, selectedAgent).slice(snapshot.repo ? 0 : 1),
			...(selectedAgent ? ["", ...this.activityLines(selectedAgent, snapshot, innerWidth)] : []),
			...this.controlLines(snapshot, innerWidth),
			...this.composerLines(selectedAgent, snapshot, innerWidth),
		];
	}

	private delegateSection(
		snapshot: OverviewSnapshot,
		innerWidth: number,
		selectedAgent: AgentKey | undefined,
	): string[] {
		if (snapshot.delegates.length === 0) return [];
		const theme = this.theme;
		const runningCount = snapshot.delegates.filter((delegate) => delegate.status === "running").length;
		const heading = `${theme.bold("Delegates")} ${theme.fg("dim", `acp_delegate · ${runningCount} running`)}`;
		return [
			"",
			heading,
			...snapshot.delegates.flatMap((delegate) =>
				this.delegateLines(delegate, innerWidth, delegate.key === selectedAgent),
			),
		];
	}

	private delegateLines(delegate: DelegateRow, innerWidth: number, isSelected: boolean): string[] {
		const theme = this.theme;
		const roleName = capitalize(delegate.role);
		const roleText = theme.bold(isSelected ? theme.fg("accent", roleName) : roleName);
		const role = padEndToWidth(roleText, ROLE_COLUMN_WIDTH);
		const modelColumnWidth = Math.max(8, innerWidth - 5 - ROLE_COLUMN_WIDTH - TIME_COLUMN_WIDTH - COST_COLUMN_WIDTH);
		const modelText = delegate.model
			? this.modelWithThinking(delegate.model, delegate.thinkingLevel)
			: theme.fg("dim", delegate.status === "queued" ? "queued" : "starting");
		const model = padEndToWidth(modelText, modelColumnWidth);
		const time = padStartToWidth(this.delegateTimeText(delegate), TIME_COLUMN_WIDTH);
		const cost = padStartToWidth(theme.fg("muted", formatCost(delegate.costUsd)), COST_COLUMN_WIDTH);
		const pointer = isSelected ? theme.fg("accent", "❯ ") : "  ";
		const row = `${pointer}${this.delegateIcon(delegate.status)}  ${role}${model}${time}${cost}`;
		const task = `${DETAIL_INDENT}${theme.fg("dim", "╰")} ${theme.fg("muted", taskHeadline(delegate.task))}`;
		return [isSelected ? theme.bg("selectedBg", padEndToWidth(row, innerWidth)) : row, task];
	}

	private delegateIcon(status: DelegateStatus): string {
		const theme = this.theme;
		switch (status) {
			case "running":
				return theme.fg("accent", SPINNER_FRAMES[this.frameIndex]);
			case "queued":
				return theme.fg("dim", "○");
			case "completed":
				return theme.fg("success", "✓");
			case "failed":
				return theme.fg("error", "✗");
			case "cancelled":
				return theme.fg("warning", "–");
			case "ended":
				return theme.fg("muted", "■");
		}
	}

	private delegateTimeText(delegate: DelegateRow): string {
		const theme = this.theme;
		const duration = formatDuration(delegate.elapsedMs);
		switch (delegate.status) {
			case "running":
				return theme.fg("accent", duration);
			case "queued":
				return theme.fg("dim", "queued");
			case "failed":
				return theme.fg("error", "failed");
			case "cancelled":
				return theme.fg("warning", "cancelled");
			default:
				return theme.fg("muted", duration);
		}
	}

	private repoLines(repo: RepoLocation | undefined): string[] {
		if (!repo) return [];
		const theme = this.theme;
		const branch = repo.branch ? theme.fg("accent", repo.branch) : theme.fg("warning", "detached HEAD");
		return [`${theme.fg("muted", "repo")} ${theme.bold(repo.repoName)}   ${theme.fg("muted", "branch")} ${branch}`];
	}

	private composerLines(selectedAgent: AgentKey | undefined, snapshot: OverviewSnapshot, innerWidth: number): string[] {
		const theme = this.theme;
		if (this.composer && selectedAgent) {
			return ["", theme.fg("accent", `Message to the ${this.agentName(selectedAgent, snapshot)}`), ...this.composer.render(innerWidth)];
		}
		if (this.armedControl) {
			const { key, confirmation } = this.armedControl;
			return ["", theme.fg("warning", `Press ${key} again to ${confirmation}; any other key leaves it`)];
		}
		if (this.actionError) return ["", theme.fg("error", this.actionError)];
		return [];
	}

	private activityLines(agent: AgentKey, snapshot: OverviewSnapshot, innerWidth: number): string[] {
		const theme = this.theme;
		const heading = `${theme.fg("accent", "❯")} ${theme.bold(theme.fg("accent", this.agentName(agent, snapshot)))} ${theme.fg("dim", "activity")}`;
		const fill = theme.fg("borderMuted", "─".repeat(Math.max(1, innerWidth - visibleWidth(heading) - 1)));
		const activity = snapshot.feeds[agent]?.activity ?? [];
		const shown = activity.slice(-ACTIVITY_LINES_SHOWN);
		const lines = shown.map((line) => `  ${this.activityText(line)}`);
		if (lines.length === 0) lines.push(theme.fg("dim", "  nothing yet"));
		return [`${heading} ${fill}`, ...lines];
	}

	private activityText(line: ActivityLine): string {
		const theme = this.theme;
		switch (line.kind) {
			case "tool": {
				const [name, ...rest] = line.text.split("  ");
				return `${theme.fg("dim", "›")} ${theme.fg("accent", name)}  ${theme.fg("muted", rest.join("  "))}`;
			}
			case "text":
				return `${theme.fg("dim", "“")} ${line.text}`;
			case "you":
				return `${theme.fg("warning", "you:")} ${line.text}`;
			case "note":
				return theme.fg("dim", `· ${line.text}`);
			case "error":
				return theme.fg("error", `✗ ${line.text}`);
		}
	}

	private statusIcon(status: StageStatus): string {
		const theme = this.theme;
		switch (status) {
			case "done":
				return theme.fg("success", "✓");
			case "working":
				return theme.fg("accent", SPINNER_FRAMES[this.frameIndex]);
			case "your-turn":
				return theme.fg("warning", "●");
			case "paused":
				return theme.fg("warning", "‖");
			case "waiting":
				return theme.fg("dim", "○");
			case "skipped":
				return theme.fg("dim", "–");
		}
	}

	private stepper(stages: readonly StageRow[]): string {
		const theme = this.theme;
		return stepsOf(stages)
			.map((stage, index) => {
				const isReached = stage.status !== "waiting" && stage.status !== "skipped";
				const label = isReached ? STAGE_SHORT_NAMES[stage.key] : theme.fg("dim", STAGE_SHORT_NAMES[stage.key]);
				const step = `${this.statusIcon(stage.status)} ${label}`;
				if (index === 0) return step;
				const connector = theme.fg(isReached ? "success" : "dim", " ─── ");
				return connector + step;
			})
			.join("");
	}

	private stageLines(
		stage: StageRow,
		snapshot: OverviewSnapshot,
		innerWidth: number,
		selectedAgent: AgentKey | undefined,
	): string[] {
		const theme = this.theme;
		const isUpcoming = stage.status === "waiting" || stage.status === "skipped";
		const agent = stage.agent;
		const isSelected = agent !== undefined && agent === selectedAgent && !isUpcoming;
		const roleText = isUpcoming ? theme.fg("dim", stage.role) : theme.bold(isSelected ? theme.fg("accent", stage.role) : stage.role);
		const role = padEndToWidth(roleText, ROLE_COLUMN_WIDTH);
		const modelColumnWidth = Math.max(8, innerWidth - 5 - ROLE_COLUMN_WIDTH - TIME_COLUMN_WIDTH - COST_COLUMN_WIDTH);
		const model = padEndToWidth(this.modelText(stage), modelColumnWidth);
		const time = padStartToWidth(this.timeText(stage), TIME_COLUMN_WIDTH);
		const cost = padStartToWidth(theme.fg("muted", formatCost(stage.costUsd)), COST_COLUMN_WIDTH);
		const pointer = isSelected ? theme.fg("accent", "❯ ") : "  ";
		const row = `${pointer}${this.statusIcon(stage.status)}  ${role}${model}${time}${cost}`;
		const lines = [isSelected ? theme.bg("selectedBg", padEndToWidth(row, innerWidth)) : row];

		const isCurrent = stage.status === "working" || stage.status === "paused" || stage.status === "your-turn";
		if (isCurrent && stage.routeReason) {
			lines.push(`${DETAIL_INDENT}${theme.fg("dim", "╰")} ${theme.fg("muted", theme.italic(stage.routeReason))}`);
		}
		const runningTool = agent ? snapshot.feeds[agent]?.runningTool : undefined;
		if (stage.status === "working" && runningTool) {
			const tool = runningTool;
			const elapsed = theme.fg("dim", formatDuration(snapshot.nowMs - tool.startedAtMs));
			const toolText = `${DETAIL_INDENT}${theme.fg("dim", "›")} ${theme.fg("accent", tool.name)}  ${theme.fg("muted", tool.detail)}`;
			lines.push(spread(toolText, elapsed, innerWidth));
		}
		if (stage.status === "your-turn") lines.push(`${DETAIL_INDENT}${theme.fg("warning", this.yourTurnHint(stage.key))}`);
		return lines;
	}

	private yourTurnHint(stage: StageKey): string {
		switch (stage) {
			case "pr":
				return "press Enter on /issue pr to open the draft PR";
			case "ship":
				return "confirm shipping, or run /build ship";
			case "re-review":
				return "still has findings: F fixes again, R reviews again, A accepts (or /build implement)";
			default:
				return "agree on the plan; the implementer then starts";
		}
	}

	private modelText(stage: StageRow): string {
		const theme = this.theme;
		if (!stage.model) {
			const text = stage.status === "skipped" || stage.status === "done" ? stage.status : stage.upcomingHint;
			return theme.fg("dim", text);
		}
		return this.modelWithThinking(stage.model, stage.thinkingLevel);
	}

	private modelWithThinking(model: string, thinkingLevel: string | undefined): string {
		if (!thinkingLevel) return model;
		const thinkingColor = THINKING_COLORS[thinkingLevel] ?? "muted";
		return `${model} ${this.theme.fg("dim", "·")} ${this.theme.fg(thinkingColor, thinkingLevel)}`;
	}

	private timeText(stage: StageRow): string {
		const theme = this.theme;
		switch (stage.status) {
			case "waiting":
				return theme.fg("dim", "waiting");
			case "skipped":
				return "";
			case "your-turn":
				return theme.fg("warning", "your turn");
			case "working":
				return theme.fg("accent", formatDuration(stage.activeMs));
			default:
				return theme.fg("muted", formatDuration(stage.activeMs));
		}
	}

	private changesLines(snapshot: OverviewSnapshot, baseCommit: string | undefined, innerWidth: number, filesShown: number): string[] {
		const theme = this.theme;
		const changes = snapshot.changes;
		const heading = theme.bold("Changes");
		switch (changes.kind) {
			case "not-started":
				return [`${heading}  ${theme.fg("dim", "counted once the implementer starts")}`];
			case "loading":
				return [`${heading}  ${theme.fg("dim", "counting…")}`];
			case "loaded":
				break;
		}
		if (!changes.result.ok) return [`${heading}  ${theme.fg("error", changes.result.error)}`];
		const { files, added, removed } = changes.result.value;
		const since = baseCommit ? theme.fg("dim", ` since ${baseCommit.slice(0, 7)}`) : "";
		if (files.length === 0) return [`${heading}${since}  ${theme.fg("dim", "no files changed yet")}`];

		const totals = this.changeTotals({ added, removed, files });
		const largestChange = Math.max(1, ...files.map((file) => file.added + file.removed));
		this.selectedFileIndex = Math.min(this.selectedFileIndex, files.length - 1);
		const firstShown = Math.max(0, Math.min(this.selectedFileIndex - filesShown + 1, files.length - filesShown));
		const shownFiles = files.slice(firstShown, firstShown + filesShown).map((file, offset) => {
			const isSelected = firstShown + offset === this.selectedFileIndex;
			return this.fileLine(file, largestChange, innerWidth, isSelected);
		});
		const above = firstShown > 0 ? [theme.fg("dim", `  ↑ ${firstShown} more`)] : [];
		const hiddenBelow = files.length - firstShown - shownFiles.length;
		const below = hiddenBelow > 0 ? [theme.fg("dim", `  ↓ ${hiddenBelow} more file${hiddenBelow === 1 ? "" : "s"}`)] : [];
		const headingLine = spread(`${heading}${since}`, totals, innerWidth);
		if (filesShown === 0) return [headingLine];
		return [headingLine, ...above, ...shownFiles, ...below];
	}

	private fileLine(file: FileChange, largestChange: number, innerWidth: number, isSelected: boolean): string {
		const theme = this.theme;
		const counts = file.isBinary
			? theme.fg("dim", "binary")
			: `${theme.fg("toolDiffAdded", `+${file.added}`)} ${theme.fg("toolDiffRemoved", `−${file.removed}`)}`;
		const tag = file.isNew ? theme.fg("dim", " new") : "";
		const pathWidth = Math.max(8, innerWidth - CHANGE_BAR_CELLS - 4 - visibleWidth(counts) - visibleWidth(tag) - 2);
		const path = truncatePathStart(file.path, pathWidth);
		const pointer = isSelected ? theme.fg("accent", "❯ ") : "  ";
		const line = spread(`${pointer}${this.changeBar(file, largestChange)}  ${path}${tag}`, counts, innerWidth);
		return isSelected ? theme.bg("selectedBg", line) : line;
	}

	/** Bar scaled to the biggest file: green for added lines, red for removed. */
	private changeBar(file: FileChange, largestChange: number): string {
		const theme = this.theme;
		const changedLines = file.added + file.removed;
		const filledCells = changedLines === 0 ? 0 : Math.max(1, Math.round((changedLines / largestChange) * CHANGE_BAR_CELLS));
		const addedCells = changedLines === 0 ? 0 : Math.round((file.added / changedLines) * filledCells);
		const removedCells = filledCells - addedCells;
		return (
			theme.fg("toolDiffAdded", "■".repeat(addedCells)) +
			theme.fg("toolDiffRemoved", "■".repeat(removedCells)) +
			theme.fg("dim", "·".repeat(CHANGE_BAR_CELLS - filledCells))
		);
	}
}
