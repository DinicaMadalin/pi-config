/**
 * Route pin: another extension (the /build workflow) can fix how new prompts in a session are routed,
 * so each phase gets its intended route. Stored as a session entry, so it survives reloads and can be
 * written into a fresh session before its first prompt.
 */
import { DIFFICULTY_TIERS, type DifficultyTier } from "./difficulty-tiers.ts";

export const ROUTE_PIN_ENTRY_TYPE = "auto-model-route-pin";

/**
 * - tier: always this tier at its configured thinking level, no rating. With preferredProvider, that provider's
 *   models of the tier are tried first (e.g. one reviewer per vendor); the tier's other models remain fallbacks.
 * - difficulty: Jev picks tier and thinking from difficulty alone; the task-kind override
 *   (planning, review, issues -> expert) and hindsight learning are skipped.
 * - normal: removes the pin.
 */
export type RoutePin =
	| { route: "tier"; tier: DifficultyTier; preferredProvider?: string }
	| { route: "difficulty" }
	| { route: "normal" };

/** Pi event-bus channel where the router announces the kind of each rated prompt. */
export const TASK_KIND_EVENT = "auto-model:task-kind";

interface SessionEntryLike {
	type: string;
	customType?: string;
	data?: unknown;
}

function parseRoutePin(data: unknown): RoutePin {
	const pin = data as { route?: unknown; tier?: unknown; preferredProvider?: unknown } | undefined;
	if (pin?.route === "tier" && DIFFICULTY_TIERS.includes(pin.tier as DifficultyTier)) {
		const tier = pin.tier as DifficultyTier;
		return typeof pin.preferredProvider === "string" ? { route: "tier", tier, preferredProvider: pin.preferredProvider } : { route: "tier", tier };
	}
	if (pin?.route === "difficulty") return { route: "difficulty" };
	return { route: "normal" };
}

/** The latest pin on the branch; normal routing when there is none or it is unreadable. */
export function findRoutePin(branchEntries: readonly SessionEntryLike[]): RoutePin {
	for (let index = branchEntries.length - 1; index >= 0; index--) {
		const entry = branchEntries[index];
		if (entry.type === "custom" && entry.customType === ROUTE_PIN_ENTRY_TYPE) return parseRoutePin(entry.data);
	}
	return { route: "normal" };
}
