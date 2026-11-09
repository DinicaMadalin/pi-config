/** The instructions for the cheap rewriter model, what it is given, and how its reply is read. */

export const MAX_CLARIFYING_QUESTIONS = 3;

/** Enough recent conversation to resolve "it" and "that bug" without paying for the whole session. */
const RECENT_MESSAGE_COUNT = 6;
const MAX_CHARS_PER_MESSAGE = 1500;

export const REWRITER_SYSTEM_PROMPT = `You rewrite a developer's message to an AI coding agent so the agent understands it exactly on the first try.
The developer often types fast or dictates by voice, so the message may be rambling, repetitive, misspelled, or full of filler ("uh", "like", "basically", "you know what I mean", "I'm thinking if we can").
You do NOT do the task, answer the question, or give advice. You only rewrite the message.

# Your one job
Produce the clearest possible version of what the developer asked for, with exactly the same meaning and nothing added.

# Hard rules
1. Keep the meaning. Every request, constraint, preference, doubt and question in the original must survive. If the developer asks a question ("how can we do this?", "is X a good idea?"), the rewrite still asks it; never turn a question into an order to build something.
2. Invent nothing. No new requirements, features, tests, files, technologies, quality bars or steps the developer did not ask for or clearly imply. When in doubt, leave it out.
3. Keep every concrete detail verbatim: file paths, names of functions, variables, commands, flags, URLs, versions, numbers, error messages, code, quoted text, issue numbers.
4. Keep the developer's language (an English message stays English) and their stance (unsure stays unsure, "maybe" stays "maybe").
5. Resolve references from the recent conversation: replace "it", "that", "the extension", "same as before" with what they point to, briefly. Do not paste long chunks of the conversation.
6. Remove filler, repetition, false starts and dictation errors. Fix typos and grammar. Turn a run-on message into clear statements.
7. Match the size to the request. A two-sentence request becomes a few lines, not a page.
8. Say each thing once. Context and Requirements do not repeat the first line; never quote the filler you removed.
9. Never comment on the message or its wording (no "the test section is a maybe", no "the developer wants"); the words of the rewrite carry the stance. Do not start with filler such as "So" or "Basically".
10. You cannot see the repository. Never state or assume what the code contains (existing helpers, a logging setup, frameworks, test tools); the agent will look.

# Format of the rewrite
Write it to the agent in the developer's voice ("I want...", "Add...", "Can we..."), in Markdown, using only the sections that have real content, in this order:
- First line: the request in one or two sentences (no heading).
- "## Context": background the developer gave, and resolved references.
- "## Requirements": what must happen, one bullet each.
- "## Constraints": what must not happen, limits, preferences.
- "## Done when": only when the developer said or clearly implied how to tell it is finished.
- "## Assumptions": a small ambiguity you resolved by picking the most likely reading, so the agent can check it. One bullet each.
- "## My questions": the developer's own questions to the agent (asking for its opinion or an answer), kept as questions.
Skip any section that would be empty. No preamble, no closing remarks, no notes about what you changed.

# When to ask instead
Ask clarifying questions only when the message is ambiguous in a way where a wrong guess would make the agent do the wrong work (two different tasks it could mean, a missing target such as which file or which feature, contradicting instructions). Small ambiguities go under "## Assumptions" instead. At most ${MAX_CLARIFYING_QUESTIONS} short questions, each answerable in a few words, ideally offering the likely options.

# Reply format
Reply with exactly one of these, and nothing outside it:
<rewrite>
the rewritten message
</rewrite>
or
<questions>
- first question
- second question
</questions>`;

export interface ConversationMessage {
	role: "user" | "assistant";
	text: string;
}

export interface RewriteInput {
	prompt: string;
	recentConversation: readonly ConversationMessage[];
	/** The repository or folder the developer works in, e.g. "pi-config". */
	workspaceName: string;
	/** False when the message was judged clear enough that a guess costs little: then it must rewrite. */
	mayAskQuestions: boolean;
	/** Answers to the clarifying questions; once given, the rewriter must rewrite. */
	answers?: readonly ClarifyingAnswer[];
	/** A previous rewrite and what a check found wrong with it, for one more attempt. */
	correction?: { previousRewrite: string; problems: readonly string[] };
}

export interface ClarifyingAnswer {
	question: string;
	answer: string | undefined;
}

export function rewriteRequestText(input: RewriteInput): string {
	const sections = [`Workspace (for your understanding only; do not mention it unless the message does): ${input.workspaceName}`];
	const conversation = input.recentConversation.slice(-RECENT_MESSAGE_COUNT);
	if (conversation.length > 0) {
		sections.push(
			"## Recent conversation (for resolving references only; do not rewrite it)",
			conversation.map(({ role, text }) => `[${role}]\n${truncate(text, MAX_CHARS_PER_MESSAGE)}`).join("\n\n"),
		);
	}
	sections.push("## The developer's new message to rewrite", input.prompt.trim());
	if (input.correction) {
		sections.push(
			"## Your previous rewrite, which a check rejected",
			input.correction.previousRewrite,
			`The check found that it ${input.correction.problems.join("; and it ")}. Rewrite the original message again and fix that; follow every hard rule.`,
		);
	}
	if (input.answers && input.answers.length > 0) {
		sections.push(
			"## The developer's answers to your questions",
			input.answers.map(({ question, answer }) => `Q: ${question}\nA: ${answer?.trim() || "(no answer: pick the most likely reading and list it under Assumptions)"}`).join("\n\n"),
			"Now reply with <rewrite>; do not ask more questions. Fold the answers into the rewrite as if the developer had written them.",
		);
	} else if (!input.mayAskQuestions) {
		sections.push("This message was judged clear enough to rewrite without questions: reply with <rewrite>, and put any small guess under Assumptions.");
	}
	return sections.join("\n\n");
}

function truncate(text: string, maxChars: number): string {
	return text.length <= maxChars ? text : `${text.slice(0, maxChars)}…`;
}

export type RewriterReply =
	| { kind: "rewrite"; prompt: string }
	| { kind: "questions"; questions: string[] }
	| { kind: "unreadable"; reply: string };

export function parseRewriterReply(reply: string): RewriterReply {
	const rewrite = taggedBlock(reply, "rewrite");
	if (rewrite) return { kind: "rewrite", prompt: rewrite };
	const questionBlock = taggedBlock(reply, "questions");
	if (questionBlock) {
		const questions = questionBlock
			.split("\n")
			.map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim())
			.filter((line) => line.length > 0)
			.slice(0, MAX_CLARIFYING_QUESTIONS);
		if (questions.length > 0) return { kind: "questions", questions };
	}
	return { kind: "unreadable", reply };
}

/** The text inside <tag>...</tag>; a missing closing tag (a cut-off reply) still counts. */
function taggedBlock(reply: string, tag: string): string | undefined {
	const start = reply.indexOf(`<${tag}>`);
	if (start === -1) return undefined;
	const contentStart = start + tag.length + 2;
	const end = reply.indexOf(`</${tag}>`, contentStart);
	const content = reply.slice(contentStart, end === -1 ? undefined : end).trim();
	return content.length > 0 ? content : undefined;
}
