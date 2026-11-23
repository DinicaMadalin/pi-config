/**
 * Runs the delegated part of a /build run: the implementers (one per work stream of the plan, building in parallel)
 * and one expert-tier reviewer is a subagent process, the planner
 * stays in your session. Moves the run along when every subagent of a stage is done, sends the implementers'
 * questions to the planner one at a time and each answer back to the one that asked, applies plan changes, lets
 * you stop, restart or message each agent, and posts a report when the run ends. The implementers stay with the
 * planner's session: its next run gives them their next work, so they keep their context.
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ROUTE_PIN_ENTRY_TYPE } from "../auto-model/route-pin.ts";
import { describeNewCheckFailures, findNewCheckFailures } from "../quality-gate/check-baseline.ts";
import type { BuildCheckRun } from "./build-checks.ts";
import type { ReviewerLineup } from "./reviewer-lineup.ts";
import { activeMsOf } from "./agent-activity.ts";
import { createSubagentSessionFile, type LaunchSubagent, launchSubagentProcess, type Subagent, type SubagentDialogs, type SubagentPane } from "./subagent-process.ts";
import {
	designPrompt,
	implementationBrief,
	fixPrompt,
	fixStepsPrompt,
	checkFailuresFixPrompt,
	plannerAnswerPrompt,
	plannerQuestionPrompt,
	reReviewPrompt,
	resumePrompt,
	reviewPrompt,
	runReport,
	type StreamAssignment,
} from "./workflow-prompts.ts";
import type { DifficultyTier } from "../auto-model/difficulty-tiers.ts";
import { assignStreams, capWorkStreams, type ImplementerSeat, implementerMaxTier, parseWorkStreams, streamOf, type WorkStream } from "./work-streams.ts";
import {
	type DelegatedPhase,
	type DelegatedState,
	type FeatureState,
	type FeatureWork,
	agentOfRecord,
	featureWorkOf,
	fixStepsFor,
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
	/** A notice that the run cannot go on without the user; inside herdr it also pings. */
	callUser(message: string): void;
	/** Your trust decision for the project, which its subagents take over. */
	isProjectTrusted(): boolean;
	/** Remove reviewed temporary contracts and verify the resulting files; failures never release work. */
	reviewerLineup(): ReviewerLineup;
	runChecks(signal: AbortSignal): Promise<BuildCheckRun>;
	changedFiles(baseCommit: string | undefined, signal: AbortSignal): Promise<string[]>;
	finalizeContracts(work: FeatureWork, signal: AbortSignal): Promise<string | undefined>;
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

type FixState = Extract<DelegatedState, { phase: "fix" }>;

/** An implementer stage runs one implementer per work stream; a review stage runs a reviewer of each vendor. */
interface StageSeat {
	role: SubagentRole;
	reviewer?: ReviewerVendor;
}

function seatsOfStage(state: DelegatedState): StageSeat[] {
	if (state.phase === "design") return [{ role: "designer" }];
	if (state.phase === "implement" || state.phase === "fix") return (state.implementers ?? []).map((seat) => ({ role: seat.role }));
	return REVIEWER_VENDORS.filter((vendor) => state.reviewerSessions?.[vendor]).map((vendor) => ({ role: reviewerRole(vendor), reviewer: vendor }));
}

