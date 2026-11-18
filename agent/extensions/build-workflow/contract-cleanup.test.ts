import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { applyContractCleanup, prepareContractCleanup, removeBuildContracts } from "./contract-cleanup.ts";

const CONTRACTED_SOURCE = [
	"// @handoff-contract begin",
	"// Sums line totals in cents; an empty cart is 0.",
	"// @handoff-contract end",
	"export function cartTotalCents(lines: number[]): number {",
	"\treturn lines.reduce((sum, cents) => sum + cents, 0);",
	"}",
	"",
].join("\n");

const CLEAN_SOURCE = ["export function cartTotalCents(lines: number[]): number {", "\treturn lines.reduce((sum, cents) => sum + cents, 0);", "}", ""].join("\n");

test("removes a contract written as standalone line comments and keeps the code", () => {
	assert.deepEqual(removeBuildContracts(CONTRACTED_SOURCE), { kind: "cleaned", text: CLEAN_SOURCE, removedBlockCount: 1 });
});

test("accepts hash comments and one-line block comments", () => {
	const python = "# @handoff-contract begin\n# Returns None for a missing id.\n# @handoff-contract end\ndef find(id): ...\n";
	assert.equal(removeBuildContracts(python).kind, "cleaned");
	const css = "/* @handoff-contract begin */\n/* Dark theme colors only. */\n/* @handoff-contract end */\n.a {}\n";
	assert.deepEqual(removeBuildContracts(css), { kind: "cleaned", text: ".a {}\n", removedBlockCount: 1 });
});

test("refuses a contract that encloses code, so cleanup never deletes an implementation", () => {
	const enclosingCode = "// @handoff-contract begin\n// Behavior.\nconst limit = 3;\n// @handoff-contract end\n";
	const removal = removeBuildContracts(enclosingCode);
	assert.equal(removal.kind, "malformed");
	assert.match(removal.kind === "malformed" ? removal.reason : "", /line 3: .*non-comment/);
});

test("refuses a marker inside code or a string, and a block that switches comment syntax", () => {
	assert.equal(removeBuildContracts('const marker = "@handoff-contract begin";\n').kind, "cleaned", "text mentioning the marker mid-line is not a marker");
	assert.equal(removeBuildContracts("foo(); // @handoff-contract begin\n").kind, "cleaned");
	assert.equal(removeBuildContracts("@handoff-contract begin\n").kind, "malformed");
	assert.equal(removeBuildContracts("// @handoff-contract begin\n# @handoff-contract end\n").kind, "malformed");
});

test("refuses an unclosed contract", () => {
	assert.equal(removeBuildContracts("// @handoff-contract begin\n// Behavior.\nexport const x = 1;\n").kind, "malformed");
	assert.equal(removeBuildContracts("// @handoff-contract begin\n// Behavior.\n").kind, "malformed");
});

function checkout(): string {
	return mkdtempSync(join(tmpdir(), "contract-cleanup-test-"));
}

test("cleans every changed file with contracts, and leaves files without them out of the edit", () => {
	const root = checkout();
	mkdirSync(join(root, "src"));
	writeFileSync(join(root, "src/cart.ts"), CONTRACTED_SOURCE);
	writeFileSync(join(root, "src/plain.ts"), CLEAN_SOURCE);
	const edits = prepareContractCleanup(root, ["src/cart.ts", "src/plain.ts", "src/cart.ts"]);
	assert.deepEqual(edits.map((edit) => edit.path), [join(root, "src/cart.ts")]);
	applyContractCleanup(edits);
	assert.equal(readFileSync(join(root, "src/cart.ts"), "utf8"), CLEAN_SOURCE);
});

test("one malformed file stops the whole cleanup before any file is written", () => {
	const root = checkout();
	writeFileSync(join(root, "a.ts"), CONTRACTED_SOURCE);
	writeFileSync(join(root, "b.ts"), "// @handoff-contract begin\nexport const x = 1;\n// @handoff-contract end\n");
	assert.throws(() => prepareContractCleanup(root, ["a.ts", "b.ts"]), /b\.ts: line 2/);
	assert.equal(readFileSync(join(root, "a.ts"), "utf8"), CONTRACTED_SOURCE);
});

test("refuses paths outside the checkout and skips symlinks and binary files", () => {
	const root = checkout();
	assert.throws(() => prepareContractCleanup(root, ["../outside.ts"]), /escapes the checkout/);
	const outside = join(checkout(), "target.ts");
	writeFileSync(outside, CONTRACTED_SOURCE);
	symlinkSync(outside, join(root, "link.ts"));
	writeFileSync(join(root, "image.bin"), Buffer.from([0, 1, 2]));
	assert.deepEqual(prepareContractCleanup(root, ["link.ts", "image.bin"]), []);
	assert.equal(readFileSync(outside, "utf8"), CONTRACTED_SOURCE, "a symlink target is never rewritten");
});

test("a file changed between validation and writing stops the cleanup", () => {
	const root = checkout();
	writeFileSync(join(root, "a.ts"), CONTRACTED_SOURCE);
	const edits = prepareContractCleanup(root, ["a.ts"]);
	writeFileSync(join(root, "a.ts"), `${CONTRACTED_SOURCE}// late edit\n`);
	assert.throws(() => applyContractCleanup(edits), /changed after validation/);
});
