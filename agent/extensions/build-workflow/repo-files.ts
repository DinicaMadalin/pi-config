/** Where the repo is, its HEAD, and the coding-rule files the agents must follow. */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { RunCommand } from "./github-issue.ts";

const RULE_FILE_NAMES = ["AGENTS.md", "CLAUDE.md"];
const GLOBAL_RULE_FILE = join(homedir(), ".pi", "agent", "AGENTS.md");

/** The repo's top directory; undefined outside a git repo. */
export async function findRepoRoot(run: RunCommand): Promise<string | undefined> {
	const result = await run("git", ["rev-parse", "--show-toplevel"]);
	return result.code === 0 ? result.stdout.trim() : undefined;
}

/** The commit the reviewers diff against; undefined outside a git repo or before the first commit. */
export async function findHeadCommit(run: RunCommand): Promise<string | undefined> {
	const result = await run("git", ["rev-parse", "HEAD"]);
	return result.code === 0 ? result.stdout.trim() : undefined;
}

/** Repo-level then directory-level rule files, then the global one: the rules Pi loads into context. */
export async function findRuleFiles(run: RunCommand, cwd: string): Promise<string[]> {
	const repoRoot = await findRepoRoot(run);
	const directories = [...new Set([repoRoot, cwd].filter((directory): directory is string => directory !== undefined))];
	const projectRuleFiles = directories.flatMap((directory) => RULE_FILE_NAMES.map((name) => join(directory, name)));
	return [...projectRuleFiles, GLOBAL_RULE_FILE].filter((path) => existsSync(path));
}