function sessionOfSeat(state: FeatureWork, seat: StageSeat): string | undefined {
	if (seat.role === "designer") return state.designerSession;
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
	/** The fix round waiting for the planner's fix steps; no implementer works until they arrive. */
	/** Bumped by stop(): a step of a stopped run that was waiting on I/O sees the change and drops out. */
	private generation = 0;
	private implementationBriefFor: ((assignment: StreamAssignment | undefined) => string) | undefined;
	private cleanupController: AbortController | undefined;
	private cleanupTask: Promise<void> | undefined;

	constructor(seat: PlannerSeat, launchSubagent: LaunchSubagent = launchSubagentProcess) {
		this.seat = seat;
		this.launchSubagent = launchSubagent;
	}

	process(role: SubagentRole): Subagent | undefined {
		return this.processes.get(role);
	}

	/** The herdr panes of every helper still running, also those whose round is over. */
	openPanes(): Map<SubagentRole, SubagentPane> {
		const panes = new Map<SubagentRole, SubagentPane>();
		for (const [role, subagent] of this.processes) if (subagent.pane) panes.set(role, subagent.pane);
		return panes;
	}

	/** The subagents of the current stage: the implementers, or every reviewer available for the run. */
	liveStages(): LiveStage[] {
		return [...this.agents.values()];
	}

	/**
	 * The fix round waits for the planner's fix steps. Read from the saved run state, not kept in memory, so a reload
	 * between the planner's question and the user's answer still passes the steps on to the implementers.
	 */
	private get isWaitingForFixSteps(): boolean {
		const state = this.seat.state();
		return state.phase === "fix" && state.findings !== undefined && state.fixSteps === undefined;
	}

	get isWaitingForPlanner(): boolean {
		return this.askingRole !== undefined || this.isWaitingForFixSteps;
	}

	/**
	 * Plan agreed: one implementer per work stream starts on its brief, with the planner's session left as it is.
	 * Implementers of the session's earlier runs build their streams again, with their context.
	 */
	startImplementation(work: FeatureWork, plan: string, briefFor: (assignment: StreamAssignment | undefined) => string): void {
		const implementState: DelegatedState = { phase: "implement", ...work };
		const crew = this.seat.crew().filter((seat) => existsSync(seat.sessionPath));
		const state: DelegatedState = { ...implementState, implementers: this.assignCrew(implementState, crew, plan) };
		this.implementationBriefFor = briefFor;
		this.beginDesign(state, plan);
	}

	private beginDesign(work: FeatureWork, plan: string): void {
		const state: DelegatedState = { phase: "design", ...featureWorkOf(work) };
		state.designerSession = this.createSession(state, { role: "designer" });
		this.seat.enterPhase(state);
		this.beginStage(state, () => designPrompt(state.planPath, plan, state.baseCommit));
	}

	/** Gives the plan's streams to the implementers, making sessions for the streams that have none. */
	private assignCrew(state: DelegatedState, crew: readonly ImplementerSeat[], plan: string): ImplementerSeat[] {
		const streams: WorkStream[] = capWorkStreams(parseWorkStreams(plan));
		return assignStreams(streams, crew, (role) => this.createSession({ ...state, phase: "implement" }, { role }));
	}

	/** After a reload: restart the subagents of the current phase that still owe an answer, and let them continue. */
	resume(): ActionRefusal {
		const state = this.seat.state();
		if (state.phase === "cleanup" || state.phase === "cleanup-failed") return this.retryCleanup();
		if (!isDelegatedState(state)) return "No subagent stage to resume";
		if (this.agents.size > 0) return "The run is already going; /build status shows its phase";
		if (state.phase === "fix" && state.findings !== undefined && state.fixSteps === undefined) {
			this.requestFixSteps(state, state.findings);
			return undefined;
		}
		const missing = seatsOfStage(state).find((seat) => {
			const sessionPath = sessionOfSeat(state, seat);
			return !sessionPath || !existsSync(sessionPath);
		});
		if (missing) return `Cannot resume: the ${SUBAGENT_NAMES[missing.role]}'s session file is missing. /build stop, then start again.`;
		if ((state.phase === "review" || state.phase === "re-review") && !state.reviewerSessions) {
			void this.beginReview(state);
			return undefined;
		}
		const answered = this.answeredReviews(state);
		this.beginStage(state, () => resumePrompt(), answered);
		if ((state.phase === "review" || state.phase === "re-review") && this.liveStages().every((live) => live.condition === "answered")) this.moveOnFromReviews(state);
		return undefined;
	}

	async resumeOrRestart(): Promise<ActionRefusal> {
		const stoppedAgents = this.liveStages().filter((stage) => stage.condition === "stopped" || stage.condition === "crashed");
		if (stoppedAgents.length === 0) return this.resume();
		for (const stage of stoppedAgents) {
			const refusal = await this.restartAgent(stage.role);
			if (refusal) return refusal;
		}
		return undefined;
	}

	/** The planner's turn settled; if it answered the implementer that asked, pass the answer on and ask the next question. */
	handlePlannerReply(reply: string): void {
		if (this.isWaitingForFixSteps) {
			this.handleFixSteps(reply);
			return;
		}
		const asker = this.askingRole;
		if (!asker) return;
		const plannerAnswer = readPlannerAnswer(reply);
		if (plannerAnswer.kind === "none") return;
		if (plannerAnswer.kind === "needs-user") {
			this.seat.callUser(`The ${SUBAGENT_NAMES[asker]} is waiting: answer the planner's question, and it passes your answer on`);
			return;
		}
		this.askingRole = undefined;
		this.promptAgent(asker, plannerAnswerPrompt(plannerAnswer.answer, asker === "designer"));
		this.askNextQuestion();
	}

	/** The planner's turn was aborted while an implementer waited on it. */
	handlePlannerAborted(): void {
		if (this.isWaitingForFixSteps) {
			this.seat.notify("The fix round waits for the planner's fix steps: ask the planner to write them", "warning");
			return;
		}
		const asker = this.askingRole;
		if (!asker) return;
		const name = SUBAGENT_NAMES[asker];
		this.seat.notify(`The ${name} still waits for the planner's answer: reply to the planner, or type into the ${name}'s herdr pane`, "warning");
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

	/** A changed contract cannot race its implementers: stop writers, then redesign the updated plan. */
	async tellImplementersAboutPlanChange(): Promise<ActionRefusal> {
		return this.startChangeRound();
	}

	/** The plan changed during a review: the review finishes, then its findings go into a change round. */
	applyPlanChangeAfterReview(): ActionRefusal {
		const state = this.seat.state();
		if (state.phase !== "review" && state.phase !== "re-review") return "No review is running";
		this.seat.enterPhase(withPlanRevision({ ...state, planChangeAfterReview: true }));
		return undefined;
	}

	/**
	 * The implementer applies the changed plan now, then every reviewer reviews again: from a running review
	 * (which is stopped), after a failed re-review, or from work waiting to ship or for its PR.
	 */
	async startChangeRound(): Promise<ActionRefusal> {
		const state = this.seat.state();
		if (!isFeatureState(state)) return "No work to change";
		if (this.cleanupController) return "Contract cleanup is running; retry the plan change when it finishes";
		const plan = this.seat.readPlan(state.planPath);
		if (plan === undefined) return `Cannot read the plan ${state.planPath}`;
		const generation = await this.stopProcesses();
		if (generation !== this.generation) return "The run was stopped";
		const work = featureWorkOf(state);
		const changeState: DelegatedState = { phase: "implement", ...work };
		const next: DelegatedState = withPlanRevision({ ...changeState, implementers: this.assignCrew(changeState, work.implementers ?? [], plan) });
		this.beginDesign(next, plan);
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
		if (state.phase !== "review-failed" && state.phase !== "cleanup-failed") return "Another fix round works after failed review or cleanup";
		const findings = state.phase === "cleanup-failed" ? state.failure : state.findings;
		const next: FixState = { phase: "fix", ...featureWorkOf(state), findings };
		this.seat.enterPhase(next);
		this.requestFixSteps(next, findings);
		return undefined;
	}

	/** After a failed re-review: you accept the work as it is, and it goes on to shipping or its PR. */
	acceptAnyway(): ActionRefusal {
		const state = this.seat.state();
		if (state.phase !== "review-failed") return "Accepting works after a failed re-review";
		if (state.designerSession) return "Contract builds require every reviewer to pass before cleanup and shipping; fix or re-review instead";
		this.seat.finish(releaseStateOf(state), "you accepted the work despite the re-review's findings");
		return undefined;
	}

	/** Ends every subagent; steps of this run still waiting on I/O drop out. */
	stop(): void {
		void this.stopProcesses();
	}

	/** stop(), resolving once every subagent ended (and its herdr pane closed). */
	async stopAndWait(): Promise<void> {
		await this.stopProcesses();
		await this.cleanupTask;
	}


	private async stopProcesses(cancelCleanup = true): Promise<number> {
		if (cancelCleanup) this.cleanupController?.abort();
		this.implementationBriefFor = undefined;
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

	/** Reviewers route freely (the expert tier); an implementer gets a cheap model unless its stream is marked. */
	private maxTierOf(seat: StageSeat, state: FeatureWork): DifficultyTier | undefined {
		if (seat.reviewer || seat.role === "designer") return undefined;
		const implementer = state.implementers?.find((candidate) => candidate.role === seat.role);
		const plan = this.seat.readPlan(state.planPath);
		const streams = plan === undefined ? [] : capWorkStreams(parseWorkStreams(plan));
		return implementerMaxTier(implementer ? streamOf(streams, implementer.stream) : undefined);
	}

	/**
	 * The seat's process, launched when it has none. An idle process whose tier ceiling no longer fits its stream
	 * (the plan marked or unmarked it) is replaced on the same session; a working one finishes its turn first.
	 */
	private ensureProcess(seat: StageSeat, state: FeatureWork): Subagent | undefined {
		const maxTier = this.maxTierOf(seat, state);
		const running = this.processes.get(seat.role);
		if (running?.isRunning && (running.maxTier === maxTier || running.isWorking)) return running;
		if (running?.isRunning) {
			this.processes.delete(seat.role);
			void running.stop();
		}
		const sessionPath = sessionOfSeat(state, seat);
		if (!sessionPath) return undefined;
		const name = SUBAGENT_NAMES[seat.role];
		const subagent: Subagent = this.launchSubagent({
			name,
			agentName: seat.role,
			cwd: this.seat.cwd(),
			sessionPath,
			dialogs: this.seat.dialogs,
			isProjectTrusted: this.seat.isProjectTrusted(),
			...(maxTier && { maxTier }),
			onSettled: (lastAnswer, isAborted) => {
				if (this.processes.get(seat.role) === subagent) this.handleSubagentSettled(seat.role, lastAnswer, isAborted);
			},
			onExit: (reason) => {
				if (this.processes.get(seat.role) !== subagent) return;
				this.handleSubagentCrash(seat.role, reason);
			},
			onWaitingForUser: () => {
				if (this.processes.get(seat.role) === subagent) this.seat.callUser(`The ${name} waits for you in its herdr pane (Implementers or Reviewers tab)`);
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
		this.seat.notify(`/build: the ${SUBAGENT_NAMES[role]} stopped (${reason}). /build implement restarts it.`, "error");
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

	/** The reviewers asked for fixes: the planner checks the findings and writes the steps the implementers follow. */
	private requestFixSteps(state: FixState, findings: string): void {
		const crew = (state.implementers ?? []).map((seat) => ({ implementerName: SUBAGENT_NAMES[seat.role], streamName: seat.stream }));
		this.seat.notify("The reviewers asked for fixes; the planner checks the findings and writes the fix steps", "info");
		this.seat.askPlanner(fixStepsPrompt(findings, crew));
	}

	/** The planner's reply while the fix round waits: once it has the steps, each implementer gets its part. */
	private handleFixSteps(reply: string): void {
		const plannerAnswer = readPlannerAnswer(reply);
		if (plannerAnswer.kind === "none") return;
		if (plannerAnswer.kind === "needs-user") {
			this.seat.callUser("The fix round waits for you: answer the planner's question, then it writes the fix steps");
			return;
		}
		const state = this.seat.state();
		if (state.phase !== "fix" || state.findings === undefined) return;
		const next: FixState = { ...state, fixSteps: plannerAnswer.answer };
		this.seat.enterPhase(next);
		this.beginStage(next, this.fixPromptFor(next, state.findings, plannerAnswer.answer));
	}

	private fixPromptFor(state: FixState, findings: string, fixSteps: string): (seat: StageSeat) => string {
		const plan = this.seat.readPlan(state.planPath);
		const assignments = plan === undefined ? new Map<SubagentRole, StreamAssignment | undefined>() : streamAssignments(state.implementers ?? [], plan);
		return (seat) => fixPrompt(findings, fixStepsFor(fixSteps, SUBAGENT_NAMES[seat.role]), assignments.get(seat.role));
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
		this.seat.askPlanner(plannerQuestionPrompt(question.implementerAnswer, isOneOfSeveral || question.role === "designer" ? name : undefined));
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
		if (!live || live.condition === "answered" || !isDelegatedState(state) || state.phase !== live.stage) return;
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
				this.seat.notify(`/build paused: ${step.reason}. /build implement restarts it; inside herdr you can also type into its pane.`, "warning");
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
				this.seat.notify(`/build paused: ${step.reason}. /build implement restarts it; inside herdr you can also type into its pane.`, "warning");
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
		let newCheckFailures = "";
		if ((previous.phase === "implement" || previous.phase === "fix") && (next.phase === "review" || next.phase === "re-review")) {
			const checkResult = await this.checkImplementersWork(previous, generation);
			if (checkResult.kind !== "proceed") return;
			newCheckFailures = checkResult.newFailures;
		}
		switch (next.phase) {
			case "review":
				await this.beginReview(next, newCheckFailures, generation);
				return;
			case "design": {
				const plan = this.seat.readPlan(next.planPath);
				if (plan === undefined) {
					this.seat.notify(`/build paused: cannot read the plan ${next.planPath}`, "error");
					return;
				}
				const stoppedGeneration = await this.stopProcesses();
				if (stoppedGeneration !== this.generation) return;
				this.beginDesign(next, plan);
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
				const briefFor = this.implementationBriefFor;
				this.implementationBriefFor = undefined;
				this.beginStage(changeState, (seat) => briefFor?.(assignments.get(seat.role)) ?? implementationBrief(next.planPath, plan, [], next.issue, next.planIssue, assignments.get(seat.role), next.baseCommit));
				return;
			}
			case "fix": {
				const fixState: FixState = { ...next, findings: next.findings ?? stageAnswer };
				this.seat.enterPhase(fixState);
				this.requestFixSteps(fixState, fixState.findings ?? stageAnswer);
				return;
			}
			case "re-review":
				this.seat.enterPhase(next);
				this.beginStage(next, () => reReviewPrompt(next.baseCommit, this.latestFixReplies(), newCheckFailures));
				return;
			case "review-failed":
				await this.finishRun(previous, next, "the re-review still has findings, and the fix round is used up");
				return;
			case "cleanup":
				this.cleanupTask = this.cleanAndVerify(next);
				await this.cleanupTask;
				return;
		}
	}

	private async checkImplementersWork(
		state: Extract<DelegatedState, { phase: "implement" | "fix" }>,
		generation: number,
	): Promise<{ kind: "fixing" } | { kind: "stale" } | { kind: "proceed"; newFailures: string }> {
		const signal = new AbortController().signal;
		let newFailures = "";
		try {
			const checkRun = await this.seat.runChecks(signal);
			if (generation !== this.generation) return { kind: "stale" };
			if (checkRun.kind === "untrusted") {
				this.seat.notify("Checks after the implementers skipped: the project is not trusted", "info");
				return { kind: "proceed", newFailures };
			}
			if (checkRun.kind === "no-checks") return { kind: "proceed", newFailures };
			const changedFiles = await this.seat.changedFiles(state.baseCommit, signal);
			if (generation !== this.generation) return { kind: "stale" };
			const failures = findNewCheckFailures(state.checkBaseline ?? [], checkRun.results, changedFiles);
			newFailures = describeNewCheckFailures(failures);
			if (failures.length === 0) return { kind: "proceed", newFailures };
			const checkNames = failures.map((failure) => failure.name).join(", ");
			if (state.checksFixRequested) {
				this.seat.notify(`Checks still fail after the fix round (${checkNames}); the reviewers see them`, "warning");
				return { kind: "proceed", newFailures };
			}
			const plan = this.seat.readPlan(state.planPath);
			const assignments = streamAssignments(state.implementers ?? [], plan ?? "");
			const fixState = { ...state, checksFixRequested: true };
			this.seat.enterPhase(fixState);
			this.seat.notify(`New check failures since the run began (${checkNames}); the implementers fix them before the review`, "info");
			this.beginStage(fixState, (seat) => checkFailuresFixPrompt(newFailures, assignments.get(seat.role)));
			return { kind: "fixing" };
		} catch (error) {
			if (generation !== this.generation) return { kind: "stale" };
			this.seat.notify(`Could not run the checks after the implementers: ${(error as Error).message}; the review starts without them`, "warning");
			return { kind: "proceed", newFailures: "" };
		}
	}

	private async beginReview(state: Extract<DelegatedState, { phase: "review" }>, newCheckFailures = "", expectedGeneration = this.generation): Promise<void> {
		const ruleFiles = await this.seat.ruleFiles();
		if (expectedGeneration !== this.generation) return;
		const lineup = this.seat.reviewerLineup();
		if (!lineup.ok) {
			// Sessions of an earlier review round must not be resumed as if this review had started.
			const { reviewerSessions: _earlierReviewers, ...pausedReview } = state;
			this.seat.enterPhase(pausedReview);
			this.seat.callUser(`/build paused before the review: ${lineup.error}. /build implement starts the review once a reviewer model is available.`);
			return;
		}
		const reviewerSessions: Partial<Record<ReviewerVendor, string>> = {};
		for (const vendor of lineup.vendors) {
			reviewerSessions[vendor] = this.createSession(state, { role: reviewerRole(vendor), reviewer: vendor });
		}
		const reviewState: DelegatedState = { ...state, reviewerSessions };
		this.seat.enterPhase(reviewState);
		const prompt = reviewPrompt(state.planPath, state.baseCommit, ruleFiles, state.issue, state.planIssue, newCheckFailures);
		this.beginStage(reviewState, () => prompt);
	}

	retryCleanup(): ActionRefusal {
		const state = this.seat.state();
		if (state.phase !== "cleanup" && state.phase !== "cleanup-failed") return "No contract cleanup to retry";
		if (this.cleanupController) return "Contract cleanup is already running";
		this.cleanupTask = this.cleanAndVerify(state);
		return undefined;
	}

	private async cleanAndVerify(work: FeatureWork): Promise<void> {
		const controller = new AbortController();
		this.cleanupController = controller;
		// Enter the gate before awaiting pane shutdown: shipping remains disabled throughout.
		const next: FeatureState = { phase: "cleanup", ...featureWorkOf(work) };
		this.seat.enterPhase(next);
		const generation = await this.stopProcesses(false);
		try {
			if (generation !== this.generation || controller.signal.aborted) return;
			const failure = await this.seat.finalizeContracts(work, controller.signal);
			if (generation !== this.generation || controller.signal.aborted) return;
			if (failure) {
				this.seat.enterPhase({ phase: "cleanup-failed", ...featureWorkOf(work), failure });
				this.seat.callUser(`Contract cleanup blocked shipping: ${failure}. /build implement retries; /build implement retries, sends it to a fix round or reviews again.`);
				return;
			}
			await this.finishRun(next, releaseStateOf(work), "every reviewer passed; temporary contracts removed and checks passed");
		} catch (error) {
			if (generation !== this.generation || controller.signal.aborted) return;
			const failure = error instanceof Error ? error.message : String(error);
			this.seat.enterPhase({ phase: "cleanup-failed", ...featureWorkOf(work), failure });
			this.seat.callUser(`Contract cleanup failed: ${failure}. /build implement retries.`);
		} finally {
			if (this.cleanupController === controller) this.cleanupController = undefined;
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
