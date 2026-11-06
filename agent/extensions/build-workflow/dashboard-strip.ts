/**
 * The dashboard strip above the editor. Its top line is the workspace's state; Pi's footer already shows the
 * directory, branch and context, so the strip only warns about the context once it fills up:
 *
 *   ◆ pi-config · +312 −48 · 6 files                  ✓ checks │ ctx ▰▰▰▰▰▱▱▱ 64% │ $1.24 │ claude-opus-5-5 · high · complex
 *     ⠹ Implementer        gpt-6-luna · medium       › bash  pnpm test                       2m 14s   $0.21
 *
 * One line per agent at work follows: /build subagents and acp_delegate runs. Compact keeps only the rule.
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { CheckStatus } from "../quality-gate/check-events.ts";
import type { RunningTool } from "./agent-activity.ts";
import type { ChangesView, RepoLocation } from "./agents-overview.ts";
import { formatCost, formatDuration, modelWithThinking, padEndToWidth, padStartToWidth, SPINNER_FRAMES } from "./card-text.ts";
import type { StripSize } from "./dashboard-layout.ts";
import type { SessionGauge } from "./session-gauge.ts";

export type StripAgentState = "working" | "waiting" | "paused" | "crashed" | "done";

export interface StripAgent {
	name: string;
	state: StripAgentState;
	model: string | undefined;
	thinkingLevel: string | undefined;
	runningTool: RunningTool | undefined;
	elapsedMs: number;
	costUsd: number;
}

export interface StripSnapshot {
	repo: RepoLocation | undefined;
	changes: ChangesView;
	gauge: SessionGauge;
	checks: CheckStatus | undefined;
	agents: readonly StripAgent[];
	nowMs: number;
}

const CONTEXT_BAR_CELLS = 8;
const CONTEXT_WARNING_PERCENT = 60;
const CONTEXT_DANGER_PERCENT = 85;
const NAME_COLUMN_WIDTH = 18;
const MODEL_COLUMN_WIDTH = 30;
const TIME_COLUMN_WIDTH = 9;
const COST_COLUMN_WIDTH = 8;
const AGENT_INDENT = "  ";
const MIN_RULE_GAP = 3;
/** Below a cent the cost reads "$0.00", which says nothing; Pi's footer has the exact figure. */
const MIN_SHOWN_COST_USD = 0.01;

/** A part of the rule; when the line is too narrow the parts with the lowest priority are left out first. */
interface RulePart {
	text: string;
	priority: number;
}

export function renderStrip(snapshot: StripSnapshot, size: StripSize, theme: Theme, spinnerFrame: number, width: number): string[] {
	if (size === "hidden") return [];
	const spinner = SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length];
	const rule = statusRule(snapshot, size, theme, spinner, width);
	if (size === "compact") return [rule];
	return [rule, ...snapshot.agents.map((agent) => agentLine(agent, theme, spinner, width))];
}

function statusRule(snapshot: StripSnapshot, size: StripSize, theme: Theme, spinner: string, width: number): string {
	const left = [...workspaceParts(snapshot, theme), ...(size === "compact" ? agentSummaryParts(snapshot.agents, theme, spinner) : [])];
	const right = sessionParts(snapshot, theme, spinner);
	const separator = theme.fg("dim", " │ ");
	const leftSeparator = theme.fg("dim", " · ");
	let shownLeft = left;
	let shownRight = right;
	const lineWidth = () =>
		visibleWidth(shownLeft.map((part) => part.text).join(leftSeparator)) +
		visibleWidth(shownRight.map((part) => part.text).join(separator)) +
		6 +
		MIN_RULE_GAP;
	while (lineWidth() > width) {
		const lowest = [...shownLeft, ...shownRight].reduce<RulePart | undefined>(
			(candidate, part) => (part.priority > 0 && (!candidate || part.priority < candidate.priority) ? part : candidate),
			undefined,
		);
		if (!lowest) break;
		shownLeft = shownLeft.filter((part) => part !== lowest);
		shownRight = shownRight.filter((part) => part !== lowest);
	}
	const leftText = ` ${shownLeft.map((part) => part.text).join(leftSeparator)} `;
	const rightText = shownRight.length > 0 ? ` ${shownRight.map((part) => part.text).join(separator)} ` : "";
	const gap = Math.max(1, width - visibleWidth(leftText) - visibleWidth(rightText));
	return truncateToWidth(leftText + " ".repeat(gap) + rightText, width);
}

