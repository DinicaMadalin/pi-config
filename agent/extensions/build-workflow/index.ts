/**
 * /build: the expert plans with you in this session; once you agree, an implementer subagent (model picked by
 * difficulty) builds it and two expert reviewer subagents (Claude and OpenAI, in parallel) review it, with at
 * most one fix round and re-review.
 * You stay in this session the whole time.
 *
 * - /build <task>: the expert investigates and plans; nothing is edited until you agree and it saves the plan.
 * - Once the plan is saved you choose: post it as a GitHub issue and start, start without an issue, or keep planning.
 *   With an issue, the implementer and the reviewers read the plan from it.
 * - The implementer runs as a subagent (build-orchestrator.ts). Its questions come to the planner here,
 *   which answers them or asks you. A review ending with REVIEW_VERDICT: fix sends the findings back to the
 *   implementer once, then both reviewers re-review. The run ends with a report in this session.
 * - After a passing review you confirm shipping: a new branch from HEAD, one commit, a normal push (never a merge
 *   or force push). /build ship asks again later.
 * - /build implement: starts an agreed plan or resumes a run interrupted by a reload. /build status, /build stop.
 * - Alt+A or /agents: the agents overview, where you can follow and message every agent (agents-overview-panel.ts).
 *   The router also suggests /build when a prompt looks like a medium+ feature.
 * - /issue <url | #123>: same workflow for a GitHub issue, on a new branch from the default branch; the expert
 *   investigates instead of planning, and after a passing review /issue pr (prefilled, you confirm) commits,
 *   pushes and opens a draft PR that fixes the issue.
 *
 * In the subagents' processes (SUBAGENT_ENV_VAR set) this extension only guards file edits for their phase.
 * Phase routes reach the auto model through its route pin (auto-model/route-pin.ts), so tier lists,
 * login checks and failover still apply.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TaskKind } from "../auto-model/classify-difficulty.ts";
import { ROUTE_PIN_ENTRY_TYPE, type RoutePin, TASK_KIND_EVENT } from "../auto-model/route-pin.ts";
import { answerText } from "./agent-activity.ts";
import { registerAgentsOverview } from "./agents-overview-panel.ts";
import { BuildOrchestrator, type PlannerSeat } from "./build-orchestrator.ts";
import {
	createIssueBranch,
	createPlanIssue,
	fetchIssue,
	isGithubRepo,
	listFilesToShip,
	openDraftPullRequest,
	parseIssueArgument,
	planTitle,
	type RunCommand,
	shipBranchName,
	shipCommitMessage,
	shipWork,
} from "./github-issue.ts";
import { loadWorkChanges } from "./work-changes.ts";
import { implementationBrief, issueInvestigationPrompt, planningPrompt } from "./workflow-prompts.ts";
import {
	BUILD_STAGE_ENTRY_TYPE,
	canEditFiles,
	canPlannerEditFiles,
	findWorkflowState,
	IDLE_WORKFLOW,
	isDelegatedPhase,
	plannerRouteForPhase,
	type StageRecord,
	SUBAGENT_ENV_VAR,
	type TrackedIssue,
	WORKFLOW_STATE_ENTRY_TYPE,
	type WorkflowState,
} from "./workflow-state.ts";

const STATUS_KEY = "build";
const AUTO_MODEL = { provider: "auto", id: "auto" } as const;
const SAVE_PLAN_TOOL_NAME = "save_agreed_plan";
const REPORT_MESSAGE_TYPE = "build-report";
const FILE_EDITING_TOOLS = new Set(["edit", "write"]);
const RULE_FILE_NAMES = ["AGENTS.md", "CLAUDE.md"];
const GLOBAL_RULE_FILE = join(homedir(), ".pi", "agent", "AGENTS.md");
const FEATURE_TASK_KINDS: ReadonlySet<TaskKind> = new Set(["feature_planning", "feature_build"]);
const WORKFLOW_SUGGESTION =
	"Tip: this looks like a feature. /build <task> has the expert plan it, a model fit for its difficulty implement it, and the expert review it";
const USAGE = "Usage: /build <task> | /build implement | /build ship | /build status | /build stop";
const MAX_SHIP_FILES_LISTED = 15;

const START_CHOICES = {
	withIssue: "Create a GitHub issue from the plan and start the implementer",
	withoutIssue: "Start the implementer without an issue",
	keepPlanning: "Not yet, keep planning",
} as const;
const ISSUE_USAGE = "Usage: /issue <github issue url | #123 | 123> | /issue pr";

const PHASE_LABELS: Record<WorkflowState["phase"], string> = {
	idle: "",
	plan: "plan (expert)",
	"awaiting-implementation": "plan agreed",
	implement: "implementer working · Alt+A",
	review: "reviewers working · Alt+A",
	fix: "implementer fixing · Alt+A",
	"re-review": "reviewers re-reviewing · Alt+A",
	"awaiting-pr": "review passed, /issue pr",
	"awaiting-ship": "review passed, /build ship",
};

function phaseLabel(state: WorkflowState): string {
	if (state.phase === "idle") return "";
	const prefix = state.issue ? `issue #${state.issue.number}` : "build";
	const label = state.phase === "plan" && state.issue ? "investigate (expert)" : PHASE_LABELS[state.phase];
	return `${prefix}: ${label}`;
}

function lastAssistantText(ctx: ExtensionContext): string {
	const branch = ctx.sessionManager.getBranch();
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry.type === "message" && entry.message.role === "assistant") return answerText(entry.message);
	}
	return "";
}

/** Stage records since the current run's plan phase began, oldest first. */
function findStageRecords(ctx: ExtensionContext): StageRecord[] {
	const records: StageRecord[] = [];
	const branch = ctx.sessionManager.getBranch();
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry.type !== "custom") continue;
		if (entry.customType === BUILD_STAGE_ENTRY_TYPE) records.unshift(entry.data as StageRecord);
		if (entry.customType === WORKFLOW_STATE_ENTRY_TYPE && (entry.data as WorkflowState).phase === "plan") break;
	}
	return records;
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
	let workflow: WorkflowState = IDLE_WORKFLOW;
	let hasSuggestedWorkflow = false;
	let sessionCtx: ExtensionContext | undefined;

	function showPhase(ctx: ExtensionContext): void {
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, phaseLabel(workflow) || undefined);
	}

	/** Persists the phase and pins the planner's route, so a reload or the next prompt continues the same phase. */
	function enterPhase(next: WorkflowState, ctx: ExtensionContext): void {
		workflow = next;
		pi.appendEntry(WORKFLOW_STATE_ENTRY_TYPE, next);
		pi.appendEntry<RoutePin>(ROUTE_PIN_ENTRY_TYPE, plannerRouteForPhase(next.phase));
		showPhase(ctx);
	}

	function activeCtx(): ExtensionContext {
		if (!sessionCtx) throw new Error("/build: no session is active");
		return sessionCtx;
	}

	function notify(message: string, level: "info" | "warning" | "error"): void {
		if (sessionCtx?.hasUI) sessionCtx.ui.notify(message, level);
	}

	/** Planner turns while a run is on are queued behind whatever the planner is doing for you. */
	function sendToPlanner(message: string): void {
		if (activeCtx().isIdle()) pi.sendUserMessage(message);
		else pi.sendUserMessage(message, { deliverAs: "followUp" });
	}

	const seat: PlannerSeat = {
		cwd: () => activeCtx().cwd,
		sessionDirectory: () => (activeCtx().sessionManager.getSessionFile() ? activeCtx().sessionManager.getSessionDir() : tmpdir()),
		plannerSessionPath: () => activeCtx().sessionManager.getSessionFile(),
		state: () => workflow,
		enterPhase: (next) => enterPhase(next, activeCtx()),
		appendStage: (record) => pi.appendEntry<StageRecord>(BUILD_STAGE_ENTRY_TYPE, record),
		stageRecords: () => findStageRecords(activeCtx()),
		ruleFiles: () => findRuleFiles(pi, activeCtx().cwd),
		describeChanges: async (baseCommit) => {
			if (!baseCommit) return undefined;
			const run: RunCommand = (command, args) => pi.exec(command, args, { cwd: activeCtx().cwd });
			const changes = await loadWorkChanges(run, baseCommit);
			if (!changes.ok) return undefined;
			const { added, removed, files } = changes.value;
			return `+${added} −${removed} in ${files.length} file${files.length === 1 ? "" : "s"}`;
		},
		askPlanner: sendToPlanner,
		postReport: (report) => pi.sendMessage({ customType: REPORT_MESSAGE_TYPE, content: report, display: true }),
		notify,
		finish: (next, summary) => {
			enterPhase(next, activeCtx());
			if (next.phase === "awaiting-pr") promptForPullRequest(activeCtx());
			else if (next.phase === "awaiting-ship") void confirmShipping(activeCtx());
			else notify(`Build workflow finished: ${summary}. Back to normal auto routing.`, "info");
		},
		dialogs: {
			select: async (title, options) => (sessionCtx?.hasUI ? sessionCtx.ui.select(title, options) : undefined),
			confirm: async (title, message) => (sessionCtx?.hasUI ? sessionCtx.ui.confirm(title, message) : false),
			input: async (title, placeholder) => (sessionCtx?.hasUI ? sessionCtx.ui.input(title, placeholder) : undefined),
		},
	};
	const orchestrator = new BuildOrchestrator(seat);
	registerAgentsOverview(pi, orchestrator, sendToPlanner);

	async function useAutoModel(ctx: ExtensionContext): Promise<boolean> {
		if (ctx.model?.provider === AUTO_MODEL.provider && ctx.model.id === AUTO_MODEL.id) return true;
		const autoModel = ctx.modelRegistry.find(AUTO_MODEL.provider, AUTO_MODEL.id);
		if (!autoModel || !(await pi.setModel(autoModel))) {
			ctx.ui.notify("/build needs the auto model (auto/auto) to switch tiers per phase; it is not available", "error");
			return false;
		}
		return true;
	}

	async function startWorkflow(task: string, ctx: ExtensionCommandContext): Promise<void> {
		if (!(await useAutoModel(ctx))) return;
		enterPhase({ phase: "plan", task }, ctx);
		pi.sendUserMessage(planningPrompt(task));
	}

	function readPlanFile(planPath: string): string | undefined {
		try {
			return readFileSync(planPath, "utf8");
		} catch (error) {
			notify(`Failed to read the agreed plan ${planPath}: ${(error as Error).message}`, "error");
			return undefined;
		}
	}

	function commandRunner(ctx: ExtensionContext): RunCommand {
		return (command, args) => pi.exec(command, args, { cwd: ctx.cwd });
	}

	async function startImplementation(ctx: ExtensionContext, planIssue?: TrackedIssue): Promise<void> {
		if (workflow.phase !== "awaiting-implementation") return;
		const { planPath, issue } = workflow;
		const plan = readPlanFile(planPath);
		if (plan === undefined) return;
		const ruleFiles = await findRuleFiles(pi, ctx.cwd);
		const baseCommit = await findHeadCommit(pi, ctx.cwd);
		const brief = implementationBrief(planPath, plan, ruleFiles, issue, planIssue);
		orchestrator.startImplementation({ planPath, baseCommit, ...(issue && { issue }), ...(planIssue && { planIssue }) }, brief);
		notify("Implementer started as a subagent. Alt+A shows the agents; you can keep talking to the planner.", "info");
	}

	let isAskingToStart = false;

	/** After /build's plan is saved: post it as an issue and start, start without one, or keep planning. */
	async function askHowToStart(ctx: ExtensionContext): Promise<void> {
		if (workflow.phase !== "awaiting-implementation" || isAskingToStart) return;
		if (workflow.issue || !ctx.hasUI) {
			await startImplementation(ctx);
			return;
		}
		isAskingToStart = true;
		try {
			const canCreateIssue = await isGithubRepo(commandRunner(ctx));
			const choices = canCreateIssue ? Object.values(START_CHOICES) : [START_CHOICES.withoutIssue, START_CHOICES.keepPlanning];
			const choice = await ctx.ui.select(`Plan saved: ${workflow.planPath}. Do you agree with it?`, choices);
			if (workflow.phase !== "awaiting-implementation") return;
			if (choice === START_CHOICES.withoutIssue) await startImplementation(ctx);
			else if (choice === START_CHOICES.withIssue) await startWithPlanIssue(ctx);
			else if (choice === START_CHOICES.keepPlanning) {
				enterPhase({ phase: "plan", task: workflow.task }, ctx);
				ctx.ui.notify("Back to planning. Tell the planner what to change; saving the plan asks again.", "info");
			} else ctx.ui.notify("Plan kept. /build implement asks again, or keep talking to the planner.", "info");
		} finally {
			isAskingToStart = false;
		}
	}

	async function startWithPlanIssue(ctx: ExtensionContext): Promise<void> {
		if (workflow.phase !== "awaiting-implementation") return;
		const plan = readPlanFile(workflow.planPath);
		if (plan === undefined) return;
		const planIssue = await createPlanIssue(commandRunner(ctx), plan);
		if (!planIssue.ok) {
			notify(`${planIssue.error}. /build implement asks again.`, "error");
			return;
		}
		notify(`Created issue #${planIssue.value.number}: ${planIssue.value.url}`, "info");
		await startImplementation(ctx, planIssue.value);
	}

	let isShipping = false;

	/** After a passing /build review: one confirmation, then a new branch, a commit and a normal push. */
	async function confirmShipping(ctx: ExtensionContext): Promise<void> {
		if (workflow.phase !== "awaiting-ship" || isShipping || !ctx.hasUI) return;
		isShipping = true;
		try {
			const run = commandRunner(ctx);
			const plan = readPlanFile(workflow.planPath);
			const title = planTitle(plan ?? "");
			const files = await listFilesToShip(run);
			const branch = await shipBranchName(run, title, workflow.planIssue);
			if (!files.ok || !branch.ok) {
				ctx.ui.notify(`${files.ok ? "" : files.error}${branch.ok ? "" : branch.error}. /build ship tries again.`, "error");
				return;
			}
			if (files.value.length === 0) {
				stopWorkflow(ctx, "the review passed, but there are no changes to ship");
				return;
			}
			const listed = files.value.slice(0, MAX_SHIP_FILES_LISTED).map((path) => `  ${path}`);
			const more = files.value.length > MAX_SHIP_FILES_LISTED ? [`  … and ${files.value.length - MAX_SHIP_FILES_LISTED} more`] : [];
			const message = [
				`Creates branch ${branch.value} from the current HEAD, commits these ${files.value.length} files and pushes the`,
				"branch to origin. No merge, no force push.",
				"",
				...listed,
				...more,
			].join("\n");
			if (!(await ctx.ui.confirm("Review passed. Ship it?", message))) {
				ctx.ui.notify("Not shipped. /build ship when you are ready; /build stop ends the run.", "info");
				return;
			}
			const shipped = await shipWork(run, { branch: branch.value, commitMessage: shipCommitMessage(title, workflow.planIssue) });
			if (!shipped.ok) {
				ctx.ui.notify(`${shipped.error}. Fix it and run /build ship again.`, "error");
				return;
			}
			const closes = workflow.planIssue ? `; merging it closes issue #${workflow.planIssue.number}` : "";
			stopWorkflow(ctx, `shipped on branch ${shipped.value}, pushed to origin${closes}`);
		} finally {
			isShipping = false;
		}
	}

	/** /build implement: start an agreed plan by hand, or restart the subagent a reload interrupted. */
	async function startOrResumeImplementation(ctx: ExtensionCommandContext): Promise<void> {
		if (workflow.phase === "awaiting-implementation") {
			await askHowToStart(ctx);
			return;
		}
		if (!isDelegatedPhase(workflow.phase)) {
			const hint = workflow.phase === "plan" ? "agree on the plan first, so the planner saves it" : "start with /build <task>";
			ctx.ui.notify(`No agreed plan to implement yet: ${hint}`, "warning");
			return;
		}
		if (orchestrator.liveStages().length > 0) {
			ctx.ui.notify("The run is already going; Alt+A shows it", "info");
			return;
		}
		if (orchestrator.resume()) ctx.ui.notify(`Resumed the ${workflow.phase} phase`, "info");
	}

	function stopWorkflow(ctx: ExtensionContext, summary: string): void {
		orchestrator.stop();
		enterPhase(IDLE_WORKFLOW, ctx);
		if (ctx.hasUI) ctx.ui.notify(`Build workflow finished: ${summary}. Back to normal auto routing.`, "info");
	}

	function promptForPullRequest(ctx: ExtensionContext): void {
		if (!ctx.hasUI || workflow.phase !== "awaiting-pr") return;
		ctx.ui.setEditorText("/issue pr");
		ctx.ui.notify(
			`Review passed. Press Enter to commit, push ${workflow.issue.branch} and open a draft PR fixing #${workflow.issue.number}.`,
			"info",
		);
	}

	async function startIssueWorkflow(issueText: string, ctx: ExtensionCommandContext): Promise<void> {
		const issueArgument = parseIssueArgument(issueText);
		if (!issueArgument) {
			ctx.ui.notify(ISSUE_USAGE, "warning");
			return;
		}
		const run: RunCommand = (command, args) => pi.exec(command, args, { cwd: ctx.cwd });
		const issue = await fetchIssue(run, issueArgument);
		if (!issue.ok) {
			ctx.ui.notify(issue.error, "error");
			return;
		}
		if (!(await useAutoModel(ctx))) return;
		const issueRef = await createIssueBranch(run, issue.value);
		if (!issueRef.ok) {
			ctx.ui.notify(issueRef.error, "error");
			return;
		}
		ctx.ui.notify(`On new branch ${issueRef.value.branch} from origin/${issueRef.value.baseBranch}`, "info");
		enterPhase({ phase: "plan", task: `Fix issue #${issue.value.number}: ${issue.value.title}`, issue: issueRef.value }, ctx);
		pi.sendUserMessage(issueInvestigationPrompt(issue.value, issueRef.value.branch));
	}

	async function openPullRequest(ctx: ExtensionCommandContext): Promise<void> {
		if (workflow.phase !== "awaiting-pr") {
			ctx.ui.notify("No reviewed issue fix to open a PR for; /issue <issue> starts one", "warning");
			return;
		}
		const { issue, planPath } = workflow;
		let plan: string;
		try {
			plan = readFileSync(planPath, "utf8");
		} catch (error) {
			ctx.ui.notify(`Failed to read the agreed plan ${planPath}: ${(error as Error).message}`, "error");
			return;
		}
		const run: RunCommand = (command, args) => pi.exec(command, args, { cwd: ctx.cwd });
		const pullRequest = await openDraftPullRequest(run, issue, plan);
		if (!pullRequest.ok) {
			ctx.ui.notify(`${pullRequest.error}. Fix it and run /issue pr again.`, "error");
			return;
		}
		stopWorkflow(ctx, `draft PR opened: ${pullRequest.value}`);
	}

	pi.on("session_start", (_event, ctx) => {
		workflow = findWorkflowState(ctx.sessionManager.getBranch());
		hasSuggestedWorkflow = false;
		sessionCtx = ctx;
		showPhase(ctx);
		if (isDelegatedPhase(workflow.phase) && ctx.hasUI) {
			ctx.ui.notify(`/build was interrupted in the ${workflow.phase} phase; /build implement resumes it`, "warning");
		}
	});

	pi.on("session_shutdown", () => {
		orchestrator.stop();
	});

	pi.on("tool_call", (event) => {
		if (canPlannerEditFiles(workflow.phase) || !FILE_EDITING_TOOLS.has(event.toolName)) return undefined;
		const reason = isDelegatedPhase(workflow.phase)
			? "/build: the implementer subagent edits the files; send it a message from Alt+A or answer its question instead"
			: `/build ${workflow.phase} phase: only the implementer edits files`;
		return { block: true, reason };
	});

	pi.on("tool_execution_end", (event, ctx) => {
		if (event.toolName !== SAVE_PLAN_TOOL_NAME || event.isError) return;
		if (workflow.phase !== "plan" && workflow.phase !== "awaiting-implementation") return;
		const planPath = (event.result?.details as { planPath?: unknown } | undefined)?.planPath;
		if (typeof planPath !== "string") return;
		enterPhase({ phase: "awaiting-implementation", task: workflow.task, planPath, issue: workflow.issue }, ctx);
	});

	pi.on("agent_settled", (event, ctx) => {
		if (event.aborted || workflow.phase === "idle") return;
		if (workflow.phase === "awaiting-implementation") {
			void askHowToStart(ctx);
			return;
		}
		if (workflow.phase === "awaiting-pr") {
			promptForPullRequest(ctx);
			return;
		}
		if (isDelegatedPhase(workflow.phase)) orchestrator.handlePlannerReply(lastAssistantText(ctx));
	});

	// Event-bus messages carry no context, so the suggestion uses the current session's.
	pi.events.on(TASK_KIND_EVENT, (taskKind) => {
		if (workflow.phase !== "idle" || hasSuggestedWorkflow || !FEATURE_TASK_KINDS.has(taskKind as TaskKind)) return;
		if (!sessionCtx?.hasUI) return;
		hasSuggestedWorkflow = true;
		sessionCtx.ui.notify(WORKFLOW_SUGGESTION, "info");
	});

	pi.registerCommand("build", {
		description:
			"Plan (expert) -> optional GitHub issue -> implementer subagent -> Claude + OpenAI reviewer subagents (expert) -> ship: /build <task> | implement | ship | status | stop",
		handler: async (args, ctx) => {
			const argument = args.trim();
			switch (argument) {
				case "":
					ctx.ui.notify(USAGE, "info");
					return;
				case "status":
					ctx.ui.notify(workflow.phase === "idle" ? "No build workflow running" : phaseLabel(workflow), "info");
					return;
				case "stop":
					if (workflow.phase === "idle") ctx.ui.notify("No build workflow running", "info");
					else stopWorkflow(ctx, "stopped");
					return;
				case "implement":
					await startOrResumeImplementation(ctx);
					return;
				case "ship":
					if (workflow.phase === "awaiting-ship") await confirmShipping(ctx);
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
				await openPullRequest(ctx);
				return;
			}
			if (workflow.phase !== "idle") {
				ctx.ui.notify(`A build workflow is running (${phaseLabel(workflow)}); /build stop first`, "warning");
				return;
			}
			await startIssueWorkflow(argument, ctx);
		},
	});
}
