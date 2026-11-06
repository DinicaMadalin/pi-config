/**
 * Runs the delegated part of a /build run: the implementer and the two reviewers (one on Claude, one on OpenAI,
 * reviewing in parallel) are subagent processes, the planner stays in your session. Moves the run along when a
 * subagent settles, sends the implementer's questions to the planner and its answers back, applies plan changes,
 * lets you stop, restart or message each agent, and posts a report when the run ends.
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ROUTE_PIN_ENTRY_TYPE } from "../auto-model/route-pin.ts";
import { activeMsOf } from "./agent-activity.ts";
import { createSubagentSessionFile, type LaunchSubagent, launchSubagentProcess, type Subagent, type SubagentDialogs } from "./subagent-process.ts";
import {
	fixPrompt,
	planChangePrompt,
	plannerAnswerPrompt,
	plannerQuestionPrompt,
	reReviewPrompt,
	resumePrompt,
	reviewPrompt,
	runReport,
} from "./workflow-prompts.ts";
import {
	type DelegatedPhase,
	type DelegatedState,
	type FeatureState,
	type FeatureWork,
	featureWorkOf,
	hasReviewVerdict,
	isAwaitingUser,
	isDelegatedState,
	isFeatureState,
	mergeReviews,
	readPlannerAnswer,
	releaseStateOf,
	REVIEWER_VENDORS,
	type ReviewerVendor,
	reviewerRole,
	reviewerRoute,
	routeForPhase,
	type StageRecord,
	stepAfterTurn,
	SUBAGENT_NAMES,
	type SubagentRole,
	WORKFLOW_STATE_ENTRY_TYPE,
	type WorkflowState,
	withPlanRevision,
} from "./workflow-state.ts";

export type { SubagentRole };

/** What the orchestrator needs from the planner's session; planner-seat.ts implements it with the Pi API. */
export interface PlannerSeat {
	cwd(): string;
	/** Directory for the subagents' session files, next to the planner's. */
	sessionDirectory(): string;
	plannerSessionPath(): string | undefined;
	state(): WorkflowState;
	enterPhase(next: WorkflowState): void;
	appendStage(record: StageRecord): void;
	/** Stages of the current run already stored in the planner's session. */
	runStageRecords(): StageRecord[];
	/** Stages stored since the current phase began; a resumed review keeps the verdicts it already has. */
	currentStageRecords(): StageRecord[];
	readPlan(planPath: string): string | undefined;
	ruleFiles(): Promise<string[]>;
	/** "+120 −8 in 5 files" since the base commit, or undefined when it cannot be counted. */
	describeChanges(baseCommit: string | undefined): Promise<string | undefined>;
	askPlanner(prompt: string): void;
	postReport(report: string): void;
	notify(message: string, level: "info" | "warning" | "error"): void;
	/** The subagents are done: the run waits for the user (decision, PR, ship) or is idle. */
	finish(next: WorkflowState, summary: string): void;
	dialogs: SubagentDialogs;
}

/**
 * How a subagent of the current stage stands. running: it works or will on its next prompt; answered: a reviewer
 * gave its report and waits for the other; stopped: you stopped its turn; crashed: its process is gone.
 */
export type AgentCondition = "running" | "waiting-for-planner" | "answered" | "stopped" | "crashed";

/** A subagent's part in the current stage; its numbers are the process totals minus those at the stage's start. */
export interface LiveStage {
	stage: DelegatedPhase;
	role: SubagentRole;
	reviewer?: ReviewerVendor;
	process: Subagent;
	condition: AgentCondition;
	startCostUsd: number;
	startActiveMs: number;
}

/** One subagent per stage of the implementer; a review stage runs a reviewer of each vendor. */
interface StageSeat {
	role: SubagentRole;
	reviewer?: ReviewerVendor;
}

