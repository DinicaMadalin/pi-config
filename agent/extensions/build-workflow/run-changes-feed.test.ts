import assert from "node:assert/strict";
import { test } from "node:test";
import type { FileDiffResult } from "./file-diff.ts";
import { baseCommitOfRun, RunChangesFeed } from "./run-changes-feed.ts";
import type { FileChange, WorkChangesResult } from "./work-changes.ts";
import type { WorkflowState } from "./workflow-state.ts";

const worktree = { path: "/w", workspaceId: "w1", rootPaneId: "w1:p1" };
const file: FileChange = { path: "a.ts", added: 1, removed: 0, isBinary: false, isNew: false };
const someChanges: WorkChangesResult = { ok: true, value: { files: [file], added: 1, removed: 0 } };

function controllableLoader() {
	const loads: { baseCommit: string; resolve: (result: WorkChangesResult) => void; reject: (error: Error) => void }[] = [];
	const loadChanges = (baseCommit: string) =>
		new Promise<WorkChangesResult>((resolve, reject) => {
			loads.push({ baseCommit, resolve, reject });
		});
	return { loads, loadChanges };
}

const noDiff = async (): Promise<FileDiffResult> => ({ ok: false, error: "unused" });
const settle = () => new Promise((resolve) => setImmediate(resolve));

test("the Diff tab counts against the base commit of a run working in its own worktree", () => {
	assert.equal(baseCommitOfRun({ phase: "implement", planPath: "p", baseCommit: "abc", worktree } as WorkflowState), "abc");
	assert.equal(baseCommitOfRun({ phase: "awaiting-ship", planPath: "p", baseCommit: "abc", worktree } as WorkflowState), "abc");
	assert.equal(baseCommitOfRun({ phase: "implement", planPath: "p", baseCommit: "abc" } as WorkflowState), undefined);
	assert.equal(baseCommitOfRun({ phase: "implement", planPath: "p", worktree } as WorkflowState), undefined);
	assert.equal(baseCommitOfRun({ phase: "idle" }), undefined);
});

test("without a base nothing is counted", () => {
	const { loads, loadChanges } = controllableLoader();
	const feed = new RunChangesFeed(loadChanges, noDiff, 3000);
	assert.deepEqual(feed.snapshot(), { changes: { kind: "not-started" }, baseCommit: undefined });
	feed.refresh(undefined, 0);
	assert.deepEqual(feed.snapshot(), { changes: { kind: "not-started" }, baseCommit: undefined });
	assert.equal(loads.length, 0);
});

test("changes load at once for a new base, then again only after the refresh interval", async () => {
	const { loads, loadChanges } = controllableLoader();
	const feed = new RunChangesFeed(loadChanges, noDiff, 3000);
	feed.refresh("a", 0);
	assert.deepEqual(feed.snapshot(), { changes: { kind: "loading" }, baseCommit: "a" });
	feed.refresh("a", 1000);
	assert.equal(loads.length, 1);
	loads[0].resolve(someChanges);
	await settle();
	assert.deepEqual(feed.snapshot(), { changes: { kind: "loaded", result: someChanges }, baseCommit: "a" });
	feed.refresh("a", 2000);
	assert.equal(loads.length, 1);
	feed.refresh("a", 4000);
	assert.equal(loads.length, 2);
	feed.refresh("b", 4001);
	assert.deepEqual(loads.map((load) => load.baseCommit), ["a", "a", "b"]);
	assert.deepEqual(feed.snapshot().changes, { kind: "loading" });
});

test("a result for an older base is dropped", async () => {
	const { loads, loadChanges } = controllableLoader();
	const feed = new RunChangesFeed(loadChanges, noDiff, 3000);
	feed.refresh("a", 0);
	feed.refresh("b", 10);
	loads[0].resolve(someChanges);
	await settle();
	assert.deepEqual(feed.snapshot(), { changes: { kind: "loading" }, baseCommit: "b" });
});

test("a failed count shows why", async () => {
	const { loads, loadChanges } = controllableLoader();
	const feed = new RunChangesFeed(loadChanges, noDiff, 3000);
	feed.refresh("a", 0);
	loads[0].reject(new Error("git exploded"));
	await settle();
	assert.deepEqual(feed.snapshot().changes, { kind: "loaded", result: { ok: false, error: "Failed to count changes: git exploded" } });
});

test("a file's diff loads against the current base, and waits for one", async () => {
	const diffs: string[] = [];
	const feed = new RunChangesFeed(controllableLoader().loadChanges, async (baseCommit, changed) => {
		diffs.push(`${baseCommit}:${changed.path}`);
		return { ok: false, error: "fake" };
	});
	assert.deepEqual(await feed.loadFileDiff(file), { ok: false, error: "The changes are still being counted" });
	feed.refresh("a", 0);
	await feed.loadFileDiff(file);
	assert.deepEqual(diffs, ["a:a.ts"]);
});
