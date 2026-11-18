/**
 * Keeps the run's Diff tab (diff-tab.ts) drawn: every tick the planner re-reads the run's base commit, counts the
 * changed files when due (run-changes-feed.ts) and pushes the next frame. Only inside herdr, in a session with a UI,
 * and only once the review passed: before that the work is still changing.
 * Replaces the dashboard's timer, which also drew the strip, the docked pane and the Overview tab.
 */
import { type ExtensionAPI, getLanguageFromPath, highlightCode } from "@earendil-works/pi-coding-agent";
import type { BuildSpace } from "./build-space.ts";
import { ChangedFilesScreen } from "./changed-files-screen.ts";
import type { HighlightCode } from "./file-diff-view.ts";
import { loadFileDiff } from "./file-diff.ts";
import type { PlannerSession } from "./planner-session.ts";
import { baseCommitOfRun, RunChangesFeed } from "./run-changes-feed.ts";
import { loadWorkChanges } from "./work-changes.ts";
import { hasPassedReview } from "./workflow-state.ts";

const DIFF_TAB_TICK_MS = 500;

const highlightForPath: HighlightCode = (codeLines, path) => {
	const language = getLanguageFromPath(path);
	if (!language) return [...codeLines];
	return highlightCode(codeLines.join("\n"), language);
};

export function registerDiffTab(pi: ExtensionAPI, session: PlannerSession, buildSpace: BuildSpace | undefined): void {
	if (!buildSpace) return;
	let feed: RunChangesFeed | undefined;
	let screen: ChangedFilesScreen | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	const stopTimer = (): void => {
		if (timer) clearInterval(timer);
		timer = undefined;
	};
	pi.on("session_start", (_event, ctx) => {
		stopTimer();
		feed = undefined;
		screen = undefined;
		if (!ctx.hasUI) return;
		feed = new RunChangesFeed(
			(baseCommit) => loadWorkChanges(session.run, baseCommit),
			(baseCommit, file) => loadFileDiff(session.run, baseCommit, file),
		);
		screen = new ChangedFilesScreen({ theme: ctx.ui.theme, readSnapshot: () => feed?.snapshot() ?? { changes: { kind: "not-started" }, baseCommit: undefined }, loadFileDiff: (file) => feed?.loadFileDiff(file) ?? Promise.resolve({ ok: false, error: "The changes are still being counted" }), highlight: highlightForPath });
		const tick = (): void => {
			if (!hasPassedReview(session.workflow.phase)) {
				buildSpace.hideDiff();
				return;
			}
			feed?.refresh(baseCommitOfRun(session.workflow), Date.now());
			if (screen) buildSpace.refreshDiff(screen);
		};
		tick();
		timer = setInterval(tick, DIFF_TAB_TICK_MS);
		timer.unref();
	});
	pi.on("session_shutdown", async (_event, ctx) => {
		stopTimer();
		feed = undefined;
		screen = undefined;
		await buildSpace.detach().catch((error: unknown) => ctx.ui.notify(`Could not stop the Diff tab: ${(error as Error).message}`, "warning"));
	});
}
