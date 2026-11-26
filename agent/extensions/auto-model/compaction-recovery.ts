/**
 * Compaction recovery: a context-compression proxy in front of the provider can end a turn with
 * `preflight_compress_failed` when it cannot shrink an oversized context. That is not a model failure;
 * any other model would get the same context. The session is compacted once and the turn continues.
 * Pure decisions and the session entry shape shared with /build; the Pi wiring lives in index.ts.
 */
import type { AssistantMessage } from "@earendil-works/pi-ai";

/** Error code the compression proxy puts in the failed response when its preflight compression failed. */
export const COMPRESSION_FAILURE_CODE = "preflight_compress_failed";
/** One compaction per prompt; a second compression failure means compaction did not help, so stop instead of looping. */
export const MAX_COMPACTION_RECOVERIES_PER_PROMPT = 1;
/** Session entry recording the recovery's progress; /build helpers read it to tell a paused turn from a final one. */
export const COMPACTION_RECOVERY_ENTRY_TYPE = "auto-model-compaction-recovery";
/** The message that restarts the turn after the compaction. */
export const COMPACTION_CONTINUE_MESSAGE_TYPE = "auto-model-compaction-continue";
export const CONTINUE_AFTER_COMPACTION_PROMPT =
	"Your previous response failed because the conversation was too large to send, so the session was compacted. " +
	"Continue the task where you left off. Do not repeat work that is already done.";

/**
 * compacting: the failed response is hidden and compaction starts once the run settles.
 * continued: compaction finished and the turn was restarted.
 * failed: compaction failed, the run was aborted, or compression failed again; `reason` is the error shown to the user.
 */
export type CompactionRecoveryEntryData =
	| { status: "compacting" }
	| { status: "continued" }
	| { status: "failed"; reason: string };

export type CompactionRecoveryStatus = CompactionRecoveryEntryData["status"];

export type CompactionRecoveryDecision =
	| { kind: "not-compression-failure" }
	| { kind: "compact"; notice: string }
	| { kind: "give-up"; error: string };

export function isCompressionFailure(response: AssistantMessage): boolean {
	return response.stopReason === "error" && response.errorMessage?.includes(COMPRESSION_FAILURE_CODE) === true;
}

export function decideCompactionRecovery(response: AssistantMessage, recoveriesThisPrompt: number): CompactionRecoveryDecision {
	if (!isCompressionFailure(response)) return { kind: "not-compression-failure" };
	const detail = compressionFailureDetail(response.errorMessage ?? "");
	if (recoveriesThisPrompt >= MAX_COMPACTION_RECOVERIES_PER_PROMPT) {
		return {
			kind: "give-up",
			error: `Auto model: context compression failed again after an automatic compaction (${detail}); stopped. Run /compact, then continue`,
		};
	}
	return { kind: "compact", notice: `Auto model: context compression failed (${detail}); compacting the session, then continuing` };
}

function compressionFailureDetail(errorMessage: string): string {
	const firstLine = errorMessage.split(/\r?\n/, 1)[0].trim();
	const statusAndJson = /^\d+\s+(\{.*\})$/.exec(firstLine);
	if (statusAndJson) {
		try {
			const envelope: unknown = JSON.parse(statusAndJson[1]);
			if (typeof envelope === "object" && envelope !== null && !Array.isArray(envelope)) {
				const error = (envelope as { error?: unknown }).error;
				if (typeof error === "object" && error !== null && !Array.isArray(error)) {
					const message = (error as { message?: unknown }).message;
					if (typeof message === "string" && message.trim()) return message.trim().slice(0, 160);
				}
			}
		} catch {
			// The original first line is still useful when the proxy response is not valid JSON.
		}
	}
	return (firstLine || "unknown error").slice(0, 160);
}

export function compactionFailedError(error: Error): string {
	return `Auto model: compaction after the failed context compression failed (${error.message || "unknown error"}); run /compact, then continue`;
}

export function readCompactionRecoveryEntry(entry: unknown): CompactionRecoveryEntryData | undefined {
	if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return undefined;
	const sessionEntry = entry as { type?: unknown; customType?: unknown; data?: unknown };
	if (sessionEntry.type !== "custom" || sessionEntry.customType !== COMPACTION_RECOVERY_ENTRY_TYPE) return undefined;
	if (typeof sessionEntry.data !== "object" || sessionEntry.data === null || Array.isArray(sessionEntry.data)) return undefined;

	const data = sessionEntry.data as { status?: unknown; reason?: unknown };
	if (data.status === "compacting" || data.status === "continued") return { status: data.status };
	if (data.status === "failed" && typeof data.reason === "string") return { status: "failed", reason: data.reason };
	return undefined;
}
