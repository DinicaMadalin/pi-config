/**
 * Runs the delegated part of a /build run: the implementers (one per work stream of the plan, building in parallel)
 * and the two reviewers (one on Claude, one on OpenAI, reviewing in parallel) are subagent processes, the planner
 * stays in your session. Moves the run along when every subagent of a stage is done, sends the implementers'
 * questions to the planner one at a time and each answer back to the one that asked, applies plan changes, lets
 * you stop, restart or message each agent, and posts a report when the run ends. The implementers stay with the
 * planner's session: its next run gives them their next work, so they keep their context.
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
	type StreamAssignment,
} from "./workflow-prompts.ts";
import { assignStreams, capWorkStreams, type ImplementerSeat, parseWorkStreams, streamOf, type WorkStream } from "./work-streams.ts";
import {
	type DelegatedPhase,
	type DelegatedState,
	type FeatureState,
	type FeatureWork,
	agentOfRecord,
	featureWorkOf,
	hasReviewVerdict,
	isImplementerRole,
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
	/** The implementers of the session's earlier runs, to give them the next work. */
	crew(): ImplementerSeat[];
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

/** An implementer stage runs one implementer per work stream; a review stage runs a reviewer of each vendor. */
interface StageSeat {
	role: SubagentRole;
	reviewer?: ReviewerVendor;
}

function seatsOfStage(state: DelegatedState): StageSeat[] {
	if (state.phase === "implement" || state.phase === "fix") return (state.implementers ?? []).map((seat) => ({ role: seat.role }));
	return REVIEWER_VENDORS.map((vendor) => ({ role: reviewerRole(vendor), reviewer: vendor }));
}

function sessionOfSeat(state: FeatureWork, seat: StageSeat): string | undefined {
	if (seat.reviewer) return state.reviewerSessions?.[seat.reviewer];
	return state.implementers?.find((implementer) => implementer.role === seat.role)?.sessionPath;
}

/** Each implementer's part of the plan; undefined for all when one implementer builds the whole plan. */
function streamAssignments(implementers: readonly ImplementerSeat[], plan: string): Map<SubagentRole, StreamAssignment | undefined> {
	const streams = capWorkStreams(parseWorkStreams(plan));
	const assignments = new Map<SubagentRole, StreamAssignment | undefined>();
	for (const seat of implementers) {
		const stream = streamOf(streams, seat.stream);
		if (implementers.length < 2 || !stream) {
			assignments.set(seat.role, undefined);
			continue;
		}
		const otherStreams = implementers
			.filter((other) => other.role !== seat.role)
			.map((other) => ({ implementerName: SUBAGENT_NAMES[other.role], streamName: other.stream }));
		assignments.set(seat.role, { implementerName: SUBAGENT_NAMES[seat.role], stream, otherStreams });
	}
	return assignments;
}

/** An implementer's question waiting for the planner, which answers one at a time. */
interface PlannerQuestion {
	role: SubagentRole;
	implementerAnswer: string;
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
	/** The implementer whose question the planner is answering now, and the questions waiting behind it. */
	private askingRole: SubagentRole | undefined;
	private readonly queuedQuestions: PlannerQuestion[] = [];
	/** Bumped by stop(): a step of a stopped run that was waiting on I/O sees the change and drops out. */
	private generation = 0;

	constructor(seat: PlannerSeat, launchSubagent: LaunchSubagent = launchSubagentProcess) {
		this.seat = seat;
		this.launchSubagent = launchSubagent;
	}

	process(role: SubagentRole): Subagent | undefined {
		return this.processes.get(role);
	}

	/** The subagents of the current stage: the implementers, or both reviewers. */
	liveStages(): LiveStage[] {
		return [...this.agents.values()];
	}

	get isWaitingForPlanner(): boolean {
		return this.askingRole !== undefined;
	}

	/**
	 * Plan agreed: one implementer per work stream starts on its brief, with the planner's session left as it is.
	 * Implementers of the session's earlier runs build their streams again, with their context.
	 */
	startImplementation(work: FeatureWork, plan: string, briefFor: (assignment: StreamAssignment | undefined) => string): void {
		const implementState: DelegatedState = { phase: "implement", ...work };
		const crew = this.seat.crew().filter((seat) => existsSync(seat.sessionPath));
		const state: DelegatedState = { ...implementState, implementers: this.assignCrew(implementState, crew, plan) };
		this.seat.enterPhase(state);
		const assignments = streamAssignments(state.implementers ?? [], plan);
		this.beginStage(state, (seat) => briefFor(assignments.get(seat.role)));
	}

