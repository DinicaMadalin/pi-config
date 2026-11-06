import assert from "node:assert/strict";
import { test } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import type { DiffLine, FileDiffResult } from "./file-diff.ts";
import { FileDiffView, highlightDiffLines } from "./file-diff-view.ts";
import type { FileChange } from "./work-changes.ts";

const plainTheme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	getBgAnsi: () => "",
	appearance: "dark",
} as unknown as Theme;

const DOWN = "\x1b[B";
const files: FileChange[] = [
	{ path: "src/a.ts", added: 40, removed: 0, isBinary: false, isNew: true },
	{ path: "src/b.ts", added: 1, removed: 1, isBinary: false, isNew: false },
];

function longDiff(): DiffLine[] {
	const firstHunk: DiffLine[] = Array.from({ length: 20 }, (_, index) => ({ kind: "added", newNumber: index + 1, text: `line ${index + 1}` }));
	const secondHunk: DiffLine[] = Array.from({ length: 20 }, (_, index) => ({ kind: "added", newNumber: index + 51, text: `line ${index + 51}` }));
	return [{ kind: "hunk", text: "@@ -0,0 +1,20 @@" }, ...firstHunk, { kind: "hunk", text: "@@ -40,0 +51,20 @@" }, ...secondHunk];
}

async function openView(): Promise<{ view: FileDiffView; requested: string[] }> {
	const requested: string[] = [];
	const view = new FileDiffView({
		theme: plainTheme,
		files,
		fileIndex: 0,
		loadDiff: async (file): Promise<FileDiffResult> => {
			requested.push(file.path);
			const lines: DiffLine[] = file.path === "src/a.ts" ? longDiff() : [{ kind: "removed", oldNumber: 3, text: "old" }];
			return { ok: true, value: { path: file.path, lines } };
		},
		highlight: undefined,
		bodyRows: () => 12,
	});
	await new Promise((resolve) => setImmediate(resolve));
	return { view, requested };
}

test("fills exactly the rows it was given, every line at full width", async () => {
	const { view } = await openView();
	const lines = view.render(80);
	assert.equal(lines.length, 12);
	assert.ok(lines.every((line) => visibleWidth(line) <= 80));
	assert.ok(lines[0].includes("src/a.ts") && lines[0].includes("1–10 of 42") && lines[0].includes("file 1/2"), lines[0]);
	assert.ok(stripTerminalSequences(lines[3]).includes("  1 │ + line 1"), lines[3]);
});

test("scrolls by line and page, and jumps between hunks", async () => {
	const { view } = await openView();
	view.handleInput(DOWN);
	assert.ok(view.render(80)[0].includes("2–11 of 42"));
	view.handleInput(" ");
	assert.ok(view.render(80)[0].includes("11–20 of 42"));
	view.handleInput("g");
	view.handleInput("n");
	assert.ok(view.render(80)[2].startsWith("@@ -40,0 +51,20 @@"), view.render(80)[2]);
	view.handleInput("G");
	assert.ok(view.render(80)[0].includes("33–42 of 42"), "G stops at the last full page");
});

test("] shows the next file and Escape asks to close", async () => {
	const { view, requested } = await openView();
	assert.equal(view.handleInput("]"), "handled");
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(requested, ["src/a.ts", "src/b.ts"]);
	const lines = view.render(80);
	assert.ok(lines[0].includes("file 2/2"));
	assert.ok(stripTerminalSequences(lines[2]).includes("3     │ − old"), lines[2]);
	assert.equal(view.handleInput("\x1b"), "close");
});

test("colors each hunk's old and new side as blocks, so multi-line syntax stays intact", () => {
	const lines: DiffLine[] = [
		{ kind: "hunk", text: "@@" },
		{ kind: "context", oldNumber: 1, newNumber: 1, text: "keep" },
		{ kind: "removed", oldNumber: 2, text: "gone" },
		{ kind: "added", newNumber: 2, text: "new" },
	];
	const blocks: string[][] = [];
	const colored = highlightDiffLines(lines, "a.ts", (codeLines) => {
		blocks.push([...codeLines]);
		return codeLines.map((line) => `<${line}>`);
	});
	assert.deepEqual(blocks, [["keep", "new"], ["keep", "gone"]]);
	assert.deepEqual(colored, ["@@", "<keep>", "<gone>", "<new>"]);
});

test("tints added and removed lines even when the theme leaves tool backgrounds at the terminal default", async () => {
	const defaultBackgroundTheme = { ...plainTheme, getBgAnsi: () => "\x1b[49m", appearance: "dark" } as unknown as Theme;
	const view = new FileDiffView({
		theme: defaultBackgroundTheme,
		files,
		fileIndex: 1,
		loadDiff: async (file) => ({ ok: true, value: { path: file.path, lines: [{ kind: "removed", oldNumber: 3, text: "old" }] } }),
		highlight: undefined,
		bodyRows: () => 5,
	});
	await new Promise((resolve) => setImmediate(resolve));
	assert.ok(view.render(40)[2].includes("\x1b[48;5;52m"), JSON.stringify(view.render(40)[2]));
});
