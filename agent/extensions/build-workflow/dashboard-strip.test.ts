import assert from "node:assert/strict";
import { test } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { renderStrip, type StripAgent, type StripSnapshot } from "./dashboard-strip.ts";

const plainTheme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as unknown as Theme;

const busyWorkspace: StripSnapshot = {
	repo: { repoName: "pi-config", branch: "dashboard" },
	changes: {
		kind: "loaded",
		result: { ok: true, value: { added: 312, removed: 48, files: Array.from({ length: 6 }, (_, index) => ({ path: `f${index}`, added: 1, removed: 0, isBinary: false, isNew: false })) } },
	},
	gauge: { costUsd: 1.24, contextPercent: 64, model: "claude-opus-5-5", thinkingLevel: "high", tier: "complex" },
	checks: { kind: "passed", checkNames: ["typecheck", "test"] },
	agents: [
		{ name: "Implementer", state: "working", model: "gpt-6-luna", thinkingLevel: "medium", runningTool: { name: "bash", detail: "pnpm test", startedAtMs: 0 }, elapsedMs: 134_000, costUsd: 0.21 },
		{ name: "Reviewer del_x", state: "crashed", model: undefined, thinkingLevel: undefined, runningTool: undefined, elapsedMs: 0, costUsd: 0 },
	] satisfies StripAgent[],
	nowMs: 0,
};

test("the rule carries repo, branch, changes, checks, context, cost and model, filling the width exactly", () => {
	const [rule, ...agentLines] = renderStrip(busyWorkspace, "full", plainTheme, 0, 160);
	assert.equal(visibleWidth(rule), 160);
	for (const part of ["◆ pi-config", "+312 −48", "6 files", "✓ checks", "ctx ▰▰▰▰▰▱▱▱ 64%", "$1.24", "claude-opus-5-5 · high · complex"]) {
		assert.ok(rule.includes(part), `${part} missing from ${rule}`);
	}
	assert.equal(agentLines.length, 2);
	assert.ok(agentLines[0].includes("Implementer") && agentLines[0].includes("› bash  pnpm test") && agentLines[0].includes("2m 14s") && agentLines[0].includes("$0.21"));
	assert.ok(agentLines[1].includes("✗") && agentLines[1].includes("stopped"));
});

test("on a narrow terminal the least useful parts go first and the repo name stays", () => {
	const [rule] = renderStrip(busyWorkspace, "full", plainTheme, 0, 70);
	assert.ok(visibleWidth(rule) <= 70, rule);
	assert.ok(rule.includes("pi-config") && rule.includes("+312 −48") && !rule.includes("claude-opus-5-5"), rule);
});

test("the compact strip is one line that counts the working agents", () => {
	const lines = renderStrip(busyWorkspace, "compact", plainTheme, 0, 200);
	assert.equal(lines.length, 1);
	assert.ok(lines[0].includes("⠋ 1 working"), lines[0]);
});

test("the context only shows once it fills up, and a detached HEAD is flagged", () => {
	const roomy: StripSnapshot = { ...busyWorkspace, gauge: { ...busyWorkspace.gauge, contextPercent: 30 }, repo: { repoName: "pi-config", branch: undefined } };
	const [rule] = renderStrip(roomy, "compact", plainTheme, 0, 200);
	assert.ok(!rule.includes("ctx") && rule.includes("detached HEAD"), rule);
});

test("a clean repository says so, a hidden strip draws nothing, and a running check shows its name", () => {
	const clean: StripSnapshot = {
		...busyWorkspace,
		agents: [],
		changes: { kind: "loaded", result: { ok: true, value: { added: 0, removed: 0, files: [] } } },
		checks: { kind: "running", checkName: "lint" },
	};
	const lines = renderStrip(clean, "full", plainTheme, 0, 160);
	assert.equal(lines.length, 1);
	assert.ok(lines[0].includes("clean") && lines[0].includes("⠋ lint"), lines[0]);
	assert.deepEqual(renderStrip(clean, "hidden", plainTheme, 0, 160), []);
});
