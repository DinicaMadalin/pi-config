/**
 * What an agent of a /build run is doing: its model, cost, working time, the tool it runs now and a short
 * feed of recent steps. Shared by the planner (this session) and the subagents (child processes).
 */

export interface RunningTool {
	name: string;
	/** Command, path or other short argument summary. */
	detail: string;
	startedAtMs: number;
}

export type ActivityKind = "tool" | "text" | "you" | "note" | "error";

export interface ActivityLine {
	kind: ActivityKind;
	text: string;
	atMs: number;
}

export interface AgentStats {
	model?: string;
	thinkingLevel?: string;
	/** Why the router picked this tier, from the auto model's route decision. */
	routeReason?: string;
	costUsd: number;
	/** Working time of finished turns; add nowMs - workingSinceMs for the turn in progress. */
	finishedTurnsMs: number;
	workingSinceMs?: number;
	runningTool?: RunningTool;
}

const MAX_ACTIVITY_LINES = 200;
const MAX_TOOL_DETAIL_CHARS = 160;
const MAX_TEXT_CHARS = 400;

export function activeMsOf(stats: AgentStats, nowMs: number): number {
	const currentTurnMs = stats.workingSinceMs === undefined ? 0 : Math.max(0, nowMs - stats.workingSinceMs);
	return stats.finishedTurnsMs + currentTurnMs;
}

export function summarizeToolArgs(toolName: string, args: unknown): string {
	const fields = (args ?? {}) as Record<string, unknown>;
	const preferredField = { bash: "command", read: "path", edit: "path", write: "path", grep: "pattern", find: "pattern" }[toolName];
	const preferred = preferredField ? fields[preferredField] : undefined;
	const firstString = Object.values(fields).find((field) => typeof field === "string");
	const detail = typeof preferred === "string" ? preferred : typeof firstString === "string" ? firstString : "";
	return detail.replace(/\s+/g, " ").trim().slice(0, MAX_TOOL_DETAIL_CHARS);
}

/** One line per step, newest last, bounded so a long run does not grow memory. */
export class ActivityLog {
	private readonly lines: ActivityLine[] = [];

	add(kind: ActivityKind, text: string, atMs: number): void {
		const oneLine = text.replace(/\s+/g, " ").trim().slice(0, MAX_TEXT_CHARS);
		if (oneLine === "") return;
		this.lines.push({ kind, text: oneLine, atMs });
		if (this.lines.length > MAX_ACTIVITY_LINES) this.lines.splice(0, this.lines.length - MAX_ACTIVITY_LINES);
	}

	recent(count: number): readonly ActivityLine[] {
		return this.lines.slice(-count);
	}
}

/** Tracks one agent from its message and tool events; the planner and the subagents feed it the same way. */
export class AgentTracker {
	readonly stats: AgentStats = { costUsd: 0, finishedTurnsMs: 0 };
	readonly activity = new ActivityLog();

	startTurn(nowMs: number): void {
		this.stats.workingSinceMs ??= nowMs;
	}

	endTurn(nowMs: number): void {
		this.stats.finishedTurnsMs = activeMsOf(this.stats, nowMs);
		this.stats.workingSinceMs = undefined;
		this.stats.runningTool = undefined;
	}

	startTool(toolName: string, args: unknown, nowMs: number): void {
		const detail = summarizeToolArgs(toolName, args);
		this.stats.runningTool = { name: toolName, detail, startedAtMs: nowMs };
		this.activity.add("tool", `${toolName}  ${detail}`, nowMs);
	}

	endTool(isError: boolean, nowMs: number): void {
		const tool = this.stats.runningTool;
		this.stats.runningTool = undefined;
		if (isError && tool) this.activity.add("error", `${tool.name} failed`, nowMs);
	}

	recordAnswer(message: AssistantMessageLike, nowMs: number): string {
		this.stats.costUsd += message.usage?.cost?.total ?? 0;
		if (message.model) this.stats.model = message.model;
		if (message.thinkingLevel) this.stats.thinkingLevel = message.thinkingLevel;
		const text = answerText(message);
		this.activity.add("text", text, nowMs);
		return text;
	}
}

export interface AssistantMessageLike {
	role: string;
	model?: string;
	thinkingLevel?: string;
	usage?: { cost?: { total?: number } };
	content?: unknown;
}

export function answerText(message: AssistantMessageLike): string {
	if (!Array.isArray(message.content)) return typeof message.content === "string" ? message.content : "";
	return message.content
		.filter((part): part is { type: "text"; text: string } => part?.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n");
}
