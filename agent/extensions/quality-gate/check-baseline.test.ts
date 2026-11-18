import assert from "node:assert/strict";
import { test } from "node:test";
import { type CheckResult, describeNewCheckFailures, findNewCheckFailures, outputMentionsChangedFile } from "./check-baseline.ts";

function passed(name: string): CheckResult {
	return { name, command: `npm run ${name}`, passed: true, outputTail: "" };
}

function failed(name: string, outputTail: string): CheckResult {
	return { name, command: `npm run ${name}`, passed: false, outputTail };
}

test("a failure naming a changed file, by path or file name, belongs to the run's work", () => {
	assert.equal(outputMentionsChangedFile("src/cart.ts(3,1): error TS2322", ["src/cart.ts"]), true);
	assert.equal(outputMentionsChangedFile("FAIL cart.test.ts", ["src/cart.test.ts"]), true);
	assert.equal(outputMentionsChangedFile("src/legacy.ts(9,1): error TS2322", ["src/cart.ts"]), false);
	assert.equal(outputMentionsChangedFile("anything", []), false);
});

test("a check that passed at the baseline and fails now is a new failure", () => {
	assert.deepEqual(findNewCheckFailures([passed("lint")], [failed("lint", "src/a.ts: x")], []), [failed("lint", "src/a.ts: x")]);
});

test("without a baseline every failing check is new", () => {
	assert.deepEqual(findNewCheckFailures([], [failed("test", "boom"), passed("lint")], []), [failed("test", "boom")]);
});

test("a check that already failed reports only its new lines that name a changed file", () => {
	const baseline = [failed("lint", "old.ts: e1")];
	const current = [failed("lint", "old.ts: e1\n\n  src/a.ts: e2  ")];
	assert.deepEqual(findNewCheckFailures(baseline, current, ["src/a.ts"]), [failed("lint", "src/a.ts: e2")]);
});

test("a check that already failed with only noise in its new lines is not new", () => {
	const baseline = [failed("lint", "old.ts: e1")];
	assert.deepEqual(findNewCheckFailures(baseline, [failed("lint", "old.ts: e1\nDone in 3.2s")], ["src/a.ts"]), []);
});

test("passing checks are never reported and the inputs stay untouched", () => {
	const baseline = [failed("typecheck", "x")];
	const current = [passed("typecheck"), failed("test", "src/a.ts broke")];
	const currentCopy = structuredClone(current);
	assert.deepEqual(findNewCheckFailures(baseline, current, ["src/a.ts"]), [failed("test", "src/a.ts broke")]);
	assert.deepEqual(current, currentCopy);
});

test("new failures read as one block per check with its output fenced", () => {
	assert.equal(describeNewCheckFailures([]), "");
	assert.equal(
		describeNewCheckFailures([failed("lint", "src/a.ts: e2"), failed("test", "boom")]),
		"`npm run lint` (lint) fails:\n```\nsrc/a.ts: e2\n```\n\n`npm run test` (test) fails:\n```\nboom\n```",
	);
});
