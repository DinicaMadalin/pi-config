import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { CheckResult } from "../quality-gate/check-baseline.ts";
import { describeNewCheckFailures, findNewCheckFailures } from "../quality-gate/check-baseline.ts";
import { abortableCheckExecutor, runEveryProjectCheck } from "../quality-gate/check-runner.ts";
import { findProjectChecks } from "../quality-gate/project-checks.ts";
import { applyContractCleanup, prepareContractCleanup } from "./contract-cleanup.ts";

/** All helpers must be stopped before calling this gate; a failure leaves shipping disabled. */
export async function finalizeBuildContracts(
	pi: Pick<ExtensionAPI, "exec">,
	cwd: string,
	baseCommit: string | undefined,
	checkBaseline: readonly CheckResult[] | undefined,
	signal: AbortSignal,
	notify: (message: string) => void,
): Promise<string | undefined> {
	const checks = findProjectChecks(cwd);
	if (checks.checks.length === 0) return "No verification commands found; agree .pi/checks.json checks with the planner before retrying";
	const git = async (args: string[]): Promise<string> => {
		signal.throwIfAborted();
		const result = await pi.exec("git", args, { cwd, signal, timeout: 30_000 });
		if (result.code !== 0 || result.killed || result.truncated) {
			throw new Error(`Contract cleanup git ${args[0]} failed: ${result.stderr || result.stdout || "command killed or output truncated"}`);
		}
		return result.stdout;
	};
	const root = (await git(["rev-parse", "--show-toplevel"])).trim();
	const changed = await git(["diff", "--name-only", "--diff-filter=ACMR", "-z", baseCommit ?? "HEAD", "--"]);
	const untracked = await git(["ls-files", "--others", "--exclude-standard", "--full-name", "-z"]);
	const paths = `${changed}${untracked}`.split("\0").filter(Boolean);
	signal.throwIfAborted();
	const edits = prepareContractCleanup(root, paths);
	applyContractCleanup(edits);
	notify(`Removed temporary contracts from ${edits.length} files; verifying the clean work`);
	const results = await runEveryProjectCheck(abortableCheckExecutor(pi, signal), checks, (check) => notify(`Post-cleanup check: ${check.name}`));
	signal.throwIfAborted();
	const newFailures = findNewCheckFailures(checkBaseline ?? [], results, paths);
	if (newFailures.length > 0) return `New check failures since the run began:\n${describeNewCheckFailures(newFailures)}`;
	// Checks can generate files: never release a run that reintroduced temporary contracts.
	const remainingChanged = await git(["diff", "--name-only", "--diff-filter=ACMR", "-z", baseCommit ?? "HEAD", "--"]);
	const remainingUntracked = await git(["ls-files", "--others", "--exclude-standard", "--full-name", "-z"]);
	const remaining = prepareContractCleanup(root, `${remainingChanged}${remainingUntracked}`.split("\0").filter(Boolean));
	if (remaining.length > 0) return `Checks reintroduced temporary contracts: ${remaining.map((edit) => edit.path).join(", ")}`;
	return undefined;
}
