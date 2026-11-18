import assert from "node:assert/strict";
import { test } from "node:test";
import { pickReviewerLineup } from "./reviewer-lineup.ts";

test("both vendors with a usable complex model each get a reviewer, Claude first", () => {
	const available = new Set(["anthropic/opus", "openai/sol"]);
	assert.deepEqual(pickReviewerLineup(["anthropic/opus", "openai/sol"], available), { ok: true, vendors: ["anthropic", "openai"] });
	assert.deepEqual(pickReviewerLineup(["openai/sol", "anthropic/opus"], available), { ok: true, vendors: ["anthropic", "openai"] });
});

test("only the vendor with a usable complex model reviews", () => {
	assert.deepEqual(pickReviewerLineup(["anthropic/opus", "openai/sol"], new Set(["openai/sol"])), { ok: true, vendors: ["openai"] });
	assert.deepEqual(pickReviewerLineup(["anthropic/opus", "openai/sol"], new Set(["anthropic/opus", "openai/other"])), { ok: true, vendors: ["anthropic"] });
});

test("no usable Claude or OpenAI complex model is a clear error, whatever else is available", () => {
	const lineup = pickReviewerLineup(["anthropic/opus", "opencode-go/glm"], new Set(["opencode-go/glm"]));
	assert.equal(lineup.ok, false);
	if (lineup.ok) return;
	assert.match(lineup.error, /^No complex-tier reviewer model is available: none of anthropic\/opus, opencode-go\/glm is logged in\. Log in to Anthropic or OpenAI with \/login/);
	assert.match(lineup.error, /"complex" tier in .*auto-model\.json$/);
});

test("an empty complex tier says no models are configured", () => {
	const lineup = pickReviewerLineup([], new Set());
	assert.equal(lineup.ok, false);
	if (!lineup.ok) assert.match(lineup.error, /none of \(no models configured\) is logged in/);
});
