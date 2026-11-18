import assert from "node:assert/strict";
import { test } from "node:test";
import type { HerdrClient } from "../herdr-tools/herdr-cli.ts";
import { BuildDiffTab, DIFF_TAB_LABEL } from "./diff-tab.ts";

/** Records what the Diff tab asks herdr to do; `tabs` is what herdr lists in the workspace. */
function fakeHerdr(tabs: { tabId: string; label: string }[]) {
	const calls: string[] = [];
	const client = {
		listTabs: async () => tabs,
		createTab: async (_workspaceId: string, cwd: string, label: string) => {
			calls.push(`create ${label} in ${cwd}`);
			tabs.push({ tabId: "w9:t2", label });
			return { tabId: "w9:t2", rootPaneId: "w9:p2" };
		},
		runInPane: async (paneId: string, commandLine: string) => {
			calls.push(`run in ${paneId}: ${commandLine.includes("pane-screen-client.ts") && commandLine.includes("pi-diff-w9.sock")}`);
		},
		closeTab: async (tabId: string) => {
			calls.push(`close ${tabId}`);
		},
		renameTab: async (tabId: string, label: string) => {
			calls.push(`rename ${tabId} ${label}`);
		},
	} as unknown as HerdrClient;
	return { client, calls };
}

const worktree = { path: "/repo-worktrees/build-x", workspaceId: "w9", rootPaneId: "w9:p1" };

test("a run's workspace gets a Diff tab running the screen client, and its first tab stays a shell", async () => {
	const { client, calls } = fakeHerdr([{ tabId: "w9:t1", label: "Shell" }]);
	const tab = new BuildDiffTab(client);
	await tab.open(worktree);
	await tab.open(worktree);
	assert.equal(tab.workspaceId, "w9");
	assert.deepEqual(calls, [`create ${DIFF_TAB_LABEL} in /repo-worktrees/build-x`, "run in w9:p2: true"]);
	await tab.close();
	assert.deepEqual(calls.slice(2), ["close w9:t2"]);
	assert.equal(tab.workspaceId, undefined);
});

test("after a reload the existing Diff tab is reused, and detaching leaves it open", async () => {
	const { client, calls } = fakeHerdr([
		{ tabId: "w9:t1", label: "Shell" },
		{ tabId: "w9:t2", label: DIFF_TAB_LABEL },
	]);
	const tab = new BuildDiffTab(client);
	await tab.open(worktree);
	await tab.detach();
	assert.deepEqual(calls, []);
	assert.equal(tab.workspaceId, undefined);
});

test("drawing before any client connected does nothing", async () => {
	const { client } = fakeHerdr([]);
	const tab = new BuildDiffTab(client);
	let renders = 0;
	tab.draw({ render: () => [String(++renders)], handleInput: () => {} });
	await tab.open(worktree);
	tab.draw({ render: () => [String(++renders)], handleInput: () => {} });
	assert.equal(renders, 0);
	await tab.close();
});
