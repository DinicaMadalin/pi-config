/**
 * Runs the delegated part of a /build run: the implementer and the two reviewers (one on Claude, one on
 * OpenAI, reviewing in parallel) are subagent processes, the planner stays in your session. Moves the run along when a subagent settles, sends the implementer's
 * questions to the planner and its answers back, and posts a report when the run ends.
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ROUTE_PIN_ENTRY_TYPE } from "../auto-model/route-pin.ts";
import { activeMsOf } from "./agent-activity.ts";
import { createSubagentSessionFile, type SubagentDialogs, SubagentProcess } from "./subagent-process.ts";
import {
	fixPrompt,
	plannerAnswerPrompt,
	plannerQuestionPrompt,
	reReviewPrompt,
	resumePrompt,
	reviewPrompt,
	runReport,
} from "./workflow-prompts.ts";
import {
	type FeatureWork,
	isDelegatedPhase,
	mergeReviews,
	readPlannerAnswer,
	REVIEWER_NAMES,
	REVIEWER_VENDORS,
	type ReviewerVendor,
	reviewerRole,
	reviewerRoute,
	routeForPhase,
	type StageRecord,
	stepAfterTurn,
	type SubagentRole,
	WORKFLOW_STATE_ENTRY_TYPE,
	type WorkflowState,
} from "./workflow-state.ts";

export type { SubagentRole };
type DelegatedState = Extract<WorkflowState, { phase: StageRecord["stage"] }>;

/** What the orchestrator needs from the planner's session; index.ts implements it with the Pi API. */
export interface PlannerSeat {
	cwd(): string;
	/** Directory for the subagents' session files, next to the planner's. */
	sessionDirectory(): string;
	plannerSessionPath(): string | undefined;
	state(): WorkflowState;
	enterPhase(next: WorkflowState): void;
	appendStage(record: StageRecord): void;
	/** Stages of the current run already stored in the planner's session. */
	stageRecords(): StageRecord[];
	ruleFiles(): Promise<string[]>;
	/** "+120 −8 in 5 files" since the base commit, or undefined when it cannot be counted. */
	describeChanges(baseCommit: string | undefined): Promise<string | undefined>;
	askPlanner(prompt: string): void;
	postReport(report: string): void;
	notify(message: string, level: "info" | "warning" | "error"): void;
	/** The run ended: idle, or awaiting the user's PR for issue work. */
	finish(next: WorkflowState, summary: string): void;
	dialogs: SubagentDialogs;
}

/** A subagent's stage in progress; its numbers are the process totals minus those at the stage's start. */
export interface LiveStage {
	stage: StageRecord["stage"];
	role: SubagentRole;
	reviewer?: ReviewerVendor;
	process: SubagentProcess;
	startCostUsd: number;
	startActiveMs: number;
}

const ROLE_NAMES: Record<SubagentRole, string> = {
	implementer: "Implementer",
	"anthropic-reviewer": REVIEWER_NAMES.anthropic,
	"openai-reviewer": REVIEWER_NAMES.openai,
};

/** One subagent per stage of the implementer; a review stage runs a reviewer of each vendor. */
interface StageSeat {
	role: SubagentRole;
	reviewer?: ReviewerVendor;
}

function seatsOfStage(stage: StageRecord["stage"]): StageSeat[] {
	if (stage === "implement" || stage === "fix") return [{ role: "implementer" }];
	return REVIEWER_VENDORS.map((vendor) => ({ role: reviewerRole(vendor), reviewer: vendor }));
}

function sessionOfSeat(state: FeatureWork, seat: StageSeat): string | undefined {
	return seat.reviewer ? state.reviewerSessions?.[seat.reviewer] : state.implementerSession;
}

export function stageStats(live: LiveStage, nowMs: number): { activeMs: number; costUsd: number } {
	const stats = live.process.tracker.stats;
	return {
		activeMs: Math.max(0, activeMsOf(stats, nowMs) - live.startActiveMs),
		costUsd: Math.max(0, stats.costUsd - live.startCostUsd),
	};
}

export class BuildOrchestrator {
	private readonly seat: PlannerSeat;
	private readonly processes = new Map<SubagentRole, SubagentProcess>();
	private readonly live = new Map<SubagentRole, LiveStage>();
	/** Latest answer of each reviewer in the current review stage; the stage moves on once both answered. */
	private readonly reviewAnswers = new Map<ReviewerVendor, string>();
	/** The implementer waits for the planner's answer. */
	private isAwaitingPlanner = false;

	constructor(seat: PlannerSeat) {
		this.seat = seat;
	}

	process(role: SubagentRole): SubagentProcess | undefined {
		return this.processes.get(role);
	}

	/** The subagents of the current stage: the implementer, or both reviewers. */
	liveStages(): LiveStage[] {
		return [...this.live.values()];
	}

