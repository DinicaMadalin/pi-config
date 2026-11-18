/** Text helpers for the Diff tab's file list: path truncation and left/right spreading. */
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/** Keeps the end of a path, where the file name is. */
export function truncatePathStart(path: string, maxWidth: number): string {
	if (visibleWidth(path) <= maxWidth) return path;
	return `…${path.slice(path.length - maxWidth + 1)}`;
}

/** Left text, then right text flush right; the left side gives way when both do not fit. */
export function spread(left: string, right: string, width: number): string {
	const rightWidth = visibleWidth(right);
	const fittedLeft = truncateToWidth(left, Math.max(0, width - rightWidth - 1), "…");
	return fittedLeft + " ".repeat(Math.max(1, width - visibleWidth(fittedLeft) - rightWidth)) + right;
}
