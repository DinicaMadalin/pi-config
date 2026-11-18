/**
 * Auto model: a virtual model (`auto/auto`) that rates each new task with the TypeSafe Jev
 * classifier and routes it to a logged-in model that fits the difficulty.
 *
 * - New user prompt: one Jev call rates difficulty (-> tier -> first available model on that tier's allowlist)
 *   and thinking depth (-> thinking level). The tier's configured thinking level is only the
 *   fallback when Jev is unavailable.
 * - Tool follow-ups and retries stay on the model and thinking level of the turn (keeps the prompt cache).
 * - No footer status of its own: Pi's footer already shows the routed model and thinking level.
 *   It also clears pi-jev's idle "jev: ready" status so the footer stays two lines.
 * - A tier's minThinkingLevel raises Jev's thinking pick (trivial and standard: at least medium, expert: at least high).
 * - Feature/architecture planning, code review, and GitHub issue investigation always go to the expert tier
 *   (thinking high, or xhigh when Jev rates the task that deep).
 * - Route pin: a session entry (see route-pin.ts) fixes a tier, or difficulty-only rating, for new prompts; /build uses it.
 * - Selected thinking level is a quality bias: low = one tier cheaper, high = one tier stronger.
 * - Failover: a failed response Pi will not retry benches that model for 5 minutes and resends
 *   the request, so the router picks the next model of the tier (at most twice per prompt).
 * - Learning: on each new prompt Jev also judges in hindsight whether the previous task got the
 *   right tier (the user complained, or it was far easier than its tier). Confident verdicts are
 *   stored as corrections that calibrate later ratings; a complaint also lifts the follow-up.
 * - Design-first hand-off (implementation-handoff.ts): a complex or expert model writes signatures, stubs and
 *   contract blocks and calls hand_off_implementation; the next turns run on the standard tier; when that settles,
 *   the designer's model reviews, hands off fixes or approves (approve_implementation deletes the contract blocks).
 *   The implementer cannot use context or delegation tools, and when it changed no file the designer writes the code
 *   itself instead of reviewing (no further hand-off for that task).
 *
 * Usage: /model auto/auto   or   pi --model auto/auto
 * Tier lists: ~/.pi/agent/auto-model.json, inspect with /auto-model.
 */
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type Api, type AssistantMessage, isContextOverflow, type Model } from "@earendil-works/pi-ai";
import type {
	AgentBeforeSettleEvent,
	BoundaryResult,
	ExtensionAPI,
	ExtensionContext,
	ModelRoute,
	ModelRouteRequest,
	ProjectedSessionEntry,
	TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	findPreviousExchange,
	hasTypesafeApiKey,
	IMPORTANT_TASK_KINDS,
	latestUserMessageHasImage,
	rateTaskDifficulty,
	type TaskKind,
} from "./classify-difficulty.ts";
import {
	applyQualityBias,
	applyThinkingFloor,
	capTier,
	DIFFICULTY_TIERS,
	type DifficultyTier,
	IMPORTANT_TASK_TIER,
	MAX_TIER_ENV_VAR,
	modelKey,
	parseTierCeiling,
	pickModelForTier,
	preferProvider,
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
import { describeTierBasis, ROUTE_DECISION_ENTRY_TYPE, type RouteDecision, type TierBasis } from "./route-decision.ts";
import { findRoutePin, TASK_KIND_EVENT } from "./route-pin.ts";
import {
	APPROVE_TOOL_NAME,
	approvalRefusal,
	type AutoRouteState,
	CONTRACT_SEARCH_PATTERN,
	DESIGNER_NOTE_MESSAGE_TYPE,
	DESIGNER_TIERS,
	designerNote,
	findAutoRouteState,
	followsDesignerNote,
	HANDOFF_TOOL_NAME,
	handoffAfter,
	handoffRefusal,
	handoffTransition,
	hasImplementerChangedFiles,
	IMPLEMENTER_BLOCKED_TOOLS,
	IMPLEMENTER_TIER,
	implementerBrief,
	implementerToolRefusal,
	readImplementerWork,
	removeContractBlocks,
	REVIEW_REQUEST_MESSAGE_TYPE,
	reviewRequest,
	TAKE_OVER_MESSAGE_TYPE,
	takeOverRequest,
} from "./implementation-handoff.ts";
import { fingerprintWorkTree, type RunCommand } from "./work-tree-fingerprint.ts";
import {
	chooseDesignerModel,
	DESIGN_REMINDER_ENTRY_TYPE,
	designFirstInstructions,
	designSource,
	shouldRemindDesigner,
	type DesignSource,
} from "./design-first.ts";

const FALLBACK_TIER: DifficultyTier = "standard";
/** Compaction summaries and other out-of-loop requests need solid but not top-tier quality. */
const DIRECT_REQUEST_TIER: DifficultyTier = "standard";
/** pi-jev's idle status ("jev: ready"); clearing it lets Pi drop the footer's status line. */
const JEV_STATUS_KEY = "jev";
const AUTO_MODEL_KEY = "auto/auto";

type AutoRouteRequest = ModelRouteRequest<AutoRouteState>;

/** Runtime state of one extension instance: failed models, failovers this prompt, and where task kinds are announced. */
interface RouterMemory {
	benchedModels: BenchedModels;
	failoversThisPrompt: number;
	announceTaskKind: (taskKind: TaskKind) => void;
	recordRouteDecision: (decision: RouteDecision) => void;
	/** A prompt typed while idle starts a new task; steering and extension messages continue the current one. */
	isNewTaskPending: boolean;
	/** The designer note goes out once per task. */
	hasSentDesignerNote: boolean;
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
	const pin = findRoutePin(ctx.sessionManager.getBranch());
	// The tier's configured model list is a strict allowlist; a provider pin only changes its order.
	const policy = pin.route === "tier" && pin.preferredProvider ? preferProvider(policies[tier], pin.preferredProvider) : policies[tier];
	const choice = pickModelForTier(usableModels(memory, ctx), policy, needsImageInput);
	if (!choice) throw new Error(`Auto model found no available configured model for the "${tier}" tier; check ${TIER_CONFIG_PATH} or log in with /login`);
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
		if (request.state?.designTask && request.state.handoff?.phase !== "implementing") {
			const designChoice = chooseDesignerModel(usableModels(memory, ctx), policies, latestUserMessageHasImage(request.messages));
			if (!designChoice) {
				throw new Error(`Auto model found no available configured designer in expert or complex; check ${TIER_CONFIG_PATH} or log in with /login`);
			}
			const fallbackThinking = applyThinkingFloor(thinkingLevel, policies[designChoice.tier]);
			return {
				model: designChoice.model,
				thinkingLevel: fallbackThinking,
				state: {
					tier: designChoice.tier,
					modelKey: modelKey(designChoice.model),
					thinkingLevel: fallbackThinking,
					handoff: request.state.handoff,
					designTask: request.state.designTask,
				},
			};
		}
		const route = routeToTier(tier, thinkingLevel, policies, request, memory, ctx);
		return { ...route, state: route.state && { ...route.state, handoff: request.state?.handoff, designTask: request.state?.designTask } };
	}
	return { model, thinkingLevel };
}

