import assert from "node:assert/strict";
import { test } from "node:test";
import { type StopBuildRequest, stopBuildFromChat } from "./stop-build.ts";
import type { WorkflowPhase } from "./workflow-state.ts";

function stopRequest(phase: WorkflowPhase, overrides: Partial<StopBuildRequest> = {}) {
	const calls = { endRun: 0, confirm: 0 };
	const request: StopBuildRequest = {
		phase,
		hasUI: true,
		confirmStop: async () => {
			calls.confirm++;
			return true;
		},
		endRun: () => {
			calls.endRun++;
		},
		...overrides,
	};
	return { request, calls };
}

test("stopping with no open run says so and ends nothing", async () => {
	const { request, calls } = stopRequest("idle");
	assert.match(await stopBuildFromChat(request), /No \/build run is open/);
	assert.deepEqual(calls, { endRun: 0, confirm: 0 });
});

test("a run that only waits on the user stops at once without asking", async () => {
	for (const phase of ["cleanup-failed", "review-failed", "awaiting-pr", "awaiting-ship"] as const) {
		const { request, calls } = stopRequest(phase, { hasUI: false });
		assert.match(await stopBuildFromChat(request), /^Stopped the \/build run/);
		assert.deepEqual(calls, { endRun: 1, confirm: 0 }, phase);
	}
});

test("while agents work the user confirms first", async () => {
	const agreed = stopRequest("implement");
	assert.match(await stopBuildFromChat(agreed.request), /^Stopped the \/build run in the implement phase/);
	assert.deepEqual(agreed.calls, { endRun: 1, confirm: 1 });

	const declined = stopRequest("review", { confirmStop: async () => false });
	assert.match(await stopBuildFromChat(declined.request), /^Not stopped: the user chose to keep the run going/);
	assert.equal(declined.calls.endRun, 0);
});

test("while agents work without a UI it refuses", async () => {
	const { request, calls } = stopRequest("design", { hasUI: false });
	assert.match(await stopBuildFromChat(request), /^Not stopped: agents are still working \(design phase\)/);
	assert.deepEqual(calls, { endRun: 0, confirm: 0 });
});
