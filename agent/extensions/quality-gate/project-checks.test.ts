import assert from "node:assert/strict";
import { test } from "node:test";
import { checksFromMakefile, checksFromPackageScripts, detectPackageManager } from "./project-checks.ts";

test("maps package scripts to typecheck, lint, and test with the repo's package manager", () => {
	const scripts = { "type-check": "tsc --noEmit", lint: "eslint .", test: "vitest", dev: "vite" };
	assert.deepEqual(checksFromPackageScripts(scripts, "pnpm"), [
		{ name: "typecheck", command: "pnpm run type-check" },
		{ name: "lint", command: "pnpm run lint" },
		{ name: "test", command: "pnpm run test" },
	]);
});

test("skips npm's placeholder test script, which always fails", () => {
	const scripts = { test: 'echo "Error: no test specified" && exit 1' };
	assert.deepEqual(checksFromPackageScripts(scripts, "npm"), []);
});

test("picks the package manager from the lockfile, npm when there is none", () => {
	assert.equal(detectPackageManager(new Set(["yarn.lock"])), "yarn");
	assert.equal(detectPackageManager(new Set(["bun.lockb"])), "bun");
	assert.equal(detectPackageManager(new Set()), "npm");
});

test("reads check, lint, and test targets from a Makefile", () => {
	const makefile = "build:\n\tgo build\ntest: build\n\tgo test ./...\nlint:\n\tgolangci-lint run\n";
	assert.deepEqual(
		checksFromMakefile(makefile).map((check) => check.command),
		["make lint", "make test"],
	);
});