/** /build pins and tier ceilings own the routing of their sessions; the hand-off stays out of them. */
function isRoutingRestricted(ctx: ExtensionContext): boolean {
	return findRoutePin(ctx.sessionManager.getBranch()).route !== "normal" || parseTierCeiling(process.env[MAX_TIER_ENV_VAR]) !== undefined;
}

/**
 * The designer's own model when it is still usable, so it keeps the prompt cache; else its tier's next model.
 * review: it checks the implementer's work. take-over: the implementer changed nothing, so it writes the code itself.
 */
function routeToDesigner(
	transition: "review" | "take-over",
	state: AutoRouteState,
	request: AutoRouteRequest,
	memory: RouterMemory,
	ctx: ExtensionContext,
): ModelRoute<AutoRouteState> {
	const policies = loadTierPolicies();
	const handoff = handoffAfter(transition, state);
	const { designer } = handoff;
	const thinkingLevel = designer.thinkingLevel ?? policies[designer.tier].thinkingLevel;
	const routeAction =
		transition === "review" ? "reviews the cheaper implementer's work" : "takes over after the implementer changed no file";
	const needsImageInput = latestUserMessageHasImage(request.messages);
	const available = usableModels(memory, ctx);
	const originalDesigner = available.find((model) => modelKey(model) === designer.modelKey);
	const originalTierPolicy = policies[designer.tier];
	const canReuseOriginal =
		originalDesigner !== undefined &&
		originalTierPolicy.models.includes(modelKey(originalDesigner)) &&
		pickModelForTier([originalDesigner], originalTierPolicy, needsImageInput) !== undefined;
	if (canReuseOriginal) {
		memory.recordRouteDecision({ tier: designer.tier, thinkingLevel, reason: `the ${designer.tier} designer ${routeAction}` });
		return {
			model: originalDesigner,
			thinkingLevel,
			state: { tier: designer.tier, modelKey: designer.modelKey, thinkingLevel, handoff, designTask: state.designTask },
		};
	}
	if (state.designTask) {
		const choice = chooseDesignerModel(available, policies, needsImageInput);
		if (!choice) throw new Error(`Auto model found no available configured designer in expert or complex; check ${TIER_CONFIG_PATH} or log in with /login`);
		const fallbackThinking = applyThinkingFloor(thinkingLevel, policies[choice.tier]);
		memory.recordRouteDecision({
			tier: choice.tier,
			thinkingLevel: fallbackThinking,
			reason: `the ${choice.tier} designer ${routeAction}${choice.tier === designer.tier ? "" : `; ${designer.tier} unavailable, ${choice.tier} fallback`}`,
		});
		return {
			model: choice.model,
			thinkingLevel: fallbackThinking,
			state: {
				tier: choice.tier,
				modelKey: modelKey(choice.model),
				thinkingLevel: fallbackThinking,
				handoff,
				designTask: state.designTask,
			},
		};
	}
	memory.recordRouteDecision({ tier: designer.tier, thinkingLevel, reason: `the ${designer.tier} designer ${routeAction}` });
	const route = routeToTier(designer.tier, thinkingLevel, policies, request, memory, ctx);
	return { ...route, state: route.state && { ...route.state, handoff, designTask: state.designTask } };
}