	/** Gives the plan's streams to the implementers, making sessions for the streams that have none. */
	private assignCrew(state: DelegatedState, crew: readonly ImplementerSeat[], plan: string): ImplementerSeat[] {
		const streams: WorkStream[] = capWorkStreams(parseWorkStreams(plan));
		return assignStreams(streams, crew, (role) => this.createSession(state, { role }));
	}

	/** After a reload: restart the subagents of the current phase that still owe an answer, and let them continue. */
	resume(): ActionRefusal {
		const state = this.seat.state();
		if (!isDelegatedState(state)) return "No subagent stage to resume";
		if (this.agents.size > 0) return "The run is already going; Alt+A shows it";
		const missing = seatsOfStage(state).find((seat) => {
			const sessionPath = sessionOfSeat(state, seat);
			return !sessionPath || !existsSync(sessionPath);
		});
		if (missing) return `Cannot resume: the ${SUBAGENT_NAMES[missing.role]}'s session file is missing. /build stop, then start again.`;
		const answered = this.answeredReviews(state);
		this.beginStage(state, () => resumePrompt(), answered);
		if (this.liveStages().every((live) => live.condition === "answered")) this.moveOnFromReviews(state);
		return undefined;
	}

	/** The planner's turn settled; if it answered the implementer that asked, pass the answer on and ask the next question. */
	handlePlannerReply(reply: string): void {
		const asker = this.askingRole;
		if (!asker) return;
		const plannerAnswer = readPlannerAnswer(reply);
		if (plannerAnswer.kind === "none") return;
		if (plannerAnswer.kind === "needs-user") {
			this.seat.notify(`The ${SUBAGENT_NAMES[asker]} is waiting: answer the planner's question, and it passes your answer on`, "info");
			return;
		}
		this.askingRole = undefined;
		this.promptAgent(asker, plannerAnswerPrompt(plannerAnswer.answer));
		this.askNextQuestion();
	}

	/** The planner's turn was aborted while an implementer waited on it. */
	handlePlannerAborted(): void {
		const asker = this.askingRole;
		if (!asker) return;
		const name = SUBAGENT_NAMES[asker];
		this.seat.notify(`The ${name} still waits for the planner's answer: reply to the planner, or message the ${name} (Alt+A)`, "warning");
	}

	/** A message you typed in the agents overview. */
	sendToSubagent(role: SubagentRole, text: string): ActionRefusal {
		const subagent = this.processes.get(role);
		if (!subagent?.isRunning) return `The ${SUBAGENT_NAMES[role]} is not running; r restarts it`;
		subagent.sendUserMessage(text);
		this.dropQuestionOf(role);
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
		this.dropQuestionOf(role);
		const restarted = this.ensureProcess(live, state);
		if (!restarted) return `No session file for the ${SUBAGENT_NAMES[role]}`;
		if (live.reviewer) this.reviewAnswers.delete(live.reviewer);
		this.agents.set(role, this.liveStageOf(live.stage, live, restarted));
		restarted.prompt(resumePrompt());
		return undefined;
	}

	/**
	 * The plan changed while the implementers work on it: each gets its part of the new plan right away, a new
	 * stream gets a new implementer, and an implementer whose stream is gone stops.
	 */
	async tellImplementersAboutPlanChange(): Promise<ActionRefusal> {
		const state = this.seat.state();
		if (state.phase !== "implement" && state.phase !== "fix") return "The implementers are not working on the plan now";
		const plan = this.seat.readPlan(state.planPath);
		if (plan === undefined) return `Cannot read the plan ${state.planPath}`;
		const implementers = this.assignCrew(state, state.implementers ?? [], plan);
		const next: DelegatedState = withPlanRevision({ ...state, implementers });
		const dropped = (state.implementers ?? []).filter((seat) => !implementers.some((kept) => kept.role === seat.role));
		const generation = this.generation;
		for (const seat of dropped) await this.retireImplementer(seat.role);
		if (generation !== this.generation) return "The run was stopped";
		this.seat.enterPhase(next);
		const assignments = streamAssignments(implementers, plan);
		for (const seat of implementers) {
			const prompt = planChangePrompt(next.planPath, plan, next.planIssue, undefined, assignments.get(seat.role));
			if (!this.agents.has(seat.role)) this.startAgent(next, { role: seat.role }, prompt);
			else this.promptAgent(seat.role, prompt);
		}
		return undefined;
	}

