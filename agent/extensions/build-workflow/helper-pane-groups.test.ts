import assert from "node:assert/strict";
import { test } from "node:test";
import { HerdrClient, type PaneLayout } from "../herdr-tools/herdr-cli.ts";
import { equalizingResizes, helperGroupOf, HelperPaneGroups } from "./helper-pane-groups.ts";

function columns(ratios: number[]): PaneLayout {
	const count = ratios.length + 1;
	return {
		panes: Array.from({ length: count }, (_, index) => ({ paneId: `p${index + 1}`, x: index * 10, width: 10 })),
		splits: ratios.map((ratio, index) => ({ direction: "right" as const, ratio, x: index * 10, y: 0 })),
	};
}

test("implementers and reviewers each get their own group", () => {
	assert.equal(helperGroupOf("implementer"), "implementers");
	assert.equal(helperGroupOf("implementer-3"), "implementers");
	assert.equal(helperGroupOf("openai-reviewer"), "reviewers");
});

test("three columns made by halving the rightmost pane become three equal columns", () => {
	const resizes = equalizingResizes(columns([0.5, 0.5]));
	assert.equal(resizes.length, 1);
	assert.equal(resizes[0].paneId, "p2");
	assert.equal(resizes[0].direction, "left");
	assert.ok(Math.abs(resizes[0].amount - (0.5 - 1 / 3)) < 1e-9);
});

test("a too narrow first column grows to the right", () => {
	assert.deepEqual(equalizingResizes(columns([0.25])), [{ paneId: "p1", direction: "right", amount: 0.25 }]);
});

test("equal columns, a single pane and cell rounding need no resize", () => {
	assert.deepEqual(equalizingResizes(columns([0.334, 0.5])), []);
	assert.deepEqual(equalizingResizes(columns([0.5])), []);
	assert.deepEqual(equalizingResizes(columns([])), []);
});

/** A herdr fake that keeps panes per tab and lays them out as herdr does: every split halves the pane. */
function fakeHerdr(options: { failResize?: boolean } = {}) {
	const calls: string[][] = [];
	const tabs = new Map<string, { panes: string[]; ratios: number[] }>();
	let nextId = 0;
	const tabOf = (paneId: string) => [...tabs].find(([, tab]) => tab.panes.includes(paneId));
	const success = (result: unknown) => ({ code: 0, stdout: JSON.stringify({ result }), stderr: "" });
	const failure = (code: string) => ({ code: 1, stdout: "", stderr: JSON.stringify({ error: { code, message: code } }) });
	const client = new HerdrClient(async (args) => {
		calls.push([...args]);
		const action = args.slice(0, 2).join(" ");
		if (action === "tab create") {
			const tabId = `w9:t${++nextId}`;
			const paneId = `w9:p${++nextId}`;
			tabs.set(tabId, { panes: [paneId], ratios: [] });
			return success({ tab: { tab_id: tabId }, root_pane: { pane_id: paneId, workspace_id: "w9" } });
		}
		if (action === "pane split") {
			const owner = tabOf(args[2]);
			if (!owner) return failure("pane_not_found");
			const paneId = `w9:p${++nextId}`;
			owner[1].panes.push(paneId);
			owner[1].ratios.push(0.5);
			return success({ pane: { pane_id: paneId, workspace_id: "w9" } });
		}
		if (action === "pane layout") {
			const tab = tabOf(args[3])?.[1];
			const layout = {
				panes: tab?.panes.map((pane_id, index) => ({ pane_id, rect: { x: index * 10, width: 10 } })),
				splits: tab?.ratios.map((ratio, index) => ({ direction: "right", ratio, rect: { x: index * 10, y: 0 } })),
			};
			return success({ layout });
		}
		if (action === "pane resize") return options.failResize ? failure("unavailable") : success({});
		if (action === "pane close") {
			const owner = tabOf(args[2]);
			if (owner) {
				const index = owner[1].panes.indexOf(args[2]);
				owner[1].panes.splice(index, 1);
				owner[1].ratios.splice(Math.max(0, index - 1), 1);
			}
			return success({});
		}
		if (action === "tab close") {
			tabs.delete(args[2]);
			return success({});
		}
		if (action === "pane zoom") return success({});
		throw new Error(`Unexpected herdr command: ${args.join(" ")}`);
	});
	return { client, calls, tabs };
}

test("three implementers share one Implementers tab in equal columns; reviewers get their own tab", async () => {
	const { client, calls, tabs } = fakeHerdr();
	const groups = new HelperPaneGroups(client);
	const errors: unknown[] = [];
	const report = (error: unknown) => errors.push(error);
	const implementerPanes = await Promise.all([1, 2, 3].map(() => groups.openPane("w9", "implementers", "/tree", report)));
	const reviewerPanes = await Promise.all([1, 2].map(() => groups.openPane("w9", "reviewers", "/tree", report)));
	assert.deepEqual(calls.filter((args) => args[1] === "create"), [
		["tab", "create", "--workspace", "w9", "--cwd", "/tree", "--label", "Implementers", "--no-focus"],
		["tab", "create", "--workspace", "w9", "--cwd", "/tree", "--label", "Reviewers", "--no-focus"],
	]);
	assert.equal(new Set(implementerPanes).size, 3);
	assert.deepEqual([...tabs.values()].map((tab) => tab.panes.length), [3, 2]);
	const splits = calls.filter((args) => args[1] === "split");
	assert.ok(splits.every((args) => args.includes("--no-focus") && args.includes("right")));
	assert.deepEqual(splits[1].slice(0, 3), ["pane", "split", implementerPanes[1]], "the third column splits the rightmost pane");
	assert.deepEqual(calls.filter((args) => args[1] === "resize").map((args) => args.slice(0, 6)), [["pane", "resize", "--pane", implementerPanes[1], "--direction", "left"]]);
	assert.deepEqual(errors, []);
	assert.equal(reviewerPanes.length, 2);
});

test("a leaving helper closes only its pane; the last one closes the group's tab", async () => {
	const { client, calls, tabs } = fakeHerdr();
	const groups = new HelperPaneGroups(client);
	const report = () => {};
	const [first, second] = [await groups.openPane("w9", "reviewers", "/tree", report), await groups.openPane("w9", "reviewers", "/tree", report)];
	await groups.closePane(first, report);
	assert.deepEqual(calls.at(-2), ["pane", "close", first]);
	assert.equal(calls.some((args) => args[0] === "tab" && args[1] === "close"), false);
	await groups.closePane(second, report);
	assert.deepEqual(calls.at(-1)?.slice(0, 2), ["tab", "close"]);
	assert.equal(tabs.size, 0);
});

test("a helper joining after you closed the group's tab opens a fresh tab", async () => {
	const { client, calls, tabs } = fakeHerdr();
	const groups = new HelperPaneGroups(client);
	await groups.openPane("w9", "implementers", "/tree", () => {});
	tabs.clear();
	const pane = await groups.openPane("w9", "implementers", "/tree", () => {});
	assert.equal(calls.filter((args) => args[1] === "create").length, 2);
	assert.equal([...tabs.values()][0].panes[0], pane);
});

test("a failed resize is reported and the helper still gets its pane", async () => {
	const { client } = fakeHerdr({ failResize: true });
	const groups = new HelperPaneGroups(client);
	const errors: unknown[] = [];
	for (let count = 0; count < 3; count++) await groups.openPane("w9", "implementers", "/tree", (error) => errors.push(error));
	assert.equal(errors.length, 1);
	assert.match(String(errors[0]), /resize/);
});

