/**
 * Turns the planner's session entries of a /build or /issue run, plus the subagent stage in progress, into
 * one row per agent role: who ran it, on which model, for how long and at what cost.
 * The planner's own turns (planning, answering the implementer) all count toward the planner's row; the
 * subagents' stages come from their stage records. A review stage has a row per reviewer (Claude, OpenAI). Pure, so the agents overview can be tested without Pi.
 */
import { ROUTE_DECISION_ENTRY_TYPE } from "../auto-model/route-decision.ts";
import {
	BUILD_STAGE_ENTRY_TYPE,
	isDelegatedPhase,
	REVIEWER_VENDORS,
	type ReviewerVendor,
	reviewerRole,
	type StageRecord,
	type SubagentRole,
	WORKFLOW_STATE_ENTRY_TYPE,
	type WorkflowPhase,
	type WorkflowState,
} from "./workflow-state.ts";

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

export type StageKey = "plan" | "implement" | "review" | "fix" | "re-review" | "pr" | "ship";

/**
 * - done: finished. working: the agent is on it now. your-turn: waits for you (agree on the plan, /issue pr).
 * - paused: the agent stopped mid-stage (waits for an answer, or a reload interrupted it).
 * - waiting: not reached yet. skipped: the run ended first.
 */
export type StageStatus = "done" | "working" | "your-turn" | "paused" | "waiting" | "skipped";

export type BuildAgentKey = "planner" | SubagentRole;

