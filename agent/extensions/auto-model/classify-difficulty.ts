import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DIFFICULTY_TIERS, type DifficultyTier, type RoutedThinkingLevel } from "./difficulty-tiers.ts";
import { PREVIOUS_TIER_FITS, type PreviousTierFit, type RoutingCorrection } from "./routing-feedback.ts";

const MAX_PROMPT_CHARS = 12_000;
/** The end of the answer holds its conclusion; enough for Jev to judge it. */
const MAX_PREVIOUS_ANSWER_CHARS = 2_000;
const MAX_EARLIER_PROMPT_CHARS = 1_500;
const EARLIER_PROMPTS_FOR_CONTEXT = 3;

/** Same key locations as the pi-jev package, so one TypeSafe login serves both. */
const TYPESAFE_KEY_FILE = join(homedir(), ".pi", "agent", "secrets", "typesafe_api_key");

/** The previous user task, how it was routed, and how it went, judged in hindsight on the next prompt. */
export interface PreviousExchange {
	prompt: string;
	routedTier: DifficultyTier;
	answerTail: string;
	toolCallCount: number;
}

export type DifficultyRating =
	| {
			kind: "rated";
			tier: DifficultyTier;
			thinkingLevel: RoutedThinkingLevel;
			confidence: number;
			previousTierFit?: { fit: PreviousTierFit; confidence: number };
	  }
	| { kind: "unavailable"; reason: string };

const TIER_FIT_CRITERIA: Record<PreviousTierFit, string> = {
	too_weak:
		"The new prompt complains about the previous answer: says it was wrong, broken, incomplete, low quality, " +
		"or misunderstood, or repeats the request because it was not done. Trust the user's reaction",
	right: "The previous answer was adequate for its task, or the new prompt gives no evidence either way",
	too_strong:
		"The user accepted the previous answer and the task was clearly far simpler than its routed tier, " +
		"e.g. a one-line answer or a single small edit on the complex or expert tier",
};

const TIER_CRITERIA: Record<DifficultyTier, string> = {
	trivial:
		"Read-only work that changes no code: chit-chat, factual questions, explaining or summarizing a repo, file, " +
		"or concept; or a tiny mechanical edit such as a rename or typo fix",
	standard: "Writing or changing code: an ordinary feature, bug fix, script, or code review confined to a few files",
	complex: "Multi-file or cross-cutting changes, non-obvious debugging, performance work, or careful design",
	expert: "Deep architecture, subtle concurrency or security issues, novel algorithms, or long autonomous work",
};

/** Thinking depth is rated separately: a simple task on a strong model can still need little thinking, and vice versa. */
const THINKING_CRITERIA: Partial<Record<RoutedThinkingLevel, string>> = {
	minimal: "Answer directly; no reasoning needed, e.g. greetings or one-line facts",
	low: "Brief reasoning; the path to the answer is obvious once the relevant code is read",
	medium: "Some step-by-step reasoning: weighing a few options or tracing logic across a couple of files",
	high: "Careful multi-step reasoning: tricky edge cases, debugging hypotheses, or design trade-offs",
	xhigh: "Exhaustive reasoning: proofs, subtle concurrency or security analysis, or long chains of dependent decisions",
};

function resolveTypesafeApiKey(): string | undefined {
	const envKey = process.env.TYPESAFE_API_KEY?.trim();
	if (envKey) return envKey;
	if (!existsSync(TYPESAFE_KEY_FILE)) return undefined;
	return readFileSync(TYPESAFE_KEY_FILE, "utf8").trim() || undefined;
}

export function hasTypesafeApiKey(): boolean {
	return resolveTypesafeApiKey() !== undefined;
}

function textOf(message: Message): string {
	if (message.role !== "user") return "";
	if (typeof message.content === "string") return message.content;
	return message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
}

export function latestUserMessageHasImage(messages: readonly Message[]): boolean {
	const latestUser = messages.findLast((message) => message.role === "user");
	if (!latestUser || typeof latestUser.content === "string") return false;
	return latestUser.content.some((block) => block.type === "image");
}

export function latestUserPromptText(messages: readonly Message[]): string {
	const latestUser = messages.findLast((message) => message.role === "user");
	return latestUser ? textOf(latestUser) : "";
}

/** The user prompt before the latest one and the agent's work on it; undefined on the first prompt. */
export function findPreviousExchange(messages: readonly Message[], routedTier: DifficultyTier): PreviousExchange | undefined {
	const userIndexes = messages.flatMap((message, index) => (message.role === "user" ? [index] : []));
	if (userIndexes.length < 2) return undefined;
	const previousUserIndex = userIndexes.at(-2) ?? 0;
	const agentWork = messages.slice(previousUserIndex + 1, userIndexes.at(-1));
	let toolCallCount = 0;
	let answerTail = "";
	for (const message of agentWork) {
		if (message.role !== "assistant") continue;
		toolCallCount += message.content.filter((block) => block.type === "toolCall").length;
		const answerText = message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
		if (answerText.trim()) answerTail = answerText;
	}
	return {
		prompt: textOf(messages[previousUserIndex]).slice(0, MAX_EARLIER_PROMPT_CHARS),
		routedTier,
		answerTail: answerTail.slice(-MAX_PREVIOUS_ANSWER_CHARS),
		toolCallCount,
	};
}

