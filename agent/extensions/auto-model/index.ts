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
 * - Planning and GitHub issue investigation always go to the expert tier at high thinking.
 * - Selected thinking level is a quality bias: low = one tier cheaper, high = one tier stronger.
 * - Failover: a failed response Pi will not retry benches that model for 5 minutes and resends
 *   the request, so the router picks the next model of the tier (at most twice per prompt).
 * - Learning: on each new prompt Jev also judges in hindsight whether the previous task got the
 *   right tier (the user complained, or it was far easier than its tier). Confident verdicts are
 *   stored as corrections that calibrate later ratings; a complaint also lifts the follow-up.
 *
 * Usage: /model auto/auto   or   pi --model auto/auto
 * Tier lists: ~/.pi/agent/auto-model.json, inspect with /auto-model.
 */
import { type Api, type AssistantMessage, isContextOverflow, type Model } from "@earendil-works/pi-ai";
import type {
	AgentBeforeSettleEvent,
	BoundaryResult,
	ExtensionAPI,
	ExtensionContext,
	ModelRoute,
	ModelRouteRequest,
	ProjectedSessionEntry,
} from "@earendil-works/pi-coding-agent";
import { findPreviousExchange, hasTypesafeApiKey, latestUserMessageHasImage, rateTaskDifficulty } from "./classify-difficulty.ts";
import {
	applyQualityBias,
	applyThinkingFloor,
	DIFFICULTY_TIERS,
	type DifficultyTier,
	IMPORTANT_TASK_ROUTE,
	modelKey,
	pickModelForTier,
	type RoutedThinkingLevel,
	type TierPolicies,
} from "./difficulty-tiers.ts";
import { BenchedModels, decideFailover } from "./model-failover.ts";
import {
	correctedTierFromFit,
	loadRoutingCorrections,
	pickCalibrationExamples,
	raiseToCorrectedTier,
	type PreviousTierFit,
	recordRoutingCorrection,
} from "./routing-feedback.ts";
import { loadTierPolicies, TIER_CONFIG_PATH } from "./tier-config.ts";

const FALLBACK_TIER: DifficultyTier = "standard";
/** Compaction summaries and other out-of-loop requests need solid but not top-tier quality. */
const DIRECT_REQUEST_TIER: DifficultyTier = "standard";
/** pi-jev's idle status ("jev: ready"); clearing it lets Pi drop the footer's status line. */
const JEV_STATUS_KEY = "jev";
const AUTO_MODEL_KEY = "auto/auto";

interface AutoRouteState {
	tier: DifficultyTier;
	modelKey: string;
	/** Absent in sessions routed before Jev picked thinking; the tier's level applies then. */
	thinkingLevel?: RoutedThinkingLevel;
}

type AutoRouteRequest = ModelRouteRequest<AutoRouteState>;

/** Runtime memory of one extension instance: which models failed and how many failovers this prompt used. */
interface RouterMemory {
	benchedModels: BenchedModels;
	failoversThisPrompt: number;
}

function usableModels(memory: RouterMemory, ctx: ExtensionContext): Model<Api>[] {
	const nowMs = Date.now();
	return ctx.modelRegistry.getAvailable().filter((model) => !memory.benchedModels.isBenched(modelKey(model), nowMs));
}

function routeToTier(
	tier: DifficultyTier,
	thinkingLevel: RoutedThinkingLevel,
	policies: TierPolicies,
	request: AutoRouteRequest,
	memory: RouterMemory,
	ctx: ExtensionContext,
): ModelRoute<AutoRouteState> {
	const needsImageInput = latestUserMessageHasImage(request.messages);
	const choice = pickModelForTier(usableModels(memory, ctx), policies[tier], tier, needsImageInput);
	if (!choice) throw new Error(`Auto model found no logged-in model for the "${tier}" tier; log in with /login`);
	return { model: choice.model, thinkingLevel, state: { tier, modelKey: modelKey(choice.model), thinkingLevel } };
}

/**
 * Same model and thinking as the turn so far: keeps the prompt cache and thinking signatures valid.
 * A benched model is the exception; the tier's next model takes over.
 */
function stayOn(
	model: Model<Api>,
	request: AutoRouteRequest,
	memory: RouterMemory,
	ctx: ExtensionContext,
): ModelRoute<AutoRouteState> {
	const policies = loadTierPolicies();
	const tier = request.state?.tier ?? FALLBACK_TIER;
	const thinkingLevel = request.state?.thinkingLevel ?? policies[tier].thinkingLevel;
	if (memory.benchedModels.isBenched(modelKey(model), Date.now())) {
		return routeToTier(tier, thinkingLevel, policies, request, memory, ctx);
	}
	return { model, thinkingLevel };
}

