import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ProjectCheck, ProjectChecks } from "./project-checks.ts";

/** The end of the output carries the error summary; this keeps the agent's context small. */
const MAX_FAILURE_OUTPUT_CHARS = 4_000;

export type CheckRun =
	| { kind: "passed"; passedNames: string[] }
	| { kind: "failed"; passedNames: string[]; failedCheck: ProjectCheck; exitCode: number; timedOut: boolean; outputTail: string };

/** Runs the checks in order and stops at the first failure, so the agent fixes one problem at a time. */
export async function runProjectChecks(
	pi: ExtensionAPI,
	projectChecks: ProjectChecks,
	onCheckStart: (check: ProjectCheck) => void,
): Promise<CheckRun> {
	const passedNames: string[] = [];
	for (const check of projectChecks.checks) {
		onCheckStart(check);
		// CI=1 keeps test runners such as vitest and jest out of watch mode.
		const result = await pi.exec("sh", ["-c", `CI=1; export CI; ${check.command}`], {
			cwd: projectChecks.workingDir,
			timeout: projectChecks.timeoutMs,
		});
		if (result.code !== 0 || result.killed) {
			const output = `${result.stdout}\n${result.stderr}`.trim();
			return {
				kind: "failed",
				passedNames,
				failedCheck: check,
				exitCode: result.code,
				timedOut: result.killed,
				outputTail: output.slice(-MAX_FAILURE_OUTPUT_CHARS),
			};
		}
		passedNames.push(check.name);
	}
	return { kind: "passed", passedNames };
}

export function describeFailedCheck(run: Extract<CheckRun, { kind: "failed" }>, timeoutMs: number): string {
	const outcome = run.timedOut ? `timed out after ${Math.round(timeoutMs / 1000)}s` : `exited with code ${run.exitCode}`;
	return `\`${run.failedCheck.command}\` (${run.failedCheck.name}) ${outcome}`;
}
