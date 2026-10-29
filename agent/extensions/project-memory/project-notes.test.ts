import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { formatNoteLine, NOTES_RELATIVE_PATH, parseNoteCommand, saveNote, selectNotesForPrompt } from "./project-notes.ts";

const SAVED_ON = new Date("2026-10-29T12:00:00Z");

function makeRepo(): string {
	const repoRoot = mkdtempSync(join(tmpdir(), "project-notes-"));
	mkdirSync(join(repoRoot, ".git", "info"), { recursive: true });
	return repoRoot;
}

test("formats a note as one dated, kinded bullet", () => {
	assert.equal(formatNoteLine("gotcha", "  deals live in\nNeo4j and Redis ", SAVED_ON), "- 2026-10-29 [gotcha] deals live in Neo4j and Redis");
});

test("saves notes under .scratch and keeps .scratch out of git", () => {
	const repoRoot = makeRepo();
	assert.equal(saveNote(repoRoot, formatNoteLine("rule", "use pnpm", SAVED_ON)).kind, "saved");
	assert.match(readFileSync(join(repoRoot, NOTES_RELATIVE_PATH), "utf8"), /\[rule\] use pnpm\n$/);
	assert.equal(readFileSync(join(repoRoot, ".git", "info", "exclude"), "utf8"), ".scratch/\n");
	saveNote(repoRoot, formatNoteLine("fact", "second", SAVED_ON));
	assert.equal(readFileSync(join(repoRoot, ".git", "info", "exclude"), "utf8"), ".scratch/\n");
});

test("does not save the same note twice, even with a different date or kind", () => {
	const repoRoot = makeRepo();
	saveNote(repoRoot, formatNoteLine("rule", "Use pnpm", SAVED_ON));
	assert.equal(saveNote(repoRoot, formatNoteLine("fact", "use pnpm", new Date())).kind, "duplicate");
});

test("keeps the newest notes that fit the prompt budget", () => {
	const notesFile = ["# Project notes", "- 2026-01-01 [fact] oldest", "- 2026-01-02 [fact] middle", "- 2026-01-03 [fact] newest"].join("\n");
	const selected = selectNotesForPrompt(notesFile, 60);
	assert.equal(selected.text, "- 2026-01-02 [fact] middle\n- 2026-01-03 [fact] newest");
	assert.equal(selected.omittedCount, 1);
});

test("parses an optional kind prefix from /note, defaulting to fact", () => {
	assert.deepEqual(parseNoteCommand("decision: Redis for sessions"), { kind: "decision", text: "Redis for sessions" });
	assert.deepEqual(parseNoteCommand("see http://x: y"), { kind: "fact", text: "see http://x: y" });
	assert.equal(parseNoteCommand("   "), undefined);
});
