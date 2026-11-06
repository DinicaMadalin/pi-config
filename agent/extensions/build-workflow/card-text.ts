/** Text helpers shared by the dashboard's cards and strip: widths, durations, money, model labels. */
import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
export const SPINNER_FRAME_MS = 100;

export type ThinkingColor = Parameters<Theme["fg"]>[0];
const THINKING_COLORS: Record<string, ThinkingColor> = {
	off: "thinkingOff",
	minimal: "thinkingMinimal",
	low: "thinkingLow",
	medium: "thinkingMedium",
	high: "thinkingHigh",
	xhigh: "thinkingXhigh",
	max: "thinkingMax",
};

export function formatDuration(durationMs: number): string {
	const totalSeconds = Math.floor(durationMs / 1000);
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const totalMinutes = Math.floor(totalSeconds / 60);
	if (totalMinutes < 60) return `${totalMinutes}m ${String(totalSeconds % 60).padStart(2, "0")}s`;
	return `${Math.floor(totalMinutes / 60)}h ${String(totalMinutes % 60).padStart(2, "0")}m`;
}

export function formatCost(costUsd: number): string {
	return costUsd > 0 ? `$${costUsd.toFixed(2)}` : "";
}

/** Keeps the end of a path, where the file name is. */
export function truncatePathStart(path: string, maxWidth: number): string {
	if (visibleWidth(path) <= maxWidth) return path;
	return `…${path.slice(path.length - maxWidth + 1)}`;
}

export function padStartToWidth(text: string, width: number): string {
	return " ".repeat(Math.max(0, width - visibleWidth(text))) + text;
}

export function padEndToWidth(text: string, width: number): string {
	const fitted = truncateToWidth(text, width, "…");
	return fitted + " ".repeat(Math.max(0, width - visibleWidth(fitted)));
}

/** Left text, then right text flush right; the left side gives way when both do not fit. */
export function spread(left: string, right: string, width: number): string {
	const rightWidth = visibleWidth(right);
	const fittedLeft = truncateToWidth(left, Math.max(0, width - rightWidth - 1), "…");
	return fittedLeft + " ".repeat(Math.max(1, width - visibleWidth(fittedLeft) - rightWidth)) + right;
}

/** "claude-opus-5-5 · high", the thinking level in its theme color. */
export function modelWithThinking(theme: Theme, model: string, thinkingLevel: string | undefined): string {
	if (!thinkingLevel) return model;
	const thinkingColor = THINKING_COLORS[thinkingLevel] ?? "muted";
	return `${model} ${theme.fg("dim", "·")} ${theme.fg(thinkingColor, thinkingLevel)}`;
}
