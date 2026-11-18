import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fingerprintWorkTree, type RunCommand } from "./work-tree-fingerprint.ts";

const run: RunCommand = (command, args, options) =>
	new Promise((resolve) => {
		execFile(command, args, { cwd: options.cwd, timeout: options.timeout }, (error, stdout) => {
			resolve({ stdout, code: error ? (typeof error.code === "number" ? error.code : 1) : 0 });
		});
	});

async function git(cwd: string, ...args: string[]): Promise<void> {
	const result = await run("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, timeout: 10_000 });
	assert.equal(result.code, 0, `git ${args.join(" ")}`);
}

async function repoWithCommit(): Promise<string> {
	const repo = mkdtempSync(join(tmpdir(), "work-tree-fingerprint-"));
	await git(repo, "init", "-q");
	writeFileSync(join(repo, "a.ts"), "export const a = 1;\n");
	await git(repo, "add", "a.ts");
	await git(repo, "commit", "-q", "-m", "init");
	return repo;
}

/** Moves a file's modification time, as a later write would, without waiting for the clock. */
function touchLater(path: string, seconds: number): void {
	const later = new Date(Date.now() + seconds * 1000);
	utimesSync(path, later, later);
}

test("an untouched work tree keeps its fingerprint", async () => {
	const repo = await repoWithCommit();
	writeFileSync(join(repo, "a.ts"), "export const a = 2;\n");
	assert.equal(await fingerprintWorkTree(run, repo), await fingerprintWorkTree(run, repo));
});

test("a new file, or another write to an already changed file, changes the fingerprint", async () => {
	const repo = await repoWithCommit();
	writeFileSync(join(repo, "a.ts"), "export const a = 2;\n");
	const afterFirstEdit = await fingerprintWorkTree(run, repo);
	writeFileSync(join(repo, "a.ts"), "export const a = 3;\n");
	touchLater(join(repo, "a.ts"), 5);
	assert.notEqual(await fingerprintWorkTree(run, repo), afterFirstEdit, "the file was already modified before");
	const beforeNewFile = await fingerprintWorkTree(run, repo);
	writeFileSync(join(repo, "b.test.ts"), "test\n");
	assert.notEqual(await fingerprintWorkTree(run, repo), beforeNewFile);
});

test("a commit changes the fingerprint even when the work tree is clean again", async () => {
	const repo = await repoWithCommit();
	const clean = await fingerprintWorkTree(run, repo);
	writeFileSync(join(repo, "a.ts"), "export const a = 2;\n");
	await git(repo, "commit", "-q", "-am", "change");
	assert.notEqual(await fingerprintWorkTree(run, repo), clean);
});

test("outside a git repository there is no fingerprint", async () => {
	assert.equal(await fingerprintWorkTree(run, mkdtempSync(join(tmpdir(), "no-git-"))), undefined);
});
