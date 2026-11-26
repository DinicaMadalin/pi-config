import assert from "node:assert/strict";
import { test } from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	COMPACTION_RECOVERY_ENTRY_TYPE,
	compactionFailedError,
	decideCompactionRecovery,
	isCompressionFailure,
	MAX_COMPACTION_RECOVERIES_PER_PROMPT,
	readCompactionRecoveryEntry,
} from "./compaction-recovery.ts";

const PROXY_503 =
	'503 {"error":{"type":"server_error","code":"preflight_compress_failed","message":"context ~301227 tokens exceeds the model window 200000 (model=claude-opus-5-5), with 11 compressible range(s) still visible and preflight compression could not bring it under","retryable":false}}';
const PROXY_413 =
	'413 {"error":{"type":"server_error","code":"preflight_compress_failed","message":"payload core text alone is ~2570486 bytes","retryable":false}}';

function response(stopReason: string, errorMessage: string | undefined): AssistantMessage {
	return {
		role: "assistant",
		provider: "anthropic",
		model: "claude-opus-5-5",
		stopReason,
		errorMessage,
		content: [],
	} as unknown as AssistantMessage;
}

test("a failed response carrying the proxy's preflight_compress_failed code is a compression failure", () => {
	assert.equal(isCompressionFailure(response("error", PROXY_503)), true);
	assert.equal(isCompressionFailure(response("error", PROXY_413)), true);
});

test("other errors, missing error text and completed responses are not compression failures", () => {
	assert.equal(isCompressionFailure(response("error", '429 {"type":"error","error":{"type":"rate_limit_error","message":"Error"}}')), false);
	assert.equal(isCompressionFailure(response("error", undefined)), false);
	assert.equal(isCompressionFailure(response("stop", "preflight_compress_failed")), false);
});

test("the first compression failure of a prompt compacts and names the proxy's reason without its JSON", () => {
	const decision = decideCompactionRecovery(response("error", PROXY_503), 0);
	assert.equal(decision.kind, "compact");
	if (decision.kind !== "compact") return;
	assert.match(decision.notice, /^Auto model: context compression failed \(context ~301227 tokens exceeds the model window 200000/);
	assert.match(decision.notice, /\); compacting the session, then continuing$/);
	assert.doesNotMatch(decision.notice, /[{}]/);
});

test("a second compression failure in the same prompt stops with a visible error instead of looping", () => {
	const decision = decideCompactionRecovery(response("error", PROXY_503), MAX_COMPACTION_RECOVERIES_PER_PROMPT);
	assert.equal(decision.kind, "give-up");
	if (decision.kind !== "give-up") return;
	assert.match(decision.error, /^Auto model: context compression failed again after an automatic compaction \(context ~301227/);
	assert.match(decision.error, /\); stopped\. Run \/compact, then continue$/);
});

test("the detail is cut to 160 characters, and an unparsable error falls back to its first line", () => {
	const longMessage = "x".repeat(400);
	const longDecision = decideCompactionRecovery(
		response("error", `503 {"error":{"code":"preflight_compress_failed","message":"${longMessage}"}}`),
		0,
	);
	assert.equal(longDecision.kind === "compact" && longDecision.notice.includes(`(${"x".repeat(160)})`), true);
	const plainDecision = decideCompactionRecovery(response("error", "proxy said preflight_compress_failed\nsecond line"), 0);
	assert.equal(plainDecision.kind === "compact" && plainDecision.notice.includes("(proxy said preflight_compress_failed)"), true);
});

test("errors that are not compression failures are left to the failover", () => {
	assert.equal(decideCompactionRecovery(response("error", "overloaded_error"), 0).kind, "not-compression-failure");
	assert.equal(decideCompactionRecovery(response("stop", undefined), 0).kind, "not-compression-failure");
});

test("a failed compaction names the failed action and how to recover by hand", () => {
	assert.equal(
		compactionFailedError(new Error("Nothing to compact (session too small)")),
		"Auto model: compaction after the failed context compression failed (Nothing to compact (session too small)); run /compact, then continue",
	);
	assert.equal(
		compactionFailedError(new Error("")),
		"Auto model: compaction after the failed context compression failed (unknown error); run /compact, then continue",
	);
});

test("recovery entries of a session file are read with their status", () => {
	const entry = (data: unknown) => ({ type: "custom", id: "a1", customType: COMPACTION_RECOVERY_ENTRY_TYPE, data });
	assert.deepEqual(readCompactionRecoveryEntry(entry({ status: "compacting" })), { status: "compacting" });
	assert.deepEqual(readCompactionRecoveryEntry(entry({ status: "continued", extra: 1 })), { status: "continued" });
	assert.deepEqual(readCompactionRecoveryEntry(entry({ status: "failed", reason: "boom" })), { status: "failed", reason: "boom" });
});

test("anything else is not a recovery entry", () => {
	assert.equal(readCompactionRecoveryEntry({ type: "custom", customType: "auto-model-route", data: { status: "compacting" } }), undefined);
	assert.equal(readCompactionRecoveryEntry({ type: "custom_message", customType: COMPACTION_RECOVERY_ENTRY_TYPE, data: { status: "compacting" } }), undefined);
	assert.equal(readCompactionRecoveryEntry({ type: "custom", customType: COMPACTION_RECOVERY_ENTRY_TYPE, data: { status: "failed" } }), undefined);
	assert.equal(readCompactionRecoveryEntry({ type: "custom", customType: COMPACTION_RECOVERY_ENTRY_TYPE, data: { status: "done" } }), undefined);
	assert.equal(readCompactionRecoveryEntry({ type: "custom", customType: COMPACTION_RECOVERY_ENTRY_TYPE }), undefined);
	assert.equal(readCompactionRecoveryEntry(null), undefined);
	assert.equal(readCompactionRecoveryEntry("compacting"), undefined);
	assert.equal(readCompactionRecoveryEntry([]), undefined);
});
