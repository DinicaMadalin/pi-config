/**
 * The project's checks as a /build run uses them: every check in the run's folder, never stopping at a failure,
 * so the run can compare with the baseline it recorded at its start (quality-gate/check-baseline.ts).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { CheckResult } from "../quality-gate/check-baseline.ts";
import { abortableCheckExecutor, runEveryProjectCheck } from "../quality-gate/check-runner.ts";
import { findProjectChecks } from "../quality-gate/project-checks.ts";

/** untrusted: Pi may not run the project's commands; no-checks: the project defines none. */
export type BuildCheckRun = { kind: "untrusted" } | { kind: "no-checks" } | { kind: "ran"; results: CheckResult[] };

export async function runBuildChecks(
	pi: Pick<ExtensionAPI, "exec">,
	workDir: string,
	isProjectTrusted: boolean,
	signal: AbortSignal,
	notify: (message: string) => void,
): Promise<BuildCheckRun> {
	if (!isProjectTrusted) return { kind: "untrusted" };
	const projectChecks = findProjectChecks(workDir);
	if (projectChecks.checks.length === 0) return { kind: "no-checks" };
	const results = await runEveryProjectCheck(abortableCheckExecutor(pi, signal), projectChecks, (check) => notify(`Checking: ${check.name}`));
	return { kind: "ran", results };
}

export async function listFilesChangedSince(
	pi: Pick<ExtensionAPI, "exec">,
	workDir: string,
	baseCommit: string | undefined,
	signal: AbortSignal,
): Promise<string[]> {
	const runGit = async (args: string[]): Promise<string> => {
		signal.throwIfAborted();
		const result = await pi.exec("git", args, { cwd: workDir, signal, timeout: 30_000 });
		if (result.code !== 0 || result.killed || result.truncated) {
			throw new Error(`Failed to list the run's changed files: git ${args[0]} ${result.stderr || result.stdout || "command killed or output truncated"}`);
		}
		return result.stdout;
	};
	const tracked = await runGit(["diff", "--name-only", baseCommit ?? "HEAD", "--"]);
	const untracked = await runGit(["ls-files", "--others", "--exclude-standard", "--full-name"]);
	return [...new Set([...tracked.split("\n"), ...untracked.split("\n")].map((path) => path.trim()).filter(Boolean))];
}