/** "◆ pi-config" (always stays), "⎇ branch" only when detached, and "+312 −48 · 6 files". */
function workspaceParts(snapshot: StripSnapshot, theme: Theme): RulePart[] {
	const repo = snapshot.repo;
	if (!repo) return [{ text: `${theme.fg("accent", "◆")} ${theme.fg("dim", "no git repository")}`, priority: 0 }];
	const parts: RulePart[] = [{ text: `${theme.fg("accent", "◆")} ${theme.bold(repo.repoName)}`, priority: 0 }];
	if (!repo.branch) parts.push({ text: theme.fg("warning", "detached HEAD"), priority: 8 });
	const changes = snapshot.changes;
	if (changes.kind !== "loaded" || !changes.result.ok) return parts;
	const { added, removed, files } = changes.result.value;
	if (files.length === 0) return [...parts, { text: theme.fg("dim", "clean"), priority: 6 }];
	const counts = `${theme.fg("toolDiffAdded", `+${added}`)} ${theme.fg("toolDiffRemoved", `−${removed}`)}`;
	const fileCount = theme.fg("muted", `${files.length} file${files.length === 1 ? "" : "s"}`);
	return [...parts, { text: counts, priority: 7 }, { text: fileCount, priority: 3 }];
}

/** Compact strip only: "⠹ 2 working" in place of the agent lines. */
function agentSummaryParts(agents: readonly StripAgent[], theme: Theme, spinner: string): RulePart[] {
	if (agents.length === 0) return [];
	const workingCount = agents.filter((agent) => agent.state === "working").length;
	const needsAttention = agents.some((agent) => agent.state === "crashed" || agent.state === "waiting");
	const icon = workingCount > 0 ? theme.fg("accent", spinner) : theme.fg(needsAttention ? "warning" : "muted", "●");
	const label = workingCount > 0 ? `${workingCount} working` : `${agents.length} agent${agents.length === 1 ? "" : "s"}`;
	return [{ text: `${icon} ${theme.fg(workingCount > 0 ? "accent" : "muted", label)}`, priority: 9 }];
}

/** Checks, context, cost and model, right-aligned; the model goes last. */
function sessionParts(snapshot: StripSnapshot, theme: Theme, spinner: string): RulePart[] {
	const gauge = snapshot.gauge;
	const parts: RulePart[] = [];
	const checks = checksText(snapshot.checks, theme, spinner);
	if (checks) parts.push({ text: checks, priority: 5 });
	if (gauge.contextPercent !== undefined && gauge.contextPercent >= CONTEXT_WARNING_PERCENT) parts.push({ text: contextText(gauge.contextPercent, theme), priority: 4 });
	if (gauge.costUsd >= MIN_SHOWN_COST_USD) parts.push({ text: theme.fg("muted", formatCost(gauge.costUsd)), priority: 2 });
	if (gauge.model) {
		const tier = gauge.tier ? `${theme.fg("dim", " · ")}${theme.fg("muted", gauge.tier)}` : "";
		parts.push({ text: modelWithThinking(theme, gauge.model, gauge.thinkingLevel) + tier, priority: 1 });
	}
	return parts;
}

function checksText(checks: CheckStatus | undefined, theme: Theme, spinner: string): string | undefined {
	switch (checks?.kind) {
		case undefined:
			return undefined;
		case "running":
			return `${theme.fg("accent", spinner)} ${theme.fg("muted", checks.checkName)}`;
		case "passed":
			return `${theme.fg("success", "✓")} ${theme.fg("muted", "checks")}`;
		case "failed":
			return `${theme.fg("error", "✗")} ${theme.fg("error", checks.checkName)}`;
	}
}

