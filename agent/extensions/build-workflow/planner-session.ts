/**
 * The planner's side of a /build run: your Pi session, the run's state stored in it, and the small services the
 * workflow steps share (notices, commands in the repo, the plan file). One instance per extension load.
 */
import { readFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ROUTE_PIN_ENTRY_TYPE, type RoutePin } from "../auto-model/route-pin.ts";
import { HerdrClient, isInsideHerdr } from "../herdr-tools/herdr-cli.ts";
import type { RunCommand } from "./github-issue.ts";
import {
	findPlannerWorkflowState,
	IDLE_WORKFLOW,
	isAwaitingUser,
	plannerRouteForPhase,
	runWorktreeOf,
	WORKFLOW_STATE_ENTRY_TYPE,
	type WorkflowPhase,
	type WorkflowState,
} from "./workflow-state.ts";

const STATUS_KEY = "build";

const PHASE_LABELS: Record<WorkflowPhase, string> = {
	idle: "",
	plan: "plan (expert)",
	"awaiting-implementation": "plan agreed",
	design: "designer preparing contracts (expert)",
	cleanup: "removing contracts and checking clean files",
	"cleanup-failed": "cleanup/checks blocked shipping · /build implement retries",
	implement: "implementing",
	review: "reviewers working",
	fix: "implementer fixing",
	"re-review": "reviewers re-reviewing",
	"review-failed": "re-review has findings, your call",
	"awaiting-pr": "review passed, /issue pr",
	"awaiting-ship": "review passed, /build ship",
};

/** "build: implementing", "issue #42: investigate (expert)"; empty when idle. */
export function phaseLabel(state: WorkflowState): string {
	if (state.phase === "idle") return "";
	const prefix = state.issue ? `issue #${state.issue.number}` : "build";
	const label = state.phase === "plan" && state.issue ? "investigate (expert)" : PHASE_LABELS[state.phase];
	return `${prefix}: ${label}`;
}

export type NoticeLevel = "info" | "warning" | "error";

const AWAITING_USER_PINGS: Partial<Record<WorkflowPhase, string>> = {
	"review-failed": "The re-review still has findings: your call",
	"awaiting-pr": "Review passed: /issue pr opens the draft PR",
	"awaiting-ship": "Review passed: ready to ship",
};

export class PlannerSession {
	readonly pi: ExtensionAPI;
	/** Undefined outside herdr: no pings, no panes, no worktrees. */
	readonly herdr: HerdrClient | undefined = isInsideHerdr() ? new HerdrClient() : undefined;
	private workflowState: WorkflowState = IDLE_WORKFLOW;
	private ctx: ExtensionContext | undefined;

	constructor(pi: ExtensionAPI) {
		this.pi = pi;
	}

	get workflow(): WorkflowState {
		return this.workflowState;
	}

	/** The current session's context; event-bus messages and subagent callbacks carry none of their own. */
	get context(): ExtensionContext {
		if (!this.ctx) throw new Error("/build: no session is active");
		return this.ctx;
	}

	get hasUI(): boolean {
		return this.ctx?.hasUI === true;
	}

	/** A new or reloaded session: the run continues from the state stored in it. */
	attach(ctx: ExtensionContext): void {
		this.ctx = ctx;
		this.workflowState = findPlannerWorkflowState(ctx.sessionManager.getBranch());
		this.showPhase();
	}

	/** Persists the phase and pins the planner's route, so a reload or the next prompt continues the same phase. */
	enterPhase(next: WorkflowState): void {
		this.workflowState = next;
		this.pi.appendEntry(WORKFLOW_STATE_ENTRY_TYPE, next);
		this.pi.appendEntry<RoutePin>(ROUTE_PIN_ENTRY_TYPE, plannerRouteForPhase(next.phase));
		this.showPhase();
		const ping = isAwaitingUser(next.phase) ? AWAITING_USER_PINGS[next.phase] : undefined;
		if (ping) this.ping(ping);
	}

	notify(message: string, level: NoticeLevel): void {
		if (this.ctx?.hasUI) this.ctx.ui.notify(message, level);
	}

	/** A herdr notification with a sound, for moments the run waits on you; nothing outside herdr. */
	ping(message: string): void {
		if (!this.herdr) return;
		const prefix = phaseLabel(this.workflowState).split(":")[0] || "build";
		this.herdr.showNotification(`Pi ${prefix}`, message, "request").catch((error: unknown) => {
			this.notify(`${(error as Error).message}; ${message}`, "warning");
		});
	}

	/** Notice plus ping: the run cannot go on without you. */
	callUser(message: string): void {
		this.notify(message, "info");
		this.ping(message);
	}

	/** Where the run's files are: its worktree, else the session's directory. */
	get workDir(): string {
		return runWorktreeOf(this.workflowState)?.path ?? this.context.cwd;
	}

	/** Runs a command in the run's work directory. */
	readonly run: RunCommand = (command, args) => this.pi.exec(command, args, { cwd: this.workDir });

	/** Runs a command in the session's own directory, e.g. to create a worktree of it. */
	readonly runInSessionDir: RunCommand = (command, args) => this.pi.exec(command, args, { cwd: this.context.cwd });

	/** The plan file's text; a failure is shown and returns undefined. */
	readPlan(planPath: string): string | undefined {
		try {
			return readFileSync(planPath, "utf8");
		} catch (error) {
			this.notify(`Failed to read the agreed plan ${planPath}: ${(error as Error).message}`, "error");
			return undefined;
		}
	}

	/** A turn for the planner; queued behind whatever it is doing for you. */
	sendToPlanner(message: string): void {
		if (this.context.isIdle()) this.pi.sendUserMessage(message);
		else this.pi.sendUserMessage(message, { deliverAs: "followUp" });
	}

	private showPhase(): void {
		if (this.ctx?.hasUI) this.ctx.ui.setStatus(STATUS_KEY, phaseLabel(this.workflowState) || undefined);
	}
}
