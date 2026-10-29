import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { findSavedPlanPath, planFileName, SAVE_PLAN_TOOL_NAME } from "./agreed-plan-files.ts";

const SAVED_AT = new Date("2026-10-29T12:34:56Z");

function planToolResult(planPath: string, isError = false): AgentMessage {
	return { role: "toolResult", toolCallId: "1", toolName: SAVE_PLAN_TOOL_NAME, content: [], details: { planPath }, isError, timestamp: 0 } as AgentMessage;
}

test("names the plan file after its title, with a sortable timestamp", () => {
	assert.equal(planFileName("# Add /health endpoint & tests!\n## Goal", SAVED_AT), "2026-10-29-12-34-add-health-endpoint-tests.md");
	assert.equal(planFileName("no title here", SAVED_AT), "2026-10-29-12-34-plan.md");
});

test("finds the newest plan the agent saved whose file still exists", () => {
	const dir = mkdtempSync(join(tmpdir(), "plans-"));
	const olderPlan = join(dir, "older.md");
	const newerPlan = join(dir, "newer.md");
	writeFileSync(olderPlan, "# Older");
	writeFileSync(newerPlan, "# Newer");
	assert.equal(findSavedPlanPath([planToolResult(olderPlan), planToolResult(newerPlan)]), newerPlan);
	assert.equal(findSavedPlanPath([planToolResult(olderPlan), planToolResult(join(dir, "deleted.md"))]), olderPlan);
	assert.equal(findSavedPlanPath([planToolResult(newerPlan, true)]), undefined);
});
