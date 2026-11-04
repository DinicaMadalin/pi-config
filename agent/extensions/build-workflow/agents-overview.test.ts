import assert from "node:assert/strict";
import { test } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { AgentsOverview, formatDuration, type OverviewSnapshot } from "./agents-overview.ts";

const plainTheme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	italic: (text: string) => text,
} as unknown as Theme;

const busySnapshot: OverviewSnapshot = {
	nowMs: 10_000,
	planTitle: undefined,
	runningTool: { name: "bash", detail: "sed -n 195,260p src/__tests__/mapper.test.ts ".repeat(5), startedAtMs: 6_000 },
	timeline: {
		task: "Write per-device screen resolutions (deviceResolutions) for every Location, provider-agnostic",
		planPath: "/repo/.scratch/handoffs/2026-11-04-08-13-write-per-device-screen-resolutions-deviceresolu.md",
		baseCommit: "df0ec63cd56d",
		isFinished: false,
		activeMs: 1_000_000,
		costUsd: 5.13,
		stages: [
			{ key: "plan", role: "Planner", status: "done", model: "claude-opus-5-5", thinkingLevel: "high", activeMs: 724_000, costUsd: 4.1, upcomingHint: "expert tier" },
			{ key: "implement", role: "Implementer", status: "working", model: "claude-opus-5-5", thinkingLevel: "high", routeReason: "rated expert (82%): deep architecture or long autonomous work", activeMs: 372_000, costUsd: 1.03, upcomingHint: "model picked by difficulty" },
			{ key: "review", role: "Reviewer", status: "waiting", activeMs: 0, costUsd: 0, upcomingHint: "expert tier" },
		],
	},
	changes: {
		kind: "loaded",
		result: {
			ok: true,
			value: {
				added: 140,
				removed: 12,
				files: [
					{ path: "src/inventory/very/deeply/nested/folder/deviceResolutions.ts", added: 120, removed: 0, isBinary: false, isNew: true },
					{ path: "src/providers/viooh/mapper.ts", added: 20, removed: 12, isBinary: false, isNew: false },
				],
			},
		},
	},
};

for (const width of [44, 72, 96]) {
	test(`every line is exactly ${width} columns wide, so the card never wraps`, () => {
		const overview = new AgentsOverview(plainTheme, () => busySnapshot, () => {});
		const lines = overview.render(width);
		assert.ok(lines.every((line) => visibleWidth(line) === width), lines.map((line) => `${visibleWidth(line)}|${line}`).join("\n"));
	});
}

test("shows the running agent's model, reason, tool and the changed files", () => {
	const text = new AgentsOverview(plainTheme, () => busySnapshot, () => {}).render(96).join("\n");
	for (const expected of ["Implementer", "claude-opus-5-5 · high", "rated expert (82%)", "› bash", "+140 −12 · 2 files", "mapper.ts", "esc close"]) {
		assert.ok(text.includes(expected), `missing "${expected}" in\n${text}`);
	}
});

test("titles the card with the plan heading, else the task's first line without markdown", () => {
	const untitled = { ...busySnapshot, timeline: { ...busySnapshot.timeline!, task: "\n# Add resolutions\nmore detail" } };
	assert.ok(new AgentsOverview(plainTheme, () => untitled, () => {}).render(72).join("\n").includes("│ Add resolutions"));
	const titled = { ...untitled, planTitle: "Write per-device resolutions" };
	assert.ok(new AgentsOverview(plainTheme, () => titled, () => {}).render(72).join("\n").includes("Write per-device resolutions"));
});

test("says no build is running when there is none", () => {
	const idle: OverviewSnapshot = { nowMs: 0, planTitle: undefined, runningTool: undefined, timeline: undefined, changes: { kind: "not-started" } };
	const text = new AgentsOverview(plainTheme, () => idle, () => {}).render(72).join("\n");
	assert.ok(text.includes("No build running"));
});

test("closes on Escape and Alt+A", () => {
	let closeCount = 0;
	const overview = new AgentsOverview(plainTheme, () => busySnapshot, () => closeCount++);
	overview.handleInput("\x1b");
	overview.handleInput("\x1ba");
	assert.equal(closeCount, 2);
});

test("formats durations for people", () => {
	assert.equal(formatDuration(42_000), "42s");
	assert.equal(formatDuration(372_000), "6m 12s");
	assert.equal(formatDuration(3_840_000), "1h 04m");
});
