import assert from "node:assert/strict";
import { test } from "node:test";
import { type GaugeEntry, readSessionGauge } from "./session-gauge.ts";

const answer = (model: string, costUsd: number, thinkingLevel = "high"): GaugeEntry => ({
	type: "message",
	message: { role: "assistant", model, thinkingLevel, usage: { cost: { total: costUsd } } },
});
const route = (tier: string): GaugeEntry => ({ type: "custom", customType: "auto-model-route", data: { tier, reason: "rated" } });

test("under the auto model it shows the model that answered last and the tier it was routed to", () => {
	const entries = [route("trivial"), answer("deepseek-v4.1-flash", 0.01, "low"), route("complex"), answer("claude-opus-5-5", 0.5)];
	const gauge = readSessionGauge(entries, { provider: "auto", id: "auto", thinkingLevel: "medium" }, 34.4);
	assert.deepEqual(gauge, { costUsd: 0.51, contextPercent: 34.4, model: "claude-opus-5-5", thinkingLevel: "high", tier: "complex" });
});

test("a model picked by hand is shown as picked, without a tier", () => {
	const gauge = readSessionGauge([route("complex"), answer("claude-opus-5-5", 1)], { provider: "openai", id: "gpt-6-luna", thinkingLevel: "medium" }, null);
	assert.deepEqual(gauge, { costUsd: 1, contextPercent: undefined, model: "gpt-6-luna", thinkingLevel: "medium", tier: undefined });
});

test("a new session under the auto model has no model or cost yet", () => {
	assert.deepEqual(readSessionGauge([], { provider: "auto", id: "auto", thinkingLevel: "medium" }, 0), {
		costUsd: 0,
		contextPercent: 0,
		model: undefined,
		thinkingLevel: undefined,
		tier: undefined,
	});
});
