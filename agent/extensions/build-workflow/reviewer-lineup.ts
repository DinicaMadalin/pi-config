/**
 * Which reviewer a /build run gets: a single one, to keep reviews cheap. Its vendor (Claude or OpenAI) is the one of
 * the first expert-tier model, in the configured order, that is logged in; a clear error when there is none.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { modelKey } from "../auto-model/difficulty-tiers.ts";
import { loadTierPolicies, TIER_CONFIG_PATH } from "../auto-model/tier-config.ts";
import { REVIEWER_VENDORS, type ReviewerVendor } from "./workflow-state.ts";

/** vendors holds exactly one vendor; a list so runs saved with two reviewers still resume. */
export type ReviewerLineup = { ok: true; vendors: readonly ReviewerVendor[] } | { ok: false; error: string };

export function pickReviewerLineup(expertTierModelKeys: readonly string[], availableModelKeys: ReadonlySet<string>): ReviewerLineup {
	const reviewerModelKey = expertTierModelKeys.find((key) => availableModelKeys.has(key) && REVIEWER_VENDORS.some((vendor) => key.startsWith(`${vendor}/`)));
	const vendor = REVIEWER_VENDORS.find((candidate) => reviewerModelKey?.startsWith(`${candidate}/`));
	if (vendor) return { ok: true, vendors: [vendor] };
	const keys = expertTierModelKeys.length > 0 ? expertTierModelKeys.join(", ") : "(no models configured)";
	return {
		ok: false,
		error: `No expert-tier reviewer model is available: none of ${keys} is logged in. Log in to Anthropic or OpenAI with /login, or add a model to the "expert" tier in ${TIER_CONFIG_PATH}`,
	};
}

export function currentReviewerLineup(ctx: Pick<ExtensionContext, "modelRegistry">): ReviewerLineup {
	try {
		const availableModelKeys = new Set(ctx.modelRegistry.getAvailable().map(modelKey));
		return pickReviewerLineup(loadTierPolicies().expert.models, availableModelKeys);
	} catch (error) {
		return { ok: false, error: `Cannot pick the reviewers: ${(error as Error).message}` };
	}
}
