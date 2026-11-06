/**
 * Saving the plan again during a run is a plan change. The run keeps one plan file, so the new version replaces
 * it, and what happens next depends on the phase (planChangeReaction in workflow-state.ts).
 */
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import type { BuildOrchestrator } from "./build-orchestrator.ts";
import { planTitle, updatePlanIssue } from "./github-issue.ts";
import type { PlannerSession } from "./planner-session.ts";
import type { StartDialog } from "./start-dialog.ts";
import { findLastRunPlan, isFeatureState, planChangeReaction, type WorkflowState } from "./workflow-state.ts";

const REVIEW_CHANGE_CHOICES = {
	afterReview: "Let the review finish, then the implementer applies the change together with its findings",
	now: "Stop the review; the implementer applies the change now",
} as const;

/** The plan file of the run, once there is an agreed plan. */
function runPlanPath(state: WorkflowState): string | undefined {
	return state.phase === "awaiting-implementation" || isFeatureState(state) ? state.planPath : undefined;
}

export class PlanChanges {
	private readonly session: PlannerSession;
	private readonly orchestrator: BuildOrchestrator;
	private readonly startDialog: StartDialog;
	/** A plan saved in the planner's current turn; handled once the turn settles, when the planner has finished. */
	private savedPlanPath: string | undefined;

	constructor(session: PlannerSession, orchestrator: BuildOrchestrator, startDialog: StartDialog) {
		this.session = session;
		this.orchestrator = orchestrator;
		this.startDialog = startDialog;
	}

	/**
	 * Called with the file save_agreed_plan just wrote. During a run the new version replaces the run's plan file,
	 * so every agent keeps reading one path; returns the path the plan now lives at.
	 */
	keepOnePlanFile(savedPath: string): string {
		const planPath = runPlanPath(this.session.workflow);
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
	 * Opens the run's plan in an editor (Alt+A, p). Saving a changed plan is a plan change like the planner
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
				this.report(await this.orchestrator.startChangeRound(), "Plan changed: the implementer applies it, then both reviewers review again");
				await this.updatePlanIssue();
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

	/** No run is on: a plan saved after a /build run in this session may start a new run. */
	private async offerNewRun(planPath: string): Promise<void> {
		if (!this.session.hasUI || !findLastRunPlan(this.session.context.sessionManager.getBranch())) return;
		const plan = this.session.readPlan(planPath);
		if (plan === undefined) return;
		const isStarting = await this.session.context.ui.confirm("Plan saved", `${planPath}\n\nStart a new /build run from this plan?`);
		if (!isStarting || this.session.workflow.phase !== "idle") return;
		this.session.enterPhase({ phase: "awaiting-implementation", task: planTitle(plan), planPath });
		await this.startDialog.ask();
	}

	/** Keeps the plan issue in step with the plan file, since the agents read the plan from it. */
	private async updatePlanIssue(): Promise<void> {
		const workflow = this.session.workflow;
		if (!isFeatureState(workflow) || !workflow.planIssue) return;
		const plan = this.session.readPlan(workflow.planPath);
		if (plan === undefined) return;
		const updated = await updatePlanIssue(this.session.run, workflow.planIssue, plan, workflow.planRevision ?? 1);
		if (!updated.ok) this.session.notify(`${updated.error}. The agents got the change; the issue still shows the old plan.`, "warning");
	}

	private report(refusal: string | undefined, doneMessage: string): void {
		if (refusal) this.session.notify(`Plan change not applied: ${refusal}`, "warning");
		else this.session.notify(doneMessage, "info");
	}
}
