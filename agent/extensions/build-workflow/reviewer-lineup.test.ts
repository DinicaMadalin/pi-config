import assert from "node:assert/strict";
import { test } from "node:test";
import { pickReviewerLineup } from "./reviewer-lineup.ts";

test("a single reviewer: the vendor of the first logged-in complex model, in the configured order", () => {
	const available = new Set(["anthropic/opus", "openai/sol"]);
	assert.deepEqual(pickReviewerLineup(["anthropic/opus", "openai/sol"], available), { ok: true, vendors: ["anthropic"] });
	assert.deepEqual(pickReviewerLineup(["openai/sol", "anthropic/opus"], available), { ok: true, vendors: ["openai"] });
});

test("falls back to the other vendor when the first configured model is not logged in", () => {
	assert.deepEqual(pickReviewerLineup(["anthropic/opus", "openai/sol"], new Set(["openai/sol"])), { ok: true, vendors: ["openai"] });
	assert.deepEqual(pickReviewerLineup(["opencode-go/glm", "openai/sol"], new Set(["opencode-go/glm", "openai/sol"])), { ok: true, vendors: ["openai"] });
});

test("no usable Claude or OpenAI complex model is a clear error, whatever else is available", () => {
	const lineup = pickReviewerLineup(["anthropic/opus", "opencode-go/glm"], new Set(["opencode-go/glm"]));
	assert.equal(lineup.ok, false);
	if (lineup.ok) return;
	assert.match(lineup.error, /^No expert-tier reviewer model is available: none of anthropic\/opus, opencode-go\/glm is logged in\. Log in to Anthropic or OpenAI with \/login/);
	assert.match(lineup.error, /"expert" tier in .*auto-model\.json$/);
});

test("an empty expert tier says no models are configured", () => {
	const lineup = pickReviewerLineup([], new Set());
	assert.equal(lineup.ok, false);
	if (!lineup.ok) assert.match(lineup.error, /none of \(no models configured\) is logged in/);
});
