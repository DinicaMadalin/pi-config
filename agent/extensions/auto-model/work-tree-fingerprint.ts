/**
 * A cheap fingerprint of a git work tree: HEAD, the status of every changed or untracked path, and each such path's
 * size and modification time. Two equal fingerprints mean no file was changed in between, whichever tool wrote it.
 */
import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { join } from "node:path";

interface CommandResult {
	stdout: string;
	code: number;
	killed?: boolean;
	truncated?: boolean;
}

export type RunCommand = (command: string, args: string[], options: { cwd: string; timeout: number }) => Promise<CommandResult>;

const GIT_TIMEOUT_MS = 20_000;
/** Past this many changed paths, stat-ing them all costs more than the check is worth; the caller falls back. */
const MAX_CHANGED_PATHS = 10_000;

/** The fingerprint, or undefined outside a git repository or when git cannot answer. */
export async function fingerprintWorkTree(run: RunCommand, cwd: string): Promise<string | undefined> {
	const git = async (args: string[], gitCwd: string): Promise<string | undefined> => {
		const result = await run("git", args, { cwd: gitCwd, timeout: GIT_TIMEOUT_MS });
		return result.code === 0 && !result.killed && !result.truncated ? result.stdout : undefined;
	};
	const repoRoot = (await git(["rev-parse", "--show-toplevel"], cwd))?.trim();
	if (!repoRoot) return undefined;
	// A repository without commits has no HEAD; the status below still tells its files apart.
	const head = (await git(["rev-parse", "--verify", "--quiet", "HEAD"], repoRoot))?.trim() ?? "no-head";
	const status = await git(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"], repoRoot);
	if (status === undefined) return undefined;
	const changedPaths = status
		.split("\0")
		.filter(Boolean)
		.map((line) => line.slice(3));
	if (changedPaths.length > MAX_CHANGED_PATHS) return undefined;
	const hash = createHash("sha256").update(head).update("\0").update(status);
	for (const path of changedPaths) {
		const stats = await lstat(join(repoRoot, path)).catch(() => undefined);
		hash.update(`\0${path}\0${stats ? `${stats.size}:${stats.mtimeMs}` : "missing"}`);
	}
	return hash.digest("hex");
}
