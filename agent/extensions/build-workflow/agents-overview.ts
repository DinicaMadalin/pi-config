/**
 * The Alt+A agents overview: a centered card with one row per /build role (model, thinking, time, cost,
 * why that model), the selected agent's live activity, the lines changed since implementation began, and a
 * message line to talk to the selected agent. Renders and handles keys; agents-overview-panel.ts feeds it.
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, type Focusable, Input, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ActivityLine, RunningTool } from "./agent-activity.ts";
import type { BuildAgentKey, BuildTimeline, StageKey, StageRow, StageStatus } from "./build-timeline.ts";
import type { DelegateStatus } from "./delegate-runs.ts";
import type { FileDiffResult } from "./file-diff.ts";
import { FileDiffView, type HighlightCode } from "./file-diff-view.ts";
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
	/** Stops a running delegate; returns an error to show, or undefined when stopped. */
	cancelDelegate(runId: string): string | undefined;
}

export interface OverviewLayout {
	/** Rows the card may use between its top and bottom borders; the diff view fills them. */
	bodyRows: () => number;
	/** Syntax colors for the diff view; plain text without it. */
	highlight?: HighlightCode;
}

/** Which list ↑↓ moves through; Tab switches. */
type OverviewFocus = "agents" | "files";

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
	private sendError: string | undefined;
	private isFocused = false;
	private readonly layout: OverviewLayout;
	/** Undefined until the user presses Tab: then agents when any can be messaged, else files. */
	private chosenFocus: OverviewFocus | undefined;
	private selectedFileIndex = 0;
	private diffView: FileDiffView | undefined;
	/** The delegate whose cancel waits for a second x, so one stray key does not stop a run. */
	private cancelArmedFor: DelegateRow | undefined;

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
		if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
			this.chosenFocus = this.focus(snapshot) === "agents" ? "files" : "agents";
			return;
		}
		if (this.focus(snapshot) === "files") {
			this.handleFilesInput(data, changedFiles(snapshot.changes));
			return;
		}
		const agents = this.selectableAgents(snapshot);
		if (agents.length === 0) return;
		const current = this.currentAgent(snapshot) ?? agents[0];
		const armedRun = this.cancelArmedFor;
		this.cancelArmedFor = undefined;
		const index = agents.indexOf(current);
		if (matchesKey(data, "up") || matchesKey(data, "k")) this.selectedAgent = agents[Math.max(0, index - 1)];
		else if (matchesKey(data, "down") || matchesKey(data, "j")) this.selectedAgent = agents[Math.min(agents.length - 1, index + 1)];
		else if (matchesKey(data, "enter") || matchesKey(data, "m")) this.openComposer(current);
		else if (matchesKey(data, "x")) this.cancelSelectedDelegate(current, snapshot, armedRun);
	}

	private cancelSelectedDelegate(current: AgentKey, snapshot: OverviewSnapshot, armedRun: DelegateRow | undefined): void {
		const delegate = snapshot.delegates.find((row) => row.key === current);
		if (!delegate || delegate.status !== "running") return;
		if (armedRun?.key !== delegate.key) {
			this.cancelArmedFor = delegate;
			this.sendError = undefined;
			return;
		}
		this.sendError = this.actions.cancelDelegate(delegate.runId);
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

	/** Agents while any can be messaged, files once the run is over; Tab overrides. */
	private focus(snapshot: OverviewSnapshot): OverviewFocus {
		const hasFiles = changedFiles(snapshot.changes).length > 0;
		const hasAgents = this.selectableAgents(snapshot).length > 0;
		if (this.chosenFocus === "files" && hasFiles) return "files";
		if (this.chosenFocus === "agents" && hasAgents) return "agents";
		return hasAgents || !hasFiles ? "agents" : "files";
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
			this.sendError = feed.messageBlocker;
			return;
		}
		const composer = new Input({ prompt: "› " });
		composer.focused = this.isFocused;
		composer.onSubmit = (text) => {
			if (text.trim() === "") return;
			this.sendError = this.actions.sendMessage(agent, text.trim());
			this.composer = undefined;
		};
		composer.onEscape = () => {
			this.composer = undefined;
		};
		this.selectedAgent = agent;
		this.sendError = undefined;
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

	private keyHint(snapshot: OverviewSnapshot): string {
		if (this.composer) return "enter send · esc cancel";
		if (this.diffView) return this.diffView.keyHint();
		const hasFiles = changedFiles(snapshot.changes).length > 0;
		const tabHint = hasFiles ? "tab agents/files · " : "";
		if (this.focus(snapshot) === "files") return `${tabHint}↑↓ file · enter/space diff · esc close`;
		const current = this.currentAgent(snapshot);
		if (!current) return "esc close";
		if (!isDelegateKey(current)) return `${tabHint}↑↓ agent · enter message · esc close`;
		const isRunning = snapshot.delegates.some((delegate) => delegate.key === current && delegate.status === "running");
		return `${tabHint}↑↓ agent${isRunning ? " · x cancel run" : ""} · esc close`;
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
		const selectedAgent = this.currentAgent(snapshot);
		const isAgentListFocused = this.focus(snapshot) === "agents";
		const linesAboveChanges = [
			this.theme.bold(snapshot.planTitle ?? taskHeadline(timeline.task)),
			...this.repoLines(snapshot.repo),
			this.stepper(timeline.stages),
			"",
			...timeline.stages.flatMap((stage) => this.stageLines(stage, snapshot, innerWidth, selectedAgent, isAgentListFocused)),
			...this.delegateSection(snapshot, innerWidth, selectedAgent, isAgentListFocused),
			...(selectedAgent ? ["", ...this.activityLines(selectedAgent, snapshot, innerWidth)] : []),
			// Under the activity, not under the file list: a long card is cut at the bottom, and this must show.
			...this.composerLines(selectedAgent, snapshot, innerWidth),
			"",
		];
		const rowsForFiles = this.layout.bodyRows() - linesAboveChanges.length - FILE_LIST_FRAME_ROWS;
		const filesShown = Math.max(MIN_FILES_SHOWN, rowsForFiles);
		return [...linesAboveChanges, ...this.changesLines(snapshot, timeline.baseCommit, innerWidth, filesShown)];
	}

	/** Only acp_delegate runs, no /build: the delegates and the selected one's activity. */
	private renderDelegatesOnly(snapshot: OverviewSnapshot, innerWidth: number): string[] {
		const selectedAgent = this.currentAgent(snapshot);
		return [
			...this.repoLines(snapshot.repo),
			...this.delegateSection(snapshot, innerWidth, selectedAgent, true).slice(snapshot.repo ? 0 : 1),
			...(selectedAgent ? ["", ...this.activityLines(selectedAgent, snapshot, innerWidth)] : []),
			...this.composerLines(selectedAgent, snapshot, innerWidth),
		];
	}

	private delegateSection(
		snapshot: OverviewSnapshot,
		innerWidth: number,
		selectedAgent: AgentKey | undefined,
		isAgentListFocused: boolean,
	): string[] {
		if (snapshot.delegates.length === 0) return [];
		const theme = this.theme;
		const runningCount = snapshot.delegates.filter((delegate) => delegate.status === "running").length;
		const heading = `${theme.bold("Delegates")} ${theme.fg("dim", `acp_delegate · ${runningCount} running`)}`;
		return [
			"",
			heading,
			...snapshot.delegates.flatMap((delegate) =>
				this.delegateLines(delegate, innerWidth, delegate.key === selectedAgent, isAgentListFocused),
			),
		];
	}

	private delegateLines(delegate: DelegateRow, innerWidth: number, isSelected: boolean, isAgentListFocused: boolean): string[] {
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
		return [isSelected && isAgentListFocused ? theme.bg("selectedBg", padEndToWidth(row, innerWidth)) : row, task];
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
		if (this.cancelArmedFor) {
			const run = this.cancelArmedFor;
			return ["", theme.fg("warning", `Press x again to cancel the ${run.role} run ${run.runId}; any other key keeps it running`)];
		}
		if (this.sendError) return ["", theme.fg("error", this.sendError)];
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
		isAgentListFocused: boolean,
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
		const lines = [isSelected && isAgentListFocused ? theme.bg("selectedBg", padEndToWidth(row, innerWidth)) : row];

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

		const fileCount = `${files.length} file${files.length === 1 ? "" : "s"}`;
		const totals = `${theme.fg("toolDiffAdded", `+${added}`)} ${theme.fg("toolDiffRemoved", `−${removed}`)} ${theme.fg("muted", `· ${fileCount}`)}`;
		const largestChange = Math.max(1, ...files.map((file) => file.added + file.removed));
		const isFileListFocused = this.focus(snapshot) === "files";
		this.selectedFileIndex = Math.min(this.selectedFileIndex, files.length - 1);
		const firstShown = Math.max(0, Math.min(this.selectedFileIndex - filesShown + 1, files.length - filesShown));
		const shownFiles = files.slice(firstShown, firstShown + filesShown).map((file, offset) => {
			const isSelected = isFileListFocused && firstShown + offset === this.selectedFileIndex;
			return this.fileLine(file, largestChange, innerWidth, isSelected);
		});
		const above = firstShown > 0 ? [theme.fg("dim", `  ↑ ${firstShown} more`)] : [];
		const hiddenBelow = files.length - firstShown - shownFiles.length;
		const below = hiddenBelow > 0 ? [theme.fg("dim", `  ↓ ${hiddenBelow} more file${hiddenBelow === 1 ? "" : "s"}`)] : [];
		const headingText = isFileListFocused ? `${theme.fg("accent", "❯")} ${heading}` : heading;
		return [spread(`${headingText}${since}`, totals, innerWidth), ...above, ...shownFiles, ...below];
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
