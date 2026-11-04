/**
 * Turns the session entries of a /build or /issue run (planning session first, then the implementation
 * session) into one row per agent role: who ran it, on which model, for how long and at what cost.
 * Pure, so the agents overview can be tested without Pi.
 */
import { ROUTE_DECISION_ENTRY_TYPE } from "../auto-model/route-decision.ts";
import { WORKFLOW_STATE_ENTRY_TYPE, type WorkflowPhase, type WorkflowState } from "./workflow-state.ts";

export interface TimelineEntry {
	type: string;
	/** ISO time the entry was written. */
	timestamp?: string;
	customType?: string;
	data?: unknown;
	message?: {
		role: string;
		model?: string;
		thinkingLevel?: string;
		usage?: { cost?: { total?: number } };
	};
}

export type StageKey = "plan" | "implement" | "review" | "fix" | "re-review" | "pr";

/**
 * - done: finished. working: the agent is on it now. your-turn: waits for you (agree, /build implement, /issue pr).
 * - paused: the agent stopped mid-phase and waits for a reply. waiting: not reached yet. skipped: the run ended first.
 */
export type StageStatus = "done" | "working" | "your-turn" | "paused" | "waiting" | "skipped";

export interface StageRow {
	key: StageKey;
	role: string;
	status: StageStatus;
	/** Model id of the latest answer in this stage, e.g. "claude-opus-5-5". */
	model?: string;
	thinkingLevel?: string;
	/** Why the router picked this tier, from the auto model's route decision. */
	routeReason?: string;
	/** Time the agent spent working, without the time it waited for you. */
	activeMs: number;
	costUsd: number;
	/** What happens in a stage that has not started yet. */
	upcomingHint: string;
}

export interface BuildTimeline {
	task: string;
	issue?: { number: number; url: string; branch: string };
	planPath?: string;
	baseCommit?: string;
	isFinished: boolean;
	stages: StageRow[];
	activeMs: number;
	costUsd: number;
}

const STAGE_OF_PHASE: Record<Exclude<WorkflowPhase, "idle">, StageKey> = {
	plan: "plan",
	"awaiting-implementation": "plan",
	implement: "implement",
	review: "review",
	fix: "fix",
	"re-review": "re-review",
	"awaiting-pr": "pr",
};

const STAGE_ORDER: readonly StageKey[] = ["plan", "implement", "review", "fix", "re-review", "pr"];
/** Fix and re-review only show up when a review asks for fixes. */
const ALWAYS_SHOWN_STAGES: ReadonlySet<StageKey> = new Set(["plan", "implement", "review"]);

const UPCOMING_HINTS: Record<StageKey, string> = {
	plan: "expert tier",
	implement: "model picked by difficulty",
	review: "expert tier",
	fix: "model picked by difficulty",
	"re-review": "expert tier",
	pr: "draft PR after you confirm",
};

interface StageProgress {
	model?: string;
	thinkingLevel?: string;
	routeReason?: string;
	activeMs: number;
	costUsd: number;
}

interface BuildRun {
	task: string;
	issue?: BuildTimeline["issue"];
	planPath?: string;
	baseCommit?: string;
	phase: WorkflowPhase;
	progressByStage: Map<StageKey, StageProgress>;
}

function roleName(stage: StageKey, isIssue: boolean): string {
	switch (stage) {
		case "plan":
			return isIssue ? "Investigator" : "Planner";
		case "implement":
			return "Implementer";
		case "review":
			return "Reviewer";
		case "fix":
			return "Fixer";
		case "re-review":
			return "Re-reviewer";
		case "pr":
			return "Pull request";
	}
}

function startRun(state: Exclude<WorkflowState, { phase: "idle" }>): BuildRun {
	const task = "task" in state ? state.task : `Implement ${state.planPath}`;
	return { task, phase: state.phase, progressByStage: new Map() };
}

function applyState(run: BuildRun, state: Exclude<WorkflowState, { phase: "idle" }>): void {
	run.phase = state.phase;
	if ("task" in state) run.task = state.task;
	if ("planPath" in state) run.planPath = state.planPath;
	if ("baseCommit" in state && state.baseCommit) run.baseCommit = state.baseCommit;
	if (state.issue) run.issue = { number: state.issue.number, url: state.issue.url, branch: state.issue.branch };
}

function progressOf(run: BuildRun): StageProgress | undefined {
	if (run.phase === "idle") return undefined;
	const stage = STAGE_OF_PHASE[run.phase];
	let progress = run.progressByStage.get(stage);
	if (!progress) {
		progress = { activeMs: 0, costUsd: 0 };
		run.progressByStage.set(stage, progress);
	}
	return progress;
}

