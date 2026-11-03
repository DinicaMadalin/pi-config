import assert from "node:assert/strict";
import { test } from "node:test";
import { checkFailureMessage, outputMentionsChangedFile } from "./check-failure-report.ts";

test("a failure naming a changed file is the agent's to fix", () => {
	assert.equal(outputMentionsChangedFile("src/cart.ts(3,1): error TS2322", ["src/cart.ts"]), true);
	assert.equal(outputMentionsChangedFile("FAIL cart.test.ts", ["src/cart.test.ts"]), true);
	assert.equal(outputMentionsChangedFile("src/legacy.ts(9,1): error TS2322", ["src/cart.ts"]), false);
});

test("tells the agent to report pre-existing errors instead of fixing them unless asked", () => {
	const message = checkFailureMessage({ description: "`npm run lint` (lint) exited with code 1", outputTail: "src/legacy.ts: error", changedFiles: ["src/cart.ts"] });
	assert.ok(message.includes("Files changed in this prompt: src/cart.ts."));
	assert.ok(message.includes("may have been in the repo before your changes"));
	assert.ok(message.includes("do not fix them unless I asked you to"));
	assert.ok(message.includes("Pre-existing problems"));
});

test("does not call a failure pre-existing when it names a changed file", () => {
	const message = checkFailureMessage({ description: "tsc", outputTail: "src/cart.ts: error", changedFiles: ["src/cart.ts"] });
	assert.ok(!message.includes("may have been in the repo"));
});
