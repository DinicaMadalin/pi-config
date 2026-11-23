import assert from "node:assert/strict";
import { test } from "node:test";
import {
	type AutoRouteState,
	approvalRefusal,
	designerNote,
	findAutoRouteState,
	followsDesignerNote,
	HANDOFF_TOOL_NAME,
	handoffAfter,
	handoffRefusal,
	handoffTransition,
	hasImplementerChangedFiles,
	implementerBrief,
	implementerToolRefusal,
	MAX_HANDOFFS_PER_TASK,
	readDesignTaskProgress,
	readImplementerWork,
	removeContractBlocks,
	reviewRequest,
	takeOverRequest,
} from "./implementation-handoff.ts";

const expertState: AutoRouteState = { tier: "expert", modelKey: "openai/gpt-6-astra", thinkingLevel: "high" };
const implementingState: AutoRouteState = {
	tier: "standard",
	modelKey: "openai/gpt-6-luna",
	thinkingLevel: "medium",
	handoff: { phase: "implementing", designer: { tier: "expert", modelKey: "openai/gpt-6-astra", thinkingLevel: "high" }, handoffCount: 1 },
};

const assistant = { role: "assistant", content: [{ type: "text", text: "ok" }] };
const handoffResult = (isError = false) => ({ role: "toolResult", toolName: HANDOFF_TOOL_NAME, isError, content: [] });
const userText = (text: string) => ({ role: "user", content: [{ type: "text", text }] });

test("finds the latest auto model router state on the branch", () => {
	const routerEntry = (state: AutoRouteState) => ({ type: "custom", customType: "pi.virtual-model-state", data: { provider: "auto", modelId: "auto", state } });
	const otherModelEntry = { type: "custom", customType: "pi.virtual-model-state", data: { provider: "jev", modelId: "auto", state: { phase: "planning" } } };
	assert.deepEqual(findAutoRouteState([routerEntry(expertState), routerEntry(implementingState), otherModelEntry]), implementingState);
	assert.equal(findAutoRouteState([{ type: "message" }]), undefined);
});

test("only a complex or expert model outside /build may hand off", () => {
	assert.equal(handoffRefusal(expertState, false), undefined);
	assert.equal(handoffRefusal({ ...expertState, tier: "complex" }, false), undefined);
	assert.match(handoffRefusal({ ...expertState, tier: "standard" }, false) ?? "", /Only the designer hands off/);
	assert.match(handoffRefusal(expertState, true) ?? "", /off in this session/);
	assert.match(handoffRefusal(undefined, false) ?? "", /Only the designer hands off/);
});

test("the implementer cannot hand off again and cannot approve", () => {
	assert.match(handoffRefusal(implementingState, false) ?? "", /You are the implementer/);
	assert.match(approvalRefusal(implementingState) ?? "", /Only the reviewer/);
});

test(`stops handing off after ${MAX_HANDOFFS_PER_TASK} rounds so the review loop ends`, () => {
	const reviewing: AutoRouteState = { ...expertState, handoff: { ...implementingState.handoff!, phase: "reviewing", handoffCount: MAX_HANDOFFS_PER_TASK } };
	assert.match(handoffRefusal(reviewing, false) ?? "", /finish the implementation yourself/);
	assert.equal(approvalRefusal(reviewing), undefined);
});

test("a successful hand-off sends the next request to the implementer", () => {
	assert.equal(handoffTransition([userText("build it"), assistant, handoffResult()], expertState), "implement");
	assert.equal(handoffTransition([userText("build it"), assistant, handoffResult(true)], expertState), undefined);
	assert.equal(handoffTransition([handoffResult(), assistant], expertState), undefined, "an older hand-off does not count again");
});

test("the review request returns the work to the designer only while implementing", () => {
	const messages = [assistant, userText(reviewRequest())];
	assert.equal(handoffTransition(messages, implementingState), "review");
	assert.equal(handoffTransition(messages, expertState), undefined);
});

test("recognizes the request that follows the designer note", () => {
	assert.equal(followsDesignerNote([assistant, { role: "toolResult", toolName: "read" }, userText(designerNote())]), true);
	assert.equal(followsDesignerNote([userText(designerNote()), assistant]), false);
});

test("the designer is remembered across hand-off rounds and the rounds are counted", () => {
	const firstHandoff = handoffAfter("implement", expertState);
	assert.deepEqual(firstHandoff, { phase: "implementing", designer: { tier: "expert", modelKey: "openai/gpt-6-astra", thinkingLevel: "high" }, handoffCount: 1 });
	const review = handoffAfter("review", { ...implementingState, handoff: firstHandoff });
	assert.deepEqual(review, { ...firstHandoff, phase: "reviewing" });
	const secondHandoff = handoffAfter("implement", { ...expertState, handoff: review });
	assert.equal(secondHandoff.handoffCount, 2);
	assert.equal(secondHandoff.designer.modelKey, "openai/gpt-6-astra");
});

