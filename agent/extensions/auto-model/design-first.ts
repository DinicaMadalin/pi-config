import type { Api, Model } from "@earendil-works/pi-ai";
import type { TaskKind } from "./classify-difficulty.ts";
import { pickModelForTier, type TierPolicies } from "./difficulty-tiers.ts";
import type { DesignTaskProgress } from "./implementation-handoff.ts";

export const DESIGN_REMINDER_ENTRY_TYPE = "auto-model-design-reminder";
export const DESIGN_BLOCKED_PREFIX = "DESIGN-BLOCKED:";
export type DesignSource = "plan_implementation" | "feature_build";
export interface DesignTask {
	id: string;
	source: DesignSource;
}

export function designSource(taskKind: TaskKind): DesignSource | undefined {
	if (taskKind === "plan_implementation" || taskKind === "feature_build") return taskKind;
	return undefined;
}

export function chooseDesignerModel(
	available: Model<Api>[],
	policies: TierPolicies,
	needsImageInput: boolean,
): { model: Model<Api>; tier: "expert" | "complex" } | undefined {
	const expert = pickModelForTier(available, policies.expert, needsImageInput);
	if (expert) return { model: expert.model, tier: "expert" };
	const complex = pickModelForTier(available, policies.complex, needsImageInput);
	return complex ? { model: complex.model, tier: "complex" } : undefined;
}

export function shouldRemindDesigner(
	task: DesignTask | undefined,
	hasHandoff: boolean,
	hasReminder: boolean,
	finalAnswer: string,
	progress: DesignTaskProgress,
): boolean {
	if (!task || hasHandoff || hasReminder || !progress.hasEditedFiles || progress.hasSavedPlanThisTurn) return false;
	return !finalAnswer.split(/\r?\n/).some((line) => /^\s*DESIGN-BLOCKED:/.test(line));
}

export function designFirstInstructions(): string {
	return [
		"## Default design-first implementation workflow",
		"When the user agrees with a plan and asks to implement it (for example, ‘okay, this is the plan, let's implement it’), save the agreed plan with `save_agreed_plan` and end the turn; saving offers the user a `/build` run with the designer, implementers, and reviewer, so do not start designing in that turn. Use this in-chat design-first flow only if the user answered that offer with ‘Not now’ or asks to ‘do it here’ in chat. If a plan was already saved in this chat and no `/build` run is open, the user chose ‘Not now’; without a `save_agreed_plan` tool, use the in-chat flow directly. If the system prompt contains an open `/build` run note, do not design or hand off: follow it, using `/build implement`, `/build ship`, or `/build stop` as directed.",
		"For a nontrivial request to implement a plan (including a rough plan discussed earlier) or build a substantial feature, first act as the designer. Refine the plan from repository evidence, keep its intent, and ask the user rather than inventing a business rule when a decision is missing. Questions, planning-only requests, and tiny mechanical edits remain ordinary tasks.",
		"Before implementation, settle the design: write exact function signatures with stub bodies and temporary @handoff-contract blocks as whole standalone comment lines. Each contract specifies behavior, edge cases, errors, invariants, changes forbidden, and concrete acceptance cases. Name or write the tests that prove the contracts and the exact checks to run. Preserve unrelated work. Do not write production function bodies before the handoff.",
		"Then call hand_off_implementation with the files, signatures, constraints, tests, and check commands. The implementer fills the stubs and runs the checks; it must not redesign the contracts. When it finishes, review its changes against the user request, contracts, tests, and real check results. Send precise fixes through another handoff when needed. Only after verification call approve_implementation to remove the temporary contract blocks, then rerun checks and report honestly.",
		"These role instructions apply only to the initial designer phase. After handoff, follow the implementer, reviewer, or no-change takeover instructions for that phase; never restart initial design or demand another handoff while reviewing or taking over. Existing no-change recovery remains in effect.",
		`If a real decision or prerequisite blocks progress, do not guess or claim completion: finish with a line beginning ${DESIGN_BLOCKED_PREFIX} that names the concrete question or failure, and ask/report it.`,
	].join("\n\n");
}
