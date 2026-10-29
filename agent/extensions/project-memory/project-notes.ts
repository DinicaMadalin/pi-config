/**
 * Per-repo notebook of durable facts at `<repo>/.scratch/project-notes.md`: one bullet per note,
 * newest last. Plain markdown so the developer can read and edit it directly.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const NOTE_KINDS = ["decision", "gotcha", "rule", "fact"] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];

export const NOTES_RELATIVE_PATH = join(".scratch", "project-notes.md");
const NOTES_HEADER =
	"# Project notes\n\nDurable facts for agents working in this repo, saved by Pi sessions. Edit freely, one bullet per note.\n\n";
const NOTE_LINE_PREFIX = "- ";
/** About 2k tokens: enough for dozens of notes without crowding every request. */
export const MAX_NOTES_PROMPT_CHARS = 8_000;

/** Walks up from `startDir` to the nearest directory holding `.git`; undefined outside a repo. */
export function findRepoRoot(startDir: string): string | undefined {
	let dir = startDir;
	while (true) {
		if (existsSync(join(dir, ".git"))) return dir;
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

export function projectRootFor(cwd: string): string {
	return findRepoRoot(cwd) ?? cwd;
}

export function formatNoteLine(kind: NoteKind, text: string, savedOn: Date): string {
	const singleLineText = text.replace(/\s+/g, " ").trim();
	return `${NOTE_LINE_PREFIX}${savedOn.toISOString().slice(0, 10)} [${kind}] ${singleLineText}`;
}

/** The note text without its date and kind, for duplicate detection. */
function noteBody(noteLine: string): string {
	return noteLine.replace(/^- \d{4}-\d{2}-\d{2} \[\w+\] /, "").toLowerCase();
}

function noteLinesOf(notesFile: string): string[] {
	return notesFile.split("\n").filter((line) => line.startsWith(NOTE_LINE_PREFIX));
}

export function isDuplicateNote(notesFile: string, noteLine: string): boolean {
	const body = noteBody(noteLine);
	return noteLinesOf(notesFile).some((line) => noteBody(line) === body);
}

/** Newest notes that fit in `maxChars`; older ones are left for the agent to read from the file. */
export function selectNotesForPrompt(notesFile: string, maxChars: number): { text: string; omittedCount: number } {
	const noteLines = noteLinesOf(notesFile);
	const kept: string[] = [];
	let usedChars = 0;
	for (const line of [...noteLines].reverse()) {
		if (usedChars + line.length + 1 > maxChars) break;
		kept.unshift(line);
		usedChars += line.length + 1;
	}
	return { text: kept.join("\n"), omittedCount: noteLines.length - kept.length };
}

/** "/note decision: use X" -> decision; text without a known kind prefix is a fact. */
export function parseNoteCommand(args: string): { kind: NoteKind; text: string } | undefined {
	const text = args.trim();
	if (!text) return undefined;
	const prefixMatch = /^(\w+):\s*(.+)$/s.exec(text);
	const prefixKind = prefixMatch?.[1].toLowerCase() as NoteKind | undefined;
	if (prefixMatch && prefixKind && NOTE_KINDS.includes(prefixKind)) return { kind: prefixKind, text: prefixMatch[2] };
	return { kind: "fact", text };
}

export function readNotesFile(projectRoot: string): string | undefined {
	const notesPath = join(projectRoot, NOTES_RELATIVE_PATH);
	return existsSync(notesPath) ? readFileSync(notesPath, "utf8") : undefined;
}

export function writeNotesFile(projectRoot: string, content: string): void {
	const notesPath = join(projectRoot, NOTES_RELATIVE_PATH);
	mkdirSync(dirname(notesPath), { recursive: true });
	excludeScratchFromGit(projectRoot);
	writeFileSync(notesPath, content);
}

export type SaveNoteResult = { kind: "saved"; notesPath: string } | { kind: "duplicate"; notesPath: string };

export function saveNote(projectRoot: string, noteLine: string): SaveNoteResult {
	const notesPath = join(projectRoot, NOTES_RELATIVE_PATH);
	const current = readNotesFile(projectRoot) ?? NOTES_HEADER;
	if (isDuplicateNote(current, noteLine)) return { kind: "duplicate", notesPath };
	const separator = current.endsWith("\n") ? "" : "\n";
	writeNotesFile(projectRoot, `${current}${separator}${noteLine}\n`);
	return { kind: "saved", notesPath };
}

/** `.scratch/` is the developer's private workspace (see AGENTS.md): keep it out of commits. */
export function excludeScratchFromGit(projectRoot: string): void {
	const gitDir = join(projectRoot, ".git");
	if (!existsSync(gitDir) || !statSync(gitDir).isDirectory()) return; // worktrees and submodules: leave alone
	const excludePath = join(gitDir, "info", "exclude");
	const excludeRules = existsSync(excludePath) ? readFileSync(excludePath, "utf8") : "";
	if (/^\/?\.scratch\/?$/m.test(excludeRules)) return;
	mkdirSync(dirname(excludePath), { recursive: true });
	const separator = excludeRules === "" || excludeRules.endsWith("\n") ? "" : "\n";
	appendFileSync(excludePath, `${separator}.scratch/\n`);
}