/** Stores a confident hindsight verdict as a correction; returns the tier the previous task should have had. */
function learnFromPreviousTask(
	previousPrompt: string,
	routedTier: DifficultyTier,
	tierFit: { fit: PreviousTierFit; confidence: number },
	ctx: ExtensionContext,
): DifficultyTier | undefined {
	const correctTier = correctedTierFromFit(routedTier, tierFit.fit, tierFit.confidence);
	if (!correctTier) return undefined;
	recordRoutingCorrection({
		prompt: previousPrompt,
		routedTier,
		correctTier,
		projectDir: ctx.cwd,
		recordedAtIso: new Date().toISOString(),
	});
	if (ctx.hasUI) ctx.ui.notify(`Auto model: the last task needed the "${correctTier}" tier, not "${routedTier}"; remembered`, "info");
	return correctTier;
}

async function rateTier(
	request: AutoRouteRequest,
	policies: TierPolicies,
	ctx: ExtensionContext,
): Promise<{ tier: DifficultyTier; thinkingLevel: RoutedThinkingLevel }> {
	const calibration = pickCalibrationExamples(loadRoutingCorrections(), ctx.cwd);
	const previousExchange = request.state ? findPreviousExchange(request.messages, request.state.tier) : undefined;
	const rating = await rateTaskDifficulty(request.messages, calibration, previousExchange, ctx, request.signal);
	if (rating.kind === "unavailable" && ctx.hasUI) {
		ctx.ui.notify(`Auto model: difficulty rating failed (${rating.reason}); using previous or "${FALLBACK_TIER}" tier`, "warning");
	}
	const correctedPreviousTier =
		rating.kind === "rated" && previousExchange && rating.previousTierFit
			? learnFromPreviousTask(previousExchange.prompt, previousExchange.routedTier, rating.previousTierFit, ctx)
			: undefined;
	const classifiedTier = rating.kind === "rated" ? rating.tier : (request.state?.tier ?? FALLBACK_TIER);
	if (rating.kind === "rated" && rating.isImportant) return IMPORTANT_TASK_ROUTE;
	const isRedoOfWeakAnswer = rating.kind === "rated" && rating.previousTierFit?.fit === "too_weak";
	const tierAfterLearning = isRedoOfWeakAnswer ? raiseToCorrectedTier(classifiedTier, correctedPreviousTier) : classifiedTier;
	const tier = applyQualityBias(tierAfterLearning, request.thinkingLevel);
	const ratedOrFallbackLevel = rating.kind === "rated" ? rating.thinkingLevel : policies[tier].thinkingLevel;
	return { tier, thinkingLevel: applyThinkingFloor(ratedOrFallbackLevel, policies[tier]) };
}

async function routeNewTask(
	request: AutoRouteRequest,
	memory: RouterMemory,
	ctx: ExtensionContext,
): Promise<ModelRoute<AutoRouteState>> {
	const policies = loadTierPolicies();
	const { tier, thinkingLevel } = await rateTier(request, policies, ctx);

	// Same tier as the running model: keep it instead of paying a cache miss for an equal model.
	const previous = request.previous?.model;
	const canKeepPrevious =
		previous !== undefined &&
		request.state?.tier === tier &&
		request.state.modelKey === modelKey(previous) &&
		!memory.benchedModels.isBenched(modelKey(previous), Date.now());
	if (previous && canKeepPrevious && request.state) {
		const isUnchanged = request.state.thinkingLevel === thinkingLevel;
		const state = isUnchanged ? request.state : { tier, modelKey: modelKey(previous), thinkingLevel };
		return { model: previous, thinkingLevel, state };
	}
	return routeToTier(tier, thinkingLevel, policies, request, memory, ctx);
}

