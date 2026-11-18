/**
 * The Diff tab's screen: the files the run changed since its base commit, one per line with a change bar and its
 * line counts; Enter opens the file's diff (file-diff-view.ts) and Esc comes back. Moved out of the deleted
 * the old overview, which drew the same list.
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { spread, truncatePathStart } from "./card-text.ts";
import type { PaneSize, ScreenView } from "./diff-tab.ts";
import type { FileDiffResult } from "./file-diff.ts";
import { FileDiffView, type HighlightCode } from "./file-diff-view.ts";
import type { ChangedFilesSnapshot } from "./run-changes-feed.ts";
import type { FileChange } from "./work-changes.ts";

const CHANGE_BAR_CELLS = 16;
/** The key hint at the bottom and the blank line above it. */
const KEY_HINT_ROWS = 2;
/** The heading and the blank line under it. */
const HEADING_ROWS = 2;
const LIST_KEY_HINT = "↑↓ file · enter diff";

export interface ChangedFilesScreenOptions {
	theme: Theme;
	readSnapshot: () => ChangedFilesSnapshot;
	loadFileDiff: (file: FileChange) => Promise<FileDiffResult>;
	highlight: HighlightCode | undefined;
}

export class ChangedFilesScreen implements ScreenView {
	private readonly options: ChangedFilesScreenOptions;
	private selectedFileIndex = 0;
	private diffView: FileDiffView | undefined;
	private size: PaneSize = { rows: 30, columns: 80 };

	constructor(options: ChangedFilesScreenOptions) {
		this.options = options;
	}

	render(size: PaneSize): string[] {
		this.size = size;
		const rowLimit = Math.max(0, size.rows);
		if (rowLimit === 0) return [];
		const theme = this.options.theme;
		if (this.diffView) {
			const diffRows = Math.max(0, rowLimit - KEY_HINT_ROWS);
			const lines = this.diffView.render(size.columns).slice(0, diffRows);
			if (lines.length < rowLimit) lines.push("");
			if (lines.length < rowLimit) lines.push(theme.fg("dim", this.diffView.keyHint()));
			return lines.slice(0, rowLimit).map((line) => truncateToWidth(line, size.columns));
		}
		const snapshot = this.options.readSnapshot();
		const lines: string[] = [];
		let files: FileChange[] = [];
		let heading = theme.bold("Changes");
		if (snapshot.changes.kind === "not-started") lines.push(`${heading}  ${theme.fg("dim", "counted once the implementer starts")}`);
		else if (snapshot.changes.kind === "loading") lines.push(`${heading}  ${theme.fg("dim", "counting…")}`);
		else if (!snapshot.changes.result.ok) lines.push(`${heading}  ${theme.fg("error", snapshot.changes.result.error)}`);
		else {
			const { added, removed } = snapshot.changes.result.value;
			files = snapshot.changes.result.value.files;
			const since = snapshot.baseCommit ? theme.fg("dim", ` since ${snapshot.baseCommit.slice(0, 7)}`) : "";
			heading = `${theme.bold("Changes")}${since}`;
			if (files.length === 0) lines.push(`${heading}  ${theme.fg("dim", "no files changed yet")}`);
			else {
				const totals = `${theme.fg("toolDiffAdded", `+${added}`)} ${theme.fg("toolDiffRemoved", `−${removed}`)} ${theme.fg("muted", `· ${files.length} file${files.length === 1 ? "" : "s"}`)}`;
				lines.push(spread(heading, totals, size.columns));
				lines.push("");
				this.selectedFileIndex = Math.min(this.selectedFileIndex, files.length - 1);
				const maximumFileRows = Math.max(1, rowLimit - HEADING_ROWS - KEY_HINT_ROWS);
				const firstVisible = Math.max(0, Math.min(this.selectedFileIndex - maximumFileRows + 1, files.length - maximumFileRows));
				const visibleFiles = files.slice(firstVisible, firstVisible + maximumFileRows);
				const largestChange = Math.max(1, ...files.map((file) => file.added + file.removed));
				if (firstVisible > 0 && lines.length < rowLimit - KEY_HINT_ROWS) lines.push(theme.fg("dim", `↑ ${firstVisible} more`));
				for (let index = 0; index < visibleFiles.length && lines.length < rowLimit - KEY_HINT_ROWS; index++) {
					lines.push(this.fileLine(visibleFiles[index], largestChange, size.columns, firstVisible + index === this.selectedFileIndex));
				}
				const belowCount = files.length - firstVisible - visibleFiles.length;
				if (belowCount > 0 && lines.length < rowLimit - KEY_HINT_ROWS) lines.push(theme.fg("dim", `↓ ${belowCount} more file${belowCount === 1 ? "" : "s"}`));
			}
		}
		while (lines.length < rowLimit - 2) lines.push("");
		if (lines.length < rowLimit) lines.push("");
		if (lines.length < rowLimit) lines.push(theme.fg("dim", LIST_KEY_HINT));
		return lines.slice(0, rowLimit).map((line) => truncateToWidth(line, size.columns));
	}

	private fileLine(file: FileChange, largestChange: number, width: number, isSelected: boolean): string {
		const theme = this.options.theme;
		const changedLines = file.added + file.removed;
		const filledCells = changedLines === 0 ? 0 : Math.max(1, Math.round((changedLines / largestChange) * CHANGE_BAR_CELLS));
		const addedCells = changedLines === 0 ? 0 : Math.round((file.added / changedLines) * filledCells);
		const removedCells = filledCells - addedCells;
		const bar = theme.fg("toolDiffAdded", "■".repeat(addedCells)) + theme.fg("toolDiffRemoved", "■".repeat(removedCells)) + theme.fg("dim", "·".repeat(CHANGE_BAR_CELLS - filledCells));
		const counts = file.isBinary ? theme.fg("dim", "binary") : `${theme.fg("toolDiffAdded", `+${file.added}`)} ${theme.fg("toolDiffRemoved", `−${file.removed}`)}`;
		const tag = file.isNew ? theme.fg("dim", " new") : "";
		const prefix = isSelected ? theme.fg("accent", "❯ ") : "  ";
		const pathWidth = Math.max(8, width - CHANGE_BAR_CELLS - 4 - visibleWidth(counts) - visibleWidth(tag) - visibleWidth(prefix));
		const row = spread(`${prefix}${bar}  ${truncatePathStart(file.path, pathWidth)}${tag}`, counts, width);
		return isSelected ? theme.bg("selectedBg", row) : row;
	}

	handleInput(keys: string): void {
		if (this.diffView) {
			if (this.diffView.handleInput(keys) === "close") this.diffView = undefined;
			return;
		}
		const changes = this.options.readSnapshot().changes;
		if (changes.kind !== "loaded" || !changes.result.ok || changes.result.value.files.length === 0) return;
		const files = changes.result.value.files;
		if (matchesKey(keys, "up") || matchesKey(keys, "k")) this.selectedFileIndex = Math.max(0, this.selectedFileIndex - 1);
		else if (matchesKey(keys, "down") || matchesKey(keys, "j")) this.selectedFileIndex = Math.min(files.length - 1, this.selectedFileIndex + 1);
		else if (matchesKey(keys, "enter") || matchesKey(keys, "space")) {
			this.diffView = new FileDiffView({
				theme: this.options.theme,
					files,
					fileIndex: Math.min(this.selectedFileIndex, files.length - 1),
					loadDiff: (changedFile) => this.options.loadFileDiff(changedFile),
					highlight: this.options.highlight,
					bodyRows: () => Math.max(0, this.size.rows - KEY_HINT_ROWS),
				});
		}
	}
}