	/** An implementer whose stream left the plan: its process ends, its work so far is recorded. */
	private async retireImplementer(role: SubagentRole): Promise<void> {
		const live = this.agents.get(role);
		if (live) this.recordUnfinishedStage(live, "(its work stream left the plan)");
		this.agents.delete(role);
		this.dropQuestionOf(role);
		const subagent = this.processes.get(role);
		this.processes.delete(role);
		await subagent?.stop();
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
		const work = featureWorkOf(state);
		const changeState: DelegatedState = { phase: "implement", ...work };
		const next: DelegatedState = withPlanRevision({ ...changeState, implementers: this.assignCrew(changeState, work.implementers ?? [], plan) });
		this.seat.enterPhase(next);
		const assignments = streamAssignments(next.implementers ?? [], plan);
		this.beginStage(next, (seat) => planChangePrompt(state.planPath, plan, state.planIssue, undefined, assignments.get(seat.role)));
		return undefined;
	}

	/** Both reviewers check the work again: after a failed re-review, or before shipping. */
	async reReview(): Promise<ActionRefusal> {
		const state = this.seat.state();
		if (!isAwaitingUser(state.phase) || !isFeatureState(state)) return "Re-review works once a review has finished";
		const next: DelegatedState = { phase: "re-review", ...featureWorkOf(state) };
		if (!next.reviewerSessions) return "This run has no reviewer sessions to continue";
		this.seat.enterPhase(next);
		this.beginStage(next, () => reReviewPrompt(next.baseCommit, this.latestFixReplies()));
		return undefined;
	}

	/** After a failed re-review: one more fix round on the remaining findings, then a re-review. */
	fixAgain(): ActionRefusal {
		const state = this.seat.state();
		if (state.phase !== "review-failed") return "Another fix round works after a failed re-review";
		const next: DelegatedState = { phase: "fix", ...featureWorkOf(state) };
		this.seat.enterPhase(next);
		this.beginStage(next, this.fixPromptFor(next, state.findings));
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
		this.clearQuestions();
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
		this.clearQuestions();
		for (const seat of seatsOfStage(state)) {
			const answer = seat.reviewer ? answered.get(seat.reviewer) : undefined;
			if (seat.reviewer && answer !== undefined) {
				const live = this.startAgent(state, seat, undefined);
				if (!live) continue;
				this.reviewAnswers.set(seat.reviewer, answer);
				live.condition = "answered";
				continue;
			}
			this.startAgent(state, seat, promptFor(seat));
		}
	}

	/** Adds a subagent to the current stage and prompts it, unless prompt is undefined (it already answered). */
	private startAgent(state: DelegatedState, seat: StageSeat, prompt: string | undefined): LiveStage | undefined {
		const subagent = this.ensureProcess(seat, state);
		if (!subagent) {
			this.seat.notify(`/build: no session file for the ${SUBAGENT_NAMES[seat.role]}`, "error");
			return undefined;
		}
		const live = this.liveStageOf(state.phase, seat, subagent);
		this.agents.set(seat.role, live);
		if (prompt !== undefined) subagent.prompt(prompt);
		return live;
	}

	/** Each implementer's fix prompt: the merged review, and its own work stream when there are several. */
	/** Each implementer's last fix report, so the re-reviewers can check its claims and rejections. */
	private latestFixReplies(): { implementerName: string; reply: string }[] {
		const replyByAgent = new Map<SubagentRole, string>();
		for (const record of this.seat.runStageRecords()) {
			if (record.stage === "fix") replyByAgent.set(agentOfRecord(record), record.report);
		}
		return [...replyByAgent].map(([agent, reply]) => ({ implementerName: SUBAGENT_NAMES[agent], reply }));
	}

