/**
 * The diff of one changed file inside the agents overview, like a git diff viewer: old and new line numbers,
 * added lines on a green background, removed on red, syntax colors, scrolling, hunk and file jumps.
 * The overview frames it; this class renders the lines between the borders and handles the keys.
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, sliceByColumn, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { DiffLine, FileDiffResult } from "./file-diff.ts";
import type { FileChange } from "./work-changes.ts";

/** Colors code lines of one file; returns one line per input line. */
export type HighlightCode = (codeLines: readonly string[], path: string) => string[];

export type DiffViewKeyResult = "handled" | "close";

type DiffLoad = { kind: "loading" } | { kind: "loaded"; result: FileDiffResult; highlighted: string[] };

const HORIZONTAL_STEP_COLUMNS = 8;
/** Header and the blank line under it. */
const HEADER_ROWS = 2;

/** Syntax colors per diff line: each hunk's new side and old side are colored as blocks, so strings and
 * comments spanning lines keep their colors. Falls back to the plain text when the highlighter misbehaves. */
export function highlightDiffLines(lines: readonly DiffLine[], path: string, highlight: HighlightCode | undefined): string[] {
	const highlighted = lines.map((line) => line.text);
	if (!highlight) return highlighted;
	let hunkStart = 0;
	const colorHunk = (hunkEnd: number): void => {
		for (const side of ["new", "old"] as const) {
			const indexes: number[] = [];
			for (let index = hunkStart; index < hunkEnd; index++) {
				const kind = lines[index].kind;
				if (kind === "context" || kind === (side === "new" ? "added" : "removed")) indexes.push(index);
			}
			if (indexes.length === 0) continue;
			const colored = highlight(
				indexes.map((index) => lines[index].text),
				path,
			);
			if (colored.length !== indexes.length) continue;
			indexes.forEach((lineIndex, position) => {
				highlighted[lineIndex] = colored[position];
			});
		}
	};
	lines.forEach((line, index) => {
		if (line.kind !== "hunk") return;
		colorHunk(index);
		hunkStart = index + 1;
	});
	colorHunk(lines.length);
	return highlighted;
}

type DiffSide = "added" | "removed";

const SIDE_THEME_BACKGROUNDS = { added: "toolSuccessBg", removed: "toolErrorBg" } as const;
const TERMINAL_DEFAULT_BACKGROUND = "\x1b[49m";
/** 256-color tints for themes whose tool backgrounds are the terminal default, as most dark themes leave them. */
const FALLBACK_TINTS: Record<"dark" | "light", Record<DiffSide, string>> = {
	dark: { added: "\x1b[48;5;22m", removed: "\x1b[48;5;52m" },
	light: { added: "\x1b[48;5;194m", removed: "\x1b[48;5;224m" },
};

function sideBackground(theme: Theme, side: DiffSide): string {
	const themed = theme.getBgAnsi(SIDE_THEME_BACKGROUNDS[side]);
	if (themed !== "" && themed !== TERMINAL_DEFAULT_BACKGROUND) return themed;
	return FALLBACK_TINTS[theme.appearance === "light" ? "light" : "dark"][side];
}