function seatsOfStage(stage: DelegatedPhase): StageSeat[] {
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

/** A refusal shown to the user, or undefined when the action was taken. */
export type ActionRefusal = string | undefined;

export class BuildOrchestrator {
	private readonly seat: PlannerSeat;
	private readonly launchSubagent: LaunchSubagent;
	private readonly processes = new Map<SubagentRole, Subagent>();
	private readonly agents = new Map<SubagentRole, LiveStage>();
	/** Latest answer of each reviewer in the current review stage; the stage moves on once both answered. */
	private readonly reviewAnswers = new Map<ReviewerVendor, string>();
	/** Bumped by stop(): a step of a stopped run that was waiting on I/O sees the change and drops out. */
	private generation = 0;

	constructor(seat: PlannerSeat, launchSubagent: LaunchSubagent = launchSubagentProcess) {
		this.seat = seat;
		this.launchSubagent = launchSubagent;
	}

	process(role: SubagentRole): Subagent | undefined {
		return this.processes.get(role);
	}

	/** The subagents of the current stage: the implementer, or both reviewers. */
	liveStages(): LiveStage[] {
		return [...this.agents.values()];
	}

	get isWaitingForPlanner(): boolean {
		return this.agents.get("implementer")?.condition === "waiting-for-planner";
	}

	/** Plan agreed: start the implementer on the brief, with the planner's session left as it is. */
	startImplementation(work: FeatureWork, brief: string): void {
		const implementState: DelegatedState = { phase: "implement", ...work };
		const sessionPath = this.createSession(implementState, { role: "implementer" });
		const state: DelegatedState = { ...implementState, implementerSession: sessionPath };
		this.seat.enterPhase(state);
		this.beginStage(state, () => brief);
	}

	/** After a reload: restart the subagents of the current phase that still owe an answer, and let them continue. */
	resume(): ActionRefusal {
		const state = this.seat.state();
		if (!isDelegatedState(state)) return "No subagent stage to resume";
		if (this.agents.size > 0) return "The run is already going; Alt+A shows it";
		const missing = seatsOfStage(state.phase).find((seat) => {
			const sessionPath = sessionOfSeat(state, seat);
			return !sessionPath || !existsSync(sessionPath);
		});
		if (missing) return `Cannot resume: the ${SUBAGENT_NAMES[missing.role]}'s session file is missing. /build stop, then start again.`;
		const answered = this.answeredReviews(state);
		this.beginStage(state, () => resumePrompt(), answered);
		if (this.liveStages().every((live) => live.condition === "answered")) this.moveOnFromReviews(state);
		return undefined;
	}

	/** The planner's turn settled; if it answered the implementer, pass the answer on. */
	handlePlannerReply(reply: string): void {
		if (!this.isWaitingForPlanner) return;
		const plannerAnswer = readPlannerAnswer(reply);
		if (plannerAnswer.kind === "none") return;
		if (plannerAnswer.kind === "needs-user") {
			this.seat.notify("The implementer is waiting: answer the planner's question, and it passes your answer on", "info");
			return;
		}
		this.promptAgent("implementer", plannerAnswerPrompt(plannerAnswer.answer));
	}

	/** The planner's turn was aborted while the implementer waited on it. */
	handlePlannerAborted(): void {
		if (!this.isWaitingForPlanner) return;
		this.seat.notify("The implementer still waits for the planner's answer: reply to the planner, or message the implementer (Alt+A)", "warning");
	}

	/** A message you typed in the agents overview. */
	sendToSubagent(role: SubagentRole, text: string): ActionRefusal {
		const subagent = this.processes.get(role);
		if (!subagent?.isRunning) return `The ${SUBAGENT_NAMES[role]} is not running; r restarts it`;
		subagent.sendUserMessage(text);
		this.setCondition(role, "running");
		return undefined;
	}

	/** Stops the agent's current turn; it keeps its process and context, waiting for a message or a restart. */
	stopAgentTurn(role: SubagentRole): ActionRefusal {
		const subagent = this.processes.get(role);
		if (!subagent?.isRunning || !subagent.isWorking) return `The ${SUBAGENT_NAMES[role]} is not working`;
		subagent.abortTurn();
		this.setCondition(role, "stopped");
		return undefined;
	}

	/** A fresh process on the agent's session, told to check the work and continue; also brings back a crashed agent. */
	async restartAgent(role: SubagentRole): Promise<ActionRefusal> {
		const live = this.agents.get(role);
		const state = this.seat.state();
		if (!live || !isDelegatedState(state)) return `The ${SUBAGENT_NAMES[role]} has no work in this stage`;
		const generation = this.generation;
		const previous = this.processes.get(role);
		if (previous) {
			this.recordUnfinishedStage(live, "(restarted by you)");
			this.processes.delete(role);
			await previous.stop();
		}
		if (generation !== this.generation) return "The run was stopped";
		const restarted = this.ensureProcess(live, state);
		if (!restarted) return `No session file for the ${SUBAGENT_NAMES[role]}`;
		if (live.reviewer) this.reviewAnswers.delete(live.reviewer);
		this.agents.set(role, this.liveStageOf(live.stage, live, restarted));
		restarted.prompt(resumePrompt());
		return undefined;
	}

	/** The plan changed while the implementer works on it: it gets the new plan right away. */
	tellImplementerAboutPlanChange(): ActionRefusal {
		const state = this.seat.state();
		if (state.phase !== "implement" && state.phase !== "fix") return "The implementer is not working on the plan now";
		const plan = this.seat.readPlan(state.planPath);
		if (plan === undefined) return `Cannot read the plan ${state.planPath}`;
		this.seat.enterPhase(withPlanRevision(state));
		this.promptAgent("implementer", planChangePrompt(state.planPath, plan, state.planIssue));
		return undefined;
	}

	/** The plan changed during a review: the review finishes, then its findings go into a change round. */
	applyPlanChangeAfterReview(): ActionRefusal {
		const state = this.seat.state();
		if (state.phase !== "review" && state.phase !== "re-review") return "No review is running";
		this.seat.enterPhase(withPlanRevision({ ...state, planChangeAfterReview: true }));
		return undefined;
	}

	/**
	 * The implementer applies the changed plan now, then both reviewers review again: from a running review
	 * (which is stopped), after a failed re-review, or from work waiting to ship or for its PR.
	 */
	async startChangeRound(): Promise<ActionRefusal> {
		const state = this.seat.state();
		if (!isFeatureState(state) || state.phase === "implement" || state.phase === "fix") return "No reviewed work to change";
		const plan = this.seat.readPlan(state.planPath);
		if (plan === undefined) return `Cannot read the plan ${state.planPath}`;
		const generation = await this.stopProcesses();
		if (generation !== this.generation) return "The run was stopped";
		const next: DelegatedState = withPlanRevision({ phase: "implement", ...featureWorkOf(state) });
		this.seat.enterPhase(next);
		this.beginStage(next, () => planChangePrompt(state.planPath, plan, state.planIssue));
		return undefined;
	}

	/** Both reviewers check the work again: after a failed re-review, or before shipping. */
	async reReview(): Promise<ActionRefusal> {
		const state = this.seat.state();
		if (!isAwaitingUser(state.phase) || !isFeatureState(state)) return "Re-review works once a review has finished";
		const next: DelegatedState = { phase: "re-review", ...featureWorkOf(state) };
		if (!next.reviewerSessions) return "This run has no reviewer sessions to continue";
		this.seat.enterPhase(next);
		this.beginStage(next, () => reReviewPrompt(next.baseCommit));
		return undefined;
	}

	/** After a failed re-review: one more fix round on the remaining findings, then a re-review. */
	fixAgain(): ActionRefusal {
		const state = this.seat.state();
		if (state.phase !== "review-failed") return "Another fix round works after a failed re-review";
		const next: DelegatedState = { phase: "fix", ...featureWorkOf(state) };
		this.seat.enterPhase(next);
		this.beginStage(next, () => fixPrompt(state.findings));
		return undefined;
	}

	/** After a failed re-review: you accept the work as it is, and it goes on to shipping or its PR. */
	acceptAnyway(): ActionRefusal {
		const state = this.seat.state();
		if (state.phase !== "review-failed") return "Accepting works after a failed re-review";
		this.seat.finish(releaseStateOf(state), "you accepted the work despite the re-review's findings");
		return undefined;
	}

	/** Ends every subagent; steps of this run still waiting on I/O drop out. */
	stop(): void {
		void this.stopProcesses();
	}

	private async stopProcesses(): Promise<number> {
		this.generation++;
		const generation = this.generation;
		const running = [...this.processes.values()];
		this.processes.clear();
		this.agents.clear();
		this.reviewAnswers.clear();
		await Promise.all(running.map((subagent) => subagent.stop()));
		return generation;
	}

	/** Reviews of this phase that already ended with a verdict before a reload; those reviewers are not asked again. */
	private answeredReviews(state: DelegatedState): Map<ReviewerVendor, string> {
		const answered = new Map<ReviewerVendor, string>();
		if (state.phase !== "review" && state.phase !== "re-review") return answered;
		for (const record of this.seat.currentStageRecords()) {
			if (record.reviewer && record.stage === state.phase && hasReviewVerdict(record.report)) answered.set(record.reviewer, record.report);
		}
		return answered;
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

	private ensureProcess(seat: StageSeat, state: FeatureWork): Subagent | undefined {
		const running = this.processes.get(seat.role);
		if (running?.isRunning) return running;
		const sessionPath = sessionOfSeat(state, seat);
		if (!sessionPath) return undefined;
		const name = SUBAGENT_NAMES[seat.role];
		const subagent: Subagent = this.launchSubagent({
			name,
			cwd: this.seat.cwd(),
			sessionPath,
			dialogs: this.seat.dialogs,
			onSettled: (lastAnswer, isAborted) => {
				if (this.processes.get(seat.role) === subagent) this.handleSubagentSettled(seat.role, lastAnswer, isAborted);
			},
			onExit: (reason) => {
				if (this.processes.get(seat.role) !== subagent) return;
				this.handleSubagentCrash(seat.role, reason);
			},
		});
		subagent.start();
		this.processes.set(seat.role, subagent);
		return subagent;
	}

	private handleSubagentCrash(role: SubagentRole, reason: string): void {
		this.processes.delete(role);
		const live = this.agents.get(role);
		if (!live) return;
		this.recordUnfinishedStage(live, `(the process stopped: ${reason})`);
		this.setCondition(role, "crashed");
		this.seat.notify(`/build: the ${SUBAGENT_NAMES[role]} stopped (${reason}). Alt+A, then r restarts it.`, "error");
	}

	/** Prompts an agent of the current stage, restarting its process when it is gone. */
	private promptAgent(role: SubagentRole, prompt: string): void {
		const live = this.agents.get(role);
		const state = this.seat.state();
		if (!live || !isFeatureState(state)) return;
		const subagent = this.ensureProcess(live, state);
		if (!subagent) {
			this.seat.notify(`/build: no session file for the ${SUBAGENT_NAMES[role]}`, "error");
			return;
		}
		if (live.process !== subagent) this.agents.set(role, this.liveStageOf(live.stage, live, subagent));
		this.setCondition(role, "running");
		subagent.prompt(prompt);
	}

	/** Starts the subagents of the state's stage on the prompt made for each; answered reviewers keep their answers. */
	private beginStage(
		state: DelegatedState,
		promptFor: (seat: StageSeat) => string,
		answered: ReadonlyMap<ReviewerVendor, string> = new Map(),
	): void {
		this.agents.clear();
		this.reviewAnswers.clear();
		for (const seat of seatsOfStage(state.phase)) {
			const subagent = this.ensureProcess(seat, state);
			if (!subagent) {
				this.seat.notify(`/build: no session file for the ${SUBAGENT_NAMES[seat.role]}`, "error");
				continue;
			}
			const live = this.liveStageOf(state.phase, seat, subagent);
			this.agents.set(seat.role, live);
			const answer = seat.reviewer ? answered.get(seat.reviewer) : undefined;
			if (seat.reviewer && answer !== undefined) {
				this.reviewAnswers.set(seat.reviewer, answer);
				live.condition = "answered";
				continue;
			}
			subagent.prompt(promptFor(seat));
		}
	}

	private liveStageOf(stage: DelegatedPhase, seat: StageSeat, subagent: Subagent): LiveStage {
		const stats = subagent.tracker.stats;
		return {
			stage,
			role: seat.role,
			reviewer: seat.reviewer,
			process: subagent,
			condition: "running",
			startCostUsd: stats.costUsd,
			startActiveMs: activeMsOf(stats, Date.now()),
		};
	}

	private setCondition(role: SubagentRole, condition: AgentCondition): void {
		const live = this.agents.get(role);
		if (live) live.condition = condition;
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
		this.agents.set(live.role, { ...this.liveStageOf(live.stage, live, live.process), condition: live.condition });
	}

	/** Keeps the cost and time of a turn that ended without an answer, so a restart does not lose them. */
	private recordUnfinishedStage(live: LiveStage, note: string): void {
		const stats = stageStats(live, Date.now());
		if (stats.costUsd > 0 || stats.activeMs > 0) this.recordStage(live, note);
	}

	private handleSubagentSettled(role: SubagentRole, lastAnswer: string, isAborted: boolean): void {
		const live = this.agents.get(role);
		const state = this.seat.state();
		if (!live || !isDelegatedState(state) || state.phase !== live.stage) return;
		if (isAborted) {
			this.setCondition(role, "stopped");
			return;
		}
		if (!live.reviewer) {
			this.moveOn(state, lastAnswer, () => this.recordStage(live, lastAnswer));
			return;
		}
		this.recordStage(live, lastAnswer);
		this.setCondition(role, "answered");
		this.reviewAnswers.set(live.reviewer, lastAnswer);
		const pendingReviewer = this.liveStages().find((stage) => stage.reviewer && !this.reviewAnswers.has(stage.reviewer));
		if (pendingReviewer) {
			this.seat.notify(`${live.process.name} finished; waiting for the ${pendingReviewer.process.name}`, "info");
			return;
		}
		this.moveOnFromReviews(state);
	}

	private moveOnFromReviews(state: DelegatedState): void {
		const reviews = [...this.reviewAnswers].map(([vendor, answer]) => ({ vendor, answer }));
		this.moveOn(state, mergeReviews(reviews), () => undefined);
	}

	/** Applies the stage's outcome; recordImplementer stores the implementer's turn once the stage ends with it. */
	private moveOn(state: DelegatedState, stageAnswer: string, recordImplementer: () => void): void {
		const step = stepAfterTurn(state, stageAnswer);
		switch (step.kind) {
			case "ask-planner":
				this.setCondition("implementer", "waiting-for-planner");
				this.seat.notify("The implementer has a question; the planner answers it", "info");
				this.seat.askPlanner(plannerQuestionPrompt(step.implementerAnswer));
				return;
			case "wait":
				this.seat.notify(`/build paused: ${step.reason}. Alt+A: message it (m) or restart it (r).`, "warning");
				return;
			case "advance":
				recordImplementer();
				void this.advance(state, step.next, stageAnswer);
				return;
		}
	}

	private async advance(previous: DelegatedState, next: WorkflowState, stageAnswer: string): Promise<void> {
		const generation = this.generation;
		this.agents.clear();
		this.reviewAnswers.clear();
		switch (next.phase) {
			case "review": {
				const ruleFiles = await this.seat.ruleFiles();
				if (generation !== this.generation) return;
				const reviewerSessions: Partial<Record<ReviewerVendor, string>> = {};
				for (const vendor of REVIEWER_VENDORS) {
					reviewerSessions[vendor] = this.createSession(next, { role: reviewerRole(vendor), reviewer: vendor });
				}
				const reviewState: DelegatedState = { ...next, reviewerSessions };
				this.seat.enterPhase(reviewState);
				const prompt = reviewPrompt(next.planPath, next.baseCommit, ruleFiles, next.issue, next.planIssue);
				this.beginStage(reviewState, () => prompt);
				return;
			}
			case "implement": {
				const plan = this.seat.readPlan(next.planPath);
				if (plan === undefined) {
					this.seat.notify(`/build paused: cannot read the plan ${next.planPath}`, "error");
					return;
				}
				this.seat.enterPhase(next);
				this.beginStage(next, () => planChangePrompt(next.planPath, plan, next.planIssue, stageAnswer));
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
			case "review-failed":
				await this.finishRun(previous, next, "the re-review still has findings, and the fix round is used up");
				return;
			case "awaiting-pr":
			case "awaiting-ship":
				await this.finishRun(previous, next, "both reviewers passed it");
				return;
		}
	}

	private async finishRun(previous: FeatureState, next: WorkflowState, summary: string): Promise<void> {
		const generation = await this.stopProcesses();
		const changes = await this.seat.describeChanges(previous.baseCommit);
		if (generation !== this.generation) return;
		this.seat.postReport(runReport(summary, this.seat.runStageRecords(), changes));
		this.seat.finish(next, summary);
	}
}
