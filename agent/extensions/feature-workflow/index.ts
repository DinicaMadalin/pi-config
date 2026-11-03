/**
 * /feature: plan with the expert tier, implement in a fresh session on the model and thinking level Jev picks
 * from the task's difficulty, then have the expert review, with at most one fix round and re-review.
 *
 * - /feature <task>: the expert investigates and plans; nothing is edited until you agree and it saves the plan.
 * - /feature implement: a fresh session gets the plan as a brief (what and how to implement, the rule files,
 *   how to write the code). When the implementer ends with IMPLEMENTATION: done, the expert reviews.
 * - A review ending with REVIEW_VERDICT: fix sends the findings to an implementer (again picked by difficulty)
 *   once, then the expert re-reviews.
 * - /feature status, /feature stop. The router also suggests /feature when a prompt looks like a medium+ feature.
 *
 * Phase routes reach the auto model through its route pin (auto-model/route-pin.ts), so tier lists,
 * login checks and failover still apply.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TaskKind } from "../auto-model/classify-difficulty.ts";
import { ROUTE_PIN_ENTRY_TYPE, type RoutePin, TASK_KIND_EVENT } from "../auto-model/route-pin.ts";
import { fixPrompt, implementationBrief, planningPrompt, reReviewPrompt, reviewPrompt } from "./workflow-prompts.ts";
import {
	canEditFiles,
	WORKFLOW_STATE_ENTRY_TYPE,
	type WorkflowState,
	findWorkflowState,
	IDLE_WORKFLOW,
	routeForPhase,
	stepAfterTurn,
} from "./workflow-state.ts";

const STATUS_KEY = "feature";
const AUTO_MODEL = { provider: "auto", id: "auto" } as const;
const SAVE_PLAN_TOOL_NAME = "save_agreed_plan";
const FILE_EDITING_TOOLS = new Set(["edit", "write"]);
const RULE_FILE_NAMES = ["AGENTS.md", "CLAUDE.md"];
const GLOBAL_RULE_FILE = join(homedir(), ".pi", "agent", "AGENTS.md");
const FEATURE_TASK_KINDS: ReadonlySet<TaskKind> = new Set(["feature_planning", "feature_build"]);
const WORKFLOW_SUGGESTION =
	"Tip: this looks like a feature. /feature <task> has the expert plan it, a model fit for its difficulty implement it, and the expert review it";
const USAGE = "Usage: /feature <task> | /feature implement | /feature status | /feature stop";

const PHASE_LABELS: Record<WorkflowState["phase"], string> = {
	idle: "",
	plan: "feature: plan (expert)",
	"awaiting-implementation": "feature: plan agreed, /feature implement",
	implement: "feature: implement",
	review: "feature: review (expert)",
	fix: "feature: fix",
	"re-review": "feature: re-review (expert)",
};

function lastAssistantText(ctx: ExtensionContext): string {
	const branch = ctx.sessionManager.getBranch();
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		return entry.message.content
			.filter((part) => part.type === "text")
			.map((part) => part.text)
			.join("\n");
	}
	return "";
}

async function findRepoRoot(pi: ExtensionAPI, cwd: string): Promise<string | undefined> {
	const result = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd });
	return result.code === 0 ? result.stdout.trim() : undefined;
}

async function findHeadCommit(pi: ExtensionAPI, cwd: string): Promise<string | undefined> {
	const result = await pi.exec("git", ["rev-parse", "HEAD"], { cwd });
	return result.code === 0 ? result.stdout.trim() : undefined;
}

/** Repo-level then directory-level rule files, then the global one: the rules Pi loads into context. */
async function findRuleFiles(pi: ExtensionAPI, cwd: string): Promise<string[]> {
	const repoRoot = await findRepoRoot(pi, cwd);
	const directories = [...new Set([repoRoot, cwd].filter((directory): directory is string => directory !== undefined))];
	const projectRuleFiles = directories.flatMap((directory) => RULE_FILE_NAMES.map((name) => join(directory, name)));
	return [...projectRuleFiles, GLOBAL_RULE_FILE].filter((path) => existsSync(path));
}