test("removing contracts keeps the code and deletes every contract block with its markers", () => {
	const source = [
		"import { x } from './x';",
		"",
		"  // @handoff-contract begin",
		"  // collectCombatEvents: ordered events of one hit.",
		"  // Acceptance: rejected hit -> [].",
		"  // @handoff-contract end",
		"  export function collectCombatEvents(hit: ResolvedHit): CombatEvent[] {",
		"    return [];",
		"  }",
		"# @handoff-contract begin",
		"# python contract",
		"# @handoff-contract end",
		"def f(): pass",
		"",
	].join("\n");
	const removal = removeContractBlocks(source);
	assert.equal(removal.kind, "cleaned");
	if (removal.kind !== "cleaned") return;
	assert.equal(removal.removedBlockCount, 2);
	assert.equal(
		removal.text,
		["import { x } from './x';", "", "  export function collectCombatEvents(hit: ResolvedHit): CombatEvent[] {", "    return [];", "  }", "def f(): pass", ""].join("\n"),
	);
});

test("removing contracts keeps Windows line endings and leaves files without contracts unchanged", () => {
	const removal = removeContractBlocks("a\r\n/* @handoff-contract begin\r\n * rule\r\n @handoff-contract end */\r\nb\r\n");
	assert.deepEqual(removal, { kind: "cleaned", text: "a\r\nb\r\n", removedBlockCount: 1 });
	assert.deepEqual(removeContractBlocks("plain\n"), { kind: "cleaned", text: "plain\n", removedBlockCount: 0 });
});

test("a contract block without its partner marker is reported and nothing is removed", () => {
	assert.deepEqual(removeContractBlocks("// @handoff-contract begin\ncode\n"), { kind: "malformed", reason: "the contract block opened at line 1 is never closed" });
	assert.deepEqual(removeContractBlocks("code\n// @handoff-contract end\n"), { kind: "malformed", reason: "line 2 closes a contract block that was never opened" });
	assert.equal(removeContractBlocks("// @handoff-contract begin\n// @handoff-contract begin\n").kind, "malformed");
});

test("a marker mentioned inside a code line is not a contract block", () => {
	const source = 'const marker = "@handoff-contract begin";\n';
	assert.deepEqual(removeContractBlocks(source), { kind: "cleaned", text: source, removedBlockCount: 0 });
});

const handoffEntry = (details: unknown, isError = false) => ({ type: "message", message: { role: "toolResult", toolName: HANDOFF_TOOL_NAME, isError, details } });
const toolEntry = (toolName: string, isError = false) => ({ type: "message", message: { role: "toolResult", toolName, isError } });

test("the implementer's work is read from the latest successful hand-off on", () => {
	const branch = [
		toolEntry("edit"),
		handoffEntry({ brief: "x", workTreeFingerprint: "before" }),
		toolEntry("compress"),
		toolEntry("edit", true),
		toolEntry("write"),
		handoffEntry({ brief: "y" }, true),
	];
	assert.deepEqual(readImplementerWork(branch), { fingerprintAtHandoff: "before", fileWriteCount: 1 });
	assert.equal(readImplementerWork([toolEntry("edit")]), undefined);
	assert.deepEqual(readImplementerWork([handoffEntry({ brief: "x" })]), { fingerprintAtHandoff: undefined, fileWriteCount: 0 });
});

test("an implementer that only compressed its context changed no file, whatever the fingerprint source", () => {
	assert.equal(hasImplementerChangedFiles({ fingerprintAtHandoff: "same", fileWriteCount: 0 }, "same"), false);
	assert.equal(hasImplementerChangedFiles({ fingerprintAtHandoff: undefined, fileWriteCount: 0 }, undefined), false);
});

test("a changed work tree counts even when only bash wrote it; without fingerprints edit and write calls count", () => {
	assert.equal(hasImplementerChangedFiles({ fingerprintAtHandoff: "before", fileWriteCount: 0 }, "after"), true);
	assert.equal(hasImplementerChangedFiles({ fingerprintAtHandoff: undefined, fileWriteCount: 2 }, "after"), true);
	assert.equal(hasImplementerChangedFiles({ fingerprintAtHandoff: "before", fileWriteCount: 0 }, undefined), false);
});

test("a take-over request returns the work to the designer only while implementing, and ends the hand-offs", () => {
	const messages = [assistant, userText(takeOverRequest())];
	assert.equal(handoffTransition(messages, implementingState), "take-over");
	assert.equal(handoffTransition(messages, expertState), undefined);
	const takingOver: AutoRouteState = { ...expertState, handoff: handoffAfter("take-over", implementingState) };
	assert.deepEqual(takingOver.handoff, { ...implementingState.handoff!, phase: "taking-over" });
	assert.match(handoffRefusal(takingOver, false) ?? "", /changed no file.*implement it yourself/);
	assert.equal(approvalRefusal(takingOver), undefined, "the designer approves its own work to delete the contracts");
});

