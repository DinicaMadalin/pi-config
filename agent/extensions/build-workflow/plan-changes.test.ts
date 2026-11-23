import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { BuildOrchestrator } from "./build-orchestrator.ts";
import { END_FINISHED_RUN_CHOICES, type FinishedRunExits, PlanChanges } from "./plan-changes.ts";
import type { PlannerSession } from "./planner-session.ts";
import type { StartDialog } from "./start-dialog.ts";
import { IDLE_WORKFLOW, type WorkflowState } from "./workflow-state.ts";

const OLD_PLAN = "# Old run\n\n## Goal\nTotals in cents.\n";
const NEW_PLAN = "# New task\n\n## Goal\nExport totals as CSV.\n";

interface Harness {
	planChanges: PlanChanges;
	runPlanPath: string;
	newPlanPath: string;
	workflow: () => WorkflowState;
	dialogs: Array<{ title: string; options: string[] }>;
	notices: string[];
	calls: string[];
	moveRunDuringNextSelection: () => void;
}

/** A finished run in `state.phase` with its plan file, a newly saved plan, and scripted dialog answers. */
function finishedRun(
	phase: "awaiting-ship" | "review-failed" | "implement",
	answers: Array<string | undefined>,
	hasUI = true,
	options: { shipLeavesRunOpen?: boolean; shipOutcome?: string } = {},
): Harness {
	const directory = mkdtempSync(join(tmpdir(), "plan-changes-"));
	const runPlanPath = join(directory, "run-plan.md");
	const newPlanPath = join(directory, "new-plan.md");
	writeFileSync(runPlanPath, OLD_PLAN);
	writeFileSync(newPlanPath, NEW_PLAN);
	const work = { planPath: runPlanPath, baseCommit: "abc123" };
	let workflow: WorkflowState = phase === "review-failed" ? { phase, ...work, findings: "still wrong" } : { phase, ...work };
	const dialogs: Harness["dialogs"] = [];
	const notices: string[] = [];
	const calls: string[] = [];
	let shouldMoveRunDuringNextSelection = false;
	const session = {
		get workflow() { return workflow; },
		get hasUI() { return hasUI; },
		enterPhase(next: WorkflowState) { workflow = next; },
		readPlan(planPath: string) { return readFileSync(planPath, "utf8"); },
		notify(message: string) { notices.push(message); },
		context: {
			ui: {
				async select(title: string, options: string[]) {
					dialogs.push({ title, options });
					if (shouldMoveRunDuringNextSelection) {
						shouldMoveRunDuringNextSelection = false;
						workflow = IDLE_WORKFLOW;
					}
					return answers.shift();
				},
			},
		},
	} as unknown as PlannerSession;
	const orchestrator = {
		async startChangeRound() {
			calls.push("change-round");
			return undefined;
		},
		async tellImplementersAboutPlanChange() {
			calls.push("tell-implementers");
			return undefined;
		},
	} as unknown as BuildOrchestrator;
	const startDialog = { async ask() { calls.push("start-dialog"); } } as unknown as StartDialog;
	const exits: FinishedRunExits = {
		async ship() {
			calls.push("ship");
			if (!options.shipLeavesRunOpen) workflow = IDLE_WORKFLOW;
			return options.shipOutcome ?? "Shipped: build-new on origin. The run is finished.";
		},
		async stop() {
			calls.push("stop");
			workflow = IDLE_WORKFLOW;
		},
	};
	return {
		planChanges: new PlanChanges(session, orchestrator, startDialog, exits),
		runPlanPath,
		newPlanPath,
		workflow: () => workflow,
		dialogs,
		notices,
		calls,
		moveRunDuringNextSelection: () => { shouldMoveRunDuringNextSelection = true; },
	};
}

async function saveNewPlan(harness: Harness): Promise<void> {
	const planPath = harness.planChanges.keepOnePlanFile(harness.newPlanPath);
	harness.planChanges.notePlanSaved(planPath);
	await harness.planChanges.handleSavedPlan();
}

test("a plan saved while a finished run waits keeps its own file until the user chooses", () => {
	const harness = finishedRun("awaiting-ship", []);
	assert.equal(harness.planChanges.keepOnePlanFile(harness.newPlanPath), harness.newPlanPath);
	assert.equal(readFileSync(harness.runPlanPath, "utf8"), OLD_PLAN);
	assert.ok(existsSync(harness.newPlanPath));
});

test("a plan saved while the implementers work still replaces the run's plan file", () => {
	const harness = finishedRun("implement", []);
	assert.equal(harness.planChanges.keepOnePlanFile(harness.newPlanPath), harness.runPlanPath);
	assert.equal(readFileSync(harness.runPlanPath, "utf8"), NEW_PLAN);
	assert.ok(!existsSync(harness.newPlanPath));
});

test("the user is asked each time: change the finished run's work or a new task", async () => {
	const harness = finishedRun("awaiting-ship", [undefined]);
	await saveNewPlan(harness);
	assert.deepEqual(harness.dialogs[0]?.options, ["Change the finished run's work", "New task"]);
	assert.equal(readFileSync(harness.runPlanPath, "utf8"), OLD_PLAN, "Esc changes nothing");
	assert.ok(existsSync(harness.newPlanPath));
	assert.deepEqual(harness.calls, []);
	assert.equal(harness.workflow().phase, "awaiting-ship");
});