function routeToImplementer(state: AutoRouteState, request: AutoRouteRequest, memory: RouterMemory, ctx: ExtensionContext): ModelRoute<AutoRouteState> {
	const policies = loadTierPolicies();
	const handoff = handoffAfter("implement", state);
	const thinkingLevel = policies[IMPLEMENTER_TIER].thinkingLevel;
	memory.recordRouteDecision({ tier: IMPLEMENTER_TIER, thinkingLevel, reason: `the ${handoff.designer.tier} designer handed the implementation off` });
	const route = routeToTier(IMPLEMENTER_TIER, thinkingLevel, policies, request, memory, ctx);
	return { ...route, state: route.state && { ...route.state, handoff, designTask: state.designTask } };
}

/**
 * Routing inside a task with a hand-off: the hand-off tool sends the next turn to the implementer, the review request
 * back to the designer. Other messages of the task (quality-gate failures, steering, the designer note) stay with
 * the model that is working instead of re-rating the task. Undefined: route as usual.
 */
function routeWithinTask(request: AutoRouteRequest, memory: RouterMemory, ctx: ExtensionContext): ModelRoute<AutoRouteState> | undefined {
	const state = request.state;
	if (!state) return undefined;
	const transition = handoffTransition(request.messages, state);
	if (transition === "implement") return routeToImplementer(state, request, memory, ctx);
	if (transition === "review" || transition === "take-over") return routeToDesigner(transition, state, request, memory, ctx);
	const previous = request.previous?.model;
	const staysWithWorkingModel = state.handoff !== undefined || state.designTask !== undefined || followsDesignerNote(request.messages);
	return previous && staysWithWorkingModel ? stayOn(previous, request, memory, ctx) : undefined;
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
	announceTaskKind: (taskKind: TaskKind) => void,
	isDifficultyOnly: boolean,
	ctx: ExtensionContext,
): Promise<{ tier: DifficultyTier; thinkingLevel: RoutedThinkingLevel; basis: TierBasis }> {
	const calibration = pickCalibrationExamples(loadRoutingCorrections(), ctx.cwd);
	// A pinned workflow phase is not a reaction to the previous answer, so there is nothing to learn from.
	const previousExchange =
		request.state && !isDifficultyOnly ? findPreviousExchange(request.messages, request.state.tier) : undefined;
	const rating = await rateTaskDifficulty(request.messages, calibration, previousExchange, ctx, request.signal);
	if (rating.kind === "unavailable" && ctx.hasUI) {
		ctx.ui.notify(`Auto model: difficulty rating failed (${rating.reason}); using previous or "${FALLBACK_TIER}" tier`, "warning");
	}
	const correctedPreviousTier =
		rating.kind === "rated" && previousExchange && rating.previousTierFit
			? learnFromPreviousTask(previousExchange.prompt, previousExchange.routedTier, rating.previousTierFit, ctx)
			: undefined;
	const classifiedTier = rating.kind === "rated" ? rating.tier : (request.state?.tier ?? FALLBACK_TIER);
	if (rating.kind === "rated" && !isDifficultyOnly) {
		announceTaskKind(rating.taskKind);
		if (IMPORTANT_TASK_KINDS.has(rating.taskKind)) {
			return {
				tier: IMPORTANT_TASK_TIER,
				thinkingLevel: applyThinkingFloor(rating.thinkingLevel, policies[IMPORTANT_TASK_TIER]),
				basis: { kind: "important-task", taskKind: rating.taskKind },
			};
		}
		const source = designSource(rating.taskKind);
		if (source && !isRoutingRestricted(ctx)) {
			return {
				tier: "expert",
				thinkingLevel: applyThinkingFloor(rating.thinkingLevel, policies.expert),
				basis: { kind: "design-first", source },
			};
		}
	}
	const isRedoOfWeakAnswer = rating.kind === "rated" && rating.previousTierFit?.fit === "too_weak";
	const tierAfterLearning = isRedoOfWeakAnswer ? raiseToCorrectedTier(classifiedTier, correctedPreviousTier) : classifiedTier;
	const tier = applyQualityBias(tierAfterLearning, request.thinkingLevel);
	const ratedOrFallbackLevel = rating.kind === "rated" ? rating.thinkingLevel : policies[tier].thinkingLevel;
	const basis: TierBasis =
		rating.kind === "rated"
			? { kind: "rated", ratedTier: rating.tier, confidence: rating.confidence }
			: { kind: "rating-unavailable" };
	return { tier, thinkingLevel: applyThinkingFloor(ratedOrFallbackLevel, policies[tier]), basis };
}

