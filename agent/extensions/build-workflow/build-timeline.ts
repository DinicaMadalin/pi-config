/**
 * Turns the planner's session entries of a /build or /issue run, plus the subagent stages in progress, into
 * the run's steps (Plan, Implement, Review, ...) and one row per agent: the planner, each implementer, each
 * reviewer, with its model, time and cost summed over all its rounds (an implementer that also fixes is one row).
 * The planner's own turns (planning, answering the implementers) count toward the planner's row; the subagents'
 * rounds come from their stage records. Pure, so the agents overview can be tested without Pi.
 */
import { ROUTE_DECISION_ENTRY_TYPE } from "../auto-model/route-decision.ts";
import {
	agentOfRecord,
	BUILD_STAGE_ENTRY_TYPE,
	isDelegatedPhase,
	isImplementerRole,
	REPORT_MESSAGE_TYPE,
	REVIEWER_VENDORS,
	type ReviewerVendor,
	reviewerRole,
	type StageRecord,
	SUBAGENT_NAMES,
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
	/** A custom message's text, e.g. the run report. */
	content?: unknown;
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

/** A row of the overview: an agent with its latest round, or one of your steps (PR, ship). */
export interface StageRow {
	/** The agent's latest round (an implementer's is implement or fix), or the user's step. */
	key: StageKey;
	/** Which reviewer, on the reviewer rows. */
	reviewer?: ReviewerVendor;
	/** The agent of the row; undefined for the user's steps (PR, ship). */
	agent?: BuildAgentKey;
	/** The work stream an implementer builds, when the plan has several. */
	stream?: string;
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

/** A subagent's part in the stage in progress, from its process. */
export interface LiveStageView {
	stage: StageRecord["stage"];
	agent: SubagentRole;
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
	phase: WorkflowPhase;
	/** The plan's version since implementation started: 1 until the plan changes. */
	planRevision: number;
	/** The last run report posted to the planner's session, once the run reached the end of a review. */
	report?: string;
	issue?: { number: number; url: string; branch: string };
	/** The GitHub issue a /build plan was posted as. */
	planIssue?: { number: number; url: string };
	planPath?: string;
	baseCommit?: string;
	isFinished: boolean;
	/** The run's steps in order, for the stepper. */
	steps: { key: StageKey; status: StageStatus }[];
	/** One row per agent, then your steps. */
	stages: StageRow[];
	activeMs: number;
	costUsd: number;
}

/** What an agent did in the run, over all its rounds. */
interface AgentProgress {
	activeMs: number;
	costUsd: number;
	model?: string;
	thinkingLevel?: string;
	routeReason?: string;
	/** Its latest round. */
	latestStage?: StageKey;
	/** The rounds it finished with a report. */
	finishedStages: Set<StageKey>;
}

interface BuildRun {
	task: string;
	issue?: BuildTimeline["issue"];
	planIssue?: BuildTimeline["planIssue"];
	planPath?: string;
	baseCommit?: string;
	phase: WorkflowPhase;
	planRevision: number;
	report?: string;
	/** The current implementers and their work streams, from the latest state. */
	implementers: { role: SubagentRole; stream: string }[];
	progressByAgent: Map<BuildAgentKey, AgentProgress>;
	/** Stages some agent worked in, or the run passed through. */
	reachedStages: Set<StageKey>;
}

function isReviewStage(stage: StageKey): stage is "review" | "re-review" {
	return stage === "review" || stage === "re-review";
}

const VENDOR_NAMES: Record<ReviewerVendor, string> = { anthropic: "Claude", openai: "OpenAI" };

function startRun(state: Exclude<WorkflowState, { phase: "idle" }>): BuildRun {
	const task = "task" in state ? state.task : `Implement ${state.planPath}`;
	return { task, phase: state.phase, planRevision: 1, implementers: [], progressByAgent: new Map(), reachedStages: new Set(["plan"]) };
}

function applyState(run: BuildRun, state: Exclude<WorkflowState, { phase: "idle" }>): void {
	run.phase = state.phase;
	if ("task" in state) run.task = state.task;
	if ("planPath" in state) run.planPath = state.planPath;
	if ("baseCommit" in state && state.baseCommit) run.baseCommit = state.baseCommit;
	if (state.issue) run.issue = { number: state.issue.number, url: state.issue.url, branch: state.issue.branch };
	if ("planIssue" in state && state.planIssue) run.planIssue = { number: state.planIssue.number, url: state.planIssue.url };
	if ("planRevision" in state && state.planRevision) run.planRevision = state.planRevision;
	if ("implementers" in state && state.implementers) {
		run.implementers = state.implementers.map((seat) => ({ role: seat.role, stream: seat.stream }));
	}
	if (isDelegatedPhase(state.phase)) run.reachedStages.add(state.phase);
	if (state.phase === "awaiting-ship") run.reachedStages.add("ship");
	if (state.phase === "awaiting-pr") run.reachedStages.add("pr");
	if (state.phase === "review-failed") run.reachedStages.add("re-review");
}

function progressOf(run: BuildRun, agent: BuildAgentKey): AgentProgress {
	let progress = run.progressByAgent.get(agent);
	if (!progress) {
		progress = { activeMs: 0, costUsd: 0, finishedStages: new Set() };
		run.progressByAgent.set(agent, progress);
	}
	return progress;
}

/** Records before parallel implementers name no agent: a reviewer's has its vendor, the rest is the implementer's. */
function agentOfStage(record: StageRecord | LiveStageView): SubagentRole {
	if (!("report" in record)) return record.agent;
	if (record.agent) return record.agent;
	// Runs from before two reviewers had one reviewer without a vendor; its row is the Claude reviewer's.
	if (!record.reviewer && isReviewStage(record.stage)) return reviewerRole("anthropic");
	return agentOfRecord(record);
}

function addStageRecord(run: BuildRun, record: StageRecord | LiveStageView): void {
	const progress = progressOf(run, agentOfStage(record));
	if ("report" in record) progress.finishedStages.add(record.stage);
	run.reachedStages.add(record.stage);
	progress.latestStage = record.stage;
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

function isAgentOfPhase(agent: SubagentRole, phase: WorkflowPhase): boolean {
	return isImplementerRole(agent) ? phase === "implement" || phase === "fix" : phase === "review" || phase === "re-review";
}

function statusOfAgent(agent: SubagentRole, run: BuildRun, isFinished: boolean, live: readonly LiveStageView[]): StageStatus {
	const progress = run.progressByAgent.get(agent);
	if (isFinished) return progress ? "done" : "skipped";
	const isInStage = isAgentOfPhase(agent, run.phase) && (!isImplementerRole(agent) || run.implementers.some((seat) => seat.role === agent));
	if (!isInStage) return progress ? "done" : "waiting";
	if (live.some((view) => view.agent === agent && view.isWorking)) return "working";
	const latestStage = progress?.latestStage;
	return latestStage === run.phase && progress?.finishedStages.has(latestStage) ? "done" : "paused";
}

function statusOfStep(stage: StageKey, run: BuildRun, isFinished: boolean, isPlannerRunning: boolean, agentRows: readonly StageRow[]): StageStatus {
	const isReached = run.reachedStages.has(stage);
	if (isFinished) return isReached ? "done" : "skipped";
	if (stage === "plan") return plannerStatus(run.phase, isPlannerRunning);
	if (stage === "pr") return run.phase === "awaiting-pr" ? "your-turn" : "waiting";
	if (stage === "ship") return run.phase === "awaiting-ship" ? "your-turn" : "waiting";
	if (stage === "re-review" && run.phase === "review-failed") return "your-turn";
	if (stage === run.phase) {
		const statuses = agentRows.filter((row) => row.agent !== "planner" && row.key === stage).map((row) => row.status);
		if (statuses.includes("working")) return "working";
		return statuses.length > 0 && statuses.every((status) => status === "done") ? "done" : "paused";
	}
	return isReached ? "done" : "waiting";
}

const STEP_ORDER: readonly StageKey[] = ["plan", "implement", "review", "fix", "re-review", "pr", "ship"];
/** Fix and re-review only show up when a review asks for fixes. */
const ALWAYS_SHOWN_STEPS: ReadonlySet<StageKey> = new Set(["plan", "implement", "review"]);

/** The implementers to show: the current ones, plus earlier ones of this run whose stream left the plan. */
function implementerRows(run: BuildRun): { role: SubagentRole; stream: string }[] {
	const current = run.implementers.length > 0 ? run.implementers : [{ role: "implementer" as const, stream: "" }];
	const earlier = [...run.progressByAgent.keys()]
		.filter((agent): agent is SubagentRole => agent !== "planner" && isImplementerRole(agent))
		.filter((role) => !current.some((seat) => seat.role === role))
		.map((role) => ({ role, stream: "" }));
	return [...current, ...earlier];
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
				progressOf(run, "planner");
			}
			applyState(run, state);
			continue;
		}
		if (!run || isFinished) continue;
		if (entry.type === "custom" && entry.customType === BUILD_STAGE_ENTRY_TYPE) {
			addStageRecord(run, entry.data as StageRecord);
			continue;
		}
		if (entry.type === "custom_message" && entry.customType === REPORT_MESSAGE_TYPE && typeof entry.content === "string") {
			run.report = entry.content;
			continue;
		}
		if (entry.type === "custom" && entry.customType === ROUTE_DECISION_ENTRY_TYPE) {
			const reason = (entry.data as { reason?: unknown } | undefined)?.reason;
			if (typeof reason === "string") progressOf(run, "planner").routeReason = reason;
			continue;
		}
		if (entry.type !== "message" || !entry.message) continue;
		if (entry.message.role === "user") {
			turnMarkMs = entryTimeMs;
			continue;
		}
		const planner = progressOf(run, "planner");
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
		progressOf(run, "planner").activeMs += Math.max(0, nowMs - turnMarkMs);
	}
	if (!isFinished && isDelegatedPhase(run.phase)) {
		for (const view of live) addStageRecord(run, view);
	}

	const finishedRun = run;
	const isIssue = finishedRun.issue !== undefined;
	const isSeveralImplementers = implementerRows(finishedRun).length > 1;
	const agentRow = (agent: BuildAgentKey, defaultStage: StageKey, role: string, status: StageStatus, upcomingHint: string): StageRow => {
		const progress = finishedRun.progressByAgent.get(agent);
		return {
			key: progress?.latestStage ?? defaultStage,
			agent,
			role,
			status,
			model: progress?.model,
			thinkingLevel: progress?.thinkingLevel,
			routeReason: progress?.routeReason,
			activeMs: progress?.activeMs ?? 0,
			costUsd: progress?.costUsd ?? 0,
			upcomingHint,
		};
	};
	const plannerStatusNow = isFinished ? "done" : plannerStatus(finishedRun.phase, isPlannerRunning);
	const plannerRow = agentRow("planner", "plan", isIssue ? "Investigator" : "Planner", plannerStatusNow, "expert tier");
	plannerRow.key = "plan";
	const implementers = implementerRows(finishedRun).map(({ role, stream }) => {
		const row = agentRow(role, "implement", SUBAGENT_NAMES[role], statusOfAgent(role, finishedRun, isFinished, live), "model picked by difficulty");
		if (isSeveralImplementers && stream) row.stream = stream;
		return row;
	});
	const reviewers = REVIEWER_VENDORS.map((vendor) => {
		const role = reviewerRole(vendor);
		const row = agentRow(role, "review", SUBAGENT_NAMES[role], statusOfAgent(role, finishedRun, isFinished, live), `expert tier, ${VENDOR_NAMES[vendor]} models first`);
		row.reviewer = vendor;
		return row;
	});
	const agentRows = [plannerRow, ...implementers, ...reviewers];

	const isStepShown = (stage: StageKey): boolean =>
		ALWAYS_SHOWN_STEPS.has(stage) ||
		finishedRun.reachedStages.has(stage) ||
		(stage === "pr" && isIssue) ||
		(stage === "ship" && !isIssue && !isFinished);
	const steps = STEP_ORDER.filter(isStepShown).map((key) => ({ key, status: statusOfStep(key, finishedRun, isFinished, isPlannerRunning, agentRows) }));
	const userRows = steps
		.filter((step) => step.key === "pr" || step.key === "ship")
		.map((step): StageRow => ({
			key: step.key,
			role: step.key === "pr" ? "Pull request" : "Ship",
			status: step.status,
			activeMs: 0,
			costUsd: 0,
			upcomingHint: step.key === "pr" ? "draft PR after you confirm" : "new branch, commit and push after you confirm",
		}));
	const stages = [...agentRows, ...userRows];
	return {
		task: finishedRun.task,
		phase: finishedRun.phase,
		planRevision: finishedRun.planRevision,
		report: finishedRun.report,
		issue: finishedRun.issue,
		planIssue: finishedRun.planIssue,
		planPath: finishedRun.planPath,
		baseCommit: finishedRun.baseCommit,
		isFinished,
		steps,
		stages,
		activeMs: stages.reduce((total, stage) => total + stage.activeMs, 0),
		costUsd: stages.reduce((total, stage) => total + stage.costUsd, 0),
	};
}
