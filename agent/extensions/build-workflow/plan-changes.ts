/**
 * Saving the plan again during a run is a plan change. The run keeps one plan file, so the new version replaces
 * it, and what happens next depends on the phase (planChangeReaction in workflow-state.ts). While a finished run
 * waits for you, you first say whether the plan changes its work or is a new task with its own plan file.
 */
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import type { BuildOrchestrator } from "./build-orchestrator.ts";
import { droppedLinesNotice, planTitle, updatePlanIssue } from "./github-issue.ts";
import type { PlannerSession } from "./planner-session.ts";
import type { StartDialog } from "./start-dialog.ts";
import { findPlanRepoRoots } from "./repo-files.ts";
import { IDLE_WORKFLOW, isFeatureState, planChangeReaction, type WorkflowState } from "./workflow-state.ts";

const REVIEW_CHANGE_CHOICES = {
	afterReview: "Let the review finish, then the implementer applies the change together with its findings",
	now: "Stop the review; the implementer applies the change now",
} as const;

/** Asked when a plan is saved while a finished run waits for you (ship, PR, or your call after a failure). */
export const FINISHED_RUN_PLAN_CHOICES = {
	changeRun: "Change the finished run's work",
	newTask: "New task",
} as const;

/** A new task starts once the finished run is out of the way. */
export const END_FINISHED_RUN_CHOICES = {
	ship: "Ship the finished run, then start the new task",
	stop: "Stop the finished run (its changes stay uncommitted), then start the new task",
	keep: "Keep the finished run; start the new task later",
} as const;

/** How a finished run is ended before a new task starts; index.ts wires them to shipping and /build stop. */
export interface FinishedRunExits {
	/** Shipping after the user confirms (Shipping.confirmAndShip); resolves with its outcome once any run end finished. */
	ship(): Promise<string>;
	/** Ends the run, its changes left uncommitted; resolves once the run ended and the planner's model is restored. */
	stop(): Promise<void>;
}

/** The plan file of the run, once there is an agreed plan. */
function runPlanPath(state: WorkflowState): string | undefined {
	return state.phase === "awaiting-implementation" || isFeatureState(state) ? state.planPath : undefined;
}

export class PlanChanges {
	private readonly session: PlannerSession;
	private readonly orchestrator: BuildOrchestrator;
	private readonly startDialog: StartDialog;
	private readonly finishedRunExits: FinishedRunExits;
	/** A plan saved in the planner's current turn; handled once the turn settles, when the planner has finished. */
	private savedPlanPath: string | undefined;

	constructor(session: PlannerSession, orchestrator: BuildOrchestrator, startDialog: StartDialog, finishedRunExits: FinishedRunExits) {
		this.session = session;
		this.orchestrator = orchestrator;
		this.startDialog = startDialog;
		this.finishedRunExits = finishedRunExits;
	}

	/**
	 * Called with the file save_agreed_plan just wrote. During a run the new version replaces the run's plan file,
	 * so every agent keeps reading one path; returns the path the plan now lives at.
	 */
	keepOnePlanFile(savedPath: string): string {
		const workflow = this.session.workflow;
		if (planChangeReaction(workflow.phase) === "ask-change-or-new-task") return savedPath;
		const planPath = runPlanPath(workflow);
		if (!planPath || planPath === savedPath) return savedPath;
		writeFileSync(planPath, readFileSync(savedPath, "utf8"));
		unlinkSync(savedPath);
		return planPath;
	}

	/** Remembers the save; the reaction waits until the planner's turn settles. */
	notePlanSaved(planPath: string): void {
		this.savedPlanPath = planPath;
	}

	/**
	 * Opens the run's plan in an editor (/build plan). Saving a changed plan is a plan change like the planner
	 * saving it; while the planner works, it is handled when its turn settles.
	 */
	async editPlanByHand(isPlannerIdle: boolean): Promise<void> {
		const planPath = runPlanPath(this.session.workflow);
		if (!planPath || !this.session.hasUI) return;
		const plan = this.session.readPlan(planPath);
		if (plan === undefined) {
			this.session.notify(`Failed to open the plan: ${planPath} cannot be read`, "error");
			return;
		}
		const edited = await this.session.context.ui.editor(`Plan: ${planPath}`, plan);
		if (edited === undefined || edited === plan) return;
		if (runPlanPath(this.session.workflow) !== planPath) {
			this.session.notify("The run moved on while you edited; the plan was not saved", "warning");
			return;
		}
		writeFileSync(planPath, edited);
		this.notePlanSaved(planPath);
		if (isPlannerIdle) await this.handleSavedPlan();
	}

	get hasPendingStart(): boolean {
		return this.savedPlanPath !== undefined;
	}

	async handleSavedPlan(): Promise<void> {
		const planPath = this.savedPlanPath;
		if (!planPath) return;
		this.savedPlanPath = undefined;
		const workflow = this.session.workflow;
		switch (planChangeReaction(workflow.phase)) {
			case "ask-to-start":
				if (workflow.phase === "plan" || workflow.phase === "awaiting-implementation") {
					this.session.enterPhase({ phase: "awaiting-implementation", task: workflow.task, planPath, ...(workflow.issue && { issue: workflow.issue }) });
				}
				await this.startDialog.ask();
				return;
			case "tell-implementer":
				this.report(await this.orchestrator.tellImplementersAboutPlanChange(), "The implementers got the changed plan");
				await this.updatePlanIssue();
				return;
			case "ask-about-review":
				await this.askAboutRunningReview();
				return;
			case "change-round":
				this.report(await this.orchestrator.startChangeRound(), "Plan changed: the implementer applies it, then every reviewer reviews again");
				await this.updatePlanIssue();
				return;
			case "ask-change-or-new-task":
				await this.askChangeOrNewTask(planPath);
				return;
			case "offer-new-run":
				await this.offerNewRun(planPath);
		}
	}

