/**
 * Starting the implementer once the plan is saved: you choose to post the plan as a GitHub issue and start, start
 * without one, or keep planning. Asked once per save; /build implement asks again.
 */
import type { BuildOrchestrator } from "./build-orchestrator.ts";
import { runBuildChecks } from "./build-checks.ts";
import { currentReviewerLineup } from "./reviewer-lineup.ts";
import { useAutoModel } from "./planner-model.ts";
import { createPlanIssue, droppedLinesNotice, isGithubRepo, issueBranchName, planTitle, shortBranchSlug } from "./github-issue.ts";
import type { PlannerSession } from "./planner-session.ts";
import { findDiffBase, findPlanRepoRoots, findRuleFiles } from "./repo-files.ts";
import { createRunWorktree, hasUncommittedChanges } from "./run-worktree.ts";
import type { CheckResult } from "../quality-gate/check-baseline.ts";
import { implementationBrief } from "./workflow-prompts.ts";
import { IDLE_WORKFLOW, type RunWorktree, type TrackedIssue, type WorkflowState } from "./workflow-state.ts";

const START_CHOICES = {
	withIssue: "Create a GitHub issue from the plan and start the implementer",
	withoutIssue: "Start implementing without an issue",
	start: "Start implementing",
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
			if (!workflow.startedFromChat) await this.startImplementation();
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
				if (workflow.startedFromChat) {
					this.session.enterPhase(IDLE_WORKFLOW);
					this.session.notify("Not started. Keep going in the chat; saving the plan again asks again.", "info");
					return;
				}
				this.session.enterPhase({ phase: "plan", task: workflow.task, ...(workflow.issue && { issue: workflow.issue }) });
				this.session.notify("Back to planning. Tell the planner what to change; saving the plan asks again.", "info");
				return;
			default:
				if (workflow.startedFromChat) {
					this.session.enterPhase(IDLE_WORKFLOW);
					this.session.notify("Not started. Keep going in the chat; saving the plan again asks again.", "info");
					return;
				}
				this.session.notify("Plan kept. /build implement asks again, or keep talking to the planner.", "info");
		}
	}

	private async startWithPlanIssue(): Promise<void> {
		const workflow = this.session.workflow;
		if (workflow.phase !== "awaiting-implementation") return;
		const plan = this.session.readPlan(workflow.planPath);
		if (plan === undefined) return;
		const repoRoots = await findPlanRepoRoots(this.session.runInSessionDir, this.session.run);
		const postedPlanIssue = await createPlanIssue(this.session.run, plan, repoRoots);
		if (!postedPlanIssue.ok) {
			this.session.notify(`${postedPlanIssue.error}. /build implement asks again.`, "error");
			return;
		}
		const postedIssue = postedPlanIssue.value.issue;
		this.session.notify(`Created issue #${postedIssue.number}: ${postedIssue.url}`, "info");
		const droppedLinesWarning = droppedLinesNotice(postedPlanIssue.value.droppedLines, `issue #${postedIssue.number}`);
		if (droppedLinesWarning) this.session.notify(droppedLinesWarning, "warning");
		await this.startImplementation(postedIssue);
	}

	private async startImplementation(planIssue?: TrackedIssue): Promise<void> {
		const awaiting = this.session.workflow;
		if (awaiting.phase !== "awaiting-implementation") return;
		const lineup = currentReviewerLineup(this.session.context);
		if (!lineup.ok) {
			this.refuseStart(awaiting.startedFromChat, lineup.error);
			return;
		}
		if (awaiting.startedFromChat && !(await useAutoModel(this.session.pi, this.session.context))) {
			this.returnChatToIdle(awaiting);
			return;
		}
		const { planPath, issue } = awaiting;
		const plan = this.session.readPlan(planPath);
		if (plan === undefined) {
			this.refuseStart(awaiting.startedFromChat, `Failed to start the build: the plan ${planPath} cannot be read`);
			return;
		}
		const worktree = issue?.worktree ?? (await this.createBuildWorktree(plan, planIssue));
		const workDir = worktree?.path ?? this.session.context.cwd;
		const ruleFiles = await findRuleFiles(this.session.run, workDir);
		const baseCommit = await findDiffBase(this.session.run);
		this.session.notify("Recording the baseline checks before the designer starts…", "info");
		let checkBaseline: CheckResult[] | undefined;
		try {
			const baseline = await runBuildChecks(
				this.session.pi,
				workDir,
				this.session.context.isProjectTrusted(),
				new AbortController().signal,
				(message) => this.session.notify(message, "info"),
			);
			if (baseline.kind === "ran") checkBaseline = baseline.results;
		} catch (error) {
			this.session.notify(`Could not record the baseline checks: ${(error as Error).message}; every failing check will count as new`, "warning");
		}
		// The awaits above let you stop the run or save another plan meanwhile; then this start is stale.
		if (this.session.workflow !== awaiting) {
			if (worktree && worktree !== issue?.worktree) await this.removeUnusedWorktree(worktree);
			return;
		}
		const work = { planPath, baseCommit, ...(checkBaseline && { checkBaseline }), ...(issue && { issue }), ...(planIssue && { planIssue }), ...(worktree && { worktree }) };
		this.orchestrator.startImplementation(work, plan, (assignment) => implementationBrief(planPath, plan, ruleFiles, issue, planIssue, assignment, baseCommit));
		const started = implementerCount(this.session.workflow);
		const who = `Expert designer started; ${started} implementer${started === 1 ? "" : "s"} will follow after contracts and tests are ready`;
		const where = worktree ? ` in worktree ${worktree.path} (herdr workspace ${worktree.workspaceId})` : "";
		const statusHint = worktree ? "the run's workspace shows the agents" : "/build status shows the phase";
		this.session.notify(`${who}${where}; ${statusHint}. You can keep talking to the planner.`, "info");
	}

	/**
	 * A start offered in a normal chat must not leave the chat in "awaiting-implementation", where file edits are
	 * blocked; a /build run keeps its agreed plan so /build implement can ask again.
	 */
	private refuseStart(isStartedFromChat: boolean | undefined, error: string): void {
		if (!isStartedFromChat) {
			this.session.notify(`${error}. /build implement asks again.`, "error");
			return;
		}
		this.session.enterPhase(IDLE_WORKFLOW);
		this.session.notify(`${error}. Not started; saving the plan again asks again.`, "error");
	}

	private returnChatToIdle(awaiting: WorkflowState): void {
		if (this.session.workflow === awaiting) this.session.enterPhase(IDLE_WORKFLOW);
	}

	private async removeUnusedWorktree(worktree: RunWorktree): Promise<void> {
		try {
			await this.session.herdr?.removeWorktree(worktree.workspaceId);
		} catch (error) {
			this.session.notify(`Could not remove the unused worktree at ${worktree.path}: ${(error as Error).message}`, "warning");
		}
	}

	/** Inside herdr a /build works in a worktree of HEAD; undefined (working in place) outside herdr or when git refuses. */
	private async createBuildWorktree(plan: string, planIssue?: TrackedIssue): Promise<RunWorktree | undefined> {
		const herdr = this.session.herdr;
		if (!herdr) return undefined;
		const run = this.session.runInSessionDir;
		// The plan's issue names the work, so the worktree carries the name the shipped branch will have.
		const name = planIssue ? issueBranchName(planIssue.number) : `build-${shortBranchSlug(planTitle(plan)) || "run"}`;
		const created = await createRunWorktree(run, herdr, { name, startPoint: "HEAD" });
		if (!created.ok) {
			this.session.notify(`${created.error}. The run works in your checkout instead.`, "warning");
			return undefined;
		}
		if (await hasUncommittedChanges(run)) {
			this.session.notify("Your checkout has uncommitted changes; the worktree starts from HEAD without them", "warning");
		}
		return created.value;
	}
}

function implementerCount(state: WorkflowState): number {
	return state.phase === "design" || state.phase === "implement" ? (state.implementers?.length ?? 1) : 1;
}
