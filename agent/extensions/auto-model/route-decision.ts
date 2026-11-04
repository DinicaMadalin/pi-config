/**
 * Why the router picked a tier for a new task, saved as a session entry so other extensions
 * (the /build agents overview) can show it next to the model that answered.
 */
import type { TaskKind } from "./classify-difficulty.ts";
import type { DifficultyTier, RoutedThinkingLevel } from "./difficulty-tiers.ts";

export const ROUTE_DECISION_ENTRY_TYPE = "auto-model-route";

export interface RouteDecision {
	tier: DifficultyTier;
	thinkingLevel: RoutedThinkingLevel;
	/** One line for people, e.g. "rated complex (78%): multi-file or tricky change". */
	reason: string;
}

/** How the tier was reached; turned into RouteDecision.reason. */
export type TierBasis =
	| { kind: "rated"; ratedTier: DifficultyTier; confidence: number }
	| { kind: "important-task"; taskKind: TaskKind }
	| { kind: "rating-unavailable" }
	| { kind: "pinned" };

const TIER_SUMMARIES: Record<DifficultyTier, string> = {
	trivial: "read-only or tiny edit",
	standard: "ordinary change in a few files",
	complex: "multi-file or tricky change",
	expert: "deep architecture or long autonomous work",
};

const TASK_KIND_LABELS: Record<TaskKind, string> = {
	feature_planning: "feature planning",
	code_review: "code review",
	issue_investigation: "issue investigation",
	feature_build: "feature build",
	other: "task",
};

export function describeTierBasis(basis: TierBasis, routedTier: DifficultyTier): string {
	switch (basis.kind) {
		case "rated": {
			const confidencePercent = Math.round(basis.confidence * 100);
			const rated = `rated ${basis.ratedTier} (${confidencePercent}%): ${TIER_SUMMARIES[basis.ratedTier]}`;
			return basis.ratedTier === routedTier ? rated : `${rated}, routed to ${routedTier}`;
		}
		case "important-task":
			return `${TASK_KIND_LABELS[basis.taskKind]} always goes to the ${routedTier} tier`;
		case "rating-unavailable":
			return `difficulty rating unavailable, kept the ${routedTier} tier`;
		case "pinned":
			return `workflow phase pinned to the ${routedTier} tier`;
	}
}
