/**
 * The run's changed files for the Diff tab: counted against the run's base commit, re-counted every few seconds,
 * and the diff of one file on request. Holds no screen code, so the Diff tab's renderer stays a pure view.
 */
import type { FileDiffResult } from "./file-diff.ts";
import type { FileChange, WorkChangesResult } from "./work-changes.ts";
import { isFeatureState, type WorkflowState } from "./workflow-state.ts";

export type ChangesView = { kind: "not-started" } | { kind: "loading" } | { kind: "loaded"; result: WorkChangesResult };

export interface ChangedFilesSnapshot {
	changes: ChangesView;
	/** What the changes are counted against; undefined while the run has none. */
	baseCommit: string | undefined;
}

/** Agents edit all the time while a run works; a few seconds is fresh enough and cheap for git. */
export const CHANGES_REFRESH_MS = 3000;

export function baseCommitOfRun(state: WorkflowState): string | undefined {
	if (!isFeatureState(state) || !state.worktree) return undefined;
	return state.baseCommit;
}

export class RunChangesFeed {
	private readonly loadChanges: (baseCommit: string) => Promise<WorkChangesResult>;
	private readonly loadDiff: (baseCommit: string, file: FileChange) => Promise<FileDiffResult>;
	private readonly refreshMs: number;
	private baseCommit: string | undefined;
	private changes: ChangesView = { kind: "not-started" };
	private isLoading = false;
	private lastLoadFinishedAtMs = 0;
	private latestNowMs = 0;

	constructor(
		loadChanges: (baseCommit: string) => Promise<WorkChangesResult>,
		loadDiff: (baseCommit: string, file: FileChange) => Promise<FileDiffResult>,
		refreshMs = CHANGES_REFRESH_MS,
	) {
		this.loadChanges = loadChanges;
		this.loadDiff = loadDiff;
		this.refreshMs = refreshMs;
	}

	refresh(baseCommit: string | undefined, nowMs: number): void {
		this.latestNowMs = nowMs;
		if (!baseCommit) {
			this.baseCommit = undefined;
			this.changes = { kind: "not-started" };
			return;
		}
		if (baseCommit !== this.baseCommit) {
			this.baseCommit = baseCommit;
			this.changes = { kind: "loading" };
			this.load(baseCommit);
			return;
		}
		if (this.isLoading || nowMs - this.lastLoadFinishedAtMs < this.refreshMs) return;
		this.load(baseCommit);
	}

	private load(baseCommit: string): void {
		this.isLoading = true;
		void this.loadChanges(baseCommit)
			.then((result) => {
				if (baseCommit === this.baseCommit) this.changes = { kind: "loaded", result };
			})
			.catch((error: unknown) => {
				if (baseCommit === this.baseCommit) this.changes = { kind: "loaded", result: { ok: false, error: `Failed to count changes: ${(error as Error).message}` } };
			})
			.finally(() => {
				this.isLoading = false;
				this.lastLoadFinishedAtMs = this.latestNowMs;
			});
	}


	snapshot(): ChangedFilesSnapshot {
		return { changes: this.changes, baseCommit: this.baseCommit };
	}

	loadFileDiff(file: FileChange): Promise<FileDiffResult> {
		if (!this.baseCommit) return Promise.resolve({ ok: false, error: "The changes are still being counted" });
		return this.loadDiff(this.baseCommit, file);
	}
}
