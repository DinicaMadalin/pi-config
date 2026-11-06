/**
 * Background agents started with the acp_delegate tool (billion-context), for the agents overview.
 * That extension has no API, so the runs are read from what it leaves behind: the tool results and
 * completion notices in this session, each run's Pi session file in <tmp>/acp-delegate/, and the run's
 * process (its command line names that session file). Cancelling sends SIGTERM, as acp_delegate_cancel does.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROUTE_DECISION_ENTRY_TYPE } from "../auto-model/route-decision.ts";
import { type ActivityLine, type RunningTool, summarizeToolArgs } from "./agent-activity.ts";

export const DELEGATE_OUTPUT_DIR = join(tmpdir(), "acp-delegate");

export type DelegateStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "ended";

/** A run as this session recorded it: from the acp_delegate tool results and completion notices. */
export interface DelegateLaunch {
	runId: string;
	/** The delegate's role: reviewer, researcher, worker, planner or oracle. */
	agent: string;
	task: string;
	recordedStatus: DelegateStatus;
	durationMs: number | undefined;
}

/** What the run's own session file says about it. */
export interface DelegateSessionSummary {
	model: string | undefined;
	thinkingLevel: string | undefined;
	routeReason: string | undefined;
	costUsd: number;
	startedAtMs: number | undefined;
	lastEntryAtMs: number | undefined;
	activity: ActivityLine[];
	/** The last tool call without a result yet. */
	pendingTool: RunningTool | undefined;
}

interface SessionEntryLike {
	type?: string;
	customType?: string;
	data?: { reason?: unknown };
	timestamp?: string;
	thinkingLevel?: string;
	message?: {
		role?: string;
		content?: unknown;
		model?: string;
		thinkingLevel?: string;
		usage?: { cost?: { total?: number } };
		toolCallId?: string;
		toolName?: string;
		isError?: boolean;
		details?: unknown;
	};
}

