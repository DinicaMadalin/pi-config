/**
 * Pure state machine of the /build workflow: plan (expert) -> implement (fresh session, model picked by
 * difficulty) -> review (expert) -> at most one fix (picked by difficulty) and re-review (expert).
 * No Pi runtime imports, so every transition can be unit tested.
 */
import type { RoutePin } from "../auto-model/route-pin.ts";

export const WORKFLOW_STATE_ENTRY_TYPE = "build-workflow-state";

/** Marker lines the agent ends a turn with; the workflow reads them to move to the next phase. */
export const IMPLEMENTATION_DONE_MARKER = "IMPLEMENTATION: done";
export const IMPLEMENTATION_BLOCKED_MARKER = "IMPLEMENTATION: blocked";
export const REVIEW_PASS_MARKER = "REVIEW_VERDICT: pass";
export const REVIEW_FIX_MARKER = "REVIEW_VERDICT: fix";

export interface FeatureWork {
	planPath: string;
	/** HEAD when implementation started; the reviewer diffs against it. Undefined outside a git repo. */
	baseCommit?: string;
}

export type WorkflowState =
	| { phase: "idle" }
	| { phase: "plan"; task: string }
	| { phase: "awaiting-implementation"; task: string; planPath: string }
	| ({ phase: "implement" } & FeatureWork)
	| ({ phase: "review" } & FeatureWork)
	| ({ phase: "fix" } & FeatureWork)
	| ({ phase: "re-review" } & FeatureWork);

export type WorkflowPhase = WorkflowState["phase"];

export const IDLE_WORKFLOW: WorkflowState = { phase: "idle" };

/** Planning and reviewing always use the expert; Jev picks the implementer's model and thinking by difficulty. */
export function routeForPhase(phase: WorkflowPhase): RoutePin {
	switch (phase) {
		case "plan":
		case "awaiting-implementation":
		case "review":
		case "re-review":
			return { route: "tier", tier: "expert" };
		case "implement":
		case "fix":
			return { route: "difficulty" };
		case "idle":
			return { route: "normal" };
	}
}

/** Planning and reviewing must not change files; only the implementer edits. */
export function canEditFiles(phase: WorkflowPhase): boolean {
	return phase === "idle" || phase === "implement" || phase === "fix";
}

interface SessionEntryLike {
	type: string;
	customType?: string;
	data?: unknown;
}

export function findWorkflowState(branchEntries: readonly SessionEntryLike[]): WorkflowState {
	for (let index = branchEntries.length - 1; index >= 0; index--) {
		const entry = branchEntries[index];
		if (entry.type === "custom" && entry.customType === WORKFLOW_STATE_ENTRY_TYPE) return entry.data as WorkflowState;
	}
	return IDLE_WORKFLOW;
}

/** Last marker line wins, so a quoted marker earlier in the answer does not count. */
function lastMarker(answer: string, markers: readonly string[]): string | undefined {
	const markerLines = answer
		.split("\n")
		.map((line) => line.trim().replace(/^[`*_]+|[`*_]+$/g, ""))
		.filter((line) => markers.some((marker) => line.startsWith(marker)));
	const lastLine = markerLines.at(-1);
	return markers.find((marker) => lastLine?.startsWith(marker));
}

/** What the workflow does after an agent turn settles in a phase. */
export type WorkflowStep =
	| { kind: "wait"; reason: string }
	| { kind: "advance"; next: WorkflowState }
	| { kind: "finish"; summary: string };

export function stepAfterTurn(state: WorkflowState, lastAnswer: string): WorkflowStep {
	switch (state.phase) {
		case "idle":
		case "plan":
		case "awaiting-implementation":
			return { kind: "wait", reason: "the plan needs your agreement" };
		case "implement":
		case "fix": {
			const marker = lastMarker(lastAnswer, [IMPLEMENTATION_DONE_MARKER, IMPLEMENTATION_BLOCKED_MARKER]);
			if (marker !== IMPLEMENTATION_DONE_MARKER) return { kind: "wait", reason: "the implementer needs your answer" };
			const work: FeatureWork = { planPath: state.planPath, baseCommit: state.baseCommit };
			return { kind: "advance", next: { phase: state.phase === "implement" ? "review" : "re-review", ...work } };
		}
		case "review": {
			const verdict = lastMarker(lastAnswer, [REVIEW_PASS_MARKER, REVIEW_FIX_MARKER]);
			if (verdict === REVIEW_PASS_MARKER) return { kind: "finish", summary: "the review passed" };
			if (verdict === REVIEW_FIX_MARKER) {
				return { kind: "advance", next: { phase: "fix", planPath: state.planPath, baseCommit: state.baseCommit } };
			}
			return { kind: "wait", reason: "the review ended without a verdict" };
		}
		case "re-review": {
			const verdict = lastMarker(lastAnswer, [REVIEW_PASS_MARKER, REVIEW_FIX_MARKER]);
			if (verdict === REVIEW_PASS_MARKER) return { kind: "finish", summary: "the re-review passed" };
			return { kind: "finish", summary: "the re-review still has findings; the fix round is used up, over to you" };
		}
	}
}
