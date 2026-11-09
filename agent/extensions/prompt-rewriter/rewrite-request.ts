import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * Lets another extension (build-workflow's /build) have a task rewritten: extension commands never reach the input
 * event, so they ask over pi.events. Without prompt-rewriter loaded, nobody answers and the text goes as typed.
 */
export const REWRITE_REQUEST_EVENT = "prompt-rewriter:rewrite";

export type RewriteOutcome = { kind: "send"; text: string } | { kind: "cancelled" };

export interface RewriteRequest {
	readonly text: string;
	readonly ctx: ExtensionContext;
	/** Set by prompt-rewriter while handling the event. */
	outcome?: Promise<RewriteOutcome>;
}

interface EventEmitter {
	emit(channel: string, data: unknown): void;
}

export async function requestRewrite(events: EventEmitter, text: string, ctx: ExtensionContext): Promise<RewriteOutcome> {
	const request: RewriteRequest = { text, ctx };
	events.emit(REWRITE_REQUEST_EVENT, request);
	return (await request.outcome) ?? { kind: "send", text };
}
