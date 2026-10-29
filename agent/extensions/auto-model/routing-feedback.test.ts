import assert from "node:assert/strict";
import { test } from "node:test";
import { shiftTier } from "./difficulty-tiers.ts";
import { correctedTierFromFit, pickCalibrationExamples, raiseToCorrectedTier, type RoutingCorrection } from "./routing-feedback.ts";

function correction(prompt: string, projectDir: string): RoutingCorrection {
	return { prompt, routedTier: "trivial", correctTier: "complex", projectDir, recordedAtIso: "2026-01-01T00:00:00Z" };
}

test("calibration prefers this project's corrections, newest first", () => {
	const stored = [correction("old here", "/repo"), correction("elsewhere", "/other"), correction("new here", "/repo")];
	const prompts = pickCalibrationExamples(stored, "/repo").map((example) => example.prompt);
	assert.deepEqual(prompts, ["new here", "old here", "elsewhere"]);
});

test("calibration is capped so the classifier prompt stays small", () => {
	const stored = Array.from({ length: 20 }, (_, index) => correction(`prompt ${index}`, "/repo"));
	assert.equal(pickCalibrationExamples(stored, "/repo").length, 8);
});

test("a confident too-weak verdict corrects the previous task one tier up, too-strong one tier down", () => {
	assert.equal(correctedTierFromFit("standard", "too_weak", 0.9), "complex");
	assert.equal(correctedTierFromFit("complex", "too_strong", 0.8), "standard");
});

test("records nothing when the tier fit, the verdict is unsure, or the tier cannot move", () => {
	assert.equal(correctedTierFromFit("standard", "right", 0.99), undefined);
	assert.equal(correctedTierFromFit("standard", "too_weak", 0.49), undefined);
	assert.equal(correctedTierFromFit("expert", "too_weak", 0.95), undefined);
	assert.equal(correctedTierFromFit("trivial", "too_strong", 0.95), undefined);
});

test("the follow-up to a weak answer gets at least the corrected tier, never less than its own rating", () => {
	assert.equal(raiseToCorrectedTier("trivial", "complex"), "complex");
	assert.equal(raiseToCorrectedTier("expert", "complex"), "expert");
	assert.equal(raiseToCorrectedTier("standard", undefined), "standard");
});

test("shifting a tier stops at trivial and expert", () => {
	assert.equal(shiftTier("standard", 1), "complex");
	assert.equal(shiftTier("expert", 1), "expert");
	assert.equal(shiftTier("trivial", -1), "trivial");
});
