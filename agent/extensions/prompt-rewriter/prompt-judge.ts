/**
 * Jev's two judgments around a rewrite: whether a message needs one at all (and may need questions), and whether a
 * rewrite kept the meaning. Undefined from either means Jev was unavailable; the rewriter then decides alone.
 */
import type { ClassifierAnswer, ClassifierQuestion } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveTypesafeApiKey } from "../auto-model/classify-difficulty.ts";
import type { ConversationMessage } from "./rewriter-prompt.ts";

/** Below this, "clear" is not trusted and the message is still rewritten. */
export const MIN_CLEAR_CONFIDENCE = 0.6;
/** From this probability of "ambiguous", the rewriter may ask questions. */
export const MIN_AMBIGUOUS_PROBABILITY = 0.35;
/** A fidelity check below this probability counts as failed. */
export const MIN_FIDELITY_PROBABILITY = 0.5;

const RECENT_MESSAGES_FOR_JUDGING = 4;
const MAX_CHARS_PER_MESSAGE = 1000;

export const PROMPT_CLARITIES = ["clear", "messy", "ambiguous"] as const;
export type PromptClarity = (typeof PROMPT_CLARITIES)[number];

const CLARITY_CRITERIA: Record<PromptClarity, string> = {
	clear:
		"An AI coding agent would understand exactly what to do from the message as written: the request is explicit, " +
		"references are resolvable, little filler. Rewriting it would not change the outcome.",
	messy:
		"The intent can be worked out, but the wording is rambling, repetitive, dictated, full of filler or typos, or " +
		"leans on vague references ('it', 'the thing'); a clean rewrite would help the agent.",
	ambiguous:
		"The message could reasonably mean materially different tasks, or misses something essential (which file, " +
		"which feature, which of two options), so a wrong guess would make the agent do the wrong work.",
};

export type RewritePlan = { kind: "send-as-typed" } | { kind: "rewrite"; mayAskQuestions: boolean };

export interface ClarityJudgment {
	clarity: PromptClarity;
	confidence: number;
	ambiguousProbability: number;
}

/** What to do with a message given Jev's judgment; without one, the rewriter decides whether to ask. */
export function planRewrite(judgment: ClarityJudgment | undefined): RewritePlan {
	if (!judgment) return { kind: "rewrite", mayAskQuestions: true };
	if (judgment.clarity === "clear" && judgment.confidence >= MIN_CLEAR_CONFIDENCE) return { kind: "send-as-typed" };
	return { kind: "rewrite", mayAskQuestions: judgment.ambiguousProbability >= MIN_AMBIGUOUS_PROBABILITY };
}

export const FIDELITY_CHECKS = {
	keepsEverything: {
		instructions:
			"Does `rewrite` keep every request, question, constraint and concrete detail of `original` (paths, names, " +
			"commands, numbers, error messages, code)? `recentConversation` explains references, for context only.",
		problem: "may have dropped a request or detail",
	},
	addsNothing: {
		instructions:
			"Does `rewrite` add nothing that `original` did not state or clearly imply: no new requirement, feature, file, " +
			"test, technology, or claim about what the code contains? Spelling out what 'it' or 'that' refers to, using " +
			"`recentConversation`, and listing guesses under an 'Assumptions' heading are allowed.",
		problem: "may have added something you did not ask for",
	},
	keepsStance: {
		instructions:
			"Does `rewrite` keep the developer's stance from `original`: uncertainty stays uncertain ('maybe', 'I guess', " +
			"'I think'), and a question stays a question instead of becoming an order?",
		problem: "may have turned a maybe or a question into an order",
	},
} as const;

export type FidelityCheckName = keyof typeof FIDELITY_CHECKS;

/** The problems the failed checks describe; empty when the rewrite kept the meaning. */
export function fidelityProblems(probabilities: Partial<Record<FidelityCheckName, number>>): string[] {
	return (Object.keys(FIDELITY_CHECKS) as FidelityCheckName[])
		.filter((name) => (probabilities[name] ?? 1) < MIN_FIDELITY_PROBABILITY)
		.map((name) => FIDELITY_CHECKS[name].problem);
}

function recentForJudging(conversation: readonly ConversationMessage[]): ConversationMessage[] {
	return conversation.slice(-RECENT_MESSAGES_FOR_JUDGING).map(({ role, text }) => ({ role, text: text.slice(0, MAX_CHARS_PER_MESSAGE) }));
}

async function askJev(
	ctx: ExtensionContext,
	state: Record<string, unknown>,
	questions: Record<string, ClassifierQuestion>,
	signal: AbortSignal,
): Promise<Record<string, ClassifierAnswer> | undefined> {
	const jev = ctx.modelRegistry.findOfType("classifier", "typesafe", "jev-latest");
	const apiKey = resolveTypesafeApiKey();
	if (!jev || !apiKey) return undefined;
	const result = await ctx.modelRegistry.classify(jev, { state: JSON.parse(JSON.stringify(state)), questions }, { signal, apiKey });
	return result.stopReason === "stop" ? result.answers : undefined;
}

export async function judgeClarity(
	ctx: ExtensionContext,
	prompt: string,
	conversation: readonly ConversationMessage[],
	signal: AbortSignal,
): Promise<ClarityJudgment | undefined> {
	const answers = await askJev(
		ctx,
		{ message: prompt, recentConversation: recentForJudging(conversation) },
		{
			clarity: {
				type: "choice",
				instructions:
					"How well would an AI coding agent understand `message`, a developer's new message to it? " +
					"`recentConversation` is the session so far; references to it count as resolvable.",
				criteria: CLARITY_CRITERIA,
			},
		},
		signal,
	);
	const clarity = answers?.clarity;
	if (clarity?.type !== "choice" || !PROMPT_CLARITIES.includes(clarity.choice as PromptClarity)) return undefined;
	return {
		clarity: clarity.choice as PromptClarity,
		confidence: clarity.confidence,
		ambiguousProbability: clarity.probabilities.ambiguous ?? 0,
	};
}

/** The problems found in the rewrite; undefined when Jev could not check it. */
export async function checkFidelity(
	ctx: ExtensionContext,
	original: string,
	rewrite: string,
	conversation: readonly ConversationMessage[],
	signal: AbortSignal,
): Promise<string[] | undefined> {
	const questions: Record<string, ClassifierQuestion> = {};
	for (const [name, check] of Object.entries(FIDELITY_CHECKS)) {
		questions[name] = { type: "bool", instructions: check.instructions, criteria: { true: "yes", false: "no" } };
	}
	const answers = await askJev(ctx, { original, rewrite, recentConversation: recentForJudging(conversation) }, questions, signal);
	if (!answers) return undefined;
	const probabilities: Partial<Record<FidelityCheckName, number>> = {};
	for (const name of Object.keys(FIDELITY_CHECKS) as FidelityCheckName[]) {
		const answer = answers[name];
		if (answer?.type === "bool") probabilities[name] = answer.probability;
	}
	return fidelityProblems(probabilities);
}
