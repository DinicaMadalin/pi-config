/**
 * What the agent is told when a check fails after its changes. The agent owns only the failures its own
 * changes caused: problems that were already in the repo are reported to the user, not fixed, unless the
 * user asked for them to be fixed.
 */

/** True when the check output names one of the files the agent changed, by path or by file name. */
export function outputMentionsChangedFile(output: string, changedFiles: readonly string[]): boolean {
	return changedFiles.some((path) => {
		const fileName = path.split("/").at(-1) ?? path;
		return output.includes(path) || output.includes(fileName);
	});
}

export interface CheckFailure {
	/** e.g. "`npm run lint` (lint) exited with code 1" */
	description: string;
	outputTail: string;
	/** Repo-relative files changed since the prompt arrived. */
	changedFiles: readonly string[];
}

function changedFilesLine(changedFiles: readonly string[]): string {
	if (changedFiles.length === 0) return "Files changed in this prompt: none found by git.";
	return `Files changed in this prompt: ${changedFiles.join(", ")}.`;
}

export function checkFailureMessage(failure: CheckFailure): string {
	const looksPreExisting = !outputMentionsChangedFile(failure.outputTail, failure.changedFiles);
	return [
		`Project checks failed after your changes: ${failure.description}.`,
		changedFilesLine(failure.changedFiles),
		...(looksPreExisting
			? ["The output does not mention any of those files, so this failure may have been in the repo before your changes."]
			: []),
		"",
		"1. Decide which errors your changes caused (use `git diff` if unsure) and fix those at the cause. Never skip or loosen a check.",
		"2. Errors that were already in the repo before your changes are not your task: do not fix them unless I asked you to.",
		"   List them in your reply under \"Pre-existing problems\" (check, file:line, one-line summary) and say they were left as they were.",
		"3. Then stop.",
		"",
		"```",
		failure.outputTail,
		"```",
	].join("\n");
}