/** Puts a background behind already colored text, re-opening it after every reset inside the text. */
function withBackground(theme: Theme, side: DiffSide, text: string): string {
	const open = sideBackground(theme, side);
	return open + text.replace(/\x1b\[(?:0|49)?m/g, (reset) => reset + open) + TERMINAL_DEFAULT_BACKGROUND;
}

function padToWidth(text: string, width: number): string {
	const fitted = truncateToWidth(text, width, "");
	return fitted + " ".repeat(Math.max(0, width - visibleWidth(fitted)));
}

export class FileDiffView {
	private readonly theme: Theme;
	private readonly files: readonly FileChange[];
	private readonly loadDiff: (file: FileChange) => Promise<FileDiffResult>;
	private readonly highlight: HighlightCode | undefined;
	private readonly bodyRows: () => number;
	private readonly loads = new Map<string, DiffLoad>();
	private fileIndex: number;
	private scrollTop = 0;
	private scrollLeft = 0;

	constructor(options: {
		theme: Theme;
		files: readonly FileChange[];
		fileIndex: number;
		loadDiff: (file: FileChange) => Promise<FileDiffResult>;
		highlight: HighlightCode | undefined;
		/** Rows the view may use between the card's borders. */
		bodyRows: () => number;
	}) {
		this.theme = options.theme;
		this.files = options.files;
		this.fileIndex = options.fileIndex;
		this.loadDiff = options.loadDiff;
		this.highlight = options.highlight;
		this.bodyRows = options.bodyRows;
		this.ensureLoaded();
	}

	get currentFile(): FileChange {
		return this.files[this.fileIndex];
	}

	keyHint(): string {
		return "↑↓ scroll · space/pgdn page · n/p hunk · ←→ pan · [ ] file · esc back";
	}

	handleInput(data: string): DiffViewKeyResult {
		if (matchesKey(data, "escape") || matchesKey(data, "q") || matchesKey(data, "backspace")) return "close";
		const lineCount = this.lines().length;
		const page = Math.max(1, this.diffRows() - 1);
		if (matchesKey(data, "up") || matchesKey(data, "k")) this.scrollTo(this.scrollTop - 1);
		else if (matchesKey(data, "down") || matchesKey(data, "j")) this.scrollTo(this.scrollTop + 1);
		else if (matchesKey(data, "pageUp") || matchesKey(data, "b")) this.scrollTo(this.scrollTop - page);
		else if (matchesKey(data, "pageDown") || matchesKey(data, "space")) this.scrollTo(this.scrollTop + page);
		else if (matchesKey(data, "home") || matchesKey(data, "g")) this.scrollTo(0);
		else if (matchesKey(data, "end") || data === "G") this.scrollTo(lineCount);
		else if (matchesKey(data, "n")) this.jumpToHunk(1);
		else if (matchesKey(data, "p")) this.jumpToHunk(-1);
		else if (matchesKey(data, "left") || matchesKey(data, "h")) this.scrollLeft = Math.max(0, this.scrollLeft - HORIZONTAL_STEP_COLUMNS);
		else if (matchesKey(data, "right") || matchesKey(data, "l")) this.scrollLeft += HORIZONTAL_STEP_COLUMNS;
		else if (data === "]" || matchesKey(data, "tab")) this.showFile(this.fileIndex + 1);
		else if (data === "[" || matchesKey(data, "shift+tab")) this.showFile(this.fileIndex - 1);
		return "handled";
	}

	render(width: number): string[] {
		const rows = this.diffRows();
		const load = this.loads.get(this.currentFile.path) ?? { kind: "loading" };
		const body = this.bodyLines(load, width, rows);
		const filler = Array.from({ length: Math.max(0, rows - body.length) }, () => "");
		return [this.header(load, width), "", ...body, ...filler];
	}

	private diffRows(): number {
		return Math.max(3, this.bodyRows() - HEADER_ROWS);
	}

	private lines(): DiffLine[] {
		const load = this.loads.get(this.currentFile.path);
		return load?.kind === "loaded" && load.result.ok ? load.result.value.lines : [];
	}

	private scrollTo(top: number): void {
		const maxTop = Math.max(0, this.lines().length - this.diffRows());
		this.scrollTop = Math.min(maxTop, Math.max(0, top));
	}

	private jumpToHunk(direction: 1 | -1): void {
		const lines = this.lines();
		for (let index = this.scrollTop + direction; index >= 0 && index < lines.length; index += direction) {
			if (lines[index].kind === "hunk") {
				this.scrollTo(index);
				return;
			}
		}
	}

	private showFile(index: number): void {
		if (index < 0 || index >= this.files.length) return;
		this.fileIndex = index;
		this.scrollTop = 0;
		this.scrollLeft = 0;
		this.ensureLoaded();
	}

	private ensureLoaded(): void {
		const file = this.currentFile;
		if (this.loads.has(file.path)) return;
		this.loads.set(file.path, { kind: "loading" });
		void this.loadDiff(file)
			.then((result) => {
				const highlighted = result.ok ? this.highlightSafely(result.value.lines, file.path) : [];
				this.loads.set(file.path, { kind: "loaded", result, highlighted });
			})
			.catch((error: unknown) => {
				const message = `Failed to load the diff of ${file.path}: ${(error as Error).message}`;
				this.loads.set(file.path, { kind: "loaded", result: { ok: false, error: message }, highlighted: [] });
			});
	}

	private highlightSafely(lines: readonly DiffLine[], path: string): string[] {
		try {
			return highlightDiffLines(lines, path, this.highlight);
		} catch {
			// An unknown language or a grammar error: show the diff uncolored rather than not at all.
			return highlightDiffLines(lines, path, undefined);
		}
	}

	private header(load: DiffLoad, width: number): string {
		const theme = this.theme;
		const file = this.currentFile;
		const counts = file.isBinary
			? theme.fg("dim", "binary")
			: `${theme.fg("toolDiffAdded", `+${file.added}`)} ${theme.fg("toolDiffRemoved", `−${file.removed}`)}`;
		const tag = file.isNew ? theme.fg("dim", " new") : "";
		const lineCount = load.kind === "loaded" && load.result.ok ? load.result.value.lines.length : 0;
		const position =
			lineCount > this.diffRows()
				? `${this.scrollTop + 1}–${Math.min(lineCount, this.scrollTop + this.diffRows())} of ${lineCount} · `
				: "";
		const right = theme.fg("muted", `${position}file ${this.fileIndex + 1}/${this.files.length}`);
		const left = `${theme.fg("accent", "❯")} ${theme.bold(file.path)}${tag}  ${counts}`;
		const leftWidth = Math.max(0, width - visibleWidth(right) - 1);
		return padToWidth(truncateToWidth(left, leftWidth, "…"), leftWidth) + " " + right;
	}

	private bodyLines(load: DiffLoad, width: number, rows: number): string[] {
		const theme = this.theme;
		if (load.kind === "loading") return [theme.fg("dim", "loading diff…")];
		if (!load.result.ok) return [theme.fg("error", load.result.error)];
		const lines = load.result.value.lines;
		const largestNumber = lines.reduce((largest, line) => {
			const numbers = [
				"oldNumber" in line ? line.oldNumber : 0,
				"newNumber" in line ? line.newNumber : 0,
			];
			return Math.max(largest, ...numbers);
		}, 0);
		const numberWidth = Math.max(3, String(largestNumber).length);
		return lines
			.slice(this.scrollTop, this.scrollTop + rows)
			.map((line, offset) => this.diffLine(line, load.highlighted[this.scrollTop + offset] ?? line.text, numberWidth, width));
	}

	private diffLine(line: DiffLine, coloredText: string, numberWidth: number, width: number): string {
		const theme = this.theme;
		const number = (lineNumber: number | undefined): string =>
			lineNumber === undefined ? " ".repeat(numberWidth) : String(lineNumber).padStart(numberWidth);
		const gutterWidth = numberWidth * 2 + 4;
		const codeWidth = Math.max(1, width - gutterWidth - 2);
		const code = padToWidth(sliceByColumn(coloredText, this.scrollLeft, codeWidth), codeWidth);
		switch (line.kind) {
			case "hunk":
				return theme.fg("accent", padToWidth(sliceByColumn(line.text, this.scrollLeft, width), width));
			case "note":
				return theme.fg("dim", padToWidth(`${" ".repeat(gutterWidth)}  ${line.text}`, width));
			case "context":
				return `${theme.fg("dim", `${number(line.oldNumber)} ${number(line.newNumber)} │ `)}  ${code}`;
			case "added":
				return (
					theme.fg("dim", `${number(undefined)} ${number(line.newNumber)} │ `) +
					withBackground(theme, "added", `${theme.fg("toolDiffAdded", "+")} ${code}`)
				);
			case "removed":
				return (
					theme.fg("dim", `${number(line.oldNumber)} ${number(undefined)} │ `) +
					withBackground(theme, "removed", `${theme.fg("toolDiffRemoved", "−")} ${code}`)
				);
		}
	}
}
