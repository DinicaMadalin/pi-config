/**
 * Quality gate: checks run on demand with /checks, before /ship, and inside /build at its start (baseline), after the
 * implementers and before shipping. Checks come from <repo>/.pi/checks.json, else package.json scripts, else Makefile.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { HerdrClient } from "../herdr-tools/herdr-cli.ts";
import { CommandPane } from "../herdr-tools/command-pane.ts";
import { backgroundCheckExecutor, canOpenChecksPane, type CheckExecutor, type CheckRun, describeFailedCheck, runProjectChecks } from "./check-runner.ts";
import { CHECKS_CONFIG_RELATIVE_PATH, findProjectChecks, type ProjectChecks } from "./project-checks.ts";

const STATUS_KEY = "checks";

const SHIP_PROMPT = (passedChecks: string) =>
	[
		`Ship the current work. ${passedChecks}`,
		"1. Run `git status` and `git diff` and review every change.",
		"2. Stage only changes that belong to the work done in this session. Leave unrelated changes unstaged and list them in your reply.",
		"3. Write the commit message in the style of `git log --oneline -10`: a short summary line, plus a brief body when the why is not obvious.",
		"4. Commit, then push the current branch, setting the upstream if it has none.",
		"Never force push, amend, or rewrite existing commits. If the push is rejected, stop and report why.",
	].join("\n");

function describeChecks(projectChecks: ProjectChecks): string {
	if (projectChecks.checks.length === 0) {
		return `No checks found. Add package.json scripts (typecheck, lint, test) or ${CHECKS_CONFIG_RELATIVE_PATH}:\n{ "checks": [{ "name": "test", "command": "npm test" }] }`;
	}
	const lines = projectChecks.checks.map((check) => `  ${check.name}: ${check.command}`);
	return [`Checks from ${projectChecks.source} (run in ${projectChecks.workingDir}):`, ...lines].join("\n");
}

export default function (pi: ExtensionAPI) {
	const runInBackground = backgroundCheckExecutor(pi);
	const herdrPaneId = process.env.HERDR_PANE_ID;
	const checksPane = canOpenChecksPane() && herdrPaneId ? new CommandPane(new HerdrClient(), herdrPaneId, "down") : undefined;

	function checkExecutorFor(ctx: ExtensionContext): CheckExecutor {
		if (!checksPane) return runInBackground;
		return async (check, projectChecks) => {
			try {
				return await checksPane.run({
					title: `${check.name}: ${check.command}`,
					argv: ["env", "CI=1", "sh", "-c", check.command],
					cwd: projectChecks.workingDir,
					timeoutMs: projectChecks.timeoutMs,
				});
			} catch (error) {
				ctx.ui.notify(`Running ${check.name} in the background: ${(error as Error).message}`, "warning");
				return runInBackground(check, projectChecks);
			}
		};
	}

	async function runChecksWithStatus(projectChecks: ProjectChecks, ctx: ExtensionContext): Promise<CheckRun> {
		try {
			return await runProjectChecks(checkExecutorFor(ctx), projectChecks, (check) => {
				ctx.ui.setStatus(STATUS_KEY, `checks: ${check.name}…`);
			});
		} finally {
			ctx.ui.setStatus(STATUS_KEY, undefined);
		}
	}

	pi.on("session_shutdown", async (_event, ctx) => {
		await checksPane?.close().catch((error: unknown) => ctx.ui.notify(`Could not close the checks pane: ${(error as Error).message}`, "warning"));
	});

	pi.registerCommand("checks", {
		description: "Run the project's checks now",
		handler: async (_args, ctx) => {
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
			pi.sendUserMessage(SHIP_PROMPT(passedChecks));
		},
	});
}
