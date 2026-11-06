/**
 * /build: the expert plans with you in this session; once you agree, an implementer subagent (model picked by
 * difficulty) builds it and two expert reviewer subagents (Claude and OpenAI, in parallel) review it, with one
 * fix round and a re-review. You stay in this session the whole time.
 *
 * - /build <task>: the expert investigates and plans; nothing is edited until you agree and it saves the plan.
 * - Once the plan is saved you choose: post it as a GitHub issue and start, start without an issue, or keep
 *   planning (start-dialog.ts). With an issue, the implementer and the reviewers read the plan from it.
 * - The implementer and reviewers run as subagents (build-orchestrator.ts). The implementer's questions come to
 *   the planner here, which answers them or asks you.
 * - Ask the planner to change the plan at any time; it saves the plan again and the run follows (plan-changes.ts).
 * - A re-review that still finds problems asks you: one more fix round, accept the work, or review again.
 * - After a passing review you confirm shipping (shipping.ts): a new branch, one commit, a normal push.
 * - /build implement starts an agreed plan or resumes a run interrupted by a reload. /build status, /build stop.
 * - Alt+A or /agents: the agents overview, to follow, message, stop and restart every agent (agents-overview-panel.ts).
 * - /issue <url | #123>: the same workflow for a GitHub issue, ending in a draft PR (issue-workflow.ts).
 *
 * In the subagents' processes (SUBAGENT_ENV_VAR set) this extension only guards file edits for their phase.
 * Phase routes reach the auto model through its route pin (auto-model/route-pin.ts).
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { TaskKind } from "../auto-model/classify-difficulty.ts";
import { TASK_KIND_EVENT } from "../auto-model/route-pin.ts";
import { SAVE_PLAN_TOOL_NAME } from "../project-memory/agreed-plan-files.ts";
import { answerText } from "./agent-activity.ts";
import { registerDashboard } from "./dashboard.ts";
import { BuildOrchestrator } from "./build-orchestrator.ts";
import { ISSUE_USAGE, openPullRequest, promptForPullRequest, startIssueWorkflow } from "./issue-workflow.ts";
import { PlanChanges } from "./plan-changes.ts";
import { restorePreviousModel, useAutoModel } from "./planner-model.ts";
import { createPlannerSeat } from "./planner-seat.ts";
import { phaseLabel, PlannerSession } from "./planner-session.ts";
import { Shipping } from "./shipping.ts";
import { StartDialog } from "./start-dialog.ts";
import { planningPrompt } from "./workflow-prompts.ts";
import {
	canEditFiles,
	canPlannerEditFiles,
	findWorkflowState,
	IDLE_WORKFLOW,
	isDelegatedPhase,
	SUBAGENT_ENV_VAR,
	type WorkflowState,
} from "./workflow-state.ts";

const FILE_EDITING_TOOLS = new Set(["edit", "write"]);
const FEATURE_TASK_KINDS: ReadonlySet<TaskKind> = new Set(["feature_planning", "feature_build"]);
const WORKFLOW_SUGGESTION =
	"Tip: this looks like a feature. /build <task> has the expert plan it, a model fit for its difficulty implement it, and two experts review it";
const USAGE = "Usage: /build <task> | /build implement | /build ship | /build status | /build stop";

const REVIEW_FAILED_CHOICES = {
	fixAgain: "One more fix round on the findings, then a re-review",
	accept: "Accept the work as it is",
	reReview: "Review again (after you changed something yourself)",
	later: "Decide later (Alt+A or /build implement)",
} as const;

/** In a subagent's process: keep the reviewers from editing; the parent session runs the workflow. */
function guardSubagentEdits(pi: ExtensionAPI): void {
	let workflow: WorkflowState = IDLE_WORKFLOW;
	pi.on("session_start", (_event, ctx) => {
		workflow = findWorkflowState(ctx.sessionManager.getBranch());
	});
	pi.on("tool_call", (event) => {
		if (canEditFiles(workflow.phase) || !FILE_EDITING_TOOLS.has(event.toolName)) return undefined;
		return { block: true, reason: `/build ${workflow.phase} phase: only the implementer edits files` };
	});
}

