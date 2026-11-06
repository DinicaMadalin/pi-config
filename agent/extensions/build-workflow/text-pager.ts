/**
 * A scrollable page of markdown text for the overview's Plan and Report tabs: wraps to the card's width,
 * colors headings, and remembers where you scrolled.
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, wrapTextWithAnsi } from "@earendil-works/pi-tui";

/** Wrapped lines of the text, headings bold and colored, code fences dimmed. */
export function markdownLines(text: string, width: number, theme: Theme): string[] {
	let isInCodeBlock = false;
	return text.split("\n").flatMap((line) => {
		if (line.trimStart().startsWith("```")) {
			isInCodeBlock = !isInCodeBlock;
			return [theme.fg("dim", line)];
		}
		if (isInCodeBlock) return wrapTextWithAnsi(theme.fg("mdCode", line), width);
		if (/^#{1,6}\s/.test(line)) return wrapTextWithAnsi(theme.bold(theme.fg("accent", line.replace(/^#+\s*/, ""))), width);
		if (line === "") return [""];
		return wrapTextWithAnsi(line, width);
	});
}

export class TextPager {
	private scrollTop = 0;

	/** Handles a scroll key; false when the key is not one, so the caller can use it. */
	handleInput(data: string, pageRows: number): boolean {
		if (matchesKey(data, "up") || matchesKey(data, "k")) this.scrollTop -= 1;
		else if (matchesKey(data, "down") || matchesKey(data, "j")) this.scrollTop += 1;
		else if (matchesKey(data, "pageUp") || matchesKey(data, "b")) this.scrollTop -= pageRows;
		else if (matchesKey(data, "pageDown") || matchesKey(data, "space")) this.scrollTop += pageRows;
		else if (matchesKey(data, "home") || matchesKey(data, "g")) this.scrollTop = 0;
		else if (matchesKey(data, "end") || data === "G") this.scrollTop = Number.MAX_SAFE_INTEGER;
		else return false;
		return true;
	}

	/** The rows to show now, plus where they sit in the whole text, e.g. for "12–40 of 90". */
	page(lines: readonly string[], rows: number): { shown: string[]; firstLine: number; lastLine: number } {
		const maxScrollTop = Math.max(0, lines.length - rows);
		this.scrollTop = Math.min(Math.max(0, this.scrollTop), maxScrollTop);
		const shown = lines.slice(this.scrollTop, this.scrollTop + rows);
		return { shown, firstLine: this.scrollTop + 1, lastLine: this.scrollTop + shown.length };
	}
}
