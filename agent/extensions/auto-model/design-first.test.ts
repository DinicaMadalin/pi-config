import assert from "node:assert/strict";
import { test } from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import { DEFAULT_TIER_POLICIES, type TierPolicies } from "./difficulty-tiers.ts";
import {
	chooseDesignerModel,
	designFirstInstructions,
	designSource,
	shouldRemindDesigner,
} from "./design-first.ts";

const expert = { provider: "test", id: "expert", input: ["text", "image"] } as unknown as Model<Api>;
const complex = { provider: "test", id: "complex", input: ["text", "image"] } as unknown as Model<Api>;
const unrelated = { provider: "test", id: "unlisted", input: ["text", "image"] } as unknown as Model<Api>;
const policies: TierPolicies = {
	...DEFAULT_TIER_POLICIES,
	expert: { models: ["test/expert"], thinkingLevel: "high" },
	complex: { models: ["test/complex"], thinkingLevel: "high" },
};

test("plan implementation and feature builds enter design-first but questions and planning alone do not", () => {
	assert.equal(designSource("plan_implementation"), "plan_implementation");
	assert.equal(designSource("feature_build"), "feature_build");
	for (const taskKind of ["other", "feature_planning", "code_review", "issue_investigation"] as const) {
		assert.equal(designSource(taskKind), undefined);
	}
});

test("expert precedes complex regardless of available catalog order", () => {
	assert.deepEqual(chooseDesignerModel([complex, expert], policies, false), { tier: "expert", model: expert });
});

test("complex is the fallback when no usable expert remains", () => {
	assert.deepEqual(chooseDesignerModel([unrelated, complex], policies, false), { tier: "complex", model: complex });
	const textOnly = { ...expert, input: ["text"] } as Model<Api>;
	assert.deepEqual(chooseDesignerModel([textOnly, complex], policies, true), { tier: "complex", model: complex });
});

test("an empty or exhausted designer allowlist never widens to arbitrary catalog models", () => {
	assert.equal(chooseDesignerModel([unrelated], policies, false), undefined);
	assert.equal(chooseDesignerModel([], policies, false), undefined);
	const emptyExpert = { ...policies, expert: { ...policies.expert, models: [] } };
	assert.deepEqual(chooseDesignerModel([expert, complex], emptyExpert, false), { tier: "complex", model: complex });
});

const editedWithoutPlan = { hasEditedFiles: true, hasSavedPlanThisTurn: false };

test("only a design task without a handoff or prior reminder is reminded", () => {
	const task = { id: "task-1", source: "plan_implementation" } as const;
	assert.equal(shouldRemindDesigner(task, false, false, "Done", editedWithoutPlan), true);
	assert.equal(shouldRemindDesigner(undefined, false, false, "Done", editedWithoutPlan), false);
	assert.equal(shouldRemindDesigner(task, true, false, "Done", editedWithoutPlan), false);
	assert.equal(shouldRemindDesigner(task, false, true, "Done", editedWithoutPlan), false);
});

test("a concrete blocker or question lets the designer return control to the user", () => {
	const task = { id: "task-1", source: "feature_build" } as const;
	assert.equal(shouldRemindDesigner(task, false, false, "Need one decision.\nDESIGN-BLOCKED: Which API should this use?", editedWithoutPlan), false);
	assert.equal(shouldRemindDesigner(task, false, false, "  DESIGN-BLOCKED: Repository unavailable", editedWithoutPlan), false);
});

test("the reminder needs file edits in the task and never follows a turn that saved a plan", () => {
	const task = { id: "task-1", source: "plan_implementation" } as const;
	assert.equal(shouldRemindDesigner(task, false, false, "Done", { hasEditedFiles: false, hasSavedPlanThisTurn: false }), false);
	assert.equal(shouldRemindDesigner(task, false, false, "Plan saved", { hasEditedFiles: true, hasSavedPlanThisTurn: true }), false);
	assert.equal(shouldRemindDesigner(task, false, false, "Plan saved", { hasEditedFiles: false, hasSavedPlanThisTurn: true }), false);
});

test("first-answer policy describes contracts, role boundaries, review and explicit blockers", () => {
	const instructions = designFirstInstructions();
	for (const fragment of ["hand_off_implementation", "approve_implementation", "@handoff-contract", "DESIGN-BLOCKED:"]) {
		assert.ok(instructions.includes(fragment), `missing ${fragment}`);
	}
	assert.match(instructions, /implementer/i);
	assert.match(instructions, /review/i);
	assert.match(instructions, /test/i);
});

test("an agreed plan to implement is saved to offer /build; the in-chat flow is for Not now or do it here", () => {
	const instructions = designFirstInstructions();
	for (const fragment of ["save_agreed_plan", "Not now", "do it here", "/build implement", "/build ship", "/build stop"]) {
		assert.ok(instructions.includes(fragment), `missing ${fragment}`);
	}
	const savePlanRule = instructions.indexOf("save_agreed_plan");
	assert.ok(savePlanRule >= 0 && savePlanRule < instructions.indexOf("Before implementation, settle the design"), "the save rule comes before the in-chat design steps");
});