function timeOf(entry: TimelineEntry): number | undefined {
	if (!entry.timestamp) return undefined;
	const timeMs = Date.parse(entry.timestamp);
	return Number.isNaN(timeMs) ? undefined : timeMs;
}

function statusOfStage(stage: StageKey, run: BuildRun, isFinished: boolean, isAgentRunning: boolean): StageStatus {
	const hasStarted = run.progressByStage.has(stage);
	if (isFinished) return hasStarted ? "done" : "skipped";
	const currentStage = run.phase === "idle" ? undefined : STAGE_OF_PHASE[run.phase];
	if (stage === currentStage) {
		if (isAgentRunning) return "working";
		return run.phase === "awaiting-implementation" || run.phase === "awaiting-pr" ? "your-turn" : "paused";
	}
	if (!hasStarted) return "waiting";
	return "done";
}

/**
 * The latest /build or /issue run in the entries; undefined when none ever started.
 * nowMs and isAgentRunning count the turn in progress, which has no answer entry yet.
 */
export function buildTimeline(
	entries: readonly TimelineEntry[],
	nowMs: number,
	isAgentRunning: boolean,
): BuildTimeline | undefined {
	let run: BuildRun | undefined;
	let isFinished = false;
	let turnMarkMs: number | undefined;

	for (const entry of entries) {
		const entryTimeMs = timeOf(entry);
		if (entry.type === "custom" && entry.customType === WORKFLOW_STATE_ENTRY_TYPE) {
			const state = entry.data as WorkflowState;
			if (state.phase === "idle") {
				if (run && !isFinished) isFinished = true;
				continue;
			}
			if (!run || isFinished) {
				run = startRun(state);
				isFinished = false;
			}
			applyState(run, state);
			progressOf(run);
			// Time from here on belongs to the new stage.
			if (turnMarkMs !== undefined && entryTimeMs !== undefined) turnMarkMs = entryTimeMs;
			continue;
		}
		if (!run || isFinished) continue;
		if (entry.type === "custom" && entry.customType === ROUTE_DECISION_ENTRY_TYPE) {
			const progress = progressOf(run);
			const reason = (entry.data as { reason?: unknown } | undefined)?.reason;
			if (progress && typeof reason === "string") progress.routeReason = reason;
			continue;
		}
		if (entry.type !== "message" || !entry.message) continue;
		if (entry.message.role === "user") {
			turnMarkMs = entryTimeMs;
			continue;
		}
		const progress = progressOf(run);
		if (!progress) continue;
		if (turnMarkMs !== undefined && entryTimeMs !== undefined) {
			progress.activeMs += Math.max(0, entryTimeMs - turnMarkMs);
			turnMarkMs = entryTimeMs;
		}
		if (entry.message.role !== "assistant") continue;
		progress.costUsd += entry.message.usage?.cost?.total ?? 0;
		if (entry.message.model) progress.model = entry.message.model;
		if (entry.message.thinkingLevel) progress.thinkingLevel = entry.message.thinkingLevel;
	}
	if (!run) return undefined;

	if (!isFinished && isAgentRunning && turnMarkMs !== undefined) {
		const progress = progressOf(run);
		if (progress) progress.activeMs += Math.max(0, nowMs - turnMarkMs);
	}

	const finishedRun = run;
	const isIssue = finishedRun.issue !== undefined;
	const visibleStages = STAGE_ORDER.filter(
		(stage) =>
			ALWAYS_SHOWN_STAGES.has(stage) || finishedRun.progressByStage.has(stage) || (stage === "pr" && isIssue),
	);
	const stages = visibleStages.map((stage): StageRow => {
		const progress = finishedRun.progressByStage.get(stage);
		return {
			key: stage,
			role: roleName(stage, isIssue),
			status: statusOfStage(stage, finishedRun, isFinished, isAgentRunning),
			model: progress?.model,
			thinkingLevel: progress?.thinkingLevel,
			routeReason: progress?.routeReason,
			activeMs: progress?.activeMs ?? 0,
			costUsd: progress?.costUsd ?? 0,
			upcomingHint: UPCOMING_HINTS[stage],
		};
	});
	return {
		task: finishedRun.task,
		issue: finishedRun.issue,
		planPath: finishedRun.planPath,
		baseCommit: finishedRun.baseCommit,
		isFinished,
		stages,
		activeMs: stages.reduce((total, stage) => total + stage.activeMs, 0),
		costUsd: stages.reduce((total, stage) => total + stage.costUsd, 0),
	};
}
