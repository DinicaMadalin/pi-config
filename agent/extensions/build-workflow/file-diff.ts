/**
 * One file's diff since the build's base commit, parsed into numbered lines for the diff view.
 * Tracked files come from `git diff <base> -- <path>`; new untracked files are diffed against /dev/null.
 */
import type { RunCommand } from "./github-issue.ts";
import type { FileChange } from "./work-changes.ts";

export type DiffLine =
	| { kind: "hunk"; text: string }
	| { kind: "added"; newNumber: number; text: string }
	| { kind: "removed"; oldNumber: number; text: string }
	| { kind: "context"; oldNumber: number; newNumber: number; text: string }
	/** "\ No newline at end of file", "Binary files differ", or a cut-off note. */
	| { kind: "note"; text: string };

export interface FileDiff {
	path: string;
	lines: DiffLine[];
}

export type FileDiffResult = { ok: true; value: FileDiff } | { ok: false; error: string };

/** A diff this long is cut, so a generated file cannot freeze the view. */
export const MAX_DIFF_LINES = 5000;
const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/;
/** Tabs would break column math; four spaces is what most editors show. */
const TAB_AS_SPACES = "    ";

function displayText(line: string): string {
	return line.replaceAll("\t", TAB_AS_SPACES).replace(/\r$/, "");
}

/** Parses `git diff` output for one file; file headers (diff --git, index, ---, +++) are dropped. */
export function parseUnifiedDiff(diffText: string): DiffLine[] {
	const lines: DiffLine[] = [];
	let oldNumber = 0;
	let newNumber = 0;
	let isInHunk = false;
	for (const rawLine of diffText.split("\n")) {
		const hunk = HUNK_HEADER.exec(rawLine);
		if (hunk) {
			oldNumber = Number(hunk[1]);
			newNumber = Number(hunk[2]);
			isInHunk = true;
			lines.push({ kind: "hunk", text: displayText(rawLine) });
			continue;
		}
		if (!isInHunk) {
			if (rawLine.startsWith("Binary files")) lines.push({ kind: "note", text: rawLine });
			continue;
		}
		const text = displayText(rawLine.slice(1));
		if (rawLine.startsWith("+")) lines.push({ kind: "added", newNumber: newNumber++, text });
		else if (rawLine.startsWith("-")) lines.push({ kind: "removed", oldNumber: oldNumber++, text });
		else if (rawLine.startsWith(" ")) lines.push({ kind: "context", oldNumber: oldNumber++, newNumber: newNumber++, text });
		else if (rawLine.startsWith("\\")) lines.push({ kind: "note", text: rawLine.slice(2) });
		else if (rawLine.startsWith("diff --git")) isInHunk = false;
	}
	if (lines.length <= MAX_DIFF_LINES) return lines;
	return [...lines.slice(0, MAX_DIFF_LINES), { kind: "note", text: `diff cut at ${MAX_DIFF_LINES} lines` }];
}

export async function loadFileDiff(run: RunCommand, baseCommit: string, file: FileChange): Promise<FileDiffResult> {
	const root = await run("git", ["rev-parse", "--show-toplevel"]);
	if (root.code !== 0) return { ok: false, error: `Not a git repository: ${root.stderr.trim()}` };
	const repoRoot = root.stdout.trim();
	const diffArgs = file.isNew
		? ["-C", repoRoot, "diff", "--no-color", "--no-ext-diff", "--no-index", "--", "/dev/null", file.path]
		: ["-C", repoRoot, "diff", "--no-color", "--no-ext-diff", baseCommit, "--", file.path];
	const diff = await run("git", diffArgs);
	// --no-index exits 1 when the files differ, which for a new file is always.
	const isDiffShown = diff.code === 0 || (file.isNew && diff.code === 1);
	if (!isDiffShown) return { ok: false, error: `git diff of ${file.path} failed: ${diff.stderr.trim()}` };
	const lines = parseUnifiedDiff(diff.stdout);
	if (lines.length === 0) lines.push({ kind: "note", text: "no changes left in this file" });
	return { ok: true, value: { path: file.path, lines } };
}
