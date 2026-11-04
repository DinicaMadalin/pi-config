/**
 * The Alt+A agents overview: a centered card with one row per /build role (model, thinking, time, cost,
 * why that model), the tool the running agent is using, and the lines changed since implementation began.
 * Only renders; index.ts gathers the snapshot and decides when to redraw.
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { BuildTimeline, StageKey, StageRow, StageStatus } from "./build-timeline.ts";
import type { FileChange, WorkChangesResult } from "./work-changes.ts";

export interface RunningTool {
	name: string;
	/** Command, path or other short argument summary. */
	detail: string;
	startedAtMs: number;
}

export type ChangesView = { kind: "not-started" } | { kind: "loading" } | { kind: "loaded"; result: WorkChangesResult };

export interface OverviewSnapshot {
	timeline: BuildTimeline | undefined;
	/** The agreed plan's "# heading"; the task's first line until a plan exists. */
	planTitle: string | undefined;
	changes: ChangesView;
	runningTool: RunningTool | undefined;
	nowMs: number;
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
export const SPINNER_FRAME_MS = 100;
const MAX_FILES_SHOWN = 6;
const CHANGE_BAR_CELLS = 12;
const ROLE_COLUMN_WIDTH = 13;
const TIME_COLUMN_WIDTH = 9;
const COST_COLUMN_WIDTH = 8;
const DETAIL_INDENT = "     ";

const STAGE_SHORT_NAMES: Record<StageKey, string> = {
	plan: "Plan",
	implement: "Implement",
	review: "Review",
	fix: "Fix",
	"re-review": "Re-review",
	pr: "PR",
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

export class AgentsOverview implements Component {
	private frameIndex = 0;
	private readonly theme: Theme;
	private readonly readSnapshot: () => OverviewSnapshot;
	private readonly close: () => void;

	constructor(theme: Theme, readSnapshot: () => OverviewSnapshot, close: () => void) {
		this.theme = theme;
		this.readSnapshot = readSnapshot;
		this.close = close;
	}

	advanceSpinner(): void {
		this.frameIndex = (this.frameIndex + 1) % SPINNER_FRAMES.length;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "q") || matchesKey(data, "alt+a") || matchesKey(data, "enter")) {
			this.close();
		}
	}

	invalidate(): void {}

	render(width: number): string[] {
		const snapshot = this.readSnapshot();
		const innerWidth = Math.max(10, width - 4);
		const body = snapshot.timeline ? this.renderBuild(snapshot.timeline, snapshot, innerWidth) : this.renderNoBuild();
		const lines = [
			this.topBorder(snapshot.timeline, width),
			this.frame("", innerWidth),
			...body.map((line) => this.frame(line, innerWidth)),
			this.frame("", innerWidth),
			this.bottomBorder(snapshot.timeline, width),
		];
		return lines.map((line) => truncateToWidth(line, width));
	}

	private frame(content: string, innerWidth: number): string {
		const border = this.theme.fg("borderMuted", "│");
		return `${border} ${padEndToWidth(content, innerWidth)} ${border}`;
	}

	private topBorder(timeline: BuildTimeline | undefined, width: number): string {
		const theme = this.theme;
		const name = timeline?.issue ? `Issue #${timeline.issue.number}` : "Build";
		const title = `${theme.fg("accent", "◆")} ${theme.bold(name)}`;
		const totals = timeline ? [formatDuration(timeline.activeMs), formatCost(timeline.costUsd)].filter(Boolean).join(" · ") : "";
		const state = timeline?.isFinished ? "finished" : "";
		const right = [state, totals].filter(Boolean).join(" · ");
		const rightPart = right ? ` ${theme.fg("muted", right)} ` : "";
		const fillWidth = Math.max(1, width - 5 - visibleWidth(title) - visibleWidth(rightPart));
		return theme.fg("borderMuted", "╭─ ") + title + theme.fg("borderMuted", ` ${"─".repeat(fillWidth)}`) + rightPart + theme.fg("borderMuted", "╮");
	}

