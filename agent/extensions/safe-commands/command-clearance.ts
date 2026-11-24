/**
 * Decides whether a shell command that Guardrails flagged is only routine cleanup: removing scratch files under /tmp or
 * in a generated folder, writing into a scratch copy, dropping a scratch worktree, unstaging files, changing
 * directory, or a plain push to any branch except main and master, possibly followed by commands Guardrails itself does
 * not treat as dangerous. Force pushes and remote deletes still ask.
 *
 * The check runs per part of the command (`&&`, `||`, `;`, newline) so a safe `rm -rf /tmp/x` cannot carry a force push
 * or a script piped into a shell along with it. `cd` parts move the directory that relative paths are resolved against,
 * and heredoc bodies are ignored only when a plain writer (`cat`, `tee`) receives them, never when an interpreter does.
 */
import { resolve } from "node:path";

export interface DangerousPattern {
	pattern: string;
	regex?: boolean;
	description?: string;
}

/** Reads branch names from the repository a command runs in; undefined when git cannot tell. */
export interface GitBranchLookup {
	currentBranch(cwd: string): string | undefined;
	/** The remote branch a `git push` without a refspec updates. */
	pushDestination(cwd: string): string | undefined;
}

export interface ClearanceOptions {
	cwd: string;
	git: GitBranchLookup;
}

export type CommandClearance =
	| { kind: "allow"; reason: string }
	| { kind: "ask"; reason: string };

type SegmentClearance =
	| { kind: "allow"; reason: string }
	| { kind: "chdir"; directory: string }
	| { kind: "ask"; reason: string };

interface CommandWord {
	text: string;
	wasQuoted: boolean;
}

const GENERATED_FOLDERS = new Set([
	"node_modules",
	"dist",
	"build",
	"out",
	"target",
	"coverage",
	".next",
	".cache",
	"__pycache__",
	".turbo",
	".parcel-cache",
]);

const DELETE_FLAG_LETTERS = new Set(["r", "R", "f", "v"]);
const DELETE_LONG_FLAGS = new Set(["--recursive", "--force", "--verbose"]);
const SHELL_EXPANSION = /[$`*?\[]/;
const HEREDOC_HEADER = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/g;
const PIPE_INTO_SHELL = /\|\s*(?:sudo\s+)?(?:sh|bash|zsh|dash|eval)\b/;
const PLAIN_HEREDOC_WRITERS = new Set(["cat", "tee"]);

/** Pushes to these branches always go to the Guardrails prompt. */
const PROTECTED_BRANCHES = new Set(["main", "master"]);
const HARMLESS_PUSH_FLAGS = new Set([
	"-u",
	"--set-upstream",
	"-q",
	"--quiet",
	"-v",
	"--verbose",
	"--progress",
	"--no-progress",
	"--porcelain",
	"--atomic",
	"--no-verify",
	"--follow-tags",
	"--tags",
	"-n",
	"--dry-run",
]);
const PUSH_FLAGS_WITH_VALUE = new Set(["-o", "--push-option"]);

export function decideCommandClearance(
	command: string,
	dangerousPatterns: readonly DangerousPattern[],
	options: ClearanceOptions,
): CommandClearance {
	const segments = splitCommandSegments(ignoreWrittenHeredocBodies(command));
	if (segments.length === 0) return ask("the command is empty");

	let cwd = options.cwd;
	const allowedReasons: string[] = [];
	for (const segment of segments) {
		const clearance = decideSegmentClearance(segment, dangerousPatterns, cwd, options.git);
		if (clearance.kind === "ask") return clearance;
		if (clearance.kind === "chdir") {
			cwd = clearance.directory;
			continue;
		}
		allowedReasons.push(clearance.reason);
	}
	if (allowedReasons.length === 0) return allow("it only changes directory");
	return allow([...new Set(allowedReasons)].join("; "));
}

function decideSegmentClearance(
	segment: string,
	dangerousPatterns: readonly DangerousPattern[],
	cwd: string,
	git: GitBranchLookup,
): SegmentClearance {
	const words = readWords(segment);
	const verb = words[0]?.text;
	if (!verb) return allow("it is blank");

	if (words.every((word) => isVariableAssignment(word.text))) {
		return allow("it only sets shell variables");
	}
	if (verb === "cd") return decideChangeDirectory(words, cwd);
	if (verb === "rm") return decideRemove(words, cwd);
	if (verb === "git") {
		const gitClearance = decideGit(segment, words, dangerousPatterns, cwd, git);
		if (gitClearance !== undefined) return gitClearance;
	}
	if (isHarmlessSegment(segment, dangerousPatterns, cwd)) {
		return allow("it runs nothing Guardrails treats as dangerous");
	}
	return ask(`it runs \`${verb}\` with something Guardrails flags inside it`);
}