test("editing the run's own plan starts a change round without asking", async () => {
	const harness = finishedRun("awaiting-ship", []);
	writeFileSync(harness.runPlanPath, NEW_PLAN);
	harness.planChanges.notePlanSaved(harness.planChanges.keepOnePlanFile(harness.runPlanPath));
	await harness.planChanges.handleSavedPlan();
	assert.deepEqual(harness.dialogs, []);
	assert.equal(readFileSync(harness.runPlanPath, "utf8"), NEW_PLAN);
	assert.deepEqual(harness.calls, ["change-round"]);
});

test("changing the finished run's work moves the plan into the run's file and starts a change round", async () => {
	const harness = finishedRun("awaiting-ship", ["Change the finished run's work"]);
	await saveNewPlan(harness);
	assert.equal(readFileSync(harness.runPlanPath, "utf8"), NEW_PLAN);
	assert.ok(!existsSync(harness.newPlanPath));
	assert.deepEqual(harness.calls, ["change-round"]);
});

test("a new task ships the finished run first, then offers the build on the new plan without touching the old plan", async () => {
	const harness = finishedRun("awaiting-ship", ["New task", END_FINISHED_RUN_CHOICES.ship]);
	await saveNewPlan(harness);
	assert.deepEqual(harness.dialogs[1]?.options, [END_FINISHED_RUN_CHOICES.ship, END_FINISHED_RUN_CHOICES.stop, END_FINISHED_RUN_CHOICES.keep]);
	assert.deepEqual(harness.calls, ["ship", "start-dialog"]);
	const offered = harness.workflow();
	assert.equal(offered.phase, "awaiting-implementation");
	assert.equal(offered.phase === "awaiting-implementation" && offered.planPath, harness.newPlanPath);
	assert.equal(offered.phase === "awaiting-implementation" && offered.startedFromChat, true);
	assert.equal(readFileSync(harness.runPlanPath, "utf8"), OLD_PLAN);
});

test("a run that cannot ship offers only stopping it before the new task", async () => {
	const harness = finishedRun("review-failed", ["New task", END_FINISHED_RUN_CHOICES.stop]);
	await saveNewPlan(harness);
	assert.deepEqual(harness.dialogs[1]?.options, [END_FINISHED_RUN_CHOICES.stop, END_FINISHED_RUN_CHOICES.keep]);
	assert.deepEqual(harness.calls, ["stop", "start-dialog"]);
	const offered = harness.workflow();
	assert.equal(offered.phase === "awaiting-implementation" && offered.planPath, harness.newPlanPath);
	assert.equal(readFileSync(harness.runPlanPath, "utf8"), OLD_PLAN);
});

test("a stale choice does not change the run or either plan", async () => {
	const harness = finishedRun("awaiting-ship", ["Change the finished run's work"]);
	harness.moveRunDuringNextSelection();
	await saveNewPlan(harness);
	assert.equal(harness.workflow().phase, "idle");
	assert.equal(readFileSync(harness.runPlanPath, "utf8"), OLD_PLAN);
	assert.ok(existsSync(harness.newPlanPath));
	assert.deepEqual(harness.calls, []);
	assert.deepEqual(harness.notices, ["The run moved on while you chose; the plan was not applied"]);
});

test("a failed ship keeps the new task plan and warns without starting it", async () => {
	const shipOutcome = "Push was rejected";
	const harness = finishedRun("awaiting-ship", ["New task", END_FINISHED_RUN_CHOICES.ship], true, { shipLeavesRunOpen: true, shipOutcome });
	await saveNewPlan(harness);
	assert.equal(harness.workflow().phase, "awaiting-ship");
	assert.equal(readFileSync(harness.runPlanPath, "utf8"), OLD_PLAN);
	assert.ok(existsSync(harness.newPlanPath));
	assert.deepEqual(harness.calls, ["ship"]);
	assert.deepEqual(harness.notices, [`New task not started: ${shipOutcome}. Its plan stays at ${harness.newPlanPath}; /build ship or /build stop, then save the plan again.`]);
});

test("a missing saved plan reports its file error instead of hiding the failed change", async () => {
	const harness = finishedRun("awaiting-ship", ["Change the finished run's work"]);
	const planPath = harness.planChanges.keepOnePlanFile(harness.newPlanPath);
	harness.planChanges.notePlanSaved(planPath);
	unlinkSync(harness.newPlanPath);
	await assert.rejects(() => harness.planChanges.handleSavedPlan(), /ENOENT/);
	assert.equal(readFileSync(harness.runPlanPath, "utf8"), OLD_PLAN);
	assert.deepEqual(harness.calls, []);
});

test("keeping the finished run leaves both runs' plans and the run as they were", async () => {
	const harness = finishedRun("awaiting-ship", ["New task", END_FINISHED_RUN_CHOICES.keep]);
	await saveNewPlan(harness);
	assert.deepEqual(harness.calls, []);
	assert.equal(harness.workflow().phase, "awaiting-ship");
	assert.ok(existsSync(harness.newPlanPath));
	assert.deepEqual(harness.notices, [`The new plan stays at ${harness.newPlanPath}; the finished run waits. /build ship or /build stop, then save the plan again to start it.`]);
});

test("without a UI a plan saved next to a finished run changes nothing", async () => {
	const harness = finishedRun("awaiting-ship", [], false);
	await saveNewPlan(harness);
	assert.deepEqual(harness.calls, []);
	assert.deepEqual(harness.dialogs, []);
	assert.equal(readFileSync(harness.runPlanPath, "utf8"), OLD_PLAN);
	assert.ok(existsSync(harness.newPlanPath));
	assert.deepEqual(harness.notices, [`Plan saved to ${harness.newPlanPath}; the finished run is unchanged. Save it again in an interactive session to choose.`]);
});
