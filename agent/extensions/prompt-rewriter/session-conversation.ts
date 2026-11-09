import type { ConversationMessage } from "./rewriter-prompt.ts";

/** The slice of a session entry this module reads; Pi's SessionEntry fits it. */
interface BranchEntry {
	type: string;
	message?: { role: string; content?: unknown };
}

/** The user and assistant text of the branch, oldest first; tool calls, tool results and thinking are left out. */
export function conversationOf(branchEntries: readonly BranchEntry[]): ConversationMessage[] {
	const conversation: ConversationMessage[] = [];
	for (const entry of branchEntries) {
		if (entry.type !== "message" || !entry.message) continue;
		const { role, content } = entry.message;
		if (role !== "user" && role !== "assistant") continue;
		const text = textOf(content).trim();
		if (text) conversation.push({ role, text });
	}
	return conversation;
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block): block is { type: "text"; text: string } => block?.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("\n");
}