function decideChangeDirectory(words: readonly CommandWord[], cwd: string): SegmentClearance {
	const target = words[1];
	if (words.length !== 2 || target === undefined) return ask("`cd` takes one directory here");
	if (SHELL_EXPANSION.test(target.text)) return ask("the directory is not a plain path");
	return { kind: "chdir", directory: resolve(cwd, target.text) };
}

function decideRemove(words: readonly CommandWord[], cwd: string): SegmentClearance {
	const targets: string[] = [];
	for (const word of words.slice(1)) {
		if (isDeleteFlag(word)) continue;
		if (word.text.startsWith("-")) {
			return ask(`\`rm ${word.text}\` is not a cleanup form this delegate allows`);
		}
		targets.push(word.text);
	}
	if (targets.length === 0) return ask("`rm` has no target");

	const unsafeTarget = targets.find((target) => !isScratchPath(target, cwd));
	if (unsafeTarget !== undefined) {
		return ask(`\`rm\` would delete ${unsafeTarget}, which is outside /tmp and the generated folders`);
	}
	return allow(`it only deletes ${targets.join(", ")}`);
}

function decideGit(
	segment: string,
	words: readonly CommandWord[],
	dangerousPatterns: readonly DangerousPattern[],
	cwd: string,
	git: GitBranchLookup,
): SegmentClearance | undefined {
	let repoDirectory = cwd;
	let gitWords = words;
	if (words[1]?.text === "-C") {
		const directory = words[2];
		if (directory === undefined || SHELL_EXPANSION.test(directory.text)) return ask("`git -C` needs a plain directory");
		repoDirectory = resolve(cwd, directory.text);
		gitWords = [words[0], ...words.slice(3)];
	}

	const subcommand = gitWords[1]?.text;
	if (subcommand === "worktree") return decideWorktree(gitWords, repoDirectory);
	if (subcommand === "restore") return decideStagedRestore(gitWords);
	if (subcommand === "rm") return decideStagedRemove(gitWords);
	if (subcommand === "checkout") return decideCheckout(gitWords);
	if (subcommand === "push") {
		const wordsBeforePushArguments = words.length - gitWords.length + 2;
		return decidePush(segment, wordsBeforePushArguments, dangerousPatterns, cwd, repoDirectory, git);
	}
	return undefined;
}

