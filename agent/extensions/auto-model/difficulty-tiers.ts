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
	/** Allowed models as "provider/id", tried in order; unavailable entries are skipped, and no other catalog models are considered. */
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
		models: ["opencode-go/deepseek-v4.1-flash", "opencode-go/glm-5.3-flash", "opencode/deepseek-v4.1-flash-free"],
		thinkingLevel: "medium",
		minThinkingLevel: "medium",
	},
	standard: {
		models: [
			"gemini-app/gemini-neon",
			"opencode-go/gpt-6-luna",
			"openai/gpt-6-luna",
			"anthropic/claude-sonnet-5-5",
			"opencode-go/glm-5.3",
		],
		thinkingLevel: "medium",
		minThinkingLevel: "medium",
	},
	complex: {
		models: ["anthropic/claude-opus-5-5", "openai/gpt-6.1-sol"],
		thinkingLevel: "high",
	},
	expert: {
		models: ["openai/gpt-6-astra", "openai/gpt-6.1-sol", "anthropic/claude-opus-5-5"],
		thinkingLevel: "high",
		// Jev may still pick xhigh for the hardest tasks.
		minThinkingLevel: "high",
	},
};

/**
 * Important work always gets the strongest tier, whatever its rated difficulty, with at least that tier's
 * minimum thinking: planning decides everything built after it, and reviews and issue investigation are
 * where shallow answers cost most.
 */
export const IMPORTANT_TASK_TIER: DifficultyTier = "expert";

/**
 * The virtual thinking level the user selects acts as a quality bias:
 * "low" routes one tier cheaper, "medium" as classified, "high" one tier stronger.
 */
export function applyQualityBias(classifiedTier: DifficultyTier, selectedLevel: string): DifficultyTier {
	const tierShiftByLevel: Record<string, number> = { low: -1, medium: 0, high: 1 };
	return shiftTier(classifiedTier, tierShiftByLevel[selectedLevel] ?? 0);
}

/**
 * A process-wide ceiling on the routed tier, set by whoever launches Pi (the /build workflow caps its implementer
 * subagents at cheap tiers, because the expert planner hands them exact steps). Unset or unknown: no ceiling.
 */
export const MAX_TIER_ENV_VAR = "PI_AUTO_MODEL_MAX_TIER";

export function parseTierCeiling(rawTier: string | undefined): DifficultyTier | undefined {
	return DIFFICULTY_TIERS.find((tier) => tier === rawTier?.trim());
}

/** The tier, lowered to the ceiling when it is above it. */
export function capTier(tier: DifficultyTier, ceiling: DifficultyTier | undefined): DifficultyTier {
	if (!ceiling) return tier;
	return DIFFICULTY_TIERS.indexOf(tier) > DIFFICULTY_TIERS.indexOf(ceiling) ? ceiling : tier;
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

/** The provider's configured models first, in their tier order, then the tier's remaining configured models. */
export function preferProvider(policy: TierPolicy, provider: string): TierPolicy {
	const isFromProvider = (key: string) => key.startsWith(`${provider}/`);
	const models = [...policy.models.filter(isFromProvider), ...policy.models.filter((key) => !isFromProvider(key))];
	return { ...policy, models };
}

export interface ModelChoice {
	model: Model<Api>;
}

/** First logged-in model explicitly listed for the tier; never falls back to the provider's broader catalog. */
export function pickModelForTier(
	availableModels: readonly Model<Api>[],
	policy: TierPolicy,
	needsImageInput: boolean,
): ModelChoice | undefined {
	const usable = needsImageInput ? availableModels.filter(canReadImages) : availableModels;
	const usableByKey = new Map(usable.map((model) => [modelKey(model), model]));
	for (const configuredModelKey of policy.models) {
		const configuredModel = usableByKey.get(configuredModelKey);
		if (configuredModel) return { model: configuredModel };
	}
	return undefined;
}
