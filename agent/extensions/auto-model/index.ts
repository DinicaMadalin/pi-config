/**
 * Auto model: a virtual model (`auto/auto`) that rates each new task with the TypeSafe Jev
 * classifier and routes it to a logged-in model that fits the difficulty.
 *
 * - New user prompt: one Jev call rates difficulty (-> tier -> first logged-in preferred model)
 *   and thinking depth (-> thinking level). The tier's configured thinking level is only the
 *   fallback when Jev is unavailable.
 * - Tool follow-ups and retries stay on the model and thinking level of the turn (keeps the prompt cache).
 * - No footer status of its own: Pi's footer already shows the routed model and thinking level.
 *   It also clears pi-jev's idle "jev: ready" status so the footer stays two lines.
 * - A tier's minThinkingLevel raises Jev's thinking pick (trivial and standard: at least medium).
 * - Selected thinking level is a quality bias: low = one tier cheaper, high = one tier stronger.
 *
 * Usage: /model auto/auto   or   pi --model auto/auto
 * Tier lists: ~/.pi/agent/auto-model.json, inspect with /auto-model.
 */
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ModelRoute, ModelRouteRequest } from "@earendil-works/pi-coding-agent";
import { hasTypesafeApiKey, latestUserMessageHasImage, rateTaskDifficulty } from "./classify-difficulty.ts";
import {
	applyQualityBias,
	applyThinkingFloor,
	DIFFICULTY_TIERS,
	type DifficultyTier,
	modelKey,
	pickModelForTier,
	type RoutedThinkingLevel,
	type TierPolicies,
} from "./difficulty-tiers.ts";
import { loadTierPolicies, TIER_CONFIG_PATH } from "./tier-config.ts";

const FALLBACK_TIER: DifficultyTier = "standard";
/** Compaction summaries and other out-of-loop requests need solid but not top-tier quality. */
const DIRECT_REQUEST_TIER: DifficultyTier = "standard";
/** pi-jev's idle status ("jev: ready"); clearing it lets Pi drop the footer's status line. */
const JEV_STATUS_KEY = "jev";

interface AutoRouteState {
	tier: DifficultyTier;
	modelKey: string;
	/** Absent in sessions routed before Jev picked thinking; the tier's level applies then. */
	thinkingLevel?: RoutedThinkingLevel;
}

type AutoRouteRequest = ModelRouteRequest<AutoRouteState>;

function routeToTier(
	tier: DifficultyTier,
	thinkingLevel: RoutedThinkingLevel,
	policies: TierPolicies,
	request: AutoRouteRequest,
	ctx: ExtensionContext,
): ModelRoute<AutoRouteState> {
	const availableModels = ctx.modelRegistry.getAvailable();
	const choice = pickModelForTier(availableModels, policies[tier], tier, latestUserMessageHasImage(request.messages));
	if (!choice) throw new Error(`Auto model found no logged-in model for the "${tier}" tier; log in with /login`);
	return { model: choice.model, thinkingLevel, state: { tier, modelKey: modelKey(choice.model), thinkingLevel } };
}

/** Same model and thinking as the turn so far: keeps the prompt cache and thinking signatures valid. */
function stayOn(model: Model<Api>, request: AutoRouteRequest, policies: TierPolicies): ModelRoute<AutoRouteState> {
	const tier = request.state?.tier ?? FALLBACK_TIER;
	return { model, thinkingLevel: request.state?.thinkingLevel ?? policies[tier].thinkingLevel };
}

async function routeNewTask(request: AutoRouteRequest, ctx: ExtensionContext): Promise<ModelRoute<AutoRouteState>> {
	const policies = loadTierPolicies();
	const rating = await rateTaskDifficulty(request.messages, ctx, request.signal);
	if (rating.kind === "unavailable" && ctx.hasUI) {
		ctx.ui.notify(`Auto model: difficulty rating failed (${rating.reason}); using previous or "${FALLBACK_TIER}" tier`, "warning");
	}
	const classifiedTier = rating.kind === "rated" ? rating.tier : (request.state?.tier ?? FALLBACK_TIER);
	const tier = applyQualityBias(classifiedTier, request.thinkingLevel);
	const ratedOrFallbackLevel = rating.kind === "rated" ? rating.thinkingLevel : policies[tier].thinkingLevel;
	const thinkingLevel = applyThinkingFloor(ratedOrFallbackLevel, policies[tier]);

	// Same tier as the running model: keep it instead of paying a cache miss for an equal model.
	const previous = request.previous?.model;
	if (previous && request.state?.tier === tier && request.state.modelKey === modelKey(previous)) {
		const isUnchanged = request.state.thinkingLevel === thinkingLevel;
		const state = isUnchanged ? request.state : { tier, modelKey: modelKey(previous), thinkingLevel };
		return { model: previous, thinkingLevel, state };
	}
	return routeToTier(tier, thinkingLevel, policies, request, ctx);
}

async function routeRequest(request: AutoRouteRequest, ctx: ExtensionContext): Promise<ModelRoute<AutoRouteState>> {
	switch (request.reason) {
		case "user":
			return routeNewTask(request, ctx);
		case "continuation": {
			const previous = request.previous?.model;
			return previous ? stayOn(previous, request, loadTierPolicies()) : routeNewTask(request, ctx);
		}
		case "retry": {
			const sticky = request.failed?.model ?? request.previous?.model;
			return sticky ? stayOn(sticky, request, loadTierPolicies()) : routeNewTask(request, ctx);
		}
		case "direct": {
			const policies = loadTierPolicies();
			const directThinkingLevel = policies[DIRECT_REQUEST_TIER].thinkingLevel;
			return routeToTier(DIRECT_REQUEST_TIER, directThinkingLevel, policies, request, ctx);
		}
	}
}

function describeTierAvailability(ctx: ExtensionContext): string {
	const policies = loadTierPolicies();
	const availableKeys = new Set(ctx.modelRegistry.getAvailable().map(modelKey));
	const lines = DIFFICULTY_TIERS.map((tier) => {
		const models = policies[tier].models
			.map((key) => (availableKeys.has(key) ? key : `${key} (not logged in)`))
			.join(", ");
		const floor = policies[tier].minThinkingLevel;
		const floorNote = floor ? `, min thinking: ${floor}` : "";
		return `${tier} [fallback thinking: ${policies[tier].thinkingLevel}${floorNote}]: ${models}`;
	});
	return [`Auto model tiers (override in ${TIER_CONFIG_PATH}):`, ...lines].join("\n");
}

export default function (pi: ExtensionAPI) {
	pi.registerVirtualModel<AutoRouteState>({
		provider: "auto",
		id: "auto",
		name: "Auto (difficulty routed)",
		thinkingLevels: ["low", "medium", "high"],
		// Shown only until the first response; afterwards Pi uses the routed model's limits.
		contextWindow: 200_000,
		maxTokens: 64_000,
		route: routeRequest,
	});

	// Runs after every session_start handler, so pi-jev has already set its status.
	pi.on("resources_discover", (_event, ctx) => {
		if (!ctx.hasUI || !hasTypesafeApiKey()) return; // keep "jev: unconfigured" visible as a warning
		ctx.ui.setStatus(JEV_STATUS_KEY, undefined);
	});

	pi.registerCommand("auto-model", {
		description: "Show the auto model's difficulty tiers and which models are logged in",
		handler: async (_args, ctx) => {
			ctx.ui.notify(describeTierAvailability(ctx), "info");
		},
	});
}