export default function (pi: ExtensionAPI) {
	let workflow: WorkflowState = IDLE_WORKFLOW;
	let hasSuggestedWorkflow = false;
	let sessionCtx: ExtensionContext | undefined;

	function showPhase(ctx: ExtensionContext): void {
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, PHASE_LABELS[workflow.phase] || undefined);
	}

	/** Persists the phase and pins its route, so a reload or the next prompt continues the same phase. */
	function enterPhase(next: WorkflowState, ctx: ExtensionContext): void {
		workflow = next;
		pi.appendEntry(WORKFLOW_STATE_ENTRY_TYPE, next);
		pi.appendEntry<RoutePin>(ROUTE_PIN_ENTRY_TYPE, routeForPhase(next.phase));
		showPhase(ctx);
	}

	async function useAutoModel(ctx: ExtensionContext): Promise<boolean> {
		if (ctx.model?.provider === AUTO_MODEL.provider && ctx.model.id === AUTO_MODEL.id) return true;
		const autoModel = ctx.modelRegistry.find(AUTO_MODEL.provider, AUTO_MODEL.id);
		if (!autoModel || !(await pi.setModel(autoModel))) {
			ctx.ui.notify("/feature needs the auto model (auto/auto) to switch tiers per phase; it is not available", "error");
			return false;
		}
		return true;
	}

	async function startWorkflow(task: string, ctx: ExtensionCommandContext): Promise<void> {
		if (!(await useAutoModel(ctx))) return;
		enterPhase({ phase: "plan", task }, ctx);
		pi.sendUserMessage(planningPrompt(task));
	}

	async function startImplementation(ctx: ExtensionCommandContext): Promise<void> {
		if (workflow.phase !== "awaiting-implementation") {
			const hint = workflow.phase === "plan" ? "agree on the plan first, so the planner saves it" : "start with /feature <task>";
			ctx.ui.notify(`No agreed plan to implement yet: ${hint}`, "warning");
			return;
		}
		if (!(await useAutoModel(ctx))) return;
		const { planPath } = workflow;
		let plan: string;
		try {
			plan = readFileSync(planPath, "utf8");
		} catch (error) {
			ctx.ui.notify(`Failed to read the agreed plan ${planPath}: ${(error as Error).message}`, "error");
			return;
		}
		const ruleFiles = await findRuleFiles(pi, ctx.cwd);
		const implementState: WorkflowState = { phase: "implement", planPath, baseCommit: await findHeadCommit(pi, ctx.cwd) };
		const brief = implementationBrief(planPath, plan, ruleFiles);

		const switched = await ctx.newSession({
			parentSession: ctx.sessionManager.getSessionFile(),
			setup: async (sessionManager) => {
				sessionManager.appendCustomEntry(WORKFLOW_STATE_ENTRY_TYPE, implementState);
				sessionManager.appendCustomEntry(ROUTE_PIN_ENTRY_TYPE, routeForPhase("implement"));
			},
			withSession: async (implementCtx) => {
				await implementCtx.sendUserMessage(brief);
			},
		});
		if (switched.cancelled) ctx.ui.notify(`New session cancelled; the plan is saved at ${planPath}`, "info");
	}

	function stopWorkflow(ctx: ExtensionContext, summary: string): void {
		enterPhase(IDLE_WORKFLOW, ctx);
		if (ctx.hasUI) ctx.ui.notify(`Feature workflow finished: ${summary}. Back to normal auto routing.`, "info");
	}

	function continueWorkflow(ctx: ExtensionContext): void {
		const lastAnswer = lastAssistantText(ctx);
		const step = stepAfterTurn(workflow, lastAnswer);
		if (step.kind === "finish") {
			stopWorkflow(ctx, step.summary);
			return;
		}
		if (step.kind === "wait") {
			const isWaitingOnPlan = workflow.phase === "plan" || workflow.phase === "awaiting-implementation";
			if (!isWaitingOnPlan && ctx.hasUI) ctx.ui.notify(`Feature workflow paused: ${step.reason}. Reply to continue.`, "info");
			return;
		}
		const ruleFilesPromise = findRuleFiles(pi, ctx.cwd);
		enterPhase(step.next, ctx);
		void ruleFilesPromise.then((ruleFiles) => {
			switch (step.next.phase) {
				case "review":
					pi.sendUserMessage(reviewPrompt(step.next.planPath, step.next.baseCommit, ruleFiles));
					return;
				case "fix":
					pi.sendUserMessage(fixPrompt(lastAnswer));
					return;
				case "re-review":
					pi.sendUserMessage(reReviewPrompt(step.next.baseCommit));
					return;
			}
		});
	}

	pi.on("session_start", (_event, ctx) => {
		workflow = findWorkflowState(ctx.sessionManager.getBranch());
		hasSuggestedWorkflow = false;
		sessionCtx = ctx;
		showPhase(ctx);
	});

	pi.on("tool_call", (event) => {
		if (canEditFiles(workflow.phase) || !FILE_EDITING_TOOLS.has(event.toolName)) return undefined;
		return { block: true, reason: `/feature ${workflow.phase} phase: only the implementer edits files` };
	});

	pi.on("tool_execution_end", (event, ctx) => {
		if (event.toolName !== SAVE_PLAN_TOOL_NAME || event.isError) return;
		if (workflow.phase !== "plan" && workflow.phase !== "awaiting-implementation") return;
		const planPath = (event.result?.details as { planPath?: unknown } | undefined)?.planPath;
		if (typeof planPath !== "string") return;
		enterPhase({ phase: "awaiting-implementation", task: workflow.task, planPath }, ctx);
	});

	pi.on("agent_settled", (event, ctx) => {
		if (event.aborted || workflow.phase === "idle") return;
		if (workflow.phase === "awaiting-implementation") {
			if (!ctx.hasUI) return;
			ctx.ui.setEditorText("/feature implement");
			ctx.ui.notify(`Plan saved at ${workflow.planPath}. Press Enter to implement it in a fresh session.`, "info");
			return;
		}
		continueWorkflow(ctx);
	});

	// Event-bus messages carry no context, so the suggestion uses the current session's.
	pi.events.on(TASK_KIND_EVENT, (taskKind) => {
		if (workflow.phase !== "idle" || hasSuggestedWorkflow || !FEATURE_TASK_KINDS.has(taskKind as TaskKind)) return;
		if (!sessionCtx?.hasUI) return;
		hasSuggestedWorkflow = true;
		sessionCtx.ui.notify(WORKFLOW_SUGGESTION, "info");
	});

	pi.registerCommand("feature", {
		description: "Plan (expert) -> implement (fresh session, model by difficulty) -> review (expert): /feature <task> | implement | status | stop",
		handler: async (args, ctx) => {
			const argument = args.trim();
			if (!ctx.isIdle()) {
				ctx.ui.notify("Wait for the agent to finish, then run /feature again", "warning");
				return;
			}
			switch (argument) {
				case "":
					ctx.ui.notify(USAGE, "info");
					return;
				case "status":
					ctx.ui.notify(workflow.phase === "idle" ? "No feature workflow running" : PHASE_LABELS[workflow.phase], "info");
					return;
				case "stop":
					if (workflow.phase === "idle") ctx.ui.notify("No feature workflow running", "info");
					else stopWorkflow(ctx, "stopped");
					return;
				case "implement":
					await startImplementation(ctx);
					return;
				default:
					if (workflow.phase !== "idle") {
						ctx.ui.notify(`A feature workflow is running (${PHASE_LABELS[workflow.phase]}); /feature stop first`, "warning");
						return;
					}
					await startWorkflow(argument, ctx);
			}
		},
	});
}
