import assert from "node:assert/strict";
import { test } from "node:test";
import { abortableCheckExecutor, type CheckExecutor, canOpenChecksPane, runEveryProjectCheck, runProjectChecks } from "./check-runner.ts";
import type { ProjectChecks } from "./project-checks.ts";

const projectChecks = {
	checks: [
		{ name: "typecheck", command: "tsc" },
		{ name: "lint", command: "eslint ." },
		{ name: "test", command: "vitest" },
	],
	workingDir: "/repo",
	timeoutMs: 1000,
} as unknown as ProjectChecks;

test("checks never split a build helper's full-size pane; main-session checks remain visible", () => {
	const herdrEnv = { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1" };
	assert.equal(canOpenChecksPane({ ...herdrEnv, PI_BUILD_SUBAGENT: "1" }), false);
	assert.equal(canOpenChecksPane(herdrEnv), true);
	assert.equal(canOpenChecksPane({ ...herdrEnv, PI_BUILD_SUBAGENT: "0" }), true);
	assert.equal(canOpenChecksPane({}), false);
	assert.equal(canOpenChecksPane({ HERDR_ENV: "1" }), false);
});

test("checks run in order and stop at the first failure, which keeps the end of its output", async () => {
	const ran: string[] = [];
	const runCheck: CheckExecutor = async (check) => {
		ran.push(check.name);
		return check.name === "lint" ? { exitCode: 2, timedOut: false, output: `${"x".repeat(5000)}END` } : { exitCode: 0, timedOut: false, output: "" };
	};
	const run = await runProjectChecks(runCheck, projectChecks, () => undefined);
	assert.deepEqual(ran, ["typecheck", "lint"]);
	assert.equal(run.kind, "failed");
	if (run.kind !== "failed") return;
	assert.deepEqual(run.passedNames, ["typecheck"]);
	assert.equal(run.exitCode, 2);
	assert.equal(run.outputTail.length, 4000);
	assert.ok(run.outputTail.endsWith("END"));
});

test("a check that timed out fails even with exit code 0", async () => {
	const run = await runProjectChecks(async () => ({ exitCode: 0, timedOut: true, output: "" }), projectChecks, () => undefined);
	assert.equal(run.kind === "failed" && run.timedOut, true);
});

test("all checks passing reports their names", async () => {
	const run = await runProjectChecks(async () => ({ exitCode: 0, timedOut: false, output: "" }), projectChecks, () => undefined);
	assert.deepEqual(run, { kind: "passed", passedNames: ["typecheck", "lint", "test"] });
});

test("a full run keeps going past failures so a baseline sees every check", async () => {
	const started: string[] = [];
	const runCheck: CheckExecutor = async (check) =>
		check.name === "lint" ? { exitCode: 1, timedOut: false, output: `${"x".repeat(5000)}bad` } : { exitCode: 0, timedOut: false, output: "ok" };
	const results = await runEveryProjectCheck(runCheck, projectChecks, (check) => started.push(check.name));
	assert.deepEqual(started, ["typecheck", "lint", "test"]);
	assert.deepEqual(
		results.map(({ name, command, passed }) => ({ name, command, passed })),
		[
			{ name: "typecheck", command: "tsc", passed: true },
			{ name: "lint", command: "eslint .", passed: false },
			{ name: "test", command: "vitest", passed: true },
		],
	);
	assert.equal(results[0].outputTail, "");
	assert.equal(results[1].outputTail.length, 4000);
	assert.ok(results[1].outputTail.endsWith("bad"));
});

test("a full run marks a silent timeout as failed and says so", async () => {
	const results = await runEveryProjectCheck(async () => ({ exitCode: 0, timedOut: true, output: "" }), projectChecks, () => undefined);
	assert.deepEqual(results.map((result) => [result.passed, result.outputTail]), [[false, "timed out"], [false, "timed out"], [false, "timed out"]]);
});

test("a full run with no checks has no results, and an executor error is not swallowed", async () => {
	assert.deepEqual(await runEveryProjectCheck(async () => ({ exitCode: 0, timedOut: false, output: "" }), { ...projectChecks, checks: [] }, () => undefined), []);
	await assert.rejects(
		runEveryProjectCheck(async () => {
			throw new Error("aborted");
		}, projectChecks, () => undefined),
		/aborted/,
	);
});

test("the abortable executor exports CI=1, passes the signal and refuses to start once aborted", async () => {
	const calls: { args: string[]; options: { cwd?: string; signal?: AbortSignal; timeout?: number } }[] = [];
	const pi = {
		exec: async (_command: string, args: string[], options: { cwd?: string; signal?: AbortSignal; timeout?: number }) => {
			calls.push({ args, options });
			return { code: 3, killed: false, stdout: "out", stderr: "err" };
		},
	} as unknown as Parameters<typeof abortableCheckExecutor>[0];
	const controller = new AbortController();
	const runCheck = abortableCheckExecutor(pi, controller.signal);
	assert.deepEqual(await runCheck(projectChecks.checks[0], projectChecks), { exitCode: 3, timedOut: false, output: "out\nerr" });
	assert.deepEqual(calls[0].args, ["-c", "CI=1; export CI; tsc"]);
	assert.equal(calls[0].options.cwd, "/repo");
	assert.equal(calls[0].options.timeout, 1000);
	assert.equal(calls[0].options.signal, controller.signal);
	controller.abort();
	await assert.rejects(runCheck(projectChecks.checks[0], projectChecks));
	assert.equal(calls.length, 1);
});