	get isWaitingForPlanner(): boolean {
		return this.isAwaitingPlanner;
	}

	/** Plan agreed: start the implementer on the brief, with the planner's session left as it is. */
	startImplementation(work: FeatureWork, brief: string): void {
		const implementState: DelegatedState = { phase: "implement", ...work };
		const sessionPath = this.createSession(implementState, { role: "implementer" });
		const state: DelegatedState = { ...implementState, implementerSession: sessionPath };
		this.seat.enterPhase(state);
		this.beginStage(state, () => brief);
	}

	/** After a reload: restart the subagents of the current phase on their sessions and let them continue. */
	resume(): boolean {
		const state = this.seat.state();
		if (!isDelegatedPhase(state.phase)) return false;
		const delegated = state as DelegatedState;
		const missing = seatsOfStage(delegated.phase).find((seat) => {
			const sessionPath = sessionOfSeat(delegated, seat);
			return !sessionPath || !existsSync(sessionPath);
		});
		if (missing) {
			this.seat.notify(
				`Cannot resume: the ${ROLE_NAMES[missing.role]}'s session file is missing. /build stop, then start again.`,
				"error",
			);
			return false;
		}
		this.beginStage(delegated, () => resumePrompt());
		return true;
	}

	/** The planner's turn settled; if it answered the implementer, pass the answer on. */
	handlePlannerReply(reply: string): void {
		if (!this.isAwaitingPlanner) return;
		const plannerAnswer = readPlannerAnswer(reply);
		if (plannerAnswer.kind === "none") return;
		if (plannerAnswer.kind === "needs-user") {
			this.seat.notify("The implementer is waiting: answer the planner's question, and it passes your answer on", "info");
			return;
		}
		this.isAwaitingPlanner = false;
		const implementer = this.ensureProcess({ role: "implementer" }, this.seat.state() as DelegatedState);
		implementer?.prompt(plannerAnswerPrompt(plannerAnswer.answer));
	}

	/** A message typed in the agents overview. */
	sendToSubagent(role: SubagentRole, text: string): string | undefined {
		const subagent = this.processes.get(role);
		if (!subagent?.isRunning) return `The ${ROLE_NAMES[role]} is not running`;
		subagent.sendUserMessage(text);
		return undefined;
	}

	stop(): void {
		for (const subagent of this.processes.values()) subagent.stop();
		this.processes.clear();
		this.live.clear();
		this.reviewAnswers.clear();
		this.isAwaitingPlanner = false;
	}

	private createSession(state: DelegatedState, seat: StageSeat): string {
		const stamp = new Date().toISOString().replace(/[:.]/g, "-");
		const sessionPath = join(this.seat.sessionDirectory(), `${stamp}_build-${seat.role}_${randomUUID()}.jsonl`);
		const route = seat.reviewer ? reviewerRoute(seat.reviewer) : routeForPhase(state.phase);
		createSubagentSessionFile(sessionPath, this.seat.cwd(), this.seat.plannerSessionPath(), [
			{ customType: WORKFLOW_STATE_ENTRY_TYPE, data: state },
			{ customType: ROUTE_PIN_ENTRY_TYPE, data: route },
		]);
		return sessionPath;
	}

	private ensureProcess(seat: StageSeat, state: DelegatedState): SubagentProcess | undefined {
		const running = this.processes.get(seat.role);
		if (running?.isRunning) return running;
		const sessionPath = sessionOfSeat(state, seat);
		if (!sessionPath) return undefined;
		const name = ROLE_NAMES[seat.role];
		const subagent: SubagentProcess = new SubagentProcess({
			name,
			cwd: this.seat.cwd(),
			sessionPath,
			dialogs: this.seat.dialogs,
			onSettled: (lastAnswer, isAborted) => this.handleSubagentSettled(subagent, lastAnswer, isAborted),
			onExit: (reason) => {
				this.seat.notify(`/build ${name} stopped (${reason}). /build implement restarts it.`, "error");
			},
		});
		subagent.start();
		this.processes.set(seat.role, subagent);
		return subagent;
	}

	/** Starts every subagent of the state's stage on the prompt made for it. */
	private beginStage(state: DelegatedState, promptFor: (seat: StageSeat) => string): void {
		this.live.clear();
		this.reviewAnswers.clear();
		for (const seat of seatsOfStage(state.phase)) {
			const subagent = this.ensureProcess(seat, state);
			if (!subagent) {
				this.seat.notify(`/build: no session for the ${ROLE_NAMES[seat.role]}`, "error");
				continue;
			}
			this.live.set(seat.role, this.liveStageOf(state.phase, seat, subagent));
			subagent.prompt(promptFor(seat));
		}
	}

