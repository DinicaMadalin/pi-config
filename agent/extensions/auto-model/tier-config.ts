import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	DEFAULT_TIER_POLICIES,
	DIFFICULTY_TIERS,
	ROUTED_THINKING_LEVELS,
	type RoutedThinkingLevel,
	type TierPolicies,
	type TierPolicy,
} from "./difficulty-tiers.ts";

export const TIER_CONFIG_PATH = join(homedir(), ".pi", "agent", "auto-model.json");

function parseThinkingLevel(tierName: string, field: string, raw: unknown): RoutedThinkingLevel | undefined {
	if (raw === undefined) return undefined;
	if (!ROUTED_THINKING_LEVELS.includes(raw as RoutedThinkingLevel)) {
		throw new Error(`${TIER_CONFIG_PATH}: tier "${tierName}".${field} must be one of ${ROUTED_THINKING_LEVELS.join(", ")}`);
	}
	return raw as RoutedThinkingLevel;
}

function parseTierPolicy(tierName: string, raw: unknown, fallback: TierPolicy): TierPolicy {
	if (raw === undefined) return fallback;
	if (typeof raw !== "object" || raw === null) {
		throw new Error(`${TIER_CONFIG_PATH}: tier "${tierName}" must be an object`);
	}
	const { models, thinkingLevel, minThinkingLevel } = raw as {
		models?: unknown;
		thinkingLevel?: unknown;
		minThinkingLevel?: unknown;
	};
	if (models !== undefined && !(Array.isArray(models) && models.every((key) => typeof key === "string"))) {
		throw new Error(`${TIER_CONFIG_PATH}: tier "${tierName}".models must be an array of "provider/id" strings`);
	}
	return {
		models: (models as string[] | undefined) ?? fallback.models,
		thinkingLevel: parseThinkingLevel(tierName, "thinkingLevel", thinkingLevel) ?? fallback.thinkingLevel,
		minThinkingLevel: parseThinkingLevel(tierName, "minThinkingLevel", minThinkingLevel) ?? fallback.minThinkingLevel,
	};
}

/** Defaults merged with the optional user file `{ "tiers": { "<tier>": { models, thinkingLevel, minThinkingLevel } } }`. */
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