/** A push to any branch but main or master needs no prompt, as long as it cannot overwrite or delete remote work. */
function decidePush(
	segment: string,
	wordsBeforePushArguments: number,
	dangerousPatterns: readonly DangerousPattern[],
	cwd: string,
	repoDirectory: string,
	git: GitBranchLookup,
): SegmentClearance {
	const [pushCommand = "", ...pipedCommands] = splitPipeline(segment);
	if (/[$]\(|`|<\(/.test(pushCommand)) return ask("the push contains a command substitution");
	if (PIPE_INTO_SHELL.test(segment)) return ask("the push output is piped into a shell");
	if (!everyRedirectStaysInScratch(pushCommand, cwd)) return ask("the push writes its output outside scratch files");
	if (pipedCommands.some((piped) => !isHarmlessSegment(piped, dangerousPatterns, cwd))) {
		return ask("the push output is piped into something Guardrails flags");
	}

	const pushArguments = withoutRedirects(readWords(pushCommand)).slice(wordsBeforePushArguments);
	const positional: string[] = [];
	for (let index = 0; index < pushArguments.length; index += 1) {
		const argument = pushArguments[index].text;
		if (PUSH_FLAGS_WITH_VALUE.has(argument)) {
			index += 1;
			continue;
		}
		if (HARMLESS_PUSH_FLAGS.has(argument)) continue;
		if (argument.startsWith("-")) return ask(`\`git push ${argument}\` is not a plain push`);
		positional.push(argument);
	}

	const [remote, ...refspecs] = positional;
	if (remote !== undefined && SHELL_EXPANSION.test(remote)) return ask("the push remote is not a plain name");

	const destinations: string[] = [];
	if (refspecs.length === 0) {
		const destination = git.pushDestination(repoDirectory);
		if (destination === undefined) return ask("git could not tell which branch this push updates");
		destinations.push(destination);
	}
	for (const refspec of refspecs) {
		const destination = readPushDestination(refspec, repoDirectory, git);
		if (destination.kind === "ask") return destination;
		destinations.push(destination.branch);
	}

	const protectedDestination = destinations.find((branch) => PROTECTED_BRANCHES.has(branch.toLowerCase()));
	if (protectedDestination !== undefined) {
		return ask(`the push updates ${protectedDestination}, which always needs your approval`);
	}
	return allow(`it only pushes to ${destinations.join(", ")}`);
}

