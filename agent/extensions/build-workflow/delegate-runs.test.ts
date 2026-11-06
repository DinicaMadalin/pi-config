import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type DelegateLaunch, delegateStatus, findDelegateRuns, findLiveDelegateProcesses, summarizeDelegateSession } from "./delegate-runs.ts";

function toolResult(details: Record<string, unknown>) {
	return { type: "message", message: { role: "toolResult", toolName: "acp_delegate", details } };
}

function userText(text: string) {
	return { type: "message", message: { role: "user", content: [{ type: "text", text }] } };
}

test("finds the session's delegate runs with their latest recorded status", () => {
	const runs = findDelegateRuns([
		toolResult({ kind: "delegate", agent: "reviewer", runId: "del_a", task: "Review PR #33", status: "running" }),
		toolResult({ kind: "delegate", agent: "researcher", runId: "del_b", task: "Find the cache", status: "running" }),
		toolResult({ kind: "other", runId: "del_x" }),
		toolResult({ kind: "delegate", agent: "reviewer", runId: "del_a", task: "Review PR #33", status: "completed", durationMs: 77_480 }),
		userText("[acp_delegate FAILED ⚠️] **researcher** (runId `del_b`, exit 1) — boom"),
	]);
	assert.deepEqual(runs, [
		{ runId: "del_a", agent: "reviewer", task: "Review PR #33", recordedStatus: "completed", durationMs: 77_480 },
		{ runId: "del_b", agent: "researcher", task: "Find the cache", recordedStatus: "failed", durationMs: undefined },
	]);
});

test("a live process means running; a gone one keeps its recorded end, or reads as ended", () => {
	const launch: DelegateLaunch = { runId: "del_a", agent: "reviewer", task: "", recordedStatus: "running", durationMs: undefined };
	assert.equal(delegateStatus(launch, new Map([["del_a", 42]])), "running");
	assert.equal(delegateStatus(launch, new Map()), "ended");
	assert.equal(delegateStatus({ ...launch, recordedStatus: "cancelled" }, new Map()), "cancelled");
	assert.equal(delegateStatus(launch, undefined), "running", "without /proc the record is all there is");
});

test("summarizes a delegate session: model, thinking, cost, activity and the tool still running", () => {
	const lines = [
		{ type: "session", timestamp: "2026-11-04T11:40:29.000Z" },
		{ type: "thinking_level_change", timestamp: "2026-11-04T11:40:29.500Z", thinkingLevel: "medium" },
		{ type: "custom", customType: "auto-model-route", timestamp: "2026-11-04T11:40:30.000Z", data: { reason: "important task: code review" } },
		{
			type: "message",
			timestamp: "2026-11-04T11:40:40.000Z",
			message: {
				role: "assistant",
				model: "claude-opus-5-5",
				thinkingLevel: "high",
				usage: { cost: { total: 0.25 } },
				content: [
					{ type: "text", text: "Checking the\ndiff first." },
					{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "git diff --stat" } },
					{ type: "toolCall", id: "call-2", name: "read", arguments: { path: "src/a.ts" } },
				],
			},
		},
		{ type: "message", timestamp: "2026-11-04T11:40:45.000Z", message: { role: "toolResult", toolCallId: "call-1", toolName: "bash", isError: true } },
	].map((entry) => JSON.stringify(entry));
	const summary = summarizeDelegateSession([...lines, '{"type":"message","timestamp":"2026-11-04T11:4'].join("\n"));
	assert.equal(summary.model, "claude-opus-5-5");
	assert.equal(summary.thinkingLevel, "high");
	assert.equal(summary.routeReason, "important task: code review");
	assert.equal(summary.costUsd, 0.25);
	assert.equal(summary.startedAtMs, Date.parse("2026-11-04T11:40:29.000Z"));
	assert.equal(summary.lastEntryAtMs, Date.parse("2026-11-04T11:40:45.000Z"));
	assert.deepEqual(
		summary.activity.map((line) => [line.kind, line.text]),
		[
			["text", "Checking the diff first."],
			["tool", "bash  git diff --stat"],
			["tool", "read  src/a.ts"],
			["error", "bash failed"],
		],
	);
	assert.deepEqual(summary.pendingTool, { name: "read", detail: "src/a.ts", startedAtMs: Date.parse("2026-11-04T11:40:40.000Z") });
});

test("finds live delegate processes by the session file on their command line", () => {
	const procRoot = mkdtempSync(join(tmpdir(), "proc-"));
	const fakeProcess = (processId: string, args: string[]): void => {
		mkdirSync(join(procRoot, processId));
		writeFileSync(join(procRoot, processId, "cmdline"), `${args.join("\0")}\0`);
	};
	fakeProcess("101", ["node", "cli.js", "--mode", "json", "--session", "/tmp/acp-delegate/del_mw21p4fk_m4lh.session.jsonl", "--session-dir", "/tmp/acp-delegate"]);
	fakeProcess("102", ["node", "cli.js", "--session", "/home/me/.pi/agent/sessions/x.jsonl"]);
	mkdirSync(join(procRoot, "self"));
	assert.deepEqual(findLiveDelegateProcesses(procRoot), new Map([["del_mw21p4fk_m4lh", 101]]));
	assert.equal(findLiveDelegateProcesses(join(procRoot, "missing")), undefined);
});
