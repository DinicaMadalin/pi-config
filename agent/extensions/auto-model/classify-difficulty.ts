import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DIFFICULTY_TIERS, type DifficultyTier, type RoutedThinkingLevel } from "./difficulty-tiers.ts";

const MAX_PROMPT_CHARS = 12_000;
const MAX_EARLIER_PROMPT_CHARS = 1_500;
const EARLIER_PROMPTS_FOR_CONTEXT = 3;

/** Same key locations as the pi-jev package, so one TypeSafe login serves both. */
const TYPESAFE_KEY_FILE = join(homedir(), ".pi", "agent", "secrets", "typesafe_api_key");

export type DifficultyRating =
	| { kind: "rated"; tier: DifficultyTier; thinkingLevel: RoutedThinkingLevel; confidence: number }
	| { kind: "unavailable"; reason: string };

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

/** Rates the latest user prompt; earlier prompts give context to short follow-ups like "do it". */
export async function rateTaskDifficulty(
	messages: readonly Message[],
	ctx: ExtensionContext,
	signal: AbortSignal | undefined,
): Promise<DifficultyRating> {
	const jev = ctx.modelRegistry.findOfType("classifier", "typesafe", "jev-latest");
	if (!jev) return { kind: "unavailable", reason: "TypeSafe classifier typesafe/jev-latest is not in the catalog" };

	const userPrompts = messages.filter((message) => message.role === "user").map(textOf);
	const latestPrompt = userPrompts.at(-1) ?? "";
	const earlierPrompts = userPrompts
		.slice(-1 - EARLIER_PROMPTS_FOR_CONTEXT, -1)
		.map((prompt) => prompt.slice(0, MAX_EARLIER_PROMPT_CHARS));

	const result = await ctx.modelRegistry.classify(
		jev,
		{
			state: { prompt: latestPrompt.slice(0, MAX_PROMPT_CHARS), earlierPrompts },
			questions: {
				difficulty: {
					type: "choice",
					instructions:
						"How much reasoning capability does an AI coding agent need to complete the task in `prompt` well? " +
						"`earlierPrompts` are previous requests in the same session, for context only.",
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
	return {
		kind: "rated",
		tier: answer.choice as DifficultyTier,
		thinkingLevel: thinkingAnswer.choice as RoutedThinkingLevel,
		confidence: answer.confidence,
	};
}
