import assert from "node:assert/strict";
import { test } from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import { applyQualityBias, applyThinkingFloor, DEFAULT_TIER_POLICIES, pickModelForTier, preferProvider, type TierPolicy } from "./difficulty-tiers.ts";

function fakeModel(provider: string, id: string, outputPrice: number, readsImages = true): Model<Api> {
	return {
		provider,
		id,
		input: readsImages ? ["text", "image"] : ["text"],
		cost: { input: 0, output: outputPrice, cacheRead: 0, cacheWrite: 0 },
	} as unknown as Model<Api>;
}

const cheap = fakeModel("a", "cheap", 1);
const middle = fakeModel("b", "middle", 10, false);
const strong = fakeModel("a", "strong", 50);
const policy: TierPolicy = { models: ["x/not-logged-in", "b/middle", "a/strong"], thinkingLevel: "medium" };

test("picks the first logged-in preferred model, skipping ones not logged in", () => {
	assert.equal(pickModelForTier([cheap, middle, strong], policy, "standard", false)?.model, middle);
});

test("skips preferred models that cannot read an attached image", () => {
	const choice = pickModelForTier([cheap, middle, strong], policy, "standard", true);
	assert.equal(choice?.model, strong);
	assert.equal(choice?.source, "preferred");
});

test("falls back to price rank when no preferred model is logged in", () => {
	const noneLoggedIn: TierPolicy = { models: ["x/missing"], thinkingLevel: "low" };
	assert.equal(pickModelForTier([strong, cheap, middle], noneLoggedIn, "trivial", false)?.model, cheap);
	assert.equal(pickModelForTier([strong, cheap, middle], noneLoggedIn, "expert", false)?.model, strong);
	assert.equal(pickModelForTier([strong, cheap, middle], noneLoggedIn, "expert", false)?.source, "price-rank");
});

test("returns nothing when no model is logged in", () => {
	assert.equal(pickModelForTier([], policy, "complex", false), undefined);
});

test("quality bias shifts one tier and clamps at the ends", () => {
	assert.equal(applyQualityBias("standard", "low"), "trivial");
	assert.equal(applyQualityBias("standard", "medium"), "standard");
	assert.equal(applyQualityBias("complex", "high"), "expert");
	assert.equal(applyQualityBias("trivial", "low"), "trivial");
	assert.equal(applyQualityBias("expert", "high"), "expert");
});

test("raises thinking below the tier floor and keeps levels at or above it", () => {
	const flooredPolicy: TierPolicy = { ...policy, minThinkingLevel: "medium" };
	assert.equal(applyThinkingFloor("low", flooredPolicy), "medium");
	assert.equal(applyThinkingFloor("minimal", flooredPolicy), "medium");
	assert.equal(applyThinkingFloor("medium", flooredPolicy), "medium");
	assert.equal(applyThinkingFloor("high", flooredPolicy), "high");
	assert.equal(applyThinkingFloor("low", policy), "low");
});

test("the expert tier thinks at least high and may go to xhigh", () => {
	assert.equal(applyThinkingFloor("medium", DEFAULT_TIER_POLICIES.expert), "high");
	assert.equal(applyThinkingFloor("xhigh", DEFAULT_TIER_POLICIES.expert), "xhigh");
});

test("preferring a provider tries its models first and keeps the others as fallbacks", () => {
	const expert: TierPolicy = { models: ["openai/gpt-6-astra", "openai/gpt-6.1-sol", "anthropic/claude-opus-5-5"], thinkingLevel: "high" };
	assert.deepEqual(preferProvider(expert, "anthropic").models, ["anthropic/claude-opus-5-5", "openai/gpt-6-astra", "openai/gpt-6.1-sol"]);
	assert.deepEqual(preferProvider(expert, "openai").models, expert.models);
	assert.deepEqual(preferProvider(expert, "xai").models, expert.models);
});
