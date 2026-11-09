/** Which typed messages are worth rewriting: a quick reply or a command is sent as typed. */

/** Below this many words a message is a reply ("yes", "go with 2"), not a task description. */
export const MIN_WORDS_TO_REWRITE = 8;

/** A prompt with this many markdown headings is already structured. */
const STRUCTURED_HEADING_COUNT = 2;

export type RewriteDecision = { kind: "rewrite" } | { kind: "skip"; reason: string };

export function decideRewrite(text: string): RewriteDecision {
	const trimmed = text.trim();
	if (trimmed.startsWith("/")) return { kind: "skip", reason: "a command" };
	if (trimmed.startsWith("!")) return { kind: "skip", reason: "a shell command" };
	if (countWords(trimmed) < MIN_WORDS_TO_REWRITE) return { kind: "skip", reason: "a short reply" };
	if (countHeadings(trimmed) >= STRUCTURED_HEADING_COUNT) return { kind: "skip", reason: "already structured" };
	return { kind: "rewrite" };
}

function countWords(text: string): number {
	return text.split(/\s+/).filter((word) => /\w/.test(word)).length;
}

function countHeadings(text: string): number {
	return text.split("\n").filter((line) => /^#{1,4} \S/.test(line)).length;
}