/** "ctx ▰▰▰▰▰▱▱▱ 64%", amber from 60 % and red from 85 %. */
function contextText(percent: number, theme: Theme): string {
	const color = percent >= CONTEXT_DANGER_PERCENT ? "error" : "warning";
	const filledCells = Math.min(CONTEXT_BAR_CELLS, Math.round((percent / 100) * CONTEXT_BAR_CELLS));
	const bar = theme.fg(color, "▰".repeat(filledCells)) + theme.fg("dim", "▱".repeat(CONTEXT_BAR_CELLS - filledCells));
	return `${theme.fg("dim", "ctx")} ${bar} ${theme.fg("muted", `${Math.round(percent)}%`)}`;
}

function agentLine(agent: StripAgent, theme: Theme, spinner: string, width: number): string {
	const name = padEndToWidth(agent.state === "working" ? theme.bold(agent.name) : agent.name, NAME_COLUMN_WIDTH);
	const model = padEndToWidth(agent.model ? modelWithThinking(theme, agent.model, agent.thinkingLevel) : theme.fg("dim", "starting"), MODEL_COLUMN_WIDTH);
	const time = padStartToWidth(theme.fg(agent.state === "working" ? "accent" : "muted", formatDuration(agent.elapsedMs)), TIME_COLUMN_WIDTH);
	const cost = padStartToWidth(theme.fg("muted", formatCost(agent.costUsd)), COST_COLUMN_WIDTH);
	const fixedWidth = visibleWidth(AGENT_INDENT) + 3 + NAME_COLUMN_WIDTH + MODEL_COLUMN_WIDTH + TIME_COLUMN_WIDTH + COST_COLUMN_WIDTH;
	const doing = padEndToWidth(stateText(agent, theme), Math.max(0, width - fixedWidth));
	return truncateToWidth(`${AGENT_INDENT}${stateIcon(agent.state, theme, spinner)}  ${name}${model}${doing}${time}${cost}`, width);
}

function stateIcon(state: StripAgentState, theme: Theme, spinner: string): string {
	switch (state) {
		case "working":
			return theme.fg("accent", spinner);
		case "waiting":
			return theme.fg("warning", "●");
		case "paused":
			return theme.fg("warning", "‖");
		case "crashed":
			return theme.fg("error", "✗");
		case "done":
			return theme.fg("success", "✓");
	}
}

/** What the agent does now: its running tool, or why it is not working. */
function stateText(agent: StripAgent, theme: Theme): string {
	switch (agent.state) {
		case "working":
			return agent.runningTool
				? `${theme.fg("dim", "›")} ${theme.fg("accent", agent.runningTool.name)}  ${theme.fg("muted", agent.runningTool.detail)}`
				: theme.fg("dim", "thinking");
		case "waiting":
			return theme.fg("warning", "waits for the planner");
		case "paused":
			return theme.fg("warning", "paused · /build implement resumes");
		case "crashed":
			return theme.fg("error", "stopped · Alt+A, r restarts");
		case "done":
			return theme.fg("success", "done");
	}
}

/** The strip as a widget: re-reads its snapshot on every render, so the caller only asks for renders. */
export class DashboardStrip implements Component {
	private spinnerFrame = 0;
	private readonly theme: Theme;
	private readonly readSnapshot: () => StripSnapshot;
	private readonly readSize: () => StripSize;

	constructor(theme: Theme, readSnapshot: () => StripSnapshot, readSize: () => StripSize) {
		this.theme = theme;
		this.readSnapshot = readSnapshot;
		this.readSize = readSize;
	}

	advanceSpinner(): void {
		this.spinnerFrame = (this.spinnerFrame + 1) % SPINNER_FRAMES.length;
	}

	render(width: number): string[] {
		return renderStrip(this.readSnapshot(), this.readSize(), this.theme, this.spinnerFrame, width);
	}

	invalidate(): void {}
}
