import assert from "node:assert/strict";
import { test } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { markdownLines, TextPager } from "./text-pager.ts";

const plainTheme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as unknown as Theme;

test("headings lose their hashes and long lines wrap to the width", () => {
	const lines = markdownLines("# Plan\n\nword ".repeat(1) + "aaaa bbbb cccc dddd", 10, plainTheme);
	assert.equal(lines[0], "Plan");
	assert.ok(lines.length > 3 && lines.every((line) => line.length <= 10), JSON.stringify(lines));
});

test("scrolling stops at both ends of the text", () => {
	const pager = new TextPager();
	const lines = Array.from({ length: 10 }, (_, index) => `line ${index + 1}`);
	assert.deepEqual(pager.page(lines, 4), { shown: ["line 1", "line 2", "line 3", "line 4"], firstLine: 1, lastLine: 4 });
	pager.handleInput(" ", 4);
	pager.handleInput(" ", 4);
	pager.handleInput(" ", 4);
	assert.equal(pager.page(lines, 4).firstLine, 7);
	pager.handleInput("g", 4);
	assert.equal(pager.page(lines, 4).firstLine, 1);
	assert.equal(pager.handleInput("x", 4), false);
});
