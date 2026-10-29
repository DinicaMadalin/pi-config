/**
 * Quality gate: the project's typecheck, lint, and test commands guard "done" and "ship".
 *
 * - Auto-verify: when the agent finishes a prompt that changed files, the checks run. A failure
 *   goes back to the agent to fix (at most two fix rounds per prompt); a pass is a short notice.
 * - /checks: show and run the checks now. /checks off|on toggles auto-verify for this session.
 * - /ship: run the checks, then have the agent review the diff, commit in the repo's style, and push.
 *
 * Checks come from <repo>/.pi/checks.json, else package.json scripts, else Makefile targets.
 */
import { createHash } from "node:crypto";
import type { AgentBeforeSettleEvent, BoundaryResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type CheckRun, describeFailedCheck, runProjectChecks } from "./check-runner.ts";
import { CHECKS_CONFIG_RELATIVE_PATH, findProjectChecks, type ProjectChecks } from "./project-checks.ts";

const MAX_FIX_ROUNDS_PER_PROMPT = 2;
const STATUS_KEY = "checks";
const FILE_EDITING_TOOLS = new Set(["edit", "write"]);
const FAILURE_MESSAGE_TYPE = "quality-gate-failure";

/** One user prompt from input until Pi settles, including the fix rounds this extension adds. */
interface PromptCycle {
	/** Hash of `git status` + `git diff HEAD` when the prompt arrived; undefined outside a git repo. */
	workingTreeAtStart?: string;
	editedFilesWithTools: boolean;
	fixRounds: number;
	/** A /ship prompt commits files; verifying its own commit would be noise. */
	isShipping: boolean;
}

const SHIP_PROMPT = (passedChecks: string) =>
	[
		`Ship the current work. ${passedChecks}`,
		"1. Run `git status` and `git diff` and review every change.",
		"2. Stage only changes that belong to the work done in this session. Leave unrelated changes unstaged and list them in your reply.",
		"3. Write the commit message in the style of `git log --oneline -10`: a short summary line, plus a brief body when the why is not obvious.",
		"4. Commit, then push the current branch, setting the upstream if it has none.",
		"Never force push, amend, or rewrite existing commits. If the push is rejected, stop and report why.",
	].join("\n");

async function snapshotWorkingTree(pi: ExtensionAPI, cwd: string): Promise<string | undefined> {
	const status = await pi.exec("git", ["status", "--porcelain=v1", "-uall"], { cwd });
	if (status.code !== 0) return undefined;
	const diff = await pi.exec("git", ["diff", "HEAD", "--no-ext-diff"], { cwd });
	return createHash("sha256").update(status.stdout).update(diff.stdout).digest("hex");
}

async function hasChangedFiles(pi: ExtensionAPI, cycle: PromptCycle, cwd: string): Promise<boolean> {
	if (cycle.editedFilesWithTools) return true;
	if (cycle.workingTreeAtStart === undefined) return false;
	return (await snapshotWorkingTree(pi, cwd)) !== cycle.workingTreeAtStart;
}

function describeChecks(projectChecks: ProjectChecks): string {
	if (projectChecks.checks.length === 0) {
		return `No checks found. Add package.json scripts (typecheck, lint, test) or ${CHECKS_CONFIG_RELATIVE_PATH}:\n{ "checks": [{ "name": "test", "command": "npm test" }] }`;
	}
	const lines = projectChecks.checks.map((check) => `  ${check.name}: ${check.command}`);
	return [`Checks from ${projectChecks.source} (run in ${projectChecks.workingDir}):`, ...lines].join("\n");
}

