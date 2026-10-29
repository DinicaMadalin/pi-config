/**
 * Failover policy: when a routed model fails and Pi will not retry it, bench that model for a
 * while and resend the request so the router picks the next model of the tier.
 * Pure state and decisions; the Pi wiring lives in index.ts.
 */
import type { AssistantMessage } from "@earendil-works/pi-ai";

/** Rides out a short outage or rate limit without locking a good model out for long. */
export const BENCH_DURATION_MS = 5 * 60_000;
/** Each failover tries one more model; two keeps a broken provider list from looping. */
export const MAX_FAILOVERS_PER_PROMPT = 2;
const MAX_ERROR_CHARS_IN_NOTICE = 160;

/** Models that failed recently, by "provider/id"; the router skips them until the bench expires. */
export class BenchedModels {
	private readonly benchedUntilMsByKey = new Map<string, number>();

	bench(modelKey: string, nowMs: number): void {
		this.benchedUntilMsByKey.set(modelKey, nowMs + BENCH_DURATION_MS);
	}

	isBenched(modelKey: string, nowMs: number): boolean {
		const benchedUntilMs = this.benchedUntilMsByKey.get(modelKey);
		if (benchedUntilMs === undefined) return false;
		if (benchedUntilMs > nowMs) return true;
		this.benchedUntilMsByKey.delete(modelKey);
		return false;
	}
}

export type FailoverDecision =
	| { kind: "fail-over"; failedModelKey: string; notice: string }
	| { kind: "give-up"; reason: string };

/**
 * Decides whether a failed response should move to another model.
 * Context overflow is excluded: compaction handles it, and another model would overflow too.
 */
export function decideFailover(
	failedResponse: AssistantMessage,
	failoversThisPrompt: number,
	isContextOverflow: boolean,
): FailoverDecision {
	if (failedResponse.stopReason !== "error") return { kind: "give-up", reason: "response did not fail" };
	if (isContextOverflow) return { kind: "give-up", reason: "context overflow is handled by compaction" };
	if (failoversThisPrompt >= MAX_FAILOVERS_PER_PROMPT) {
		return { kind: "give-up", reason: `already failed over ${failoversThisPrompt} times for this prompt` };
	}
	const failedModelKey = `${failedResponse.provider}/${failedResponse.model}`;
	const shortError = (failedResponse.errorMessage ?? "unknown error").split("\n")[0].slice(0, MAX_ERROR_CHARS_IN_NOTICE);
	return {
		kind: "fail-over",
		failedModelKey,
		notice: `Auto model: ${failedModelKey} failed (${shortError}); retrying on the next model of the tier`,
	};
}