export interface StageRow {
	key: StageKey;
	/** Which reviewer, on the review rows. */
	reviewer?: ReviewerVendor;
	/** The agent doing this stage; undefined for the user's steps (PR, ship). */
	agent?: BuildAgentKey;
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

/** The subagent stage in progress, from its process. */
export interface LiveStageView {
	stage: StageRecord["stage"];
	reviewer?: ReviewerVendor;
	model?: string;
	thinkingLevel?: string;
	routeReason?: string;
	activeMs: number;
	costUsd: number;
	isWorking: boolean;
}

export interface BuildTimeline {
	task: string;
	issue?: { number: number; url: string; branch: string };
	/** The GitHub issue a /build plan was posted as. */
	planIssue?: { number: number; url: string };
	planPath?: string;
	baseCommit?: string;
	isFinished: boolean;
	stages: StageRow[];
	activeMs: number;
	costUsd: number;
}

const STAGE_ORDER: readonly StageKey[] = ["plan", "implement", "review", "fix", "re-review", "pr", "ship"];
/** Fix and re-review only show up when a review asks for fixes. */
const ALWAYS_SHOWN_STAGES: ReadonlySet<StageKey> = new Set(["plan", "implement", "review"]);

const UPCOMING_HINTS: Record<StageKey, string> = {
	plan: "expert tier",
	implement: "model picked by difficulty",
	review: "expert tier",
	fix: "model picked by difficulty",
	"re-review": "expert tier",
	pr: "draft PR after you confirm",
	ship: "new branch, commit and push after you confirm",
};

interface StageProgress {
	/** A stage record of this row arrived: the agent finished its part. */
	hasRecord: boolean;
	model?: string;
	thinkingLevel?: string;
	routeReason?: string;
	activeMs: number;
	costUsd: number;
}

interface BuildRun {
	task: string;
	issue?: BuildTimeline["issue"];
	planIssue?: BuildTimeline["planIssue"];
	planPath?: string;
	baseCommit?: string;
	phase: WorkflowPhase;
	/** Keyed by rowId. */
	progressByStage: Map<string, StageProgress>;
}

/** "review:openai" for a reviewer's row, else the stage key. */
function rowId(stage: StageKey, reviewer: ReviewerVendor | undefined): string {
	return reviewer ? `${stage}:${reviewer}` : stage;
}

function isReviewStage(stage: StageKey): stage is "review" | "re-review" {
	return stage === "review" || stage === "re-review";
}

const VENDOR_NAMES: Record<ReviewerVendor, string> = { anthropic: "Claude", openai: "OpenAI" };

function agentOfRow(stage: StageKey, reviewer: ReviewerVendor | undefined): BuildAgentKey | undefined {
	switch (stage) {
		case "plan":
			return "planner";
		case "implement":
		case "fix":
			return "implementer";
		case "review":
		case "re-review":
			return reviewer ? reviewerRole(reviewer) : undefined;
		case "pr":
		case "ship":
			return undefined;
	}
}

function rowRoleName(stage: StageKey, reviewer: ReviewerVendor | undefined, isIssue: boolean): string {
	const role = roleName(stage, isIssue);
	return reviewer ? `${VENDOR_NAMES[reviewer]} ${role.toLowerCase()}` : role;
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
		case "ship":
			return "Ship";
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
	if ("planIssue" in state && state.planIssue) run.planIssue = { number: state.planIssue.number, url: state.planIssue.url };
	if (state.phase === "awaiting-ship") progressOf(run, "ship");
}

function progressOf(run: BuildRun, stage: StageKey, reviewer?: ReviewerVendor): StageProgress {
	const id = rowId(stage, reviewer);
	let progress = run.progressByStage.get(id);
	if (!progress) {
		progress = { hasRecord: false, activeMs: 0, costUsd: 0 };
		run.progressByStage.set(id, progress);
	}
	return progress;
}

function addStageRecord(run: BuildRun, record: StageRecord | LiveStageView): void {
	const progress = progressOf(run, record.stage, record.reviewer);
	if ("report" in record) progress.hasRecord = true;
	progress.activeMs += record.activeMs;
	progress.costUsd += record.costUsd;
	if (record.model) progress.model = record.model;
	if (record.thinkingLevel) progress.thinkingLevel = record.thinkingLevel;
	if (record.routeReason) progress.routeReason = record.routeReason;
}

function timeOf(entry: TimelineEntry): number | undefined {
	if (!entry.timestamp) return undefined;
	const timeMs = Date.parse(entry.timestamp);
	return Number.isNaN(timeMs) ? undefined : timeMs;
}

function plannerStatus(phase: WorkflowPhase, isPlannerRunning: boolean): StageStatus {
	if (isPlannerRunning) return "working";
	return phase === "plan" ? "your-turn" : "done";
}

function statusOfRow(
	stage: StageKey,
	reviewer: ReviewerVendor | undefined,
	run: BuildRun,
	isFinished: boolean,
	isPlannerRunning: boolean,
	live: readonly LiveStageView[],
): StageStatus {
	const progress = run.progressByStage.get(rowId(stage, reviewer));
	if (isFinished) return progress ? "done" : "skipped";
	if (stage === "plan") return plannerStatus(run.phase, isPlannerRunning);
	if (stage === "pr") return run.phase === "awaiting-pr" ? "your-turn" : "waiting";
	if (stage === "ship") return run.phase === "awaiting-ship" ? "your-turn" : "waiting";
	if (stage === run.phase) {
		const isWorking = live.some((view) => view.stage === stage && view.reviewer === reviewer && view.isWorking);
		if (isWorking) return "working";
		return progress?.hasRecord ? "done" : "paused";
	}
	return progress ? "done" : "waiting";
}

/** A review stage shows a row per reviewer it reached; the first review shows both before it starts. */
function reviewersOfStage(run: BuildRun, stage: "review" | "re-review"): (ReviewerVendor | undefined)[] {
	const reached = REVIEWER_VENDORS.filter((vendor) => run.progressByStage.has(rowId(stage, vendor)));
	const legacySingleReviewer = run.progressByStage.has(stage) ? [undefined] : [];
	const reviewers = [...legacySingleReviewer, ...reached];
	if (reviewers.length === 0 && stage === "review") return [...REVIEWER_VENDORS];
	return reviewers;
}

/**
 * The latest /build or /issue run in the planner's entries; undefined when none ever started.
 * nowMs and isPlannerRunning count the planner's turn in progress, which has no answer entry yet.
 */
export function buildTimeline(
	entries: readonly TimelineEntry[],
	nowMs: number,
	isPlannerRunning: boolean,
	live: readonly LiveStageView[] = [],
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
				progressOf(run, "plan");
			}
			applyState(run, state);
			continue;
		}
		if (!run || isFinished) continue;
		if (entry.type === "custom" && entry.customType === BUILD_STAGE_ENTRY_TYPE) {
			addStageRecord(run, entry.data as StageRecord);
			continue;
		}
		if (entry.type === "custom" && entry.customType === ROUTE_DECISION_ENTRY_TYPE) {
			const reason = (entry.data as { reason?: unknown } | undefined)?.reason;
			if (typeof reason === "string") progressOf(run, "plan").routeReason = reason;
			continue;
		}
		if (entry.type !== "message" || !entry.message) continue;
		if (entry.message.role === "user") {
			turnMarkMs = entryTimeMs;
			continue;
		}
		const planner = progressOf(run, "plan");
		if (turnMarkMs !== undefined && entryTimeMs !== undefined) {
			planner.activeMs += Math.max(0, entryTimeMs - turnMarkMs);
			turnMarkMs = entryTimeMs;
		}
		if (entry.message.role !== "assistant") continue;
		planner.costUsd += entry.message.usage?.cost?.total ?? 0;
		if (entry.message.model) planner.model = entry.message.model;
		if (entry.message.thinkingLevel) planner.thinkingLevel = entry.message.thinkingLevel;
	}
	if (!run) return undefined;

	if (!isFinished && isPlannerRunning && turnMarkMs !== undefined) {
		progressOf(run, "plan").activeMs += Math.max(0, nowMs - turnMarkMs);
	}
	if (!isFinished && isDelegatedPhase(run.phase)) {
		for (const view of live) addStageRecord(run, view);
	}

	const finishedRun = run;
	const isIssue = finishedRun.issue !== undefined;
	const rows = STAGE_ORDER.flatMap((stage): { stage: StageKey; reviewer?: ReviewerVendor }[] => {
		if (isReviewStage(stage)) return reviewersOfStage(finishedRun, stage).map((reviewer) => ({ stage, reviewer }));
		const isShown =
			ALWAYS_SHOWN_STAGES.has(stage) ||
			finishedRun.progressByStage.has(stage) ||
			(stage === "pr" && isIssue) ||
			(stage === "ship" && !isIssue && !isFinished);
		return isShown ? [{ stage }] : [];
	});
	const stages = rows.map(({ stage, reviewer }): StageRow => {
		const progress = finishedRun.progressByStage.get(rowId(stage, reviewer));
		const row: StageRow = {
			key: stage,
			agent: agentOfRow(stage, reviewer),
			role: rowRoleName(stage, reviewer, isIssue),
			status: statusOfRow(stage, reviewer, finishedRun, isFinished, isPlannerRunning, live),
			model: progress?.model,
			thinkingLevel: progress?.thinkingLevel,
			routeReason: progress?.routeReason,
			activeMs: progress?.activeMs ?? 0,
			costUsd: progress?.costUsd ?? 0,
			upcomingHint: reviewer ? `expert tier, ${VENDOR_NAMES[reviewer]} models first` : UPCOMING_HINTS[stage],
		};
		if (reviewer) row.reviewer = reviewer;
		return row;
	});
	return {
		task: finishedRun.task,
		issue: finishedRun.issue,
		planIssue: finishedRun.planIssue,
		planPath: finishedRun.planPath,
		baseCommit: finishedRun.baseCommit,
		isFinished,
		stages,
		activeMs: stages.reduce((total, stage) => total + stage.activeMs, 0),
		costUsd: stages.reduce((total, stage) => total + stage.costUsd, 0),
	};
}
