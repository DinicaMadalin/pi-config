/** Writes the agreed plan from the conversation with a model, for /handoff when the agent saved none. */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type Api, type Message, type Model, uuidv7 } from "@earendil-works/pi-ai";
import { convertToLlm, type ExtensionContext, type SessionEntry, serializeConversation } from "@earendil-works/pi-coding-agent";
import { AGREED_PLAN_SECTIONS } from "./agreed-plan-files.ts";

/** The auto-model extension's virtual provider; it cannot answer a direct completion call. */
const VIRTUAL_PROVIDER = "auto";

const PLAN_WRITER_SYSTEM_PROMPT = `You turn a planning conversation between a developer and a coding agent into the final agreed plan.
Record only what was agreed; where the conversation changed its mind, keep the final position.
Write markdown with exactly these sections, starting with a single "# <plan title>" line:

${AGREED_PLAN_SECTIONS}

Be dense and specific: exact paths, names, commands. No filler, no preamble.`;

function entryToMessage(entry: SessionEntry): AgentMessage | undefined {
	if (entry.type === "message") return entry.message;
	if (entry.type === "compaction") {
		return { role: "compactionSummary", summary: entry.summary, tokensBefore: entry.tokensBefore, timestamp: new Date(entry.timestamp).getTime() };
	}
	return undefined;
}

/** After a compaction the branch is the compaction summary plus the entries kept after it. */
export function messagesForPlan(branch: SessionEntry[]): AgentMessage[] {
	const compactionIndex = branch.findLastIndex((entry) => entry.type === "compaction");
	if (compactionIndex < 0) return branch.map(entryToMessage).filter((message) => message !== undefined);
	const compaction = branch[compactionIndex];
	const firstKeptIndex = compaction.type === "compaction" ? branch.findIndex((entry) => entry.id === compaction.firstKeptEntryId) : -1;
	const visibleBranch = [compaction, ...(firstKeptIndex >= 0 ? branch.slice(firstKeptIndex, compactionIndex) : []), ...branch.slice(compactionIndex + 1)];
	return visibleBranch.map(entryToMessage).filter((message) => message !== undefined);
}

/** The selected model, or with auto mode on, the real model that answered most recently. */
export function pickPlanWriterModel(ctx: ExtensionContext, messages: AgentMessage[]): Model<Api> | undefined {
	if (ctx.model && ctx.model.provider !== VIRTUAL_PROVIDER) return ctx.model;
	const lastAnswer = messages.findLast((message) => message.role === "assistant" && message.provider !== VIRTUAL_PROVIDER);
	if (lastAnswer?.role !== "assistant") return undefined;
	return ctx.modelRegistry.find(lastAnswer.provider, lastAnswer.model);
}

export async function writeAgreedPlan(
	ctx: ExtensionContext,
	model: Model<Api>,
	messages: AgentMessage[],
	focus: string,
	signal: AbortSignal,
): Promise<string | undefined> {
	const conversation = serializeConversation(convertToLlm(messages));
	const focusSection = focus ? `\n\n## Developer's note on what the plan should cover\n\n${focus}` : "";
	const request: Message = {
		role: "user",
		content: [{ type: "text", text: `## Conversation\n\n${conversation}${focusSection}` }],
		timestamp: Date.now(),
	};
	const response = await ctx.modelRegistry.complete(
		model,
		{ systemPrompt: PLAN_WRITER_SYSTEM_PROMPT, messages: [request] },
		{ signal, cacheRetention: "none", sessionId: uuidv7() },
	);
	if (response.stopReason === "aborted") return undefined;
	if (response.stopReason === "error") throw new Error(`${model.provider}/${model.id} failed to write the plan: ${response.errorMessage ?? "unknown error"}`);
	return response.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n")
		.trim();
}
