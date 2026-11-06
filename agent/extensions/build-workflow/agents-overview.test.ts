import assert from "node:assert/strict";
import { test } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { ControlCommand } from "./agent-controls.ts";
import type { FileDiffResult } from "./file-diff.ts";
import { type AgentKey, AgentsOverview, type DelegateRow, type OverviewActions, type OverviewSnapshot } from "./agents-overview.ts";
import { formatDuration } from "./card-text.ts";

const plainTheme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	italic: (text: string) => text,
	bg: (_color: string, text: string) => text,
	getBgAnsi: () => "",
	appearance: "dark",
} as unknown as Theme;

/** Marks background highlights as [[...]] so tests can see which text is highlighted. */
const markingTheme = { ...plainTheme, bg: (_color: string, text: string) => `[[${text}]]` } as unknown as Theme;

const busySnapshot: OverviewSnapshot = {
	nowMs: 10_000,
	changesBase: "abc1234def",
	delegates: [],
	planTitle: undefined,
	planText: "# Write per-device resolutions\n\n## Goal\nEvery Location gets deviceResolutions.\n\n## Approach\n1. Map screens",
	repo: { repoName: "neo4j-inventory-sync", branch: "issue-42-crash" },
	feeds: {
		planner: { activity: [{ kind: "text", text: "Plan saved.", atMs: 1_000 }], runningTool: undefined, messageBlocker: undefined },
		implementer: {
			activity: [
				{ kind: "tool", text: "read  src/providers/viooh/mapper.ts", atMs: 5_000 },
				{ kind: "you", text: "use the existing toInteger helper", atMs: 5_500 },
			],
			runningTool: { name: "bash", detail: "sed -n 195,260p src/__tests__/mapper.test.ts ".repeat(5), startedAtMs: 6_000 },
			messageBlocker: undefined,
		},
	},
	timeline: {
		task: "Write per-device screen resolutions (deviceResolutions) for every Location, provider-agnostic",
		phase: "implement",
		planRevision: 1,
		planPath: "/repo/.scratch/handoffs/2026-11-04-08-13-write-per-device-screen-resolutions-deviceresolu.md",
		baseCommit: "df0ec63cd56d",
		isFinished: false,
		activeMs: 1_000_000,
		costUsd: 5.13,
		stages: [
			{ key: "plan", agent: "planner", role: "Planner", status: "done", model: "claude-opus-5-5", thinkingLevel: "high", activeMs: 724_000, costUsd: 4.1, upcomingHint: "expert tier" },
			{ key: "implement", agent: "implementer", role: "Implementer", status: "working", model: "claude-opus-5-5", thinkingLevel: "high", routeReason: "rated expert (82%): deep architecture or long autonomous work", activeMs: 372_000, costUsd: 1.03, upcomingHint: "model picked by difficulty" },
			{ key: "review", reviewer: "anthropic", agent: "anthropic-reviewer", role: "Claude reviewer", status: "waiting", activeMs: 0, costUsd: 0, upcomingHint: "expert tier, Claude models first" },
			{ key: "review", reviewer: "openai", agent: "openai-reviewer", role: "OpenAI reviewer", status: "waiting", activeMs: 0, costUsd: 0, upcomingHint: "expert tier, OpenAI models first" },
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

const noDiff = async (): Promise<FileDiffResult> => ({ ok: false, error: "no diff in this test" });
const noActions: OverviewActions = {
	close: () => {},
	sendMessage: () => undefined,
	loadFileDiff: noDiff,
	control: async () => undefined,
	editPlan: () => {},
};

/** Actions that record every control the overview asks for. */
function recordingActions(commands: ControlCommand[]): OverviewActions {
	return {
		...noActions,
		control: async (command) => {
			commands.push(command);
			return undefined;
		},
	};
}

for (const width of [44, 72, 96]) {
	test(`every line is exactly ${width} columns wide, so the card never wraps`, () => {
		const overview = new AgentsOverview(plainTheme, () => busySnapshot, noActions);
		const lines = overview.render(width);
		assert.ok(lines.every((line) => visibleWidth(line) === width), lines.map((line) => `${visibleWidth(line)}|${line}`).join("\n"));
	});
}

test("shows the running agent's model, reason, tool and the changed files", () => {
	const text = new AgentsOverview(plainTheme, () => busySnapshot, noActions).render(96).join("\n");
	for (const expected of ["Implementer", "claude-opus-5-5 · high", "rated expert (82%)", "› bash", "+140 −12 · 2 files", "mapper.ts", "esc close", "you: use the existing toInteger helper"]) {
		assert.ok(text.includes(expected), `missing "${expected}" in\n${text}`);
	}
});

test("lists both reviewers as rows but as one Review step in the stepper", () => {
	const text = new AgentsOverview(plainTheme, () => busySnapshot, noActions).render(96).join("\n");
	assert.ok(text.includes("Claude reviewer") && text.includes("OpenAI reviewer"), text);
	assert.equal(text.match(/○ Review/g)?.length, 1, text);
});

test("shows the repository and branch the run works on", () => {
	const text = new AgentsOverview(plainTheme, () => busySnapshot, noActions).render(96).join("\n");
	assert.ok(text.includes("repo neo4j-inventory-sync   branch issue-42-crash"), text);
	const detached = { ...busySnapshot, repo: { repoName: "neo4j-inventory-sync", branch: undefined } };
	assert.ok(new AgentsOverview(plainTheme, () => detached, noActions).render(96).join("\n").includes("detached HEAD"));
});

test("highlights the whole row of the selected agent", () => {
	const lines = new AgentsOverview(markingTheme, () => busySnapshot, noActions).render(96);
	const highlighted = lines.filter((line) => line.includes("[[") && !line.includes("1 Agents"));
	assert.equal(highlighted.length, 1);
	assert.ok(highlighted[0].includes("❯ ") && highlighted[0].includes("Implementer"), highlighted[0]);
});

test("titles the card with the plan heading, else the task's first line without markdown", () => {
	const untitled = { ...busySnapshot, timeline: { ...busySnapshot.timeline!, task: "\n# Add resolutions\nmore detail" } };
	assert.ok(new AgentsOverview(plainTheme, () => untitled, noActions).render(72).join("\n").includes("│ Add resolutions"));
	const titled = { ...untitled, planTitle: "Write per-device resolutions" };
	assert.ok(new AgentsOverview(plainTheme, () => titled, noActions).render(72).join("\n").includes("Write per-device resolutions"));
});

test("says no build is running when there is none", () => {
	const idle: OverviewSnapshot = {
		nowMs: 0,
		repo: undefined,
		planTitle: undefined,
		planText: undefined,
		feeds: {},
		delegates: [],
		timeline: undefined,
		changes: { kind: "not-started" },
		changesBase: "HEAD",
	};
	const text = new AgentsOverview(plainTheme, () => idle, noActions).render(72).join("\n");
	assert.ok(text.includes("Workspace") && text.includes("No agents running"), text);
});

test("closes on Escape and Alt+A", () => {
	let closeCount = 0;
	const overview = new AgentsOverview(plainTheme, () => busySnapshot, { ...noActions, close: () => closeCount++ });
	overview.handleInput("\x1b");
	overview.handleInput("\x1ba");
	assert.equal(closeCount, 2);
});

test("shows the working agent's activity until the user selects another agent", () => {
	const overview = new AgentsOverview(plainTheme, () => busySnapshot, noActions);
	assert.ok(overview.render(96).join("\n").includes("❯ ⠋  Implementer"));
	overview.handleInput("\x1b[A");
	const text = overview.render(96).join("\n");
	assert.ok(text.includes("❯ ✓  Planner"), text);
	assert.ok(text.includes("“ Plan saved."), text);
});

test("Enter opens a message line and sends what the user typed to the selected agent", () => {
	const sent: Array<{ agent: AgentKey; text: string }> = [];
	const overview = new AgentsOverview(plainTheme, () => busySnapshot, {
		close: () => {},
		sendMessage: (agent, text) => {
			sent.push({ agent, text });
			return undefined;
		},
		loadFileDiff: noDiff,
		control: async () => undefined,
		editPlan: () => {},
	});
	overview.handleInput("\r");
	assert.ok(overview.render(96).join("\n").includes("Message to the Implementer"));
	for (const character of "rerun the tests") overview.handleInput(character);
	overview.handleInput("\r");
	assert.deepEqual(sent, [{ agent: "implementer", text: "rerun the tests" }]);
	assert.ok(!overview.render(96).join("\n").includes("Message to the"));
});

test("Escape in the message line cancels the message, not the overview", () => {
	let closeCount = 0;
	const overview = new AgentsOverview(plainTheme, () => busySnapshot, { ...noActions, close: () => closeCount++ });
	overview.handleInput("\r");
	overview.handleInput("\x1b");
	assert.equal(closeCount, 0);
	overview.handleInput("\x1b");
	assert.equal(closeCount, 1);
});

test("formats durations for people", () => {
	assert.equal(formatDuration(42_000), "42s");
	assert.equal(formatDuration(372_000), "6m 12s");
	assert.equal(formatDuration(3_840_000), "1h 04m");
});

test("2 opens the Changes tab, and Enter opens the selected file's diff", async () => {
	const requested: string[] = [];
	const overview = new AgentsOverview(markingTheme, () => busySnapshot, {
		...noActions,
		loadFileDiff: async (file) => {
			requested.push(file.path);
			return { ok: true, value: { path: file.path, lines: [{ kind: "added", newNumber: 1, text: "export const x = 1;" }] } };
		},
	});
	overview.handleInput("2");
	overview.handleInput("\x1b[B");
	const highlighted = overview.render(96).filter((line) => line.includes("[[") && !line.includes("1 Agents"));
	assert.equal(highlighted.length, 1);
	assert.ok(highlighted[0].includes("❯ ") && highlighted[0].includes("mapper.ts"), highlighted[0]);

	overview.handleInput("\r");
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(requested, ["src/providers/viooh/mapper.ts"]);
	const diffText = overview.render(96).join("\n");
	assert.ok(diffText.includes("export const x = 1;") && diffText.includes("file 2/2"), diffText);
	overview.handleInput("\x1b");
	assert.ok(overview.render(96).join("\n").includes("Changes"), "Escape returns to the overview");
});

function changesTab(overview: AgentsOverview): AgentsOverview {
	overview.handleInput("2");
	return overview;
}

test("the file list grows to fill the rows the card may use", () => {
	const manyFiles = Array.from({ length: 80 }, (_, index) => ({ path: `src/file${index}.ts`, added: 80 - index, removed: 0, isBinary: false, isNew: false }));
	const snapshot: OverviewSnapshot = { ...busySnapshot, changes: { kind: "loaded", result: { ok: true, value: { added: 3240, removed: 0, files: manyFiles } } } };
	const shownFileCount = (bodyRows: number): number =>
		changesTab(new AgentsOverview(plainTheme, () => snapshot, noActions, { bodyRows: () => bodyRows }))
			.render(120)
			.filter((line) => /src\/file\d+\.ts/.test(line)).length;
	assert.equal(shownFileCount(10), 3, "a short card still shows 3 files");
	assert.ok(shownFileCount(50) > 20, String(shownFileCount(50)));
	const tall = changesTab(new AgentsOverview(plainTheme, () => snapshot, noActions, { bodyRows: () => 50 })).render(120);
	// Body rows plus borders and padding; one row stays free while the list is scrolled to the top.
	assert.ok(tall.length <= 54 && tall.length >= 53, `the card fills its height without overflowing, got ${tall.length}`);
});

const reviewerRun: DelegateRow = {
	key: "delegate:del_abc_1",
	runId: "del_abc_1",
	role: "reviewer",
	task: "Code review, SPEC axis, of PR #21\nmore detail",
	status: "running",
	model: "claude-opus-5-5",
	thinkingLevel: "high",
	routeReason: undefined,
	elapsedMs: 87_000,
	costUsd: 0.42,
};

test("lists acp_delegate runs even without a build, with their task and activity", () => {
	const snapshot: OverviewSnapshot = {
		nowMs: 0,
		repo: undefined,
		planTitle: undefined,
		planText: undefined,
		timeline: undefined,
		changes: { kind: "not-started" },
		changesBase: "HEAD",
		delegates: [reviewerRun, { ...reviewerRun, key: "delegate:del_abc_2", runId: "del_abc_2", status: "completed", costUsd: 1 }],
		feeds: { "delegate:del_abc_1": { activity: [{ kind: "tool", text: "bash  pnpm test", atMs: 0 }], runningTool: undefined, messageBlocker: "no" } },
	};
	const text = new AgentsOverview(plainTheme, () => snapshot, noActions).render(100).join("\n");
	assert.ok(text.includes("Agents") && text.includes("Delegates") && text.includes("1 running"), text);
	assert.ok(text.includes("Reviewer") && text.includes("claude-opus-5-5 · high") && text.includes("1m 27s") && text.includes("$0.42"), text);
	assert.ok(text.includes("╰ Code review, SPEC axis, of PR #21") && !text.includes("more detail"), text);
	assert.ok(text.includes("Reviewer del_abc_1 activity") && text.includes("pnpm test"), text);
	assert.ok(text.includes("x cancel run"), text);
});

test("x twice cancels the selected running delegate; another key in between keeps it", () => {
	const commands: ControlCommand[] = [];
	const snapshot: OverviewSnapshot = { ...busySnapshot, delegates: [reviewerRun] };
	const overview = new AgentsOverview(plainTheme, () => snapshot, recordingActions(commands));
	for (let step = 0; step < 5; step++) overview.handleInput("\x1b[B");
	overview.handleInput("x");
	assert.ok(overview.render(100).join("\n").includes("Press x again to cancel the reviewer run del_abc_1"));
	overview.handleInput("\x1b[A");
	overview.handleInput("\x1b[B");
	overview.handleInput("x");
	assert.deepEqual(commands, []);
	overview.handleInput("x");
	assert.deepEqual(commands, [{ kind: "cancel-delegate", runId: "del_abc_1" }]);
});

test("the working implementer can be stopped at once, and restarting it asks for the key twice", () => {
	const commands: ControlCommand[] = [];
	const overview = new AgentsOverview(plainTheme, () => busySnapshot, recordingActions(commands));
	assert.ok(overview.render(100).join("\n").includes("keys  s stop turn · r restart"));
	overview.handleInput("s");
	overview.handleInput("r");
	assert.ok(overview.render(100).join("\n").includes("Press r again to restart the Implementer"));
	overview.handleInput("r");
	assert.deepEqual(commands, [
		{ kind: "agent", role: "implementer", control: "stop-turn" },
		{ kind: "agent", role: "implementer", control: "restart" },
	]);
});

const failedReviewSnapshot: OverviewSnapshot = {
	...busySnapshot,
	timeline: {
		...busySnapshot.timeline!,
		phase: "review-failed",
		stages: busySnapshot.timeline!.stages.map((stage) => ({ ...stage, status: "done" as const })),
	},
};

test("after a failed re-review the run's keys fix again, review again or accept after a second A", () => {
	const commands: ControlCommand[] = [];
	const overview = new AgentsOverview(plainTheme, () => failedReviewSnapshot, recordingActions(commands));
	assert.ok(overview.render(100).join("\n").includes("F fix again · R review again · A accept anyway"));
	overview.handleInput("F");
	overview.handleInput("A");
	overview.handleInput("j");
	overview.handleInput("A");
	assert.deepEqual(commands, [{ kind: "run", control: "fix-again" }]);
	overview.handleInput("A");
	assert.deepEqual(commands.at(-1), { kind: "run", control: "accept" });
});

test("number keys switch tabs; the Plan tab shows the plan and marks a changed plan until seen", () => {
	const changedPlan: OverviewSnapshot = { ...busySnapshot, timeline: { ...busySnapshot.timeline!, planRevision: 2 } };
	const overview = new AgentsOverview(plainTheme, () => changedPlan, noActions);
	assert.ok(overview.render(100).join("\n").includes("3 Plan v2 ●"));
	overview.handleInput("3");
	const planText = overview.render(100).join("\n");
	assert.ok(planText.includes("Goal") && planText.includes("Every Location gets deviceResolutions."), planText);
	assert.ok(planText.includes("changed, version 2"), planText);
	overview.handleInput("1");
	assert.ok(!overview.render(100).join("\n").includes("●"), "the marker goes once the plan was seen");
});

test("p opens the plan in the editor from any tab; Tab steps through the tabs", () => {
	let editCount = 0;
	const overview = new AgentsOverview(plainTheme, () => busySnapshot, { ...noActions, editPlan: () => editCount++ });
	overview.handleInput("\t");
	assert.ok(overview.render(100).join("\n").includes("enter diff"));
	overview.handleInput("\t");
	overview.handleInput("\t");
	assert.ok(overview.render(100).join("\n").includes("No report yet"));
	overview.handleInput("p");
	assert.equal(editCount, 1);
});

const uncommittedWork: OverviewSnapshot = {
	nowMs: 0,
	repo: { repoName: "pi-config", branch: "dashboard" },
	planTitle: undefined,
	planText: undefined,
	feeds: {},
	delegates: [],
	timeline: undefined,
	changesBase: "HEAD",
	changes: {
		kind: "loaded",
		result: { ok: true, value: { added: 12, removed: 3, files: [{ path: "src/app.ts", added: 12, removed: 3, isBinary: false, isNew: false }] } },
	},
};

test("outside a build the Changes tab lists the uncommitted work, and there is no Plan tab", () => {
	const overview = new AgentsOverview(plainTheme, () => uncommittedWork, noActions);
	assert.ok(overview.render(100).join("\n").includes("+12 −3 · 1 file"));
	overview.handleInput("3");
	overview.handleInput("2");
	const text = overview.render(100).join("\n");
	assert.ok(text.includes("Changes uncommitted") && text.includes("src/app.ts") && !text.includes("Plan"), text);
});

test("docked beside the chat, Esc goes back to the chat and Alt+A opens the full overview", () => {
	const calls: string[] = [];
	const actions: OverviewActions = { ...noActions, close: () => calls.push("close"), expand: () => calls.push("expand") };
	const overview = new AgentsOverview(plainTheme, () => uncommittedWork, actions, { bodyRows: () => 20, placement: "docked" });
	assert.ok(overview.render(60).join("\n").includes("alt+s focus"));
	overview.focused = true;
	const pane = overview.render(60);
	assert.ok(pane.join("\n").includes("esc chat"));
	assert.equal(pane.length, 20 + 4, "the docked pane keeps its full height");
	overview.handleInput("\x1ba");
	overview.handleInput("\x1b");
	assert.deepEqual(calls, ["expand", "close"]);
});
