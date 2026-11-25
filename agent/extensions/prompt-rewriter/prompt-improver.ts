/**
 * The steps from a typed message to the text that is sent: every eligible message is rewritten by the cheap model, Jev
 * decides whether it may ask questions, and checks that the rewrite kept the meaning. A rewrite that passes is sent on
 * its own; when the check still finds a problem, your original text is sent instead.
 */
import { basename } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { checkFidelity, judgeClarity, planRewrite } from "./prompt-judge.ts";
import type { RewriteOutcome } from "./rewrite-request.ts";
import { askRewriter, REWRITE_TIMEOUT_MS } from "./rewriter-model.ts";
import type { ClarifyingAnswer, ConversationMessage, RewriteInput } from "./rewriter-prompt.ts";
import { conversationOf } from "./session-conversation.ts";

const STATUS_KEY = "prompt-rewriter";
/** Jev answers in about a second; past this the message is rewritten without its judgment. */
const JUDGE_TIMEOUT_MS = 15_000;

/** Jev is optional: when it fails the rewrite goes on without its judgment, and you hear about it once per session. */
let hasReportedJevFailure = false;

function withoutJev(ctx: ExtensionContext, step: string): (error: unknown) => undefined {
	return (error) => {
		if (!hasReportedJevFailure) {
			hasReportedJevFailure = true;
			ctx.ui.notify(`Jev could not ${step} (${(error as Error).message}); the prompt rewriter goes on without it`, "warning");
		}
		return undefined;
	};
}

interface CheckedRewrite {
	prompt: string;
	modelName: string;
	/** What Jev's last check still found wrong; empty when it passed or could not run. */
	problems: readonly string[];
}

/** The text to send: the rewrite when it kept your meaning, your text otherwise; cancelled only when you press Esc on a question. */
export async function improvePrompt(ctx: ExtensionContext, original: string): Promise<RewriteOutcome> {
	const conversation = conversationOf(ctx.sessionManager.getBranch());
	let rewrite: CheckedRewrite | undefined;
	try {
		ctx.ui.setStatus(STATUS_KEY, "✎ reading your prompt…");
		const judgment = await judgeClarity(ctx, original, conversation, AbortSignal.timeout(JUDGE_TIMEOUT_MS)).catch(withoutJev(ctx, "judge your prompt"));
		const plan = planRewrite(judgment);
		const input: RewriteInput = { prompt: original, recentConversation: conversation, workspaceName: basename(ctx.cwd), mayAskQuestions: plan.mayAskQuestions };
		rewrite = await rewriteWithAnswers(ctx, input);
		if (!rewrite) return { kind: "cancelled" };
	} catch (error) {
		ctx.ui.notify(`Prompt rewrite failed (${(error as Error).message}); sending your message as typed`, "warning");
		return { kind: "send", text: original };
	} finally {
		ctx.ui.setStatus(STATUS_KEY, undefined);
	}
	return sendRewriteOrOriginal(ctx, original, rewrite);
}

/** Undefined when you pressed Esc on a question. */
async function rewriteWithAnswers(ctx: ExtensionContext, input: RewriteInput): Promise<CheckedRewrite | undefined> {
	ctx.ui.setStatus(STATUS_KEY, "✎ rewriting your prompt…");
	const first = await askRewriter(ctx, input, AbortSignal.timeout(REWRITE_TIMEOUT_MS));
	let answeredInput = input;
	let draft: { prompt: string; modelName: string };
	if (first.reply.kind === "questions") {
		ctx.ui.setStatus(STATUS_KEY, undefined);
		const answers = await askClarifyingQuestions(ctx, first.reply.questions);
		if (!answers) return undefined;
		answeredInput = { ...input, answers };
		ctx.ui.setStatus(STATUS_KEY, "✎ rewriting your prompt with your answers…");
		const second = await askRewriter(ctx, answeredInput, AbortSignal.timeout(REWRITE_TIMEOUT_MS));
		if (second.reply.kind !== "rewrite") throw new Error(`${second.modelName} asked again instead of rewriting`);
		draft = { prompt: second.reply.prompt, modelName: second.modelName };
	} else if (first.reply.kind === "rewrite") {
		draft = { prompt: first.reply.prompt, modelName: first.modelName };
	} else {
		throw new Error(`${first.modelName} gave an unreadable reply`);
	}
	return checkAndCorrect(ctx, answeredInput, draft);
}

/** Jev checks the draft; when it finds a problem, the rewriter gets one more attempt with what was wrong. */
async function checkAndCorrect(ctx: ExtensionContext, input: RewriteInput, draft: { prompt: string; modelName: string }): Promise<CheckedRewrite> {
	ctx.ui.setStatus(STATUS_KEY, "✎ checking the rewrite…");
	const problems = await fidelityProblemsOf(ctx, input.prompt, draft.prompt, input.recentConversation);
	if (problems.length === 0) return { ...draft, problems };
	ctx.ui.setStatus(STATUS_KEY, "✎ fixing the rewrite…");
	const retry = await askRewriter(
		ctx,
		{ ...input, mayAskQuestions: false, correction: { previousRewrite: draft.prompt, problems } },
		AbortSignal.timeout(REWRITE_TIMEOUT_MS),
	);
	if (retry.reply.kind !== "rewrite") return { ...draft, problems };
	ctx.ui.setStatus(STATUS_KEY, "✎ checking the rewrite…");
	const retryProblems = await fidelityProblemsOf(ctx, input.prompt, retry.reply.prompt, input.recentConversation);
	return { prompt: retry.reply.prompt, modelName: retry.modelName, problems: retryProblems };
}

async function fidelityProblemsOf(
	ctx: ExtensionContext,
	original: string,
	rewrite: string,
	conversation: readonly ConversationMessage[],
): Promise<string[]> {
	const problems = await checkFidelity(ctx, original, rewrite, conversation, AbortSignal.timeout(JUDGE_TIMEOUT_MS)).catch(withoutJev(ctx, "check the rewrite"));
	return problems ?? [];
}

/** Undefined when you pressed Esc on a question: the message goes back to the editor. */
async function askClarifyingQuestions(ctx: ExtensionContext, questions: readonly string[]): Promise<ClarifyingAnswer[] | undefined> {
	const answers: ClarifyingAnswer[] = [];
	for (const [index, question] of questions.entries()) {
		const answer = await ctx.ui.input(`Before rewriting (${index + 1}/${questions.length}): ${question}`, "Your answer; leave empty to let it pick");
		if (answer === undefined) return undefined;
		answers.push({ question, answer });
	}
	return answers;
}

/**
 * Sent without asking: the rewriter has been checked, so the rewrite goes out and the original stays in the session.
 * A rewrite the check still doubts could change what you asked, so your own text goes instead.
 */
function sendRewriteOrOriginal(ctx: ExtensionContext, original: string, rewrite: CheckedRewrite): RewriteOutcome {
	if (rewrite.problems.length === 0) return { kind: "send", text: rewrite.prompt };
	ctx.ui.notify(`Sent your prompt as typed: the rewrite ${rewrite.problems.join("; ")}`, "warning");
	return { kind: "send", text: original };
}
