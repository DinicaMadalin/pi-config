/**
 * Comparing check runs with a baseline: a /build run records which checks already failed when it began, and later
 * reports only the failures its own work added. Pure: running the checks is check-runner.ts's job.
 */

/** How one check ended in a full run. outputTail is empty for a check that passed. */
export interface CheckResult {
	name: string;
	command: string;
	passed: boolean;
	outputTail: string;
}

export function outputMentionsChangedFile(output: string, changedFiles: readonly string[]): boolean {
	return changedFiles.some((path) => output.includes(path) || output.includes(path.split("/").at(-1) ?? path));
}

export function findNewCheckFailures(baseline: readonly CheckResult[], current: readonly CheckResult[], changedFiles: readonly string[]): CheckResult[] {
	const baselineByName = new Map(baseline.map((result) => [result.name, result]));
	const newFailures: CheckResult[] = [];
	for (const result of current) {
		if (result.passed) continue;
		const baselineResult = baselineByName.get(result.name);
		if (!baselineResult || baselineResult.passed) {
			newFailures.push(result);
			continue;
		}
		const baselineLines = new Set(baselineResult.outputTail.split("\n").map((line) => line.trim()).filter(Boolean));
		const newLines = result.outputTail.split("\n").map((line) => line.trim()).filter((line) => line && !baselineLines.has(line));
		const changedLines = newLines.filter((line) => outputMentionsChangedFile(line, changedFiles));
		if (changedLines.length > 0) newFailures.push({ ...result, outputTail: changedLines.join("\n") });
	}
	return newFailures;
}

export function describeNewCheckFailures(failures: readonly CheckResult[]): string {
	return failures.map(({ command, name, outputTail }) => `\`${command}\` (${name}) fails:\n\`\`\`\n${outputTail}\n\`\`\``).join("\n\n");
}