const RECORDED_STATUSES: readonly DelegateStatus[] = ["queued", "running", "completed", "failed", "cancelled"];
/** "[acp_delegate completed] **reviewer** (runId `del_…`" and "[acp_delegate FAILED ⚠️] …". */
const COMPLETION_NOTICE = /\[acp_delegate (completed|FAILED|cancelled)[^\]]*\] \*\*([\w-]+)\*\* \(runId `([^`]+)`/g;
const SESSION_FILE_OF_RUN = /(del_[A-Za-z0-9_]+)\.session\.jsonl$/;
const MAX_ACTIVITY_LINES = 50;

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: "text"; text: string } => part?.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n");
}

function asRecordedStatus(status: unknown): DelegateStatus | undefined {
	return RECORDED_STATUSES.find((known) => known === status);
}

/** Runs this session started, oldest first, each with its latest recorded status. */
export function findDelegateRuns(entries: readonly SessionEntryLike[]): DelegateLaunch[] {
	const runs = new Map<string, DelegateLaunch>();
	for (const entry of entries) {
		const message = entry.message;
		if (entry.type !== "message" || !message) continue;
		if (message.role === "toolResult") {
			const details = message.details as Record<string, unknown> | undefined;
			if (details?.kind !== "delegate" || typeof details.runId !== "string") continue;
			const known = runs.get(details.runId);
			runs.set(details.runId, {
				runId: details.runId,
				agent: typeof details.agent === "string" ? details.agent : (known?.agent ?? "delegate"),
				task: typeof details.task === "string" ? details.task : (known?.task ?? ""),
				recordedStatus: asRecordedStatus(details.status) ?? known?.recordedStatus ?? "running",
				durationMs: typeof details.durationMs === "number" ? details.durationMs : known?.durationMs,
			});
			continue;
		}
		if (message.role !== "user") continue;
		for (const notice of textOf(message.content).matchAll(COMPLETION_NOTICE)) {
			const [, outcome, , runId] = notice;
			const known = runs.get(runId);
			if (!known) continue;
			known.recordedStatus = outcome === "FAILED" ? "failed" : outcome === "cancelled" ? "cancelled" : "completed";
		}
	}
	return [...runs.values()];
}

function timestampMs(entry: SessionEntryLike): number | undefined {
	const parsed = entry.timestamp ? Date.parse(entry.timestamp) : Number.NaN;
	return Number.isNaN(parsed) ? undefined : parsed;
}

function parseEntry(line: string): SessionEntryLike | undefined {
	try {
		return JSON.parse(line) as SessionEntryLike;
	} catch {
		// A line cut mid-write that happens to end in "}": the next read sees it whole.
		return undefined;
	}
}

export function summarizeDelegateSession(sessionText: string): DelegateSessionSummary {
	const summary: DelegateSessionSummary = {
		model: undefined,
		thinkingLevel: undefined,
		routeReason: undefined,
		costUsd: 0,
		startedAtMs: undefined,
		lastEntryAtMs: undefined,
		activity: [],
		pendingTool: undefined,
	};
	const pendingTools = new Map<string, RunningTool>();
	for (const line of sessionText.split("\n")) {
		// The run may be mid-write: a line without its closing brace is not complete yet.
		if (!line.startsWith("{") || !line.endsWith("}")) continue;
		const entry = parseEntry(line);
		if (!entry) continue;
		const atMs = timestampMs(entry) ?? summary.lastEntryAtMs ?? 0;
		summary.startedAtMs ??= timestampMs(entry);
		summary.lastEntryAtMs = timestampMs(entry) ?? summary.lastEntryAtMs;
		if (entry.type === "thinking_level_change" && entry.thinkingLevel) summary.thinkingLevel = entry.thinkingLevel;
		if (entry.type === "custom" && entry.customType === ROUTE_DECISION_ENTRY_TYPE && typeof entry.data?.reason === "string") {
			summary.routeReason = entry.data.reason;
		}
		const message = entry.message;
		if (entry.type !== "message" || !message) continue;
		if (message.role === "toolResult" && message.toolCallId) {
			pendingTools.delete(message.toolCallId);
			if (message.isError) summary.activity.push({ kind: "error", text: `${message.toolName ?? "tool"} failed`, atMs });
			continue;
		}
		if (message.role !== "assistant") continue;
		if (message.model && message.model !== "auto") summary.model = message.model;
		if (message.thinkingLevel) summary.thinkingLevel = message.thinkingLevel;
		summary.costUsd += message.usage?.cost?.total ?? 0;
		const parts = Array.isArray(message.content) ? (message.content as Array<Record<string, unknown>>) : [];
		for (const part of parts) {
			if (part.type === "text" && typeof part.text === "string" && part.text.trim() !== "") {
				summary.activity.push({ kind: "text", text: part.text.replace(/\s+/g, " ").trim(), atMs });
			}
			if (part.type === "toolCall" && typeof part.name === "string") {
				const detail = summarizeToolArgs(part.name, part.arguments);
				summary.activity.push({ kind: "tool", text: `${part.name}  ${detail}`, atMs });
				if (typeof part.id === "string") pendingTools.set(part.id, { name: part.name, detail, startedAtMs: atMs });
			}
		}
	}
	summary.activity = summary.activity.slice(-MAX_ACTIVITY_LINES);
	summary.pendingTool = [...pendingTools.values()].at(-1);
	return summary;
}

/** Process ids of the delegate runs alive now, by run id; undefined where /proc is not available. */
export function findLiveDelegateProcesses(procRoot = "/proc"): Map<string, number> | undefined {
	let processIds: string[];
	try {
		processIds = readdirSync(procRoot).filter((name) => /^\d+$/.test(name));
	} catch {
		// Not Linux: liveness is unknown and the recorded status is all there is.
		return undefined;
	}
	const live = new Map<string, number>();
	for (const processId of processIds) {
		let commandLine: string;
		try {
			commandLine = readFileSync(join(procRoot, processId, "cmdline"), "utf8");
		} catch {
			// The process ended between listing and reading.
			continue;
		}
		if (!commandLine.includes("acp-delegate")) continue;
		const sessionArg = commandLine.split("\0").find((arg) => SESSION_FILE_OF_RUN.test(arg));
		const runId = sessionArg?.match(SESSION_FILE_OF_RUN)?.[1];
		if (runId) live.set(runId, Number(processId));
	}
	return live;
}

export function delegateStatus(launch: DelegateLaunch, liveProcesses: Map<string, number> | undefined): DelegateStatus {
	if (!liveProcesses) return launch.recordedStatus;
	if (liveProcesses.has(launch.runId)) return "running";
	const hasFinishedOnRecord = launch.recordedStatus !== "running" && launch.recordedStatus !== "queued";
	return hasFinishedOnRecord ? launch.recordedStatus : "ended";
}

/** Reads each run's session file again only when it grew. */
export class DelegateSessionReader {
	private readonly cache = new Map<string, { sizeBytes: number; summary: DelegateSessionSummary }>();
	private readonly outputDir: string;

	constructor(outputDir = DELEGATE_OUTPUT_DIR) {
		this.outputDir = outputDir;
	}

	read(runId: string): DelegateSessionSummary | undefined {
		const path = join(this.outputDir, `${runId}.session.jsonl`);
		let sizeBytes: number;
		try {
			sizeBytes = statSync(path).size;
		} catch {
			// Not written yet, or cleaned up: the row shows what the session recorded.
			return undefined;
		}
		const cached = this.cache.get(runId);
		if (cached?.sizeBytes === sizeBytes) return cached.summary;
		const summary = summarizeDelegateSession(readFileSync(path, "utf8"));
		this.cache.set(runId, { sizeBytes, summary });
		return summary;
	}
}

/** Stops a running delegate the way acp_delegate_cancel does; returns an error to show, or undefined. */
export function cancelDelegate(runId: string, liveProcesses: Map<string, number> | undefined): string | undefined {
	const processId = liveProcesses?.get(runId);
	if (processId === undefined) return `Run ${runId} is not running`;
	try {
		process.kill(processId, "SIGTERM");
		return undefined;
	} catch (error) {
		return `Failed to cancel ${runId} (process ${processId}): ${(error as Error).message}`;
	}
}