	private fixPromptFor(state: DelegatedState, findings: string): (seat: StageSeat) => string {
		const plan = this.seat.readPlan(state.planPath);
		const assignments = plan === undefined ? new Map<SubagentRole, StreamAssignment | undefined>() : streamAssignments(state.implementers ?? [], plan);
		return (seat) => fixPrompt(findings, assignments.get(seat.role));
	}

	private askPlanner(question: PlannerQuestion): void {
		this.setCondition(question.role, "waiting-for-planner");
		const name = SUBAGENT_NAMES[question.role];
		if (this.askingRole) {
			this.queuedQuestions.push(question);
			this.seat.notify(`The ${name} has a question; the planner answers it after the current one`, "info");
			return;
		}
		this.askingRole = question.role;
		this.seat.notify(`The ${name} has a question; the planner answers it`, "info");
		const isOneOfSeveral = [...this.agents.keys()].filter(isImplementerRole).length > 1;
		this.seat.askPlanner(plannerQuestionPrompt(question.implementerAnswer, isOneOfSeveral ? name : undefined));
	}

	private askNextQuestion(): void {
		const next = this.queuedQuestions.shift();
		if (next) this.askPlanner(next);
	}

	/** The implementer got going without the planner (your message, a restart): its question is void. */
	private dropQuestionOf(role: SubagentRole): void {
		const queued = this.queuedQuestions.findIndex((question) => question.role === role);
		if (queued !== -1) this.queuedQuestions.splice(queued, 1);
		if (this.askingRole !== role) return;
		this.askingRole = undefined;
		this.askNextQuestion();
	}

	private clearQuestions(): void {
		this.askingRole = undefined;
		this.queuedQuestions.length = 0;
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
			agent: live.role,
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
			this.handleImplementerSettled(state, live, lastAnswer);
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

	/** An implementer that is done waits for the others; one that stopped short asks the planner. */
	private handleImplementerSettled(state: DelegatedState, live: LiveStage, lastAnswer: string): void {
		const step = stepAfterTurn(state, lastAnswer);
		switch (step.kind) {
			case "ask-planner":
				this.askPlanner({ role: live.role, implementerAnswer: step.implementerAnswer });
				return;
			case "wait":
				this.seat.notify(`/build paused: ${step.reason}. Alt+A: message it (m) or restart it (r).`, "warning");
				return;
			case "advance": {
				this.recordStage(live, lastAnswer);
				this.setCondition(live.role, "answered");
				const stillWorking = this.liveStages().filter((stage) => stage.condition !== "answered");
				if (stillWorking.length > 0) {
					const names = stillWorking.map((stage) => stage.process.name).join(", ");
					this.seat.notify(`${live.process.name} is done; waiting for ${names}`, "info");
					return;
				}
				void this.advance(state, step.next, lastAnswer);
				return;
			}
		}
	}

	private moveOnFromReviews(state: DelegatedState): void {
		const reviews = [...this.reviewAnswers].map(([vendor, answer]) => ({ vendor, answer }));
		const stageAnswer = mergeReviews(reviews);
		const step = stepAfterTurn(state, stageAnswer);
		switch (step.kind) {
			case "ask-planner":
				return;
			case "wait":
				this.seat.notify(`/build paused: ${step.reason}. Alt+A: message it (m) or restart it (r).`, "warning");
				return;
			case "advance":
				void this.advance(state, step.next, stageAnswer);
				return;
		}
	}

	private async advance(previous: DelegatedState, next: WorkflowState, stageAnswer: string): Promise<void> {
		const generation = this.generation;
		this.agents.clear();
		this.reviewAnswers.clear();
		this.clearQuestions();
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
				const changeState: DelegatedState = { ...next, implementers: this.assignCrew(next, next.implementers ?? [], plan) };
				this.seat.enterPhase(changeState);
				const assignments = streamAssignments(changeState.implementers ?? [], plan);
				this.beginStage(changeState, (seat) => planChangePrompt(next.planPath, plan, next.planIssue, stageAnswer, assignments.get(seat.role)));
				return;
			}
			case "fix":
				this.seat.enterPhase(next);
				this.beginStage(next, this.fixPromptFor(next, stageAnswer));
				return;
			case "re-review":
				this.seat.enterPhase(next);
				this.beginStage(next, () => reReviewPrompt(next.baseCommit, this.latestFixReplies()));
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
