import assert from "node:assert/strict";
import { test } from "node:test";
import { describeTierBasis } from "./route-decision.ts";

test("explains a rated tier with its confidence", () => {
	const reason = describeTierBasis({ kind: "rated", ratedTier: "complex", confidence: 0.784 }, "complex");
	assert.equal(reason, "rated complex (78%): multi-file or tricky change");
});

test("mentions the routed tier when learning or quality bias moved it", () => {
	const reason = describeTierBasis({ kind: "rated", ratedTier: "standard", confidence: 0.6 }, "complex");
	assert.equal(reason, "rated standard (60%): ordinary change in a few files, routed to complex");
});

test("explains important tasks and pinned phases", () => {
	assert.equal(
		describeTierBasis({ kind: "important-task", taskKind: "code_review" }, "expert"),
		"code review always goes to the expert tier",
	);
	assert.equal(describeTierBasis({ kind: "pinned" }, "expert"), "workflow phase pinned to the expert tier");
});