export default function (pi: ExtensionAPI) {
	if (process.env[SUBAGENT_ENV_VAR] === "1") {
		guardSubagentEdits(pi);
		return;
	}
	const session = new PlannerSession(pi);
	let hasSuggestedWorkflow = false;

	/** The run is over: subagents stopped, the planner back on normal routing and on the model you had before. */
	function endRun(summary: string): void {
		orchestrator.stop();
		session.enterPhase(IDLE_WORKFLOW);
		session.notify(`Build workflow finished: ${summary}. Back to normal routing.`, "info");
		void restorePreviousModel(pi, session.context);
	}

	/** The subagents are done; what follows needs you. */
	function handleRunFinished(next: WorkflowState, summary: string): void {
		session.enterPhase(next);
		if (next.phase === "awaiting-pr") promptForPullRequest(session);
		else if (next.phase === "awaiting-ship") void shipping.confirmAndShip();
		else if (next.phase === "review-failed") void askAfterFailedReview();
		else endRun(summary);
	}

	const orchestrator = new BuildOrchestrator(createPlannerSeat(session, handleRunFinished));
	const startDialog = new StartDialog(session, orchestrator);
	const planChanges = new PlanChanges(session, orchestrator, startDialog);
	const shipping = new Shipping(session, endRun);

	async function askAfterFailedReview(): Promise<void> {
		if (session.workflow.phase !== "review-failed" || !session.hasUI) return;
		const choice = await session.context.ui.select("The re-review still has findings (see the report)", Object.values(REVIEW_FAILED_CHOICES));
		const refusal = await applyFailedReviewChoice(choice);
		if (refusal) session.notify(refusal, "warning");
	}

	async function applyFailedReviewChoice(choice: string | undefined): Promise<string | undefined> {
		switch (choice) {
			case REVIEW_FAILED_CHOICES.fixAgain:
				return orchestrator.fixAgain();
			case REVIEW_FAILED_CHOICES.accept:
				return orchestrator.acceptAnyway();
			case REVIEW_FAILED_CHOICES.reReview:
				return orchestrator.reReview();
			default:
				session.notify("The run waits for your decision: Alt+A, or /build implement asks again", "info");
				return undefined;
		}
	}

	async function startWorkflow(task: string, ctx: ExtensionCommandContext): Promise<void> {
		if (!(await useAutoModel(pi, ctx))) return;
		session.enterPhase({ phase: "plan", task });
		pi.sendUserMessage(planningPrompt(task));
	}

	async function startOrResumeImplementation(ctx: ExtensionCommandContext): Promise<void> {
		const workflow = session.workflow;
		switch (workflow.phase) {
			case "awaiting-implementation":
				await startDialog.ask();
				return;
			case "review-failed":
				await askAfterFailedReview();
				return;
			case "awaiting-ship":
				await shipping.confirmAndShip();
				return;
			case "awaiting-pr":
				promptForPullRequest(session);
				return;
			case "plan":
				ctx.ui.notify("No agreed plan to implement yet: agree on the plan first, so the planner saves it", "warning");
				return;
			case "idle":
				ctx.ui.notify("No agreed plan to implement yet: start with /build <task>", "warning");
				return;
			default: {
				const refusal = orchestrator.resume();
				ctx.ui.notify(refusal ?? `Resumed the ${workflow.phase} phase`, refusal ? "warning" : "info");
			}
		}
	}

	pi.on("session_start", (_event, ctx) => {
		session.attach(ctx);
		hasSuggestedWorkflow = false;
		const phase = session.workflow.phase;
		if (isDelegatedPhase(phase)) {
			session.notify(`/build was interrupted in the ${phase} phase; /build implement resumes it, /build stop ends it`, "warning");
		}
		if (phase === "review-failed") session.notify("/build waits for your decision on the re-review; /build implement asks", "info");
	});

	pi.on("session_shutdown", () => {
		orchestrator.stop();
	});

	// After the session_start above: the dashboard reads git through the session, which must be attached first.
	registerDashboard(pi, session, orchestrator, planChanges);

	pi.on("tool_call", (event) => {
		const phase = session.workflow.phase;
		if (canPlannerEditFiles(phase) || !FILE_EDITING_TOOLS.has(event.toolName)) return undefined;
		const reason =
			phase === "plan" || phase === "awaiting-implementation"
				? `/build ${phase} phase: nothing is edited until the plan is agreed; the implementer edits the files (/build stop ends the run)`
				: `/build ${phase} phase: the implementer edits the files. To change the work, save the plan again or message the implementer (Alt+A); /build stop ends the run and allows edits here again`;
		return { block: true, reason };
	});

	// A plan saved during a run replaces the run's plan file; the result tells the planner where it now is.
	pi.on("tool_result", (event) => {
		if (event.toolName !== SAVE_PLAN_TOOL_NAME || event.isError) return undefined;
		const savedPath = (event.details as { planPath?: unknown } | undefined)?.planPath;
		if (typeof savedPath !== "string") return undefined;
		const planPath = planChanges.keepOnePlanFile(savedPath);
		planChanges.notePlanSaved(planPath);
		if (planPath === savedPath) return undefined;
		return { content: [{ type: "text", text: `Plan saved to ${planPath} (the run's plan, updated)` }], details: { planPath } };
	});

	pi.on("agent_settled", async (event, ctx) => {
		if (event.aborted) {
			orchestrator.handlePlannerAborted();
			return;
		}
		if (planChanges.hasPendingStart) {
			await planChanges.handleSavedPlan();
			return;
		}
		if (isDelegatedPhase(session.workflow.phase)) orchestrator.handlePlannerReply(lastAnswer(ctx.sessionManager.getBranch()));
	});

	const stopListeningForTaskKinds = pi.events.on(TASK_KIND_EVENT, (taskKind) => {
		if (session.workflow.phase !== "idle" || hasSuggestedWorkflow || !FEATURE_TASK_KINDS.has(taskKind as TaskKind)) return;
		if (!session.hasUI) return;
		hasSuggestedWorkflow = true;
		session.notify(WORKFLOW_SUGGESTION, "info");
	});
	pi.on("session_shutdown", () => stopListeningForTaskKinds());

	pi.registerCommand("build", {
		description:
			"Plan (expert) -> optional GitHub issue -> implementer subagent -> Claude + OpenAI reviewer subagents (expert) -> ship: /build <task> | implement | ship | status | stop",
		handler: async (args, ctx) => {
			const argument = args.trim();
			const workflow = session.workflow;
			switch (argument) {
				case "":
					ctx.ui.notify(USAGE, "info");
					return;
				case "status":
					ctx.ui.notify(workflow.phase === "idle" ? "No build workflow running" : phaseLabel(workflow), "info");
					return;
				case "stop":
					if (workflow.phase === "idle") ctx.ui.notify("No build workflow running", "info");
					else endRun("stopped");
					return;
				case "implement":
					await startOrResumeImplementation(ctx);
					return;
				case "ship":
					if (workflow.phase === "awaiting-ship") await shipping.confirmAndShip();
					else ctx.ui.notify("Nothing to ship: /build ship works after a passing review", "warning");
					return;
				default:
					if (!ctx.isIdle()) {
						ctx.ui.notify("Wait for the agent to finish, then run /build again", "warning");
						return;
					}
					if (workflow.phase !== "idle") {
						ctx.ui.notify(`A build workflow is running (${phaseLabel(workflow)}); /build stop first`, "warning");
						return;
					}
					await startWorkflow(argument, ctx);
			}
		},
	});

	pi.registerCommand("issue", {
		description: "GitHub issue -> investigate (expert) -> implement -> review (expert) -> draft PR: /issue <url | #123> | pr",
		handler: async (args, ctx) => {
			const argument = args.trim();
			if (!ctx.isIdle()) {
				ctx.ui.notify("Wait for the agent to finish, then run /issue again", "warning");
				return;
			}
			if (argument === "") {
				ctx.ui.notify(ISSUE_USAGE, "info");
				return;
			}
			if (argument === "pr") {
				await openPullRequest(session, ctx, endRun);
				return;
			}
			if (session.workflow.phase !== "idle") {
				ctx.ui.notify(`A build workflow is running (${phaseLabel(session.workflow)}); /build stop first`, "warning");
				return;
			}
			await startIssueWorkflow(session, argument, ctx);
		},
	});
}

function lastAnswer(branch: ReturnType<ExtensionCommandContext["sessionManager"]["getBranch"]>): string {
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry.type === "message" && entry.message.role === "assistant") return answerText(entry.message);
	}
	return "";
}
