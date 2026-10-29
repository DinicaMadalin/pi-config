/**
 * Pure routing policy: which logged-in model and thinking level fits a task difficulty.
 * No Pi runtime imports beyond types, so it can be unit tested in isolation.
 */
import type { Api, Model } from "@earendil-works/pi-ai";

export const DIFFICULTY_TIERS = ["trivial", "standard", "complex", "expert"] as const;
export type DifficultyTier = (typeof DIFFICULTY_TIERS)[number];

export const ROUTED_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
export type RoutedThinkingLevel = (typeof ROUTED_THINKING_LEVELS)[number];

export interface TierPolicy {
	/** Preferred models as "provider/id", best first. Unavailable ones are skipped. */
	models: string[];
	/** Used only when Jev cannot rate thinking depth, and for compaction summaries. */
	thinkingLevel: RoutedThinkingLevel;
	/** Floor for Jev's thinking choice; a lower pick is raised to this. */
	minThinkingLevel?: RoutedThinkingLevel;
}

export type TierPolicies = Record<DifficultyTier, TierPolicy>;

/** Defaults tuned to the providers logged in on this machine; override in ~/.pi/agent/auto-model.json. */
export const DEFAULT_TIER_POLICIES: TierPolicies = {
	trivial: {
		models: ["opencode-go/deepseek-v4.1-flash", "opencode-go/glm-5.3-flash"],
		thinkingLevel: "medium",
		minThinkingLevel: "medium",
	},
	standard: {
		models: ["opencode-go/gpt-6-luna", "anthropic/claude-sonnet-5-5", "opencode-go/glm-5.3"],
		thinkingLevel: "medium",
		minThinkingLevel: "medium",
	},
	complex: {
		models: ["anthropic/claude-opus-5-5"],
		thinkingLevel: "high",
	},
	expert: {
		models: ["anthropic/claude-opus-5-5"],
		thinkingLevel: "high",
	},
};

/**
 * The virtual thinking level the user selects acts as a quality bias:
 * "low" routes one tier cheaper, "medium" as classified, "high" one tier stronger.
 */
export function applyQualityBias(classifiedTier: DifficultyTier, selectedLevel: string): DifficultyTier {
	const tierShiftByLevel: Record<string, number> = { low: -1, medium: 0, high: 1 };
	return shiftTier(classifiedTier, tierShiftByLevel[selectedLevel] ?? 0);
}

/** Moves a tier up (positive steps) or down, stopping at trivial and expert. */
export function shiftTier(tier: DifficultyTier, steps: number): DifficultyTier {
	const index = DIFFICULTY_TIERS.indexOf(tier) + steps;
	const clampedIndex = Math.min(Math.max(index, 0), DIFFICULTY_TIERS.length - 1);
	return DIFFICULTY_TIERS[clampedIndex];
}

/** Raises a thinking level to the tier's floor; levels at or above it are kept. */
export function applyThinkingFloor(level: RoutedThinkingLevel, policy: TierPolicy): RoutedThinkingLevel {
	if (!policy.minThinkingLevel) return level;
	const isBelowFloor = ROUTED_THINKING_LEVELS.indexOf(level) < ROUTED_THINKING_LEVELS.indexOf(policy.minThinkingLevel);
	return isBelowFloor ? policy.minThinkingLevel : level;
}

export function modelKey(model: Pick<Model<Api>, "provider" | "id">): string {
	return `${model.provider}/${model.id}`;
}

function canReadImages(model: Model<Api>): boolean {
	return model.input.includes("image");
}

/** Price per million output tokens; the best available proxy for capability across providers. */
function outputPrice(model: Model<Api>): number {
	return model.cost?.output ?? 0;
}

/**
 * Fallback when no preferred model of a tier is logged in: rank the logged-in models by price
 * and take the one at the tier's position (trivial = cheapest, expert = most expensive).
 */
function pickByPriceRank(candidates: readonly Model<Api>[], tier: DifficultyTier): Model<Api> | undefined {
	if (candidates.length === 0) return undefined;
	const byPrice = [...candidates].sort((left, right) => outputPrice(left) - outputPrice(right));
	const tierPosition = DIFFICULTY_TIERS.indexOf(tier) / (DIFFICULTY_TIERS.length - 1);
	return byPrice[Math.round(tierPosition * (byPrice.length - 1))];
}

export interface ModelChoice {
	model: Model<Api>;
	/** "preferred" when it came from the tier list, "price-rank" when the fallback picked it. */
	source: "preferred" | "price-rank";
}

/** First logged-in preferred model of the tier, else the price-ranked fallback. */
export function pickModelForTier(
	availableModels: readonly Model<Api>[],
	policy: TierPolicy,
	tier: DifficultyTier,
	needsImageInput: boolean,
): ModelChoice | undefined {
	const usable = needsImageInput ? availableModels.filter(canReadImages) : availableModels;
	const usableByKey = new Map(usable.map((model) => [modelKey(model), model]));
	for (const preferredKey of policy.models) {
		const preferred = usableByKey.get(preferredKey);
		if (preferred) return { model: preferred, source: "preferred" };
	}
	const ranked = pickByPriceRank(usable, tier);
	return ranked ? { model: ranked, source: "price-rank" } : undefined;
}