	private async askAboutRunningReview(): Promise<void> {
		const choice = this.session.hasUI
			? await this.session.context.ui.select("The plan changed while the reviewers check the old one", Object.values(REVIEW_CHANGE_CHOICES))
			: REVIEW_CHANGE_CHOICES.afterReview;
		if (choice === REVIEW_CHANGE_CHOICES.now) {
			this.report(await this.orchestrator.startChangeRound(), "Review stopped: the implementer applies the changed plan");
		} else {
			this.report(this.orchestrator.applyPlanChangeAfterReview(), "The implementer applies the changed plan after the review");
		}
		await this.updatePlanIssue();
	}

	private async askChangeOrNewTask(savedPlanPath: string): Promise<void> {
		const finishedRun = this.session.workflow;
		if (savedPlanPath === runPlanPath(finishedRun)) {
			await this.changeFinishedRun(savedPlanPath);
			return;
		}
		if (!this.session.hasUI) {
			this.session.notify(`Plan saved to ${savedPlanPath}; the finished run is unchanged. Save it again in an interactive session to choose.`, "info");
			return;
		}

		const choice = await this.session.context.ui.select(
			"A plan was saved while the finished /build run waits for you",
			Object.values(FINISHED_RUN_PLAN_CHOICES),
		);
		if (this.session.workflow !== finishedRun) {
			this.session.notify("The run moved on while you chose; the plan was not applied", "warning");
			return;
		}
		switch (choice) {
			case FINISHED_RUN_PLAN_CHOICES.changeRun:
				await this.changeFinishedRun(savedPlanPath);
				return;
			case FINISHED_RUN_PLAN_CHOICES.newTask:
				await this.askToEndFinishedRun(savedPlanPath);
				return;
			default:
				this.session.notify(`Plan saved to ${savedPlanPath}; the finished run is unchanged. Save the plan again to choose.`, "info");
		}
	}

	private async changeFinishedRun(savedPlanPath: string): Promise<void> {
		const runPlan = runPlanPath(this.session.workflow);
		if (!runPlan) throw new Error("Failed to apply the plan change: the finished /build run has no plan file");
		if (savedPlanPath !== runPlan) {
			writeFileSync(runPlan, readFileSync(savedPlanPath, "utf8"));
			unlinkSync(savedPlanPath);
		}
		this.report(await this.orchestrator.startChangeRound(), "Plan changed: the implementer applies it, then every reviewer reviews again");
		await this.updatePlanIssue();
	}

	private async askToEndFinishedRun(newPlanPath: string): Promise<void> {
		const finishedRun = this.session.workflow;
		const choices = [
			...(finishedRun.phase === "awaiting-ship" ? [END_FINISHED_RUN_CHOICES.ship] : []),
			END_FINISHED_RUN_CHOICES.stop,
			END_FINISHED_RUN_CHOICES.keep,
		];
		const choice = await this.session.context.ui.select("Start the new task: ship or stop the finished run first", choices);
		if (this.session.workflow !== finishedRun) {
			this.session.notify("The run moved on while you chose; the new task was not started", "warning");
			return;
		}

		if (choice === END_FINISHED_RUN_CHOICES.ship && finishedRun.phase === "awaiting-ship") {
			const outcome = await this.finishedRunExits.ship();
			if (this.session.workflow.phase === "idle") {
				await this.offerNewRun(newPlanPath);
				return;
			}
			this.session.notify(`New task not started: ${outcome}. Its plan stays at ${newPlanPath}; /build ship or /build stop, then save the plan again.`, "warning");
			return;
		}
		if (choice === END_FINISHED_RUN_CHOICES.stop) {
			await this.finishedRunExits.stop();
			if (this.session.workflow.phase === "idle") {
				await this.offerNewRun(newPlanPath);
				return;
			}
			this.session.notify(`New task not started: the finished run is still open. Its plan stays at ${newPlanPath}; /build ship or /build stop, then save the plan again.`, "warning");
			return;
		}

		this.session.notify(`The new plan stays at ${newPlanPath}; the finished run waits. /build ship or /build stop, then save the plan again to start it.`, "info");
	}

	/** No run is on: a plan saved in a normal chat offers to start a build on it. */
	private async offerNewRun(planPath: string): Promise<void> {
		if (!this.session.hasUI || this.session.workflow.phase !== "idle") return;
		const plan = this.session.readPlan(planPath);
		if (plan === undefined) return;
		this.session.enterPhase({ phase: "awaiting-implementation", task: planTitle(plan), planPath, startedFromChat: true });
		await this.startDialog.ask();
	}

	/** Keeps the plan issue's public summary in step with the local plan file the agents read. */
	private async updatePlanIssue(): Promise<void> {
		const workflow = this.session.workflow;
		if (!isFeatureState(workflow) || !workflow.planIssue) return;
		const plan = this.session.readPlan(workflow.planPath);
		if (plan === undefined) return;
		const repoRoots = await findPlanRepoRoots(this.session.runInSessionDir, this.session.run);
		const updated = await updatePlanIssue(this.session.run, workflow.planIssue, plan, repoRoots);
		if (!updated.ok) {
			this.session.notify(`${updated.error}. The agents got the change; the issue still shows the old plan.`, "warning");
			return;
		}
		const droppedLinesWarning = droppedLinesNotice(updated.value.droppedLines, `issue #${workflow.planIssue.number}`);
		if (droppedLinesWarning) this.session.notify(droppedLinesWarning, "warning");
	}

	private report(refusal: string | undefined, doneMessage: string): void {
		if (refusal) this.session.notify(`Plan change not applied: ${refusal}`, "warning");
		else this.session.notify(doneMessage, "info");
	}
}