/**
 * Rates the latest user prompt; earlier prompts give context to short follow-ups like "do it".
 * `pastCorrections` are prompts that were routed to the wrong tier, used as calibration.
 * With `previousExchange`, Jev also judges in hindsight whether the previous task got the right tier.
 */
export async function rateTaskDifficulty(
	messages: readonly Message[],
	pastCorrections: readonly RoutingCorrection[],
	previousExchange: PreviousExchange | undefined,
	ctx: ExtensionContext,
	signal: AbortSignal | undefined,
): Promise<DifficultyRating> {
	const jev = ctx.modelRegistry.findOfType("classifier", "typesafe", "jev-latest");
	if (!jev) return { kind: "unavailable", reason: "TypeSafe classifier typesafe/jev-latest is not in the catalog" };

	const userPrompts = messages.filter((message) => message.role === "user").map(textOf);
	const latestPrompt = userPrompts.at(-1) ?? "";
	const corrections = pastCorrections.map(({ prompt, routedTier, correctTier }) => ({ prompt, routedTier, correctTier }));
	const earlierPrompts = userPrompts
		.slice(-1 - EARLIER_PROMPTS_FOR_CONTEXT, -1)
		.map((prompt) => prompt.slice(0, MAX_EARLIER_PROMPT_CHARS));

	const tierFitQuestion = {
		type: "choice" as const,
		instructions:
			"Judge in hindsight whether `previousExchange` (an earlier task, the tier it was routed to, the end of the " +
			"agent's answer, and how many tools it called) got the right capability tier. The user's reaction is in " +
			"`prompt`, and it is the main evidence. Tiers from weakest to strongest: trivial, standard, complex, expert.",
		criteria: TIER_FIT_CRITERIA,
	};
	const result = await ctx.modelRegistry.classify(
		jev,
		{
			state: {
				prompt: latestPrompt.slice(0, MAX_PROMPT_CHARS),
				earlierPrompts,
				pastCorrections: corrections,
				...(previousExchange ? { previousExchange: { ...previousExchange } } : {}),
			},
			questions: {
				...(previousExchange ? { previousTierFit: tierFitQuestion } : {}),
				difficulty: {
					type: "choice",
					instructions:
						"How much reasoning capability does an AI coding agent need to complete the task in `prompt` well? " +
						"`earlierPrompts` are previous requests in the same session, for context only. " +
						"`pastCorrections` are earlier prompts that were rated wrongly (`routedTier`) and the tier " +
						"they actually needed (`correctTier`); rate prompts that ask for similar work like the corrected tier.",
					criteria: TIER_CRITERIA,
				},
				thinkingDepth: {
					type: "choice",
					instructions:
						"How much deliberate step-by-step reasoning should the agent spend before acting on `prompt`? " +
						"`earlierPrompts` are previous requests in the same session, for context only.",
					criteria: THINKING_CRITERIA as Record<string, string>,
				},
			},
		},
		{ signal, apiKey: resolveTypesafeApiKey() },
	);

	if (result.stopReason !== "stop") {
		return { kind: "unavailable", reason: result.errorMessage ?? `classifier stopped: ${result.stopReason}` };
	}
	const answer = result.answers.difficulty;
	if (answer?.type !== "choice" || !DIFFICULTY_TIERS.includes(answer.choice as DifficultyTier)) {
		return { kind: "unavailable", reason: "classifier returned no difficulty choice" };
	}
	const thinkingAnswer = result.answers.thinkingDepth;
	if (thinkingAnswer?.type !== "choice" || !(thinkingAnswer.choice in THINKING_CRITERIA)) {
		return { kind: "unavailable", reason: "classifier returned no thinking depth choice" };
	}
	const fitAnswer = result.answers.previousTierFit;
	const previousTierFit =
		fitAnswer?.type === "choice" && PREVIOUS_TIER_FITS.includes(fitAnswer.choice as PreviousTierFit)
			? { fit: fitAnswer.choice as PreviousTierFit, confidence: fitAnswer.confidence }
			: undefined;
	return {
		kind: "rated",
		tier: answer.choice as DifficultyTier,
		thinkingLevel: thinkingAnswer.choice as RoutedThinkingLevel,
		confidence: answer.confidence,
		previousTierFit,
	};
}
