import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { CheckResult } from "./check-baseline.ts";
import type { ProjectCheck, ProjectChecks } from "./project-checks.ts";
import { SUBAGENT_ENV_VAR } from "../build-workflow/workflow-state.ts";
import { isInsideHerdr } from "../herdr-tools/herdr-cli.ts";

/** Helpers keep their sole pane full-size; their checks use the background executor instead. */
export function canOpenChecksPane(env: NodeJS.ProcessEnv = process.env): boolean {
	return isInsideHerdr(env) && env[SUBAGENT_ENV_VAR] !== "1";
}

/** The end of the output carries the error summary; this keeps the agent's context small. */
const MAX_FAILURE_OUTPUT_CHARS = 4_000;

export type CheckRun =
	| { kind: "passed"; passedNames: string[] }
	| { kind: "failed"; passedNames: string[]; failedCheck: ProjectCheck; exitCode: number; timedOut: boolean; outputTail: string };

/** How one check command ended. */
export interface CheckOutcome {
	exitCode: number;
	timedOut: boolean;
	output: string;
}

/** Runs one check command: hidden in the background, or visibly in a herdr pane. */
export type CheckExecutor = (check: ProjectCheck, projectChecks: ProjectChecks) => Promise<CheckOutcome>;

/** The hidden run: Pi's exec, with CI=1 so test runners such as vitest and jest stay out of watch mode. */
export function backgroundCheckExecutor(pi: ExtensionAPI): CheckExecutor {
	return async (check, projectChecks) => {
		const result = await pi.exec("sh", ["-c", `CI=1; export CI; ${check.command}`], {
			cwd: projectChecks.workingDir,
			timeout: projectChecks.timeoutMs,
		});
		return { exitCode: result.code, timedOut: result.killed === true, output: `${result.stdout}\n${result.stderr}`.trim() };
	};
}

/** Runs the checks in order and stops at the first failure, so the agent fixes one problem at a time. */
export async function runProjectChecks(
	runCheck: CheckExecutor,
	projectChecks: ProjectChecks,
	onCheckStart: (check: ProjectCheck) => void,
): Promise<CheckRun> {
	const passedNames: string[] = [];
	for (const check of projectChecks.checks) {
		onCheckStart(check);
		const outcome = await runCheck(check, projectChecks);
		if (outcome.exitCode !== 0 || outcome.timedOut) {
			return {
				kind: "failed",
				passedNames,
				failedCheck: check,
				exitCode: outcome.exitCode,
				timedOut: outcome.timedOut,
				outputTail: outcome.output.slice(-MAX_FAILURE_OUTPUT_CHARS),
			};
		}
		passedNames.push(check.name);
	}
	return { kind: "passed", passedNames };
}

export function abortableCheckExecutor(pi: Pick<ExtensionAPI, "exec">, signal: AbortSignal): CheckExecutor {
	return async (check, projectChecks) => {
		signal.throwIfAborted();
		const result = await pi.exec("sh", ["-c", `CI=1; export CI; ${check.command}`], {
			cwd: projectChecks.workingDir,
			timeout: projectChecks.timeoutMs,
			signal,
		});
		return { exitCode: result.code, timedOut: result.killed === true, output: `${result.stdout}\n${result.stderr}`.trim() };
	};
}

export async function runEveryProjectCheck(
	runCheck: CheckExecutor,
	projectChecks: ProjectChecks,
	onCheckStart: (check: ProjectCheck) => void,
): Promise<CheckResult[]> {
	const results: CheckResult[] = [];
	for (const check of projectChecks.checks) {
		onCheckStart(check);
		const outcome = await runCheck(check, projectChecks);
		const passed = outcome.exitCode === 0 && !outcome.timedOut;
		results.push({
			name: check.name,
			command: check.command,
			passed,
			outputTail: passed ? "" : outcome.output.slice(-MAX_FAILURE_OUTPUT_CHARS) || (outcome.timedOut ? "timed out" : ""),
		});
	}
	return results;
}

export function describeFailedCheck(run: Extract<CheckRun, { kind: "failed" }>, timeoutMs: number): string {
	const outcome = run.timedOut ? `timed out after ${Math.round(timeoutMs / 1000)}s` : `exited with code ${run.exitCode}`;
	return `\`${run.failedCheck.command}\` (${run.failedCheck.name}) ${outcome}`;
}
