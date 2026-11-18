/**
 * Inside herdr a /build or /issue run works in its own git worktree, opened as a herdr workspace: your checkout
 * stays as it is while the subagents build, and their panes sit in the run's workspace. Outside herdr runs work
 * in place, as before.
 */
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { HerdrClient } from "../herdr-tools/herdr-cli.ts";
import { commandError, type RunCommand, type StepResult } from "./github-issue.ts";
import type { RunWorktree } from "./workflow-state.ts";

const MAX_NAME_SUFFIX = 50;

/** Worktrees sit beside the repo in a hidden folder: ~/code/app -> ~/code/.app-worktrees/<name>. */
export function worktreePathFor(repoRoot: string, name: string, isTaken: (path: string) => boolean): string | undefined {
	const folder = join(dirname(repoRoot), `.${basename(repoRoot)}-worktrees`);
	for (let suffix = 1; suffix <= MAX_NAME_SUFFIX; suffix++) {
		const candidate = join(folder, suffix === 1 ? name : `${name}-${suffix}`);
		if (!isTaken(candidate)) return candidate;
	}
	return undefined;
}

export interface WorktreeRequest {
	/** Folder name and herdr workspace label, e.g. "issue-42" or "build-fix-eslint". */
	name: string;
	/** What to check out: a commit for /build, the fetched default branch for /issue. */
	startPoint: string;
	/** A branch to create at the start point; undefined checks it out detached (/build names its branch when shipping). */
	newBranch?: string;
}

/** Creates the worktree with git, then opens it in herdr; a failed open removes the worktree again. */
export async function createRunWorktree(run: RunCommand, herdr: HerdrClient, request: WorktreeRequest): Promise<StepResult<RunWorktree>> {
	const toplevel = await run("git", ["rev-parse", "--show-toplevel"]);
	if (toplevel.code !== 0) return { ok: false, error: commandError("find the repository root", toplevel) };
	const repoRoot = toplevel.stdout.trim();
	const path = worktreePathFor(repoRoot, request.name, existsSync);
	if (!path) return { ok: false, error: `Worktree folders for ${request.name} are all taken; remove old ones beside ${repoRoot}` };
	const branchArgs = request.newBranch ? ["--no-track", "-b", request.newBranch] : ["--detach"];
	const add = await run("git", ["worktree", "add", ...branchArgs, path, request.startPoint]);
	if (add.code !== 0) return { ok: false, error: commandError(`create the worktree ${path}`, add) };
	try {
		const opened = await herdr.openWorktree(repoRoot, path, request.name);
		return { ok: true, value: { path, workspaceId: opened.workspaceId, rootPaneId: opened.rootPaneId } };
	} catch (error) {
		const removal = await run("git", ["worktree", "remove", path]);
		const cleanup = removal.code === 0 ? "" : ` (and ${commandError(`remove ${path}`, removal)})`;
		return { ok: false, error: `${(error as Error).message}${cleanup}` };
	}
}

/** True when your checkout has changes the worktree will not see. */
export async function hasUncommittedChanges(run: RunCommand): Promise<boolean> {
	const status = await run("git", ["status", "--porcelain"]);
	return status.code === 0 && status.stdout.trim() !== "";
}
