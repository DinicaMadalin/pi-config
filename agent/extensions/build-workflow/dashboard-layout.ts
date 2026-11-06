/**
 * How the dashboard sits around the chat, chosen with /dashboard and remembered across sessions: the strip
 * above the editor (full, one line, or hidden) and the side panel (right, left, or off). The side panel covers
 * the chat's edge, since Pi cannot narrow the chat, so it only shows on terminals wide enough to spare it.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type StripSize = "full" | "compact" | "hidden";
export type SidePanelPlacement = "right" | "left" | "off";

export interface DashboardLayout {
	strip: StripSize;
	sidePanel: SidePanelPlacement;
}

export const DEFAULT_LAYOUT: DashboardLayout = { strip: "full", sidePanel: "right" };

/** Below this the side panel would leave the chat too narrow to read, so it hides; the strip stays. */
export const MIN_COLUMNS_FOR_SIDE_PANEL = 160;
/** Pi resolves a percentage on every render, so the panel follows the terminal's width. */
export const SIDE_PANEL_WIDTH = "34%";
export const MIN_SIDE_PANEL_WIDTH = 56;

export const LAYOUT_CHOICES: readonly { label: string; layout: DashboardLayout }[] = [
	{ label: "Strip + side panel on the right", layout: { strip: "full", sidePanel: "right" } },
	{ label: "Strip + side panel on the left", layout: { strip: "full", sidePanel: "left" } },
	{ label: "Strip only", layout: { strip: "full", sidePanel: "off" } },
	{ label: "One-line strip + side panel on the right", layout: { strip: "compact", sidePanel: "right" } },
	{ label: "One-line strip only", layout: { strip: "compact", sidePanel: "off" } },
	{ label: "Nothing (Alt+A still opens the overview)", layout: { strip: "hidden", sidePanel: "off" } },
];

const STRIP_SIZES: readonly StripSize[] = ["full", "compact", "hidden"];
const SIDE_PANEL_PLACEMENTS: readonly SidePanelPlacement[] = ["right", "left", "off"];

export function canShowSidePanel(layout: DashboardLayout, terminalColumns: number): boolean {
	return layout.sidePanel !== "off" && terminalColumns >= MIN_COLUMNS_FOR_SIDE_PANEL;
}

/** A saved layout; parts that are missing or unknown, e.g. from a hand edit, fall back to the default. */
export function parseLayout(saved: unknown): DashboardLayout {
	const fields = (typeof saved === "object" && saved !== null ? saved : {}) as Record<string, unknown>;
	const strip = STRIP_SIZES.find((size) => size === fields.strip) ?? DEFAULT_LAYOUT.strip;
	const sidePanel = SIDE_PANEL_PLACEMENTS.find((placement) => placement === fields.sidePanel) ?? DEFAULT_LAYOUT.sidePanel;
	return { strip, sidePanel };
}

export function loadLayout(layoutPath: string): DashboardLayout {
	if (!existsSync(layoutPath)) return DEFAULT_LAYOUT;
	try {
		return parseLayout(JSON.parse(readFileSync(layoutPath, "utf8")));
	} catch (error) {
		throw new Error(`Failed to read the dashboard layout from ${layoutPath}: ${(error as Error).message}`);
	}
}

export function saveLayout(layoutPath: string, layout: DashboardLayout): void {
	mkdirSync(dirname(layoutPath), { recursive: true });
	writeFileSync(layoutPath, `${JSON.stringify(layout, null, "\t")}\n`);
}