test("the implementer may not compress, search context or delegate; everyone else may", () => {
	for (const toolName of ["compress", "decompress", "search_context", "acp_status", "subagent", "contact_supervisor"]) {
		assert.match(implementerToolRefusal(toolName, implementingState) ?? "", new RegExp(`may not call ${toolName}`));
	}
	assert.equal(implementerToolRefusal("edit", implementingState), undefined);
	assert.equal(implementerToolRefusal("bash", implementingState), undefined);
	assert.equal(implementerToolRefusal("compress", expertState), undefined);
	assert.equal(implementerToolRefusal("compress", undefined), undefined);
});

test("the brief and the review tell the models not to waste the hand-off", () => {
	const brief = implementerBrief("Fill src/a.ts");
	assert.match(brief, /Do not call context or delegation tools \(compress, /);
	assert.match(brief, /changes no file counts as not done/);
	assert.match(reviewRequest(), /do not send the same brief again/);
	assert.match(takeOverRequest(), /Do not call hand_off_implementation again/);
});

test("the take-over makes an implementer's reported blocker the designer's to resolve", () => {
	const takeOver = takeOverRequest();
	assert.match(takeOver, /reported a blocker/);
	assert.match(takeOver, /yours to resolve/);
	assert.match(takeOver, /DESIGN-BLOCKED:/);
	assert.match(takeOver, /Do not call hand_off_implementation again/);
	const implementingState: AutoRouteState = {
		tier: "standard",
		modelKey: "openai/gpt-6-luna",
		handoff: { phase: "implementing", designer: { tier: "expert", modelKey: "openai/gpt-6-astra" }, handoffCount: 1 },
	};
	assert.equal(handoffTransition([{ role: "assistant", content: "Blocked." }, { role: "user", content: takeOver }], implementingState), "take-over");
});

function designStateEntry(taskId: string) {
	return {
		type: "custom",
		customType: "pi.virtual-model-state",
		data: { provider: "auto", modelId: "auto", state: { tier: "expert", modelKey: "openai/gpt-6-astra", designTask: { id: taskId, source: "plan_implementation" } } },
	};
}

function toolResultEntry(toolName: string, isError = false) {
	return { type: "message", message: { role: "toolResult", toolName, isError } };
}

const userEntry = { type: "message", message: { role: "user" } };

test("design task progress counts successful file edits since the task began", () => {
	assert.deepEqual(readDesignTaskProgress([designStateEntry("task-1"), userEntry, toolResultEntry("edit")], "task-1"), { hasEditedFiles: true, hasSavedPlanThisTurn: false });
	assert.equal(readDesignTaskProgress([userEntry, toolResultEntry("write"), designStateEntry("task-1"), toolResultEntry("read")], "task-1").hasEditedFiles, false, "an edit before the task does not count");
	assert.equal(readDesignTaskProgress([designStateEntry("task-1"), toolResultEntry("edit", true)], "task-1").hasEditedFiles, false, "a failed edit does not count");
	assert.equal(readDesignTaskProgress([designStateEntry("task-1"), toolResultEntry("write")], "task-1").hasEditedFiles, true);
});

test("design task progress sees a plan saved after the latest user message only", () => {
	assert.equal(readDesignTaskProgress([designStateEntry("task-1"), userEntry, toolResultEntry("save_agreed_plan")], "task-1").hasSavedPlanThisTurn, true);
	assert.equal(readDesignTaskProgress([designStateEntry("task-1"), toolResultEntry("save_agreed_plan")], "task-1").hasSavedPlanThisTurn, true, "the task's first turn");
	assert.equal(readDesignTaskProgress([designStateEntry("task-1"), toolResultEntry("save_agreed_plan"), userEntry, toolResultEntry("edit")], "task-1").hasSavedPlanThisTurn, false);
	assert.equal(readDesignTaskProgress([designStateEntry("task-1"), userEntry, toolResultEntry("save_agreed_plan", true)], "task-1").hasSavedPlanThisTurn, false);
	const reminder = { type: "custom_message", customType: "auto-model-design-reminder" };
	assert.equal(readDesignTaskProgress([designStateEntry("task-1"), userEntry, toolResultEntry("save_agreed_plan"), reminder], "task-1").hasSavedPlanThisTurn, true, "a custom message is not a user message");
});

test("design task progress of an unknown task is empty", () => {
	assert.deepEqual(readDesignTaskProgress([designStateEntry("other"), userEntry, toolResultEntry("edit"), toolResultEntry("save_agreed_plan")], "task-1"), { hasEditedFiles: false, hasSavedPlanThisTurn: false });
});

test("hand-off prompts say what happened without naming model cost", () => {
	const prompts = [designerNote(), implementerBrief("Fill src/a.ts"), reviewRequest(), takeOverRequest()];
	for (const prompt of prompts) assert.doesNotMatch(prompt, /cheap|expensive/i);
	assert.match(takeOverRequest(), /^\[auto-model: hand-off produced no change\] The implementer ended its turn without changing any file/);
});