	private bottomBorder(timeline: BuildTimeline | undefined, width: number): string {
		const theme = this.theme;
		const keys = ` ${theme.fg("dim", "esc close")} `;
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
		return [
			this.theme.bold(snapshot.planTitle ?? taskHeadline(timeline.task)),
			this.stepper(timeline.stages),
			"",
			...timeline.stages.flatMap((stage) => this.stageLines(stage, snapshot, innerWidth)),
			"",
			...this.changesLines(snapshot.changes, timeline.baseCommit, innerWidth),
		];
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
		return stages
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

	private stageLines(stage: StageRow, snapshot: OverviewSnapshot, innerWidth: number): string[] {
		const theme = this.theme;
		const isUpcoming = stage.status === "waiting" || stage.status === "skipped";
		const role = padEndToWidth(isUpcoming ? theme.fg("dim", stage.role) : theme.bold(stage.role), ROLE_COLUMN_WIDTH);
		const modelColumnWidth = Math.max(8, innerWidth - 3 - ROLE_COLUMN_WIDTH - TIME_COLUMN_WIDTH - COST_COLUMN_WIDTH);
		const model = padEndToWidth(this.modelText(stage), modelColumnWidth);
		const time = padStartToWidth(this.timeText(stage), TIME_COLUMN_WIDTH);
		const cost = padStartToWidth(theme.fg("muted", formatCost(stage.costUsd)), COST_COLUMN_WIDTH);
		const lines = [`${this.statusIcon(stage.status)}  ${role}${model}${time}${cost}`];

		const isCurrent = stage.status === "working" || stage.status === "paused" || stage.status === "your-turn";
		if (isCurrent && stage.routeReason) {
			lines.push(`${DETAIL_INDENT}${theme.fg("dim", "╰")} ${theme.fg("muted", theme.italic(stage.routeReason))}`);
		}
		if (stage.status === "working" && snapshot.runningTool) {
			const tool = snapshot.runningTool;
			const elapsed = theme.fg("dim", formatDuration(snapshot.nowMs - tool.startedAtMs));
			const toolText = `${DETAIL_INDENT}${theme.fg("dim", "›")} ${theme.fg("accent", tool.name)}  ${theme.fg("muted", tool.detail)}`;
			lines.push(spread(toolText, elapsed, innerWidth));
		}
		if (stage.status === "your-turn") lines.push(`${DETAIL_INDENT}${theme.fg("warning", this.yourTurnHint(stage.key))}`);
		return lines;
	}

	private yourTurnHint(stage: StageKey): string {
		return stage === "pr" ? "press Enter on /issue pr to open the draft PR" : "agree on the plan, then /build implement";
	}

	private modelText(stage: StageRow): string {
		const theme = this.theme;
		if (!stage.model) return theme.fg("dim", stage.status === "skipped" ? "skipped" : stage.upcomingHint);
		if (!stage.thinkingLevel) return stage.model;
		const thinkingColor = THINKING_COLORS[stage.thinkingLevel] ?? "muted";
		return `${stage.model} ${theme.fg("dim", "·")} ${theme.fg(thinkingColor, stage.thinkingLevel)}`;
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

	private changesLines(changes: ChangesView, baseCommit: string | undefined, innerWidth: number): string[] {
		const theme = this.theme;
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
		const shownFiles = files.slice(0, MAX_FILES_SHOWN).map((file) => this.fileLine(file, largestChange, innerWidth));
		const hiddenCount = files.length - MAX_FILES_SHOWN;
		const more = hiddenCount > 0 ? [theme.fg("dim", `  + ${hiddenCount} more file${hiddenCount === 1 ? "" : "s"}`)] : [];
		return [spread(`${heading}${since}`, totals, innerWidth), ...shownFiles, ...more];
	}

	private fileLine(file: FileChange, largestChange: number, innerWidth: number): string {
		const theme = this.theme;
		const counts = file.isBinary
			? theme.fg("dim", "binary")
			: `${theme.fg("toolDiffAdded", `+${file.added}`)} ${theme.fg("toolDiffRemoved", `−${file.removed}`)}`;
		const tag = file.isNew ? theme.fg("dim", " new") : "";
		const pathWidth = Math.max(8, innerWidth - CHANGE_BAR_CELLS - 4 - visibleWidth(counts) - visibleWidth(tag) - 2);
		const path = truncatePathStart(file.path, pathWidth);
		return spread(`  ${this.changeBar(file, largestChange)}  ${path}${tag}`, counts, innerWidth);
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
