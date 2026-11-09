import type { Api, Message, Model } from "@earendil-works/pi-ai";
import { uuidv7 } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { modelKey } from "../auto-model/difficulty-tiers.ts";
import { loadTierPolicies } from "../auto-model/tier-config.ts";
import { parseRewriterReply, REWRITER_SYSTEM_PROMPT, type RewriteInput, type RewriterReply, rewriteRequestText } from "./rewriter-prompt.ts";

/** A rewrite is worth a short wait, not a long one: past this the message goes as typed. */
export const REWRITE_TIMEOUT_MS = 45_000;

export interface RewriterAnswer {
	reply: RewriterReply;
	modelName: string;
}

/** The cheap models of auto-model's trivial tier that are logged in, cheapest first. */
function rewriterModels(ctx: ExtensionContext): Model<Api>[] {
	const availableByKey = new Map(ctx.modelRegistry.getAvailable().map((model) => [modelKey(model), model]));
	return loadTierPolicies()
		.trivial.models.map((key) => availableByKey.get(key))
		.filter((model) => model !== undefined);
}

/** Asks the cheap models in turn; the next one gets the job when one fails. */
export async function askRewriter(ctx: ExtensionContext, input: RewriteInput, signal: AbortSignal): Promise<RewriterAnswer> {
	const models = rewriterModels(ctx);
	if (models.length === 0) throw new Error("no model of auto-model's trivial tier is logged in");
	const failures: string[] = [];
	for (const model of models) {
		const modelName = `${model.provider}/${model.id}`;
		const request: Message = { role: "user", content: [{ type: "text", text: rewriteRequestText(input) }], timestamp: Date.now() };
		const response = await ctx.modelRegistry.complete(
			model,
			{ systemPrompt: REWRITER_SYSTEM_PROMPT, messages: [request] },
			{ signal, cacheRetention: "none", sessionId: uuidv7() },
		);
		if (response.stopReason === "aborted") throw new Error("the rewrite was stopped");
		if (response.stopReason === "error") {
			failures.push(`${modelName}: ${response.errorMessage ?? "unknown error"}`);
			continue;
		}
		const text = response.content
			.filter((block) => block.type === "text")
			.map((block) => block.text)
			.join("\n");
		const reply = parseRewriterReply(text);
		if (reply.kind !== "unreadable") return { reply, modelName };
		failures.push(`${modelName}: the reply had neither <rewrite> nor <questions>`);
	}
	throw new Error(failures.join("; "));
}
