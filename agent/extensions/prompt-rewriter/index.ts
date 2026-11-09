/**
 * prompt-rewriter: before a typed message goes to the model, a cheap model rewrites it into a clear, structured
 * prompt with the same meaning, asks you up to three questions when the message is ambiguous, and shows you the
 * rewrite to send, edit, or skip. /build tasks get the same treatment (see rewrite-request.ts).
 *
 * - /rewrite on|off turns it on or off (saved in ~/.pi/agent/prompt-rewriter.json); /rewrite shows the state.
 * - Short replies, commands and already structured prompts go as typed; so does everything when the rewrite fails.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { decideRewrite } from "./rewrite-policy.ts";
import { REWRITE_REQUEST_EVENT, type RewriteOutcome, type RewriteRequest } from "./rewrite-request.ts";
import { askRewriter, REWRITE_TIMEOUT_MS } from "./rewriter-model.ts";
import type { ClarifyingAnswer, RewriteInput } from "./rewriter-prompt.ts";
import { conversationOf } from "./session-conversation.ts";

const SETTINGS_PATH = join(homedir(), ".pi", "agent", "prompt-rewriter.json");
const STATUS_KEY = "prompt-rewriter";
const ORIGINAL_ENTRY_TYPE = "prompt-rewriter-original";

const PREVIEW_CHOICES = {
	sendRewrite: "Send the rewrite",
	edit: "Edit the rewrite",
	sendOriginal: "Send my original",
} as const;

function loadIsEnabled(): boolean {
	if (!existsSync(SETTINGS_PATH)) return true;
	try {
		return (JSON.parse(readFileSync(SETTINGS_PATH, "utf8")) as { enabled?: unknown }).enabled !== false;
	} catch (error) {
		throw new Error(`Failed to read ${SETTINGS_PATH}: ${(error as Error).message}`);
	}
}

function saveIsEnabled(isEnabled: boolean): void {
	writeFileSync(SETTINGS_PATH, `${JSON.stringify({ enabled: isEnabled }, null, 2)}\n`);
}

export default function (pi: ExtensionAPI) {
	let isEnabled = loadIsEnabled();

	/** The rewrite, after any questions, as you approved it; the original when the rewrite failed. */
	async function improvePrompt(ctx: ExtensionContext, original: string): Promise<RewriteOutcome> {
		const input: RewriteInput = {
			prompt: original,
			recentConversation: conversationOf(ctx.sessionManager.getBranch()),
			workspaceName: basename(ctx.cwd),
		};
		let rewrite: { prompt: string; modelName: string };
		try {
			ctx.ui.setStatus(STATUS_KEY, "✎ rewriting your prompt…");
			const signal = AbortSignal.timeout(REWRITE_TIMEOUT_MS);
			const first = await askRewriter(ctx, input, signal);
			if (first.reply.kind === "questions") {
				ctx.ui.setStatus(STATUS_KEY, undefined);
				const answers = await askClarifyingQuestions(ctx, first.reply.questions);
				if (!answers) return { kind: "cancelled" };
				ctx.ui.setStatus(STATUS_KEY, "✎ rewriting your prompt with your answers…");
				const second = await askRewriter(ctx, { ...input, answers }, AbortSignal.timeout(REWRITE_TIMEOUT_MS));
				if (second.reply.kind !== "rewrite") throw new Error(`${second.modelName} asked again instead of rewriting`);
				rewrite = { prompt: second.reply.prompt, modelName: second.modelName };
			} else if (first.reply.kind === "rewrite") {
				rewrite = { prompt: first.reply.prompt, modelName: first.modelName };
			} else {
				throw new Error(`${first.modelName} gave an unreadable reply`);
			}
		} catch (error) {
			ctx.ui.notify(`Prompt rewrite failed (${(error as Error).message}); sending your message as typed`, "warning");
			return { kind: "send", text: original };
		} finally {
			ctx.ui.setStatus(STATUS_KEY, undefined);
		}
		const approved = await previewRewrite(ctx, rewrite.prompt, rewrite.modelName);
		if (approved.kind === "send" && approved.text !== original) pi.appendEntry(ORIGINAL_ENTRY_TYPE, { original, sent: approved.text });
		return approved.kind === "send" || approved.kind === "cancelled" ? approved : { kind: "send", text: original };
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

	async function previewRewrite(
		ctx: ExtensionContext,
		rewrite: string,
		modelName: string,
	): Promise<RewriteOutcome | { kind: "original" }> {
		const title = `Rewritten prompt (${modelName})\n\n${rewrite}\n`;
		const choice = await ctx.ui.select(title, Object.values(PREVIEW_CHOICES));
		switch (choice) {
			case PREVIEW_CHOICES.sendRewrite:
				return { kind: "send", text: rewrite };
			case PREVIEW_CHOICES.sendOriginal:
				return { kind: "original" };
			case PREVIEW_CHOICES.edit: {
				const edited = await ctx.ui.editor("Edit the rewritten prompt, then save to send it", rewrite);
				return edited?.trim() ? { kind: "send", text: edited } : { kind: "cancelled" };
			}
			default:
				return { kind: "cancelled" };
		}
	}

	pi.on("input", async (event, ctx) => {
		if (!isEnabled || event.source !== "interactive" || event.streamingBehavior || !ctx.hasUI) return { action: "continue" };
		if (decideRewrite(event.text).kind === "skip") return { action: "continue" };
		const outcome = await improvePrompt(ctx, event.text);
		if (outcome.kind === "cancelled") {
			ctx.ui.setEditorText(event.text);
			ctx.ui.notify("Not sent; your message is back in the editor", "info");
			return { action: "handled" };
		}
		if (outcome.text === event.text) return { action: "continue" };
		return { action: "transform", text: outcome.text, ...(event.images && { images: event.images }) };
	});

	pi.events.on(REWRITE_REQUEST_EVENT, (data) => {
		const request = data as RewriteRequest;
		const { ctx, text } = request;
		if (!isEnabled || !ctx.hasUI || decideRewrite(text).kind === "skip") return;
		request.outcome = improvePrompt(ctx, text);
	});

	pi.registerCommand("rewrite", {
		description: "Rewrite typed prompts into clear, structured ones before sending: /rewrite on|off",
		handler: async (args, ctx) => {
			const setting = args.trim().toLowerCase();
			if (setting === "on" || setting === "off") {
				isEnabled = setting === "on";
				saveIsEnabled(isEnabled);
			} else if (setting) {
				ctx.ui.notify("Usage: /rewrite on|off", "warning");
				return;
			}
			ctx.ui.notify(`Prompt rewriting is ${isEnabled ? "on" : "off"}`, "info");
		},
	});
}