export default function (pi: ExtensionAPI) {
	let cycle: PromptCycle | undefined;
	let isShipRequested = false;
	/** Session override from /checks on|off; undefined follows the project's autoVerify setting. */
	let autoVerifyOverride: boolean | undefined;

	async function runChecksWithStatus(projectChecks: ProjectChecks, ctx: ExtensionContext): Promise<CheckRun> {
		try {
			return await runProjectChecks(pi, projectChecks, (check) => ctx.ui.setStatus(STATUS_KEY, `checks: ${check.name}…`));
		} finally {
			ctx.ui.setStatus(STATUS_KEY, undefined);
		}
	}

	async function verifyBeforeSettle(event: AgentBeforeSettleEvent, ctx: ExtensionContext): Promise<BoundaryResult | undefined> {
		if (event.outcome !== "completed" || !cycle || cycle.isShipping) return undefined;
		const projectChecks = findProjectChecks(ctx.cwd);
		if (!(autoVerifyOverride ?? projectChecks.autoVerify) || projectChecks.checks.length === 0) return undefined;
		if (!(await hasChangedFiles(pi, cycle, ctx.cwd))) return undefined;

		const run = await runChecksWithStatus(projectChecks, ctx);
		if (run.kind === "passed") {
			ctx.ui.notify(`Checks passed: ${run.passedNames.join(", ")}`, "info");
			return undefined;
		}
		const failure = describeFailedCheck(run, projectChecks.timeoutMs);
		if (cycle.fixRounds >= MAX_FIX_ROUNDS_PER_PROMPT) {
			ctx.ui.notify(`Checks still failing after ${MAX_FIX_ROUNDS_PER_PROMPT} fix rounds: ${failure}`, "error");
			return undefined;
		}
		cycle.fixRounds++;
		const content = `Project checks failed after your changes: ${failure}. Fix the cause (never skip or loosen the check), then stop.\n\n\`\`\`\n${run.outputTail}\n\`\`\``;
		return { entries: [{ type: "custom_message", customType: FAILURE_MESSAGE_TYPE, content, display: true }], continue: true };
	}

	pi.on("input", async (_event, ctx) => {
		if (cycle) return; // a steer or follow-up joins the running prompt
		cycle = {
			workingTreeAtStart: await snapshotWorkingTree(pi, ctx.cwd),
			editedFilesWithTools: false,
			fixRounds: 0,
			isShipping: isShipRequested,
		};
		isShipRequested = false;
	});

	pi.on("tool_execution_end", (event) => {
		if (cycle && !event.isError && FILE_EDITING_TOOLS.has(event.toolName)) cycle.editedFilesWithTools = true;
	});

	pi.on("agent_before_settle", verifyBeforeSettle);

	pi.on("agent_settled", () => {
		cycle = undefined;
		isShipRequested = false;
	});

	pi.registerCommand("checks", {
		description: "Run the project's checks now; /checks off|on toggles running them after the agent changes files",
		handler: async (args, ctx) => {
			const toggle = args.trim().toLowerCase();
			if (toggle === "on" || toggle === "off") {
				autoVerifyOverride = toggle === "on";
				ctx.ui.notify(`Auto-verify ${toggle} for this session`, "info");
				return;
			}
			const projectChecks = findProjectChecks(ctx.cwd);
			ctx.ui.notify(describeChecks(projectChecks), "info");
			if (projectChecks.checks.length === 0) return;
			const run = await runChecksWithStatus(projectChecks, ctx);
			if (run.kind === "passed") {
				ctx.ui.notify(`Checks passed: ${run.passedNames.join(", ")}`, "info");
			} else {
				ctx.ui.notify(`Check failed: ${describeFailedCheck(run, projectChecks.timeoutMs)}\n${run.outputTail.slice(-1500)}`, "error");
			}
		},
	});

	pi.registerCommand("ship", {
		description: "Run the checks, then commit the session's work in the repo's style and push",
		handler: async (_args, ctx) => {
			if (!ctx.isIdle()) {
				ctx.ui.notify("Wait for the agent to finish, then /ship", "warning");
				return;
			}
			const status = await pi.exec("git", ["status", "--porcelain"], { cwd: ctx.cwd });
			if (status.code !== 0) {
				ctx.ui.notify(`/ship needs a git repository: ${status.stderr.trim()}`, "error");
				return;
			}
			if (!status.stdout.trim()) {
				ctx.ui.notify("Nothing to ship: the working tree is clean", "info");
				return;
			}
			const projectChecks = findProjectChecks(ctx.cwd);
			const run = await runChecksWithStatus(projectChecks, ctx);
			if (run.kind === "failed") {
				ctx.ui.notify(`Not shipping, a check failed: ${describeFailedCheck(run, projectChecks.timeoutMs)}`, "error");
				return;
			}
			const passedChecks = run.passedNames.length > 0 ? `Checks already passed: ${run.passedNames.join(", ")}.` : "This project has no checks configured.";
			isShipRequested = true;
			pi.sendUserMessage(SHIP_PROMPT(passedChecks));
		},
	});
}
