import assert from "node:assert/strict";
import { test } from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { BENCH_DURATION_MS, BenchedModels, decideFailover, MAX_FAILOVERS_PER_PROMPT } from "./model-failover.ts";

function failedResponse(errorMessage: string): AssistantMessage {
	return {
		role: "assistant",
		provider: "cursor",
		model: "composer-2.5",
		stopReason: "error",
		errorMessage,
		content: [],
	} as unknown as AssistantMessage;
}

test("fails over a non-retried error and names the failed model", () => {
	const decision = decideFailover(failedResponse("Cursor repeatedly requested disabled local tools"), 0, false);
	assert.equal(decision.kind, "fail-over");
	assert.equal(decision.kind === "fail-over" && decision.failedModelKey, "cursor/composer-2.5");
});

test("never fails over a context overflow, compaction owns that", () => {
	assert.equal(decideFailover(failedResponse("prompt is too long"), 0, true).kind, "give-up");
});

test("stops after the per-prompt failover limit so a broken tier cannot loop", () => {
	assert.equal(decideFailover(failedResponse("boom"), MAX_FAILOVERS_PER_PROMPT, false).kind, "give-up");
});

test("ignores responses that did not fail", () => {
	const completed = { ...failedResponse(""), stopReason: "stop" } as AssistantMessage;
	assert.equal(decideFailover(completed, 0, false).kind, "give-up");
});

test("a benched model comes back once the bench expires", () => {
	const benched = new BenchedModels();
	benched.bench("cursor/composer-2.5", 1_000);
	assert.equal(benched.isBenched("cursor/composer-2.5", 1_000 + BENCH_DURATION_MS - 1), true);
	assert.equal(benched.isBenched("cursor/composer-2.5", 1_000 + BENCH_DURATION_MS), false);
	assert.equal(benched.isBenched("opencode-go/gpt-6-luna", 1_000), false);
});
