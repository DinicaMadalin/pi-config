/**
 * /build: the expert plans with you in this session; saving an agreed plan in a normal chat opens the start dialog.
 * Then a designer prepares contracts, implementers build, and one complex-tier reviewer per available vendor reviews it.
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
 * - /build implement starts an agreed plan or resumes/restarts the current stage. /build plan edits the run plan;
 *   /build status and /build stop are controls. The herdr workspace keeps the Diff tab.
 * - /issue <url | #123>: the same workflow for a GitHub issue, ending in a draft PR (issue-workflow.ts).
 *
 * In the subagents' processes (SUBAGENT_ENV_VAR set) this extension only guards file edits for their phase.
 * Phase routes reach the auto model through its route pin (auto-model/route-pin.ts).
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { SAVE_PLAN_TOOL_NAME } from "../project-memory/agreed-plan-files.ts";
import { ownWorkspaceId } from "../herdr-tools/herdr-cli.ts";
import { answerText } from "./agent-activity.ts";
import { registerDiffTab } from "./diff-tab-registration.ts";
import { requestRewrite } from "../prompt-rewriter/rewrite-request.ts";
import { BuildOrchestrator } from "./build-orchestrator.ts";
import { createBuildSpace } from "./build-space.ts";
import { herdrSubagentLauncher } from "./herdr-subagent.ts";
import { launchSubagentProcess } from "./subagent-process.ts";
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
	isAwaitingUser,
	isDelegatedPhase,
	isFeatureState,
	PROJECT_TRUST_ENV_VAR,
	type RunWorktree,
	runWorktreeOf,
	SUBAGENT_ENV_VAR,
	type WorkflowState,
} from "./workflow-state.ts";
import { tooManyStreamsWarning } from "./work-streams.ts";

const FILE_EDITING_TOOLS = new Set(["edit", "write"]);
const START_OFFER_NOTE = "The user is now asked whether to start the build on this plan (designer, implementers, reviewers). End your turn now: do not implement anything in this turn.";
const USAGE = "Usage: /build <task> | /build implement | /build plan | /build ship | /build status | /build stop | /build here | /build back";

const REVIEW_FAILED_CHOICES = {
	fixAgain: "One more fix round on the findings, then a re-review",
	accept: "Accept the work as it is",
	reReview: "Review again (after you changed something yourself)",
	later: "Decide later (/build implement asks again)",
} as const;

const CLEANUP_FAILED_CHOICES = {
	retry: "Run the cleanup and checks again",
	fixAgain: "Send the failure to a fix round, then a re-review",
	reReview: "Review again (after you changed something yourself)",
	later: "Decide later (/build implement asks again)",
} as const;

const SHIP_TOOL_NAME = "ship_build";

/** In a subagent's process: the run's worktree is a new folder to Pi, so it takes over your trust decision instead of asking. */
function takeOverProjectTrust(pi: ExtensionAPI): void {
	pi.on("project_trust", () => {
		const trust = process.env[PROJECT_TRUST_ENV_VAR];
		if (trust === "1") return { trusted: "yes" };
		if (trust === "0") return { trusted: "no" };
		return { trusted: "undecided" };
	});
}

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
		takeOverProjectTrust(pi);
		return;
	}
	const session = new PlannerSession(pi);

	/**
	 * The run is over: subagents stopped (their herdr panes closed), the planner back on normal routing and on the
	 * model you had before. Released work (shipped, PR opened) frees its worktree; otherwise the worktree stays.
	 */
	function endRun(summary: string, isWorkReleased = false): void {
		void endRunAndRestoreModel(summary, isWorkReleased);
	}

	async function endRunAndRestoreModel(summary: string, isWorkReleased: boolean): Promise<void> {
		const worktree = runWorktreeOf(session.workflow);
		session.enterPhase(IDLE_WORKFLOW);
		await orchestrator.stopAndWait();
		const canRemoveWorkspace = worktree && buildSpace ? await buildSpace.leave(worktree) : true;
		const worktreeNote = !worktree
			? ""
			: canRemoveWorkspace
				? await releaseWorktree(worktree, isWorkReleased)
				: ` The planner is still in the run's workspace, so its worktree stays at ${worktree.path}.`;
		session.notify(`Build workflow finished: ${summary}.${worktreeNote} Back to normal routing.`, "info");
		await restorePreviousModel(pi, session.context);
	}

	/** Removes the run's worktree once its work left it; unreleased work stays there for you. Returns a notice. */
	async function releaseWorktree(worktree: RunWorktree, isWorkReleased: boolean): Promise<string> {
		if (!isWorkReleased || !session.herdr) return ` Its worktree stays at ${worktree.path}.`;
		try {
			await session.herdr.removeWorktree(worktree.workspaceId);
			return " Its worktree was removed; the branch stays.";
		} catch (error) {
			return ` Could not remove its worktree at ${worktree.path}: ${(error as Error).message}.`;
		}
	}

	/**
	 * A new /build or /issue may replace a run that only waits on you (ship, PR, the call after a failed re-review):
	 * it ends, its changes stay in the folder, and its implementers take the next work. A run whose agents still
	 * work is refused; undefined means the new run may start.
	 */
	async function makeRoomForNewRun(): Promise<string | undefined> {
		const workflow = session.workflow;
		if (workflow.phase === "idle") return undefined;
		if (!isAwaitingUser(workflow.phase)) return `A build workflow is running (${phaseLabel(workflow)}); /build stop first`;
		await endRunAndRestoreModel("replaced by a new run; its changes stay uncommitted", false);
		return undefined;
	}

	/** The subagents are done; what follows needs you. */
	function handleRunFinished(next: WorkflowState, summary: string): void {
		session.enterPhase(next);
		if (next.phase === "awaiting-pr") promptForPullRequest(session);
		else if (next.phase === "awaiting-ship") void shipping.confirmAndShip();
		else if (next.phase === "review-failed") void askAfterFailedReview();
		else if (next.phase === "cleanup-failed") void askAfterFailedCleanup();
		else endRun(summary);
	}

	const buildSpace = createBuildSpace(session.herdr, () => runWorktreeOf(session.workflow), (message) => session.notify(message, "warning"));
	const launchSubagent = session.herdr
		? herdrSubagentLauncher(session.herdr, () => runWorktreeOf(session.workflow)?.workspaceId ?? ownWorkspaceId())
		: launchSubagentProcess;
	const orchestrator = new BuildOrchestrator(createPlannerSeat(session, handleRunFinished), launchSubagent);
	const startDialog = new StartDialog(session, orchestrator);
	const planChanges = new PlanChanges(session, orchestrator, startDialog);
	const shipping = new Shipping(session, endRun);

	async function askAfterFailedReview(): Promise<void> {
		if (session.workflow.phase !== "review-failed" || !session.hasUI) return;
		const choice = await session.context.ui.select("The re-review still has findings (see the report)", Object.values(REVIEW_FAILED_CHOICES).filter((choice) => !session.workflow.designerSession || choice !== REVIEW_FAILED_CHOICES.accept));
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
				session.notify("The run waits for your decision: /build implement asks again", "info");
				return undefined;
		}
	}

	async function askAfterFailedCleanup(): Promise<void> {
		if (session.workflow.phase !== "cleanup-failed" || !session.hasUI) return;
		const choice = await session.context.ui.select("Contract cleanup or checks failed (see the report)", Object.values(CLEANUP_FAILED_CHOICES));
		let refusal: string | undefined;
		switch (choice) {
			case CLEANUP_FAILED_CHOICES.retry:
				refusal = orchestrator.retryCleanup();
				break;
			case CLEANUP_FAILED_CHOICES.fixAgain:
				refusal = orchestrator.fixAgain();
				break;
			case CLEANUP_FAILED_CHOICES.reReview:
				refusal = await orchestrator.reReview();
				break;
			default:
				session.notify("The run waits for your decision: /build implement asks again", "info");
		}
		if (refusal) session.notify(refusal, "warning");
	}

	async function startWorkflow(task: string, ctx: ExtensionCommandContext): Promise<void> {
		if (!(await useAutoModel(pi, ctx))) return;
		session.enterPhase({ phase: "plan", task });
		pi.sendUserMessage(planningPrompt(task));
	}

	async function startOrResumeImplementation(ctx: ExtensionCommandContext): Promise<void> {
		const workflow = session.workflow;
		switch (workflow.phase) {
			case "cleanup": {
				const refusal = orchestrator.retryCleanup();
				if (refusal) ctx.ui.notify(refusal, "warning");
				return;
			}
			case "cleanup-failed":
				await askAfterFailedCleanup();
				return;
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
				ctx.ui.notify("No agreed plan to implement yet: agree on a plan in the chat (saving it offers the build), or /build <task>", "warning");
				return;
			default: {
				const refusal = await orchestrator.resumeOrRestart();
				ctx.ui.notify(refusal ?? `Resumed the ${workflow.phase} phase`, refusal ? "warning" : "info");
			}
		}
	}

	pi.on("session_start", (_event, ctx) => {
		session.attach(ctx);
		const phase = session.workflow.phase;
		if (isDelegatedPhase(phase) || phase === "cleanup" || phase === "cleanup-failed") {
			session.notify(`/build was interrupted in the ${phase} phase; /build implement resumes it, /build stop ends it`, "warning");
		}
		if (phase === "review-failed") session.notify("/build waits for your decision on the re-review; /build implement asks", "info");
		if (phase === "cleanup-failed") void askAfterFailedCleanup();
	});

	// Awaited so the subagents' herdr panes close before Pi exits.
	pi.on("session_shutdown", async () => {
		await orchestrator.stopAndWait();
	});

	pi.registerTool({
		name: SHIP_TOOL_NAME,
		label: "Ship /build work",
		description:
			"Ship the work of a finished /build run: the user confirms in a dialog, then it goes on a new branch with one commit and a normal push (never a merge or force push), and the run ends. " +
			"Only works after every reviewer passed; otherwise it says what the run is waiting for.",
		promptSnippet: "Ship a reviewed /build run when the user asks to ship, commit or push it",
		promptGuidelines: [
			`When the user asks to ship, commit or push the work of a /build run, call ${SHIP_TOOL_NAME} instead of running git commit or git push yourself, so the run ends cleanly.`,
		],
		parameters: Type.Object({}),
		async execute() {
			const outcome = await shipping.confirmAndShip();
			return { content: [{ type: "text", text: outcome }], details: { outcome } };
		},
	});

	// After the session_start above: the Diff tab reads git through the attached session.
	registerDiffTab(pi, session, buildSpace);

	pi.on("tool_call", (event) => {
		const phase = session.workflow.phase;
		if (canPlannerEditFiles(phase) || !FILE_EDITING_TOOLS.has(event.toolName)) return undefined;
		const reason =
			phase === "plan" || phase === "awaiting-implementation"
				? `/build ${phase} phase: nothing is edited until the plan is agreed; the implementer edits the files (/build stop ends the run)`
				: `/build ${phase} phase: the implementer edits the files. To change the work, save the plan again or type into the implementer's herdr pane; /build stop ends the run and allows edits here again`;
		return { block: true, reason };
	});

	// A plan saved during a run replaces the run's plan file; the result tells the planner where it now is.
	pi.on("tool_result", (event) => {
		if (event.toolName !== SAVE_PLAN_TOOL_NAME || event.isError) return undefined;
		const savedPath = (event.details as { planPath?: unknown } | undefined)?.planPath;
		if (typeof savedPath !== "string") return undefined;
		const planPath = planChanges.keepOnePlanFile(savedPath);
		planChanges.notePlanSaved(planPath);
		const streamsWarning = tooManyStreamsWarning(session.readPlan(planPath) ?? "");
		const startNote = session.workflow.phase === "idle" && session.hasUI ? START_OFFER_NOTE : "";
		if (planPath === savedPath && !streamsWarning && !startNote) return undefined;
		const saved = planPath === savedPath ? `Plan saved to ${planPath}` : `Plan saved to ${planPath} (the run's plan, updated)`;
		const message = [saved, streamsWarning, startNote].filter(Boolean).join("\n");
		return { content: [{ type: "text", text: message }], details: { planPath } };
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

	pi.registerCommand("build", {
		description:
			"Plan (expert) -> designer -> implementers -> complex-tier reviewer(s) for available vendors -> ship: /build <task> | implement | plan | ship | status | stop | here | back",
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
				case "plan":
					if (workflow.phase === "awaiting-implementation" || isFeatureState(workflow)) await planChanges.editPlanByHand(ctx.isIdle());
					else ctx.ui.notify("No run plan to edit", "info");
					return;
				case "here":
				case "back": {
					if (!buildSpace) {
						ctx.ui.notify("The planner can only move inside herdr", "warning");
						return;
					}
					const moveError = argument === "here" ? await buildSpace.bringPlannerHere() : await buildSpace.sendPlannerBack();
					if (moveError) ctx.ui.notify(moveError, "warning");
					return;
				}
				case "ship":
					if (workflow.phase === "awaiting-ship") await shipping.confirmAndShip();
					else ctx.ui.notify("Nothing to ship: /build ship works after a passing review", "warning");
					return;
				default:
					if (!ctx.isIdle()) {
						ctx.ui.notify("Wait for the agent to finish, then run /build again", "warning");
						return;
					}
					const rewrittenTask = await requestRewrite(pi.events, argument, ctx);
					if (rewrittenTask.kind === "cancelled") {
						ctx.ui.setEditorText(`/build ${argument}`);
						return;
					}
					const buildRefusal = await makeRoomForNewRun();
					if (buildRefusal) {
						ctx.ui.notify(buildRefusal, "warning");
						return;
					}
					await startWorkflow(rewrittenTask.text, ctx);
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
			const issueRefusal = await makeRoomForNewRun();
			if (issueRefusal) {
				ctx.ui.notify(issueRefusal, "warning");
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
