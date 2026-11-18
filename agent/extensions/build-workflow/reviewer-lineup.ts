/**
 * Which reviewers a /build run gets: one per vendor (Claude, OpenAI) that has a usable model on the complex tier.
 * Both when both have one, only the one that does otherwise, and a clear error when neither does.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { modelKey } from "../auto-model/difficulty-tiers.ts";
import { loadTierPolicies, TIER_CONFIG_PATH } from "../auto-model/tier-config.ts";
import type { ReviewerVendor } from "./workflow-state.ts";

/** vendors is never empty and keeps REVIEWER_VENDORS order. */
export type ReviewerLineup = { ok: true; vendors: readonly ReviewerVendor[] } | { ok: false; error: string };

export function pickReviewerLineup(complexTierModelKeys: readonly string[], availableModelKeys: ReadonlySet<string>): ReviewerLineup {
	const vendors = (["anthropic", "openai"] as const).filter((vendor) =>
		complexTierModelKeys.some((key) => key.startsWith(`${vendor}/`) && availableModelKeys.has(key)),
	);
	if (vendors.length > 0) return { ok: true, vendors };
	const keys = complexTierModelKeys.length > 0 ? complexTierModelKeys.join(", ") : "(no models configured)";
	return {
		ok: false,
		error: `No complex-tier reviewer model is available: none of ${keys} is logged in. Log in to Anthropic or OpenAI with /login, or add a model to the "complex" tier in ${TIER_CONFIG_PATH}`,
	};
}

export function currentReviewerLineup(ctx: Pick<ExtensionContext, "modelRegistry">): ReviewerLineup {
	try {
		const availableModelKeys = new Set(ctx.modelRegistry.getAvailable().map(modelKey));
		return pickReviewerLineup(loadTierPolicies().complex.models, availableModelKeys);
	} catch (error) {
		return { ok: false, error: `Cannot pick the reviewers: ${(error as Error).message}` };
	}
}