	private liveStageOf(stage: StageRecord["stage"], seat: StageSeat, subagent: SubagentProcess): LiveStage {
		const stats = subagent.tracker.stats;
		return {
			stage,
			role: seat.role,
			reviewer: seat.reviewer,
			process: subagent,
			startCostUsd: stats.costUsd,
			startActiveMs: activeMsOf(stats, Date.now()),
		};
	}

	/** Stores what the subagent did since its stage (or its last record) began; it stays live until the stage ends. */
	private recordStage(live: LiveStage, report: string): void {
		const stats = live.process.tracker.stats;
		const record: StageRecord = {
			stage: live.stage,
			model: stats.model,
			thinkingLevel: stats.thinkingLevel,
			routeReason: stats.routeReason,
			...stageStats(live, Date.now()),
			report,
		};
		if (live.reviewer) record.reviewer = live.reviewer;
		this.seat.appendStage(record);
		this.live.set(live.role, this.liveStageOf(live.stage, live, live.process));
	}

	private handleSubagentSettled(subagent: SubagentProcess, lastAnswer: string, isAborted: boolean): void {
		const live = [...this.live.values()].find((stage) => stage.process === subagent);
		const state = this.seat.state();
		if (isAborted || !live || !isDelegatedPhase(state.phase)) return;
		if (!live.reviewer) {
			this.moveOn(state as DelegatedState, live, lastAnswer, lastAnswer);
			return;
		}
		this.recordStage(live, lastAnswer);
		this.reviewAnswers.set(live.reviewer, lastAnswer);
		const pendingReviewer = [...this.live.values()].find(
			(stage) => stage.reviewer && !this.reviewAnswers.has(stage.reviewer),
		);
		if (pendingReviewer) {
			this.seat.notify(`${live.process.name} finished; waiting for the ${pendingReviewer.process.name}`, "info");
			return;
		}
		const reviews = [...this.reviewAnswers].map(([vendor, answer]) => ({ vendor, answer }));
		this.moveOn(state as DelegatedState, live, mergeReviews(reviews), undefined);
	}

	/**
	 * Applies the stage's outcome. implementerReport is the implementer's answer to record; reviewers record
	 * theirs as they settle, since a stage of two reviewers ends with whichever settles last.
	 */
	private moveOn(state: DelegatedState, live: LiveStage, stageAnswer: string, implementerReport: string | undefined): void {
		const step = stepAfterTurn(state, stageAnswer);
		switch (step.kind) {
			case "ask-planner":
				this.isAwaitingPlanner = true;
				this.seat.notify("The implementer has a question; the planner answers it", "info");
				this.seat.askPlanner(plannerQuestionPrompt(step.implementerAnswer));
				return;
			case "wait":
				this.seat.notify(`/build paused: ${step.reason}. Alt+A lets you message the ${live.process.name}.`, "warning");
				return;
			case "finish":
				if (implementerReport !== undefined) this.recordStage(live, implementerReport);
				this.live.clear();
				void this.finishRun(state, { phase: "idle" }, step.summary);
				return;
			case "advance":
				if (implementerReport !== undefined) this.recordStage(live, implementerReport);
				this.live.clear();
				void this.advance(state, step.next, stageAnswer);
				return;
		}
	}

	private async advance(previous: DelegatedState, next: WorkflowState, stageAnswer: string): Promise<void> {
		switch (next.phase) {
			case "review": {
				const reviewerSessions: Partial<Record<ReviewerVendor, string>> = {};
				for (const vendor of REVIEWER_VENDORS) {
					reviewerSessions[vendor] = this.createSession(next, { role: reviewerRole(vendor), reviewer: vendor });
				}
				const reviewState: DelegatedState = { ...next, reviewerSessions };
				this.seat.enterPhase(reviewState);
				const ruleFiles = await this.seat.ruleFiles();
				const prompt = reviewPrompt(next.planPath, next.baseCommit, ruleFiles, next.issue, next.planIssue);
				this.beginStage(reviewState, () => prompt);
				return;
			}
			case "fix":
				this.seat.enterPhase(next);
				this.beginStage(next, () => fixPrompt(stageAnswer));
				return;
			case "re-review":
				this.seat.enterPhase(next);
				this.beginStage(next, () => reReviewPrompt(next.baseCommit));
				return;
			case "awaiting-pr":
			case "awaiting-ship":
				await this.finishRun(previous, next, "both reviewers passed it");
				return;
		}
	}

	private async finishRun(previous: WorkflowState, next: WorkflowState, summary: string): Promise<void> {
		this.stop();
		const baseCommit = "baseCommit" in previous ? previous.baseCommit : undefined;
		const changes = await this.seat.describeChanges(baseCommit);
		this.seat.postReport(runReport(summary, this.seat.stageRecords(), changes));
		this.seat.finish(next, summary);
	}
}
