/**
 * Lines added and removed since the build's base commit: tracked changes from git diff, plus new
 * untracked files counted line by line (git diff leaves them out).
 */
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { RunCommand } from "./github-issue.ts";

export interface FileChange {
	path: string;
	added: number;
	removed: number;
	isBinary: boolean;
	isNew: boolean;
}

export interface WorkChanges {
	files: FileChange[];
	added: number;
	removed: number;
}

export type WorkChangesResult = { ok: true; value: WorkChanges } | { ok: false; error: string };

/** Untracked files beyond this are listed without line counts, so a stray build folder stays cheap. */
const MAX_UNTRACKED_FILES_COUNTED = 200;
const MAX_COUNTED_FILE_BYTES = 2_000_000;
const BINARY_SNIFF_BYTES = 8000;

/** Parses `git diff --numstat`: "added<TAB>removed<TAB>path", with "-" counts for binary files. */
export function parseNumstat(numstat: string): FileChange[] {
	return numstat
		.split("\n")
		.filter((line) => line.trim() !== "")
		.map((line) => {
			const [addedText, removedText, ...pathParts] = line.split("\t");
			const isBinary = addedText === "-";
			return {
				path: pathParts.join("\t"),
				added: isBinary ? 0 : Number(addedText),
				removed: isBinary ? 0 : Number(removedText),
				isBinary,
				isNew: false,
			};
		});
}

function countNewFileLines(repoRoot: string, path: string, shouldCount: boolean): FileChange {
	const uncounted: FileChange = { path, added: 0, removed: 0, isBinary: false, isNew: true };
	if (!shouldCount) return uncounted;
	const fullPath = join(repoRoot, path);
	try {
		if (statSync(fullPath).size > MAX_COUNTED_FILE_BYTES) return uncounted;
		const content = readFileSync(fullPath);
		if (content.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return { ...uncounted, isBinary: true };
		const text = content.toString("utf8");
		const lineCount = text === "" ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
		return { ...uncounted, added: lineCount };
	} catch {
		// Deleted between git listing it and reading it: show it without a count.
		return uncounted;
	}
}

/** Biggest changes first. */
export async function loadWorkChanges(run: RunCommand, baseCommit: string): Promise<WorkChangesResult> {
	const root = await run("git", ["rev-parse", "--show-toplevel"]);
	if (root.code !== 0) return { ok: false, error: `Not a git repository: ${root.stderr.trim()}` };
	const repoRoot = root.stdout.trim();
	const [diff, untracked] = await Promise.all([
		run("git", ["-C", repoRoot, "diff", "--numstat", baseCommit]),
		run("git", ["-C", repoRoot, "ls-files", "--others", "--exclude-standard"]),
	]);
	if (diff.code !== 0) return { ok: false, error: `git diff against ${baseCommit.slice(0, 7)} failed: ${diff.stderr.trim()}` };
	if (untracked.code !== 0) return { ok: false, error: `git ls-files failed: ${untracked.stderr.trim()}` };

	const untrackedPaths = untracked.stdout.split("\n").filter((path) => path !== "");
	const newFiles = untrackedPaths.map((path, index) => countNewFileLines(repoRoot, path, index < MAX_UNTRACKED_FILES_COUNTED));
	const files = [...parseNumstat(diff.stdout), ...newFiles].sort(
		(left, right) => right.added + right.removed - (left.added + left.removed),
	);
	return {
		ok: true,
		value: {
			files,
			added: files.reduce((total, file) => total + file.added, 0),
			removed: files.reduce((total, file) => total + file.removed, 0),
		},
	};
}