function readPushDestination(
	refspec: string,
	repoDirectory: string,
	git: GitBranchLookup,
): { kind: "branch"; branch: string } | { kind: "ask"; reason: string } {
	if (refspec.startsWith("+")) return { kind: "ask", reason: `the refspec ${refspec} force-pushes` };
	if (SHELL_EXPANSION.test(refspec)) return { kind: "ask", reason: `the refspec ${refspec} is not a plain name` };

	const [source, destination] = refspec.split(":", 2);
	if (source === "") return { kind: "ask", reason: `the refspec ${refspec} deletes a remote branch` };
	if (destination === "") return { kind: "ask", reason: `the refspec ${refspec} has no destination` };

	const target = destination ?? source;
	const branch = target === "HEAD" ? git.currentBranch(repoDirectory) : target.replace(/^refs\/heads\//, "");
	if (branch === undefined) return { kind: "ask", reason: "git could not tell which branch HEAD is" };
	return { kind: "branch", branch };
}

function splitPipeline(segment: string): string[] {
	const commands: string[] = [];
	let current = "";
	let quote: string | undefined;
	for (const character of segment) {
		if (quote) {
			if (character === quote) quote = undefined;
		} else if (character === '"' || character === "'") {
			quote = character;
		} else if (character === "|") {
			commands.push(current.trim());
			current = "";
			continue;
		}
		current += character;
	}
	commands.push(current.trim());
	return commands;
}

/** Drops `2>&1`, `> file` and similar words so only the command's own arguments remain. */
function withoutRedirects(words: readonly CommandWord[]): CommandWord[] {
	const kept: CommandWord[] = [];
	for (let index = 0; index < words.length; index += 1) {
		const word = words[index];
		const redirect = word.wasQuoted ? null : /^(?:\d*|&)(?:>>?|<)(.*)$/.exec(word.text);
		if (redirect === null) {
			kept.push(word);
			continue;
		}
		if (redirect[1] === "") index += 1;
	}
	return kept;
}

function decideWorktree(words: readonly CommandWord[], cwd: string): SegmentClearance {
	if (words[2]?.text === "prune" && words.length === 3) {
		return allow("it only prunes stale worktree records");
	}
	if (words[2]?.text !== "remove") return ask("only `git worktree remove` and `git worktree prune` are allowed");

	const paths: string[] = [];
	for (const word of words.slice(3)) {
		if (word.text === "--force" || word.text === "-f") continue;
		if (word.text.startsWith("-")) {
			return ask(`\`git worktree remove ${word.text}\` is not a cleanup form this delegate allows`);
		}
		paths.push(word.text);
	}
	if (paths.length !== 1) return ask("`git worktree remove` takes one path");

	const [worktreePath] = paths;
	const resolvedPath = resolve(cwd, worktreePath);
	if (!isScratchPath(worktreePath, cwd) && !resolvedPath.includes("-worktrees/")) {
		return ask(`${worktreePath} is not a scratch worktree (under /tmp or in a -worktrees folder)`);
	}
	return allow(`it only removes the scratch worktree ${worktreePath}`);
}

function decideStagedRestore(words: readonly CommandWord[]): SegmentClearance {
	let sawStaged = false;
	let pathCount = 0;
	for (const word of words.slice(2)) {
		if (word.text === "--staged") {
			sawStaged = true;
			continue;
		}
		if (word.text === "--quiet" || word.text === "-q" || word.text === "--") continue;
		if (word.text.startsWith("-")) {
			return ask(`\`git restore ${word.text}\` can discard working-tree changes`);
		}
		pathCount += 1;
	}
	if (!sawStaged) return ask("`git restore` without `--staged` can discard working-tree changes");
	if (pathCount === 0) return ask("`git restore --staged` has no path");
	return allow("it only unstages files, keeping their content");
}

function decideStagedRemove(words: readonly CommandWord[]): SegmentClearance {
	const isCached = words.some((word) => word.text === "--cached");
	if (!isCached) return ask("`git rm` without `--cached` deletes the files from disk");
	return allow("it only removes files from the index, keeping them on disk");
}

function decideCheckout(words: readonly CommandWord[]): SegmentClearance | undefined {
	if (words.some((word) => word.text === "--")) {
		return ask("`git checkout --` throws away working-tree changes");
	}
	return undefined;
}

function isHarmlessSegment(
	segment: string,
	dangerousPatterns: readonly DangerousPattern[],
	cwd: string,
): boolean {
	if (/[$]\(|`|<\(/.test(segment)) return false;
	if (PIPE_INTO_SHELL.test(segment)) return false;
	if (!everyRedirectStaysInScratch(segment, cwd)) return false;
	return !dangerousPatterns.some((pattern) => matchesPattern(segment, pattern));
}

function everyRedirectStaysInScratch(segment: string, cwd: string): boolean {
	for (const match of segment.matchAll(/&>>?|>>?/g)) {
		const afterOperator = segment.slice((match.index ?? 0) + match[0].length).trimStart();
		if (afterOperator.startsWith("&")) continue;
		const target = afterOperator.split(/[\s;&|()]/, 1)[0] ?? "";
		if (target === "/dev/null" || isScratchPath(target, cwd)) continue;
		return false;
	}
	return true;
}

/**
 * Drops heredoc bodies when a plain writer (`cat`, `tee`) receives them, so text in a scratch file cannot look like a
 * dangerous command. A heredoc handed to anything else keeps its body, because that body runs.
 */
function ignoreWrittenHeredocBodies(command: string): string {
	const headers = [...command.matchAll(HEREDOC_HEADER)];
	if (headers.length === 0) return command;

	for (const segment of splitCommandSegments(command)) {
		if (!segment.includes("<<")) continue;
		const verb = readWords(segment)[0]?.text;
		if (verb === undefined || !PLAIN_HEREDOC_WRITERS.has(verb)) return command;
	}

	const kept: string[] = [];
	const pendingMarkers: string[] = [];
	for (const line of command.split("\n")) {
		const openMarker = pendingMarkers[0];
		if (openMarker !== undefined) {
			if (line.trim() === openMarker) pendingMarkers.shift();
			continue;
		}
		kept.push(line);
		for (const match of line.matchAll(HEREDOC_HEADER)) {
			if (match[2] !== undefined) pendingMarkers.push(match[2]);
		}
	}
	return kept.join("\n");
}

function matchesPattern(segment: string, pattern: DangerousPattern): boolean {
	if (pattern.regex !== true) return segment.includes(pattern.pattern);
	try {
		return new RegExp(pattern.pattern).test(segment);
	} catch {
		return false;
	}
}

function isVariableAssignment(word: string): boolean {
	return /^[A-Za-z_][A-Za-z0-9_]*=/.test(word);
}

function isDeleteFlag(word: CommandWord): boolean {
	if (word.wasQuoted) return false;
	if (DELETE_LONG_FLAGS.has(word.text)) return true;
	if (!/^-[a-zA-Z]+$/.test(word.text)) return false;
	return [...word.text.slice(1)].every((letter) => DELETE_FLAG_LETTERS.has(letter));
}

export function isScratchPath(candidate: string, cwd: string): boolean {
	const path = stripTrailingSlash(candidate);
	if (path.length === 0) return false;
	if (SHELL_EXPANSION.test(path)) return false;
	if (hasParentSegment(path)) return false;

	if (path.startsWith("/")) return isUnderTmp(path);
	if (GENERATED_FOLDERS.has(path.split("/")[0])) return true;
	return isUnderTmp(resolve(cwd, path));
}

function isUnderTmp(path: string): boolean {
	return path.startsWith("/tmp/") && path.length > "/tmp/".length;
}

function hasParentSegment(path: string): boolean {
	return path.split("/").includes("..");
}

function stripTrailingSlash(path: string): string {
	return path.endsWith("/") ? path.slice(0, -1) : path;
}

export function splitCommandSegments(command: string): string[] {
	const segments: string[] = [];
	let current = "";
	let quote: string | undefined;

	const finishSegment = () => {
		const trimmed = current.trim();
		if (trimmed.length > 0) segments.push(trimmed);
		current = "";
	};

	for (let index = 0; index < command.length; index += 1) {
		const character = command.slice(index, index + 1);
		if (quote) {
			current += character;
			if (character === quote) quote = undefined;
			continue;
		}
		if (character === '"' || character === "'") {
			quote = character;
			current += character;
			continue;
		}
		const next = command.slice(index + 1, index + 2);
		if (character === ";" || character === "\n") {
			finishSegment();
			continue;
		}
		if ((character === "&" || character === "|") && next === character) {
			finishSegment();
			index += 1;
			continue;
		}
		current += character;
	}

	finishSegment();
	return segments;
}

export function readWords(segment: string): CommandWord[] {
	const words: CommandWord[] = [];
	let current = "";
	let wasQuoted = false;
	let quote: string | undefined;

	const finishWord = () => {
		if (current.length > 0) words.push({ text: current, wasQuoted });
		current = "";
		wasQuoted = false;
	};

	for (let index = 0; index < segment.length; index += 1) {
		const character = segment.slice(index, index + 1);
		if (quote) {
			if (character === quote) {
				quote = undefined;
				continue;
			}
			current += character;
			continue;
		}
		if (character === '"' || character === "'") {
			quote = character;
			wasQuoted = true;
			continue;
		}
		if (character === "\\") {
			current += segment.slice(index + 1, index + 2);
			index += 1;
			continue;
		}
		if (/\s/.test(character)) {
			finishWord();
			continue;
		}
		current += character;
	}

	finishWord();
	return words;
}

function allow(reason: string): { kind: "allow"; reason: string } {
	return { kind: "allow", reason };
}

function ask(reason: string): { kind: "ask"; reason: string } {
	return { kind: "ask", reason };
}