async function routeNewTask(
	request: AutoRouteRequest,
	memory: RouterMemory,
	ctx: ExtensionContext,
): Promise<ModelRoute<AutoRouteState>> {
	const policies = loadTierPolicies();
	const pin = findRoutePin(ctx.sessionManager.getBranch());
	const isDifficultyOnly = pin.route !== "normal";
	const rated = await rateTier(request, policies, memory.announceTaskKind, isDifficultyOnly, ctx);
	if (!isRoutingRestricted(ctx) && rated.basis.kind === "design-first") {
		return routeDesignTask(rated.basis.source, rated.thinkingLevel, request, memory, ctx);
	}
	// A pinned tier keeps Jev's thinking depth, raised to that tier's minimum.
	const chosen =
		pin.route === "tier"
			? {
					tier: pin.tier,
					thinkingLevel: applyThinkingFloor(rated.thinkingLevel, policies[pin.tier]),
					basis: { kind: "pinned" } as const,
				}
			: rated;
	const ceiling = parseTierCeiling(process.env[MAX_TIER_ENV_VAR]);
	const tier = capTier(chosen.tier, ceiling);
	const isCapped = tier !== chosen.tier;
	const thinkingLevel = isCapped ? applyThinkingFloor(chosen.thinkingLevel, policies[tier]) : chosen.thinkingLevel;
	const reason = describeTierBasis(chosen.basis, chosen.tier);
	memory.recordRouteDecision({ tier, thinkingLevel, reason: isCapped ? `${reason}, capped at ${tier}` : reason });

	// Same tier as the running model: keep it instead of paying a cache miss for an equal model.
	const previous = request.previous?.model;
	const canKeepPrevious =
		previous !== undefined &&
		request.state?.tier === tier &&
		request.state.modelKey === modelKey(previous) &&
		!memory.benchedModels.isBenched(modelKey(previous), Date.now());
	if (previous && canKeepPrevious && request.state) {
		// A new task starts without the previous task's hand-off.
		const isUnchanged =
			request.state.thinkingLevel === thinkingLevel && request.state.handoff === undefined && request.state.designTask === undefined;
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
		case "user": {
			const isNewTask = memory.isNewTaskPending;
			memory.isNewTaskPending = false;
			if (isNewTask) return routeNewTask(request, memory, ctx);
			return routeWithinTask(request, memory, ctx) ?? routeNewTask(request, memory, ctx);
		}
		case "continuation": {
			const withinTask = routeWithinTask(request, memory, ctx);
			if (withinTask) return withinTask;
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

function routeDesignTask(
	source: DesignSource,
	thinkingLevel: RoutedThinkingLevel,
	request: AutoRouteRequest,
	memory: RouterMemory,
	ctx: ExtensionContext,
): ModelRoute<AutoRouteState> {
	const policies = loadTierPolicies();
	const choice = chooseDesignerModel(usableModels(memory, ctx), policies, latestUserMessageHasImage(request.messages));
	if (!choice) {
		throw new Error(`Auto model found no available configured designer in expert or complex; check ${TIER_CONFIG_PATH} or log in with /login`);
	}
	const actualThinkingLevel = applyThinkingFloor(thinkingLevel, policies[choice.tier]);
	const reason = `design-first ${source}: ${choice.tier} designer${choice.tier === "complex" ? " fallback" : ""}`;
	memory.recordRouteDecision({ tier: choice.tier, thinkingLevel: actualThinkingLevel, reason });
	return {
		model: choice.model,
		thinkingLevel: actualThinkingLevel,
		state: {
			tier: choice.tier,
			modelKey: modelKey(choice.model),
			thinkingLevel: actualThinkingLevel,
			designTask: { id: randomUUID(), source },
		},
	};
}

function remindDesigner(event: AgentBeforeSettleEvent, ctx: ExtensionContext): BoundaryResult | undefined {
	if (event.outcome !== "completed" || !isAutoModelSelected(ctx) || isRoutingRestricted(ctx)) return undefined;
	if (ctx.hasPendingMessages() || event.continue) return undefined;
	const branch = ctx.sessionManager.getBranch();
	const state = findAutoRouteState(branch);
	if (!state?.designTask || state.handoff) return undefined;
	const alreadyReminded = branch.some(
		(entry) => entry.type === "custom" && entry.customType === DESIGN_REMINDER_ENTRY_TYPE &&
			(entry.data as { taskId?: unknown } | undefined)?.taskId === state.designTask?.id,
	);
	const alreadyProposed = event.entries.some(
		(entry) => entry.type === "custom" && entry.customType === DESIGN_REMINDER_ENTRY_TYPE &&
			(entry.data as { taskId?: unknown } | undefined)?.taskId === state.designTask?.id,
	);
	const latestAssistantText = event.context.contextEntries
		.flatMap((entry) => entry.messages)
		.filter((message) => message.role === "assistant")
		.map((message) =>
			typeof message.content === "string"
				? message.content
				: message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n"),
		)
		.at(-1) ?? "";
	if (!shouldRemindDesigner(state.designTask, false, alreadyReminded || alreadyProposed, latestAssistantText)) return undefined;
	return {
		entries: [
			...event.entries,
			{ type: "custom", customType: DESIGN_REMINDER_ENTRY_TYPE, data: { taskId: state.designTask.id } },
			{
				type: "custom_message",
				customType: DESIGN_REMINDER_ENTRY_TYPE,
				content:
					"This design-first task ended before implementation was handed off. Finish the contract comments, tests, and check commands, then call hand_off_implementation. If a real decision or prerequisite blocks you, instead end with DESIGN-BLOCKED: and its concrete question or failure. Do not claim implementation is complete or approve contracts before reviewer verification.",
				display: false,
			},
		],
		continue: true,
	};
}

interface BranchMessageEntry {
	type: string;
	message?: { role?: string; content?: unknown };
}

/** The latest persisted assistant text, used to treat a reply to DESIGN-BLOCKED as an answer within this task. */
function latestAssistantTextInBranch(branch: readonly BranchMessageEntry[]): string {
	const message = branch.findLast((entry) => entry.type === "message" && entry.message?.role === "assistant")?.message;
	if (!message) return "";
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return "";
	return message.content.flatMap((block: { type?: unknown; text?: unknown }) =>
		block.type === "text" && typeof block.text === "string" ? [block.text] : [],
	).join("\n");
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

function runCommandWith(pi: ExtensionAPI): RunCommand {
	return (command, args, options) => pi.exec(command, args, options);
}

/**
 * Once the implementer settles, the request routes back to the designer's model: to review the work, or, when the
 * implementer changed no file, to write the code itself instead of handing the same brief to the same model again.
 */
async function returnToDesigner(pi: ExtensionAPI, event: AgentBeforeSettleEvent, ctx: ExtensionContext): Promise<BoundaryResult | undefined> {
	if (event.outcome !== "completed" || !isAutoModelSelected(ctx)) return undefined;
	const branch = ctx.sessionManager.getBranch();
	if (findAutoRouteState(branch)?.handoff?.phase !== "implementing") return undefined;
	const work = readImplementerWork(branch);
	const hasChangedFiles = work !== undefined && hasImplementerChangedFiles(work, await fingerprintWorkTree(runCommandWith(pi), ctx.cwd));
	if (!hasChangedFiles && ctx.hasUI) ctx.ui.notify("auto-model: the implementer changed no file; the designer writes the code itself", "warning");
	const message = hasChangedFiles
		? { customType: REVIEW_REQUEST_MESSAGE_TYPE, content: reviewRequest() }
		: { customType: TAKE_OVER_MESSAGE_TYPE, content: takeOverRequest() };
	return { entries: [...event.entries, { type: "custom_message", ...message, display: true }], continue: true };
}

/** Keeps the implementer on the code: context and delegation tools are blocked while it implements. */
function blockImplementerDetours(toolName: string, ctx: ExtensionContext): { block: true; reason: string } | undefined {
	if (!isAutoModelSelected(ctx)) return undefined;
	const reason = implementerToolRefusal(toolName, findAutoRouteState(ctx.sessionManager.getBranch()));
	return reason ? { block: true, reason } : undefined;
}

/**
 * After the first tool turn of a complex or expert task, tells that model to design and hand off. Routing picks the
 * tier only when the first request goes out, after the system prompt is built, so the note cannot go there.
 */
function sendDesignerNote(event: TurnEndEvent, memory: RouterMemory, ctx: ExtensionContext): BoundaryResult | undefined {
	if (memory.hasSentDesignerNote || event.outcome !== "completed" || event.toolResults.length === 0) return undefined;
	if (!isAutoModelSelected(ctx) || isRoutingRestricted(ctx)) return undefined;
	const state = findAutoRouteState(ctx.sessionManager.getBranch());
	if (!state || !DESIGNER_TIERS.has(state.tier) || state.handoff || state.designTask) return undefined;
	memory.hasSentDesignerNote = true;
	return { entries: [...event.entries, { type: "custom_message", customType: DESIGNER_NOTE_MESSAGE_TYPE, content: designerNote(), display: false }] };
}

/** Repo files (tracked, and untracked but not ignored) that still hold a contract block. */
async function findFilesWithContracts(pi: ExtensionAPI, cwd: string): Promise<string[]> {
	const root = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd });
	if (root.code !== 0) throw new Error(`Cannot find contract blocks: ${cwd} is not in a git repository; delete them by hand`);
	const repoRoot = root.stdout.trim();
	const search = await pi.exec("git", ["grep", "--untracked", "-l", "-I", "-i", "-E", CONTRACT_SEARCH_PATTERN], { cwd: repoRoot });
	// git grep exits 1 when nothing matches.
	if (search.code === 1 && !search.stderr.trim()) return [];
	if (search.code !== 0) throw new Error(`Failed to search ${repoRoot} for contract blocks: ${search.stderr.trim() || `git grep exit code ${search.code}`}`);
	return search.stdout.split("\n").filter(Boolean).map((relativePath) => join(repoRoot, relativePath));
}

/** Deletes the contract blocks of every file; a malformed file is left as is and reported. */
async function removeAllContractBlocks(pi: ExtensionAPI, cwd: string): Promise<{ cleanedFiles: string[]; removedBlockCount: number; problems: string[] }> {
	const cleanedFiles: string[] = [];
	const problems: string[] = [];
	let removedBlockCount = 0;
	for (const filePath of await findFilesWithContracts(pi, cwd)) {
		const removal = removeContractBlocks(await readFile(filePath, "utf8"));
		if (removal.kind === "malformed") {
			problems.push(`${filePath}: ${removal.reason}`);
			continue;
		}
		if (removal.removedBlockCount === 0) continue;
		await writeFile(filePath, removal.text, "utf8");
		cleanedFiles.push(filePath);
		removedBlockCount += removal.removedBlockCount;
	}
	return { cleanedFiles, removedBlockCount, problems };
}

function registerHandoffTools(pi: ExtensionAPI): void {
	pi.registerTool({
		name: HANDOFF_TOOL_NAME,
		label: "Hand off implementation",
		description:
			"Hand the implementation of a designed change to a cheaper model on the auto model. Call it as the designer of a " +
			`design-first task, after a '${DESIGNER_NOTE_MESSAGE_TYPE}' note, or as the reviewer to send fix steps. ` +
			"The next turns run on the cheaper model; you review its work afterwards.",
		promptSnippet: "Hand a designed change (signatures, stubs, contract blocks) to a cheaper implementer model",
		promptGuidelines: [
			`Use ${HANDOFF_TOOL_NAME} as the designer of a design-first task or after the designer note, or as the reviewer for fixes; it refuses otherwise.`,
		],
		parameters: Type.Object({
			brief: Type.String({ description: "What to implement: the files and functions to fill, the constraints, the tests and check commands to run" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const refusal = isAutoModelSelected(ctx)
				? handoffRefusal(findAutoRouteState(ctx.sessionManager.getBranch()), isRoutingRestricted(ctx))
				: "Hand-off needs the auto model (auto/auto); implement it yourself.";
			if (refusal) throw new Error(refusal);
			// Taken now so the implementer's settle can tell whether it changed any file, also through bash.
			const workTreeFingerprint = await fingerprintWorkTree(runCommandWith(pi), ctx.cwd);
			return { content: [{ type: "text", text: implementerBrief(params.brief) }], details: { brief: params.brief, workTreeFingerprint } };
		},
	});

	pi.registerTool({
		name: APPROVE_TOOL_NAME,
		label: "Approve implementation",
		description:
			"Sign off a handed-off implementation after you verified it against its contract blocks and the user's request. " +
			"Deletes every @handoff-contract block in the repo; rerun the checks afterwards.",
		promptSnippet: "Sign off a handed-off implementation and delete its contract blocks",
		promptGuidelines: [`Call ${APPROVE_TOOL_NAME} only as the reviewer of a handed-off implementation, after verifying it.`],
		parameters: Type.Object({
			verification: Type.String({ description: "What you verified: the contracts checked and the commands you ran with their results" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const refusal = approvalRefusal(findAutoRouteState(ctx.sessionManager.getBranch()));
			if (refusal) throw new Error(refusal);
			const { cleanedFiles, removedBlockCount, problems } = await removeAllContractBlocks(pi, ctx.cwd);
			const removed =
				cleanedFiles.length > 0
					? `Removed ${removedBlockCount} contract block(s) from:\n${cleanedFiles.map((filePath) => `- ${filePath}`).join("\n")}`
					: "No contract blocks were left to remove.";
			const malformed = problems.length > 0 ? `\nNot removed, fix these by hand:\n${problems.map((problem) => `- ${problem}`).join("\n")}` : "";
			const text = `${removed}${malformed}\nRerun the project's checks now, then report to the user.`;
			return { content: [{ type: "text", text }], details: { verification: params.verification, cleanedFiles, problems } };
		},
	});
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
	const memory: RouterMemory = {
		benchedModels: new BenchedModels(),
		failoversThisPrompt: 0,
		announceTaskKind: (taskKind) => pi.events.emit(TASK_KIND_EVENT, taskKind),
		recordRouteDecision: (decision) => pi.appendEntry<RouteDecision>(ROUTE_DECISION_ENTRY_TYPE, decision),
		isNewTaskPending: false,
		hasSentDesignerNote: false,
	};

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

	pi.on("input", (_event, ctx) => {
		memory.failoversThisPrompt = 0;
		if (!ctx.isIdle()) return; // steering joins the running task
		const branch = ctx.sessionManager.getBranch();
		const isAnsweringDesignBlocker =
			findAutoRouteState(branch)?.designTask !== undefined &&
			latestAssistantTextInBranch(branch).split(/\r?\n/).some((line) => /^\s*DESIGN-BLOCKED:/.test(line));
		memory.isNewTaskPending = !isAnsweringDesignBlocker;
		memory.hasSentDesignerNote = false;
	});

	pi.on("before_agent_start", (event, ctx) => {
		const sections = event.systemPromptOptions.sections;
		const hasActiveHandoff = findAutoRouteState(ctx.sessionManager.getBranch())?.handoff !== undefined;
		if (isAutoModelSelected(ctx) && !isRoutingRestricted(ctx) && (!hasActiveHandoff || memory.isNewTaskPending)) {
			sections.auto_model_design_first = designFirstInstructions();
		} else {
			delete sections.auto_model_design_first;
		}
	});
	pi.on("agent_before_settle", async (event, ctx) => {
		const failover = failOverToNextModel(event, memory, ctx);
		if (failover) return failover;
		const returned = await returnToDesigner(pi, event, ctx);
		return returned ?? remindDesigner(event, ctx);
	});
	pi.on("tool_call", (event, ctx) => (IMPLEMENTER_BLOCKED_TOOLS.has(event.toolName) ? blockImplementerDetours(event.toolName, ctx) : undefined));
	pi.on("turn_end", (event, ctx) => sendDesignerNote(event, memory, ctx));
	registerHandoffTools(pi);

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
