/**
 * Starting the implementer once the plan is saved: you choose to post the plan as a GitHub issue and start, start
 * without one, or keep planning. Asked once per save; /build implement asks again.
 */
import type { BuildOrchestrator } from "./build-orchestrator.ts";
import { createPlanIssue, isGithubRepo } from "./github-issue.ts";
import type { PlannerSession } from "./planner-session.ts";
import { findHeadCommit, findRuleFiles } from "./repo-files.ts";
import { implementationBrief } from "./workflow-prompts.ts";
import type { TrackedIssue } from "./workflow-state.ts";

const START_CHOICES = {
	withIssue: "Create a GitHub issue from the plan and start the implementer",
	withoutIssue: "Start the implementer without an issue",
	start: "Start the implementer",
	keepPlanning: "Not yet, keep planning",
} as const;

type StartChoice = (typeof START_CHOICES)[keyof typeof START_CHOICES];

export class StartDialog {
	private readonly session: PlannerSession;
	private readonly orchestrator: BuildOrchestrator;
	private isAsking = false;

	constructor(session: PlannerSession, orchestrator: BuildOrchestrator) {
		this.session = session;
		this.orchestrator = orchestrator;
	}

	/** Asks how to start the agreed plan; without a UI it starts right away. */
	async ask(): Promise<void> {
		const workflow = this.session.workflow;
		if (workflow.phase !== "awaiting-implementation" || this.isAsking) return;
		if (!this.session.hasUI) {
			await this.startImplementation();
			return;
		}
		this.isAsking = true;
		try {
			const choice = await this.session.context.ui.select(
				`Plan saved: ${workflow.planPath}. Do you agree with it?`,
				await this.startChoices(workflow.issue !== undefined),
			);
			await this.applyChoice(choice);
		} finally {
			this.isAsking = false;
		}
	}

	/** /issue runs already have their issue; other runs offer to post the plan when the repo is on GitHub. */
	private async startChoices(isIssueRun: boolean): Promise<StartChoice[]> {
		if (isIssueRun) return [START_CHOICES.start, START_CHOICES.keepPlanning];
		if (!(await isGithubRepo(this.session.run))) return [START_CHOICES.start, START_CHOICES.keepPlanning];
		return [START_CHOICES.withIssue, START_CHOICES.withoutIssue, START_CHOICES.keepPlanning];
	}

	private async applyChoice(choice: string | undefined): Promise<void> {
		const workflow = this.session.workflow;
		if (workflow.phase !== "awaiting-implementation") return;
		switch (choice) {
			case START_CHOICES.start:
			case START_CHOICES.withoutIssue:
				await this.startImplementation();
				return;
			case START_CHOICES.withIssue:
				await this.startWithPlanIssue();
				return;
			case START_CHOICES.keepPlanning:
				this.session.enterPhase({ phase: "plan", task: workflow.task, ...(workflow.issue && { issue: workflow.issue }) });
				this.session.notify("Back to planning. Tell the planner what to change; saving the plan asks again.", "info");
				return;
			default:
				this.session.notify("Plan kept. /build implement asks again, or keep talking to the planner.", "info");
		}
	}

	private async startWithPlanIssue(): Promise<void> {
		const workflow = this.session.workflow;
		if (workflow.phase !== "awaiting-implementation") return;
		const plan = this.session.readPlan(workflow.planPath);
		if (plan === undefined) return;
		const planIssue = await createPlanIssue(this.session.run, plan);
		if (!planIssue.ok) {
			this.session.notify(`${planIssue.error}. /build implement asks again.`, "error");
			return;
		}
		this.session.notify(`Created issue #${planIssue.value.number}: ${planIssue.value.url}`, "info");
		await this.startImplementation(planIssue.value);
	}

	private async startImplementation(planIssue?: TrackedIssue): Promise<void> {
		const awaiting = this.session.workflow;
		if (awaiting.phase !== "awaiting-implementation") return;
		const { planPath, issue } = awaiting;
		const plan = this.session.readPlan(planPath);
		if (plan === undefined) return;
		const ruleFiles = await findRuleFiles(this.session.run, this.session.context.cwd);
		const baseCommit = await findHeadCommit(this.session.run);
		// The awaits above let you stop the run or save another plan meanwhile; then this start is stale.
		if (this.session.workflow !== awaiting) return;
		const brief = implementationBrief(planPath, plan, ruleFiles, issue, planIssue);
		this.orchestrator.startImplementation({ planPath, baseCommit, ...(issue && { issue }), ...(planIssue && { planIssue }) }, brief);
		this.session.notify("Implementer started as a subagent. Alt+A shows the agents; you can keep talking to the planner.", "info");
	}
}
