import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	DEFAULT_TIER_POLICIES,
	DIFFICULTY_TIERS,
	type RoutedThinkingLevel,
	type TierPolicies,
	type TierPolicy,
} from "./difficulty-tiers.ts";

export const TIER_CONFIG_PATH = join(homedir(), ".pi", "agent", "auto-model.json");

const THINKING_LEVELS: readonly RoutedThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

function parseTierPolicy(tierName: string, raw: unknown, fallback: TierPolicy): TierPolicy {
	if (raw === undefined) return fallback;
	if (typeof raw !== "object" || raw === null) {
		throw new Error(`${TIER_CONFIG_PATH}: tier "${tierName}" must be an object`);
	}
	const { models, thinkingLevel } = raw as { models?: unknown; thinkingLevel?: unknown };
	if (models !== undefined && !(Array.isArray(models) && models.every((key) => typeof key === "string"))) {
		throw new Error(`${TIER_CONFIG_PATH}: tier "${tierName}".models must be an array of "provider/id" strings`);
	}
	if (thinkingLevel !== undefined && !THINKING_LEVELS.includes(thinkingLevel as RoutedThinkingLevel)) {
		throw new Error(`${TIER_CONFIG_PATH}: tier "${tierName}".thinkingLevel must be one of ${THINKING_LEVELS.join(", ")}`);
	}
	return {
		models: (models as string[] | undefined) ?? fallback.models,
		thinkingLevel: (thinkingLevel as RoutedThinkingLevel | undefined) ?? fallback.thinkingLevel,
	};
}

/** Defaults merged with the optional user file `{ "tiers": { "<tier>": { models, thinkingLevel } } }`. */
export function loadTierPolicies(): TierPolicies {
	if (!existsSync(TIER_CONFIG_PATH)) return DEFAULT_TIER_POLICIES;
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(TIER_CONFIG_PATH, "utf8"));
	} catch (error) {
		throw new Error(`Failed to read ${TIER_CONFIG_PATH}: ${(error as Error).message}`);
	}
	const rawTiers = (parsed as { tiers?: Record<string, unknown> } | null)?.tiers ?? {};
	const policies = { ...DEFAULT_TIER_POLICIES };
	for (const tier of DIFFICULTY_TIERS) {
		policies[tier] = parseTierPolicy(tier, rawTiers[tier], DEFAULT_TIER_POLICIES[tier]);
	}
	return policies;
}