async function routeRequest(
	request: AutoRouteRequest,
	memory: RouterMemory,
	ctx: ExtensionContext,
): Promise<ModelRoute<AutoRouteState>> {
	switch (request.reason) {
		case "user":
			return routeNewTask(request, memory, ctx);
		case "continuation": {
			const previous = request.previous?.model;
			return previous ? stayOn(previous, request, memory, ctx) : routeNewTask(request, memory, ctx);
		}
		case "retry": {
			const sticky = request.failed?.model ?? request.previous?.model;
			return sticky ? stayOn(sticky, request, memory, ctx) : routeNewTask(request, memory, ctx);
		}
		case "direct": {
			const policies = loadTierPolicies();
			const directThinkingLevel = policies[DIRECT_REQUEST_TIER].thinkingLevel;
			return routeToTier(DIRECT_REQUEST_TIER, directThinkingLevel, policies, request, memory, ctx);
		}
	}
}

function isAutoModelSelected(ctx: ExtensionContext): boolean {
	return ctx.model !== undefined && modelKey(ctx.model) === AUTO_MODEL_KEY;
}

function findFailedResponseEntry(
	entries: readonly ProjectedSessionEntry[],
): { entryId: string; response: AssistantMessage } | undefined {
	const lastEntry = entries.at(-1);
	const response = lastEntry?.messages.at(-1);
	if (!lastEntry || response?.role !== "assistant" || response.stopReason !== "error") return undefined;
	return { entryId: lastEntry.sourceEntry.id, response };
}

/** Hides the failed response from the model, like Pi's own retries do, and requests one more turn. */
function failOverToNextModel(
	event: AgentBeforeSettleEvent,
	memory: RouterMemory,
	ctx: ExtensionContext,
): BoundaryResult | undefined {
	if (event.outcome !== "error" || !isAutoModelSelected(ctx)) return undefined;
	const failed = findFailedResponseEntry(event.context.contextEntries);
	if (!failed) return undefined;
	const failedModel = ctx.modelRegistry.find(failed.response.provider, failed.response.model);
	const isOverflow = isContextOverflow(failed.response, failedModel?.contextWindow ?? 0);
	const decision = decideFailover(failed.response, memory.failoversThisPrompt, isOverflow);
	if (decision.kind === "give-up") return undefined;

	memory.benchedModels.bench(decision.failedModelKey, Date.now());
	memory.failoversThisPrompt++;
	if (ctx.hasUI) ctx.ui.notify(decision.notice, "warning");
	return { entries: [{ type: "context_edit", targetId: failed.entryId, replacement: null }], continue: true };
}

function describeTierAvailability(memory: RouterMemory, ctx: ExtensionContext): string {
	const policies = loadTierPolicies();
	const nowMs = Date.now();
	const availableKeys = new Set(ctx.modelRegistry.getAvailable().map(modelKey));
	const describeModel = (key: string): string => {
		if (!availableKeys.has(key)) return `${key} (not logged in)`;
		return memory.benchedModels.isBenched(key, nowMs) ? `${key} (benched after a failure)` : key;
	};
	const lines = DIFFICULTY_TIERS.map((tier) => {
		const models = policies[tier].models.map(describeModel).join(", ");
		const floor = policies[tier].minThinkingLevel;
		const floorNote = floor ? `, min thinking: ${floor}` : "";
		return `${tier} [fallback thinking: ${policies[tier].thinkingLevel}${floorNote}]: ${models}`;
	});
	return [`Auto model tiers (override in ${TIER_CONFIG_PATH}):`, ...lines].join("\n");
}

export default function (pi: ExtensionAPI) {
	const memory: RouterMemory = { benchedModels: new BenchedModels(), failoversThisPrompt: 0 };

	pi.registerVirtualModel<AutoRouteState>({
		provider: "auto",
		id: "auto",
		name: "Auto (difficulty routed)",
		thinkingLevels: ["low", "medium", "high"],
		// Shown only until the first response; afterwards Pi uses the routed model's limits.
		contextWindow: 200_000,
		maxTokens: 64_000,
		route: (request, ctx) => routeRequest(request, memory, ctx),
	});

	pi.on("input", () => {
		memory.failoversThisPrompt = 0;
	});

	pi.on("agent_before_settle", (event, ctx) => failOverToNextModel(event, memory, ctx));

	// Runs after every session_start handler, so pi-jev has already set its status.
	pi.on("resources_discover", (_event, ctx) => {
		if (!ctx.hasUI || !hasTypesafeApiKey()) return; // keep "jev: unconfigured" visible as a warning
		ctx.ui.setStatus(JEV_STATUS_KEY, undefined);
	});

	pi.registerCommand("auto-model", {
		description: "Show the auto model's difficulty tiers and which models are logged in",
		handler: async (_args, ctx) => {
			ctx.ui.notify(describeTierAvailability(memory, ctx), "info");
		},
	});
}
