/** Post-review cleanup: validate every changed file before deleting temporary comment blocks. */
import { lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { removeContractBlocks, type ContractRemoval } from "../auto-model/implementation-handoff.ts";

const MAX_CHANGED_FILES = 2_000;
const MAX_CONTRACT_FILE_BYTES = 8 * 1024 * 1024;
const COMMENT_LINE = /^(?:\/\/.*|#.*|--.*|;.*|\/\*(?:(?!\*\/).)*\*\/|<!--(?:(?!-->).)*-->)$/;
const MARKER_LINE = /^(\/\/|#|--|;|\/\*|<!--)\s*@handoff-contract\s+(begin|end)\s*(?:\*\/|-->)?$/i;
const MARKER_START = /^(?:(?:\/\/|#|--|;|\/\*|<!--)\s*)?@handoff-contract\b/i;

/** The shared remover is deliberately permissive; builds additionally require whole comment lines. */
export function removeBuildContracts(text: string): ContractRemoval {
	let commentPrefix: string | undefined;
	for (const [index, line] of text.split(/\r?\n/).entries()) {
		const trimmed = line.trim();
		const marker = MARKER_LINE.exec(trimmed);
		if (MARKER_START.test(trimmed) && (!marker || !COMMENT_LINE.test(trimmed))) {
			return { kind: "malformed", reason: `line ${index + 1}: contract marker must be a standalone comment` };
		}
		if (marker) {
			if (commentPrefix && commentPrefix !== marker[1]) return { kind: "malformed", reason: `line ${index + 1}: contract changes comment syntax` };
			commentPrefix = marker[2].toLowerCase() === "begin" ? marker[1] : undefined;
		} else if (commentPrefix && trimmed && (!trimmed.startsWith(commentPrefix) || !COMMENT_LINE.test(trimmed))) {
			return { kind: "malformed", reason: `line ${index + 1}: contract contains a non-comment line; refusing to remove code` };
		}
	}
	return removeContractBlocks(text);
}

export interface ContractFileEdit {
	path: string;
	before: string;
	after: string;
}

/** Paths come from git's NUL-separated changed/untracked lists, not from an agent's prose. */
export function prepareContractCleanup(root: string, changedPaths: readonly string[]): ContractFileEdit[] {
	const paths = [...new Set(changedPaths)];
	if (paths.length > MAX_CHANGED_FILES) throw new Error(`Contract cleanup exceeds ${MAX_CHANGED_FILES} changed files; split the build into milestones`);
	const checkout = realpathSync(root);
	const edits: ContractFileEdit[] = [];
	for (const path of paths) {
		const absolutePath = resolve(checkout, path);
		const relativePath = relative(checkout, absolutePath);
		if (isAbsolute(path) || relativePath === ".." || relativePath.startsWith(`..${sep}`)) throw new Error(`Contract cleanup path escapes the checkout: ${path}`);
		const stat = lstatSync(absolutePath);
		// A changed symlink is a git object, not a file whose target this workflow owns.
		if (stat.isSymbolicLink() || !stat.isFile()) continue;
		if (realpathSync(absolutePath) !== absolutePath) throw new Error(`Contract cleanup refuses a symlink parent: ${path}`);
		if (stat.size > MAX_CONTRACT_FILE_BYTES) throw new Error(`Contract cleanup cannot inspect ${path}: exceeds ${MAX_CONTRACT_FILE_BYTES} bytes`);
		const bytes = readFileSync(absolutePath);
		if (bytes.includes(0)) continue;
		const before = bytes.toString("utf8");
		// Binary/non-UTF8 files must never be rewritten through a lossy text decoder.
		if (!Buffer.from(before).equals(bytes)) continue;
		const cleaned = removeBuildContracts(before);
		if (cleaned.kind === "malformed") throw new Error(`${path}: ${cleaned.reason}`);
		if (cleaned.removedBlockCount > 0) edits.push({ path: absolutePath, before, after: cleaned.text });
	}
	return edits;
}

export function applyContractCleanup(edits: readonly ContractFileEdit[]): void {
	for (const edit of edits) {
		if (readFileSync(edit.path, "utf8") !== edit.before) throw new Error(`Contract cleanup stopped: ${edit.path} changed after validation`);
	}
	for (const edit of edits) writeFileSync(edit.path, edit.after);
}
