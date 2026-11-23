/**
 * Design-first hand-off: on a complex or expert task the strong model designs the change (exact signatures with
 * stub bodies, each under a contract comment block), a cheaper model writes the bodies, and the strong model
 * reviews. On sign-off the contract blocks are deleted, so the files end up clean.
 *
 * Pure policy and texts; index.ts wires them into the router, the hooks and the tools.
 */
import type { DifficultyTier, RoutedThinkingLevel } from "./difficulty-tiers.ts";
import type { DesignTask } from "./design-first.ts";
import { SAVE_PLAN_TOOL_NAME } from "../project-memory/agreed-plan-files.ts";

export const HANDOFF_TOOL_NAME = "hand_off_implementation";
export const APPROVE_TOOL_NAME = "approve_implementation";
/** The tier that writes the code; the same ceiling /build gives its implementers. */
export const IMPLEMENTER_TIER: DifficultyTier = "standard";
/** Tiers expensive enough that writing code themselves wastes money. */
export const DESIGNER_TIERS: ReadonlySet<DifficultyTier> = new Set(["complex", "expert"]);
/** Review rounds are bounded: after this many hand-offs in one task the designer finishes the work itself. */
export const MAX_HANDOFFS_PER_TASK = 3;

export const CONTRACT_BEGIN_LINE = "@handoff-contract begin";
export const CONTRACT_END_LINE = "@handoff-contract end";
/** git grep pattern that finds files still holding a contract block. */
export const CONTRACT_SEARCH_PATTERN = "@handoff-contract[[:space:]]+begin";

export const REVIEW_REQUEST_MESSAGE_TYPE = "auto-model-review-request";
export const TAKE_OVER_MESSAGE_TYPE = "auto-model-take-over";
export const DESIGNER_NOTE_MESSAGE_TYPE = "auto-model-designer-note";
/** Leading tags let the router recognize these extension messages among the user-role messages of a request. */
const REVIEW_REQUEST_TAG = "[auto-model: review the implementation]";
const TAKE_OVER_TAG = "[auto-model: hand-off produced no change]";
const DESIGNER_NOTE_TAG = "[auto-model: you are the designer]";

/**
 * Tools the implementer may not call. A cheap model handed a long session tends to tidy its context or delegate
 * instead of writing the code, then ends its turn as if done.
 */
export const IMPLEMENTER_BLOCKED_TOOLS: ReadonlySet<string> = new Set([
	"compress",
	"decompress",
	"search_context",
	"acp_status",
	"acp_cache",
	"subagent",
	"subagent_supervisor",
	"contact_supervisor",
	"bg_wait",
]);
/** Tools whose successful result means the implementer wrote a file. */
const FILE_WRITING_TOOLS: ReadonlySet<string> = new Set(["edit", "write"]);

const VIRTUAL_MODEL_STATE_ENTRY_TYPE = "pi.virtual-model-state";

export interface DesignerModel {
	tier: DifficultyTier;
	modelKey: string;
	thinkingLevel?: RoutedThinkingLevel;
}

export interface ImplementationHandoff {
	/** taking-over: the implementer changed no file, so the designer finishes the work itself. */
	phase: "implementing" | "reviewing" | "taking-over";
	/** The model that designed the change; it reviews the implementation. */
	designer: DesignerModel;
	handoffCount: number;
}

/** The auto model's router state as Pi stores it on the session branch. */
export interface AutoRouteState {
	tier: DifficultyTier;
	modelKey: string;
	/** Absent in sessions routed before Jev picked thinking; the tier's level applies then. */
	thinkingLevel?: RoutedThinkingLevel;
	handoff?: ImplementationHandoff;
	/** Present only for default/explicit design-first tasks; preserved through implementation, review and failover. */
	designTask?: DesignTask;
}

interface SessionEntryLike {
	type: string;
	customType?: string;
	data?: unknown;
}

/** The latest auto/auto router state on the branch, or undefined before the first routed request. */
export function findAutoRouteState(branchEntries: readonly SessionEntryLike[]): AutoRouteState | undefined {
	for (let index = branchEntries.length - 1; index >= 0; index--) {
		const entry = branchEntries[index];
		if (entry.type !== "custom" || entry.customType !== VIRTUAL_MODEL_STATE_ENTRY_TYPE) continue;
		const stored = entry.data as { provider?: unknown; modelId?: unknown; state?: unknown } | undefined;
		if (stored?.provider !== "auto" || stored.modelId !== "auto") continue;
		const state = stored.state as Partial<AutoRouteState> | undefined;
		return typeof state?.tier === "string" && typeof state.modelKey === "string" ? (state as AutoRouteState) : undefined;
	}
	return undefined;
}

/** Why a model may not hand off right now; undefined when it may. */
export function handoffRefusal(state: AutoRouteState | undefined, isRoutingRestricted: boolean): string | undefined {
	if (isRoutingRestricted) return "Hand-off is off in this session (a /build phase or a tier ceiling decides the models); implement it yourself.";
	if (state?.handoff?.phase === "implementing") return "You are the implementer: write the bodies yourself and report; the reviewer checks your work afterwards.";
	if (!state || !DESIGNER_TIERS.has(state.tier)) return "Only the designer hands off: implement the change yourself.";
	if (state.handoff?.phase === "taking-over") {
		return `The last hand-off changed no file, so hand-off is off for this task: implement it yourself, then call ${APPROVE_TOOL_NAME}.`;
	}
	const handoffCount = state.handoff?.handoffCount ?? 0;
	if (handoffCount >= MAX_HANDOFFS_PER_TASK) {
		return `This task was already handed off ${handoffCount} times: finish the implementation yourself, then call ${APPROVE_TOOL_NAME}.`;
	}
	return undefined;
}

/** Why a model may not approve right now; undefined when it may. */
export function approvalRefusal(state: AutoRouteState | undefined): string | undefined {
	if (state?.handoff?.phase === "implementing") return "Only the reviewer can approve: report your work instead; the reviewer checks it next.";
	if (!state || !DESIGNER_TIERS.has(state.tier)) return "Only the designer or reviewer model can approve the implementation.";
	return undefined;
}

/** Why the implementer may not call this tool; undefined when it may, and always for everyone else. */
export function implementerToolRefusal(toolName: string, state: AutoRouteState | undefined): string | undefined {
	if (state?.handoff?.phase !== "implementing" || !IMPLEMENTER_BLOCKED_TOOLS.has(toolName)) return undefined;
	return `The implementer may not call ${toolName}: write the code the brief asks for, run its checks, then report.`;
}

interface MessageEntryLike {
	type: string;
	message?: { role?: string; toolName?: string; isError?: boolean; details?: unknown };
}

/** What the implementer did since the latest successful hand-off, as far as the session shows it. */
export interface ImplementerWork {
	/** The work tree's fingerprint when the hand-off happened; undefined outside git or when it could not be taken. */
	fingerprintAtHandoff: string | undefined;
	/** Successful edit and write tool results after the hand-off. */
	fileWriteCount: number;
}

/** Reads the implementer's work from the branch; undefined when no successful hand-off is on it. */
export function readImplementerWork(branchEntries: readonly MessageEntryLike[]): ImplementerWork | undefined {
	const isToolResult = (entry: MessageEntryLike, toolNames: ReadonlySet<string>): boolean =>
		entry.type === "message" && entry.message?.role === "toolResult" && toolNames.has(entry.message.toolName ?? "") && entry.message.isError !== true;
	const handoffIndex = branchEntries.findLastIndex((entry) => isToolResult(entry, new Set([HANDOFF_TOOL_NAME])));
	if (handoffIndex < 0) return undefined;
	const details = branchEntries[handoffIndex].message?.details as { workTreeFingerprint?: unknown } | undefined;
	const fingerprintAtHandoff = typeof details?.workTreeFingerprint === "string" ? details.workTreeFingerprint : undefined;
	const fileWriteCount = branchEntries.slice(handoffIndex + 1).filter((entry) => isToolResult(entry, FILE_WRITING_TOOLS)).length;
	return { fingerprintAtHandoff, fileWriteCount };
}

/** What the designer of a design-first task did so far; decides whether it gets the hand-off reminder. */
export interface DesignTaskProgress {
	/** A successful edit or write tool result since the task's first routed request. */
	hasEditedFiles: boolean;
	/** A successful save_agreed_plan tool result since the latest user message: the turn offered /build instead. */
	hasSavedPlanThisTurn: boolean;
}

interface DesignBranchEntry {
	type: string;
	customType?: string;
	data?: unknown;
	message?: { role?: string; toolName?: string; isError?: boolean };
}

export function readDesignTaskProgress(branchEntries: readonly DesignBranchEntry[], designTaskId: string): DesignTaskProgress {
	const taskStartIndex = branchEntries.findIndex((entry) => {
		if (entry.type !== "custom" || entry.customType !== VIRTUAL_MODEL_STATE_ENTRY_TYPE) return false;
		const storedState = entry.data as { provider?: unknown; modelId?: unknown; state?: unknown } | undefined;
		const routeState = storedState?.state as { designTask?: { id?: unknown } } | undefined;
		return storedState?.provider === "auto" && storedState.modelId === "auto" && routeState?.designTask?.id === designTaskId;
	});
	if (taskStartIndex < 0) return { hasEditedFiles: false, hasSavedPlanThisTurn: false };

	const taskEntries = branchEntries.slice(taskStartIndex + 1);
	const lastUserIndex = taskEntries.findLastIndex((entry) => entry.type === "message" && entry.message?.role === "user");
	const isSuccessfulToolResult = (entry: DesignBranchEntry, toolName: string): boolean =>
		entry.type === "message" &&
		entry.message?.role === "toolResult" &&
		entry.message.toolName === toolName &&
		entry.message.isError !== true;
	const hasEditedFiles = taskEntries.some((entry) => {
		const toolName = entry.message?.toolName;
		return toolName !== undefined && FILE_WRITING_TOOLS.has(toolName) && isSuccessfulToolResult(entry, toolName);
	});

	return {
		hasEditedFiles,
		hasSavedPlanThisTurn: taskEntries.slice(lastUserIndex + 1).some((entry) => isSuccessfulToolResult(entry, SAVE_PLAN_TOOL_NAME)),
	};
}

/**
 * Whether the implementer changed any file. The work-tree fingerprints decide when both exist, since bash can write
 * files too; without them only its edit and write tool calls count.
 */
export function hasImplementerChangedFiles(work: ImplementerWork, fingerprintNow: string | undefined): boolean {
	if (work.fingerprintAtHandoff !== undefined && fingerprintNow !== undefined) return work.fingerprintAtHandoff !== fingerprintNow;
	return work.fileWriteCount > 0;
}

interface MessageLike {
	role: string;
	content?: unknown;
	toolName?: string;
	isError?: boolean;
}

function textOf(message: MessageLike): string {
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return "";
	return message.content
		.flatMap((block: { type?: unknown; text?: unknown }) => (block.type === "text" && typeof block.text === "string" ? [block.text] : []))
		.join("\n");
}

/** The messages after the latest assistant response: tool results and user-role messages of this request. */
function messagesSinceLastResponse(messages: readonly MessageLike[]): readonly MessageLike[] {
	const lastResponseIndex = messages.findLastIndex((message) => message.role === "assistant");
	return messages.slice(lastResponseIndex + 1);
}

/** What this request means for the hand-off: start implementing, start reviewing, the designer takes over, or nothing. */
export type HandoffTransition = "implement" | "review" | "take-over" | undefined;

export function handoffTransition(messages: readonly MessageLike[], state: AutoRouteState | undefined): HandoffTransition {
	if (!state) return undefined;
	const newMessages = messagesSinceLastResponse(messages);
	const isHandedOff = newMessages.some((message) => message.role === "toolResult" && message.toolName === HANDOFF_TOOL_NAME && !message.isError);
	if (isHandedOff) return "implement";
	const isReviewRequested = newMessages.some((message) => message.role === "user" && textOf(message).startsWith(REVIEW_REQUEST_TAG));
	if (isReviewRequested && state.handoff?.phase === "implementing") return "review";
	const isTakeOverRequested = newMessages.some((message) => message.role === "user" && textOf(message).startsWith(TAKE_OVER_TAG));
	if (isTakeOverRequested && state.handoff?.phase === "implementing") return "take-over";
	return undefined;
}

/** Whether this request only follows the designer note, which must not re-rate the task. */
export function followsDesignerNote(messages: readonly MessageLike[]): boolean {
	return messagesSinceLastResponse(messages).some((message) => message.role === "user" && textOf(message).startsWith(DESIGNER_NOTE_TAG));
}

/** The router state after a transition; handoffCount counts the hand-offs of this task. */
export function handoffAfter(transition: Exclude<HandoffTransition, undefined>, state: AutoRouteState): ImplementationHandoff {
	const designer = state.handoff?.designer ?? { tier: state.tier, modelKey: state.modelKey, thinkingLevel: state.thinkingLevel };
	const handoffCount = state.handoff?.handoffCount ?? 0;
	if (transition === "implement") return { phase: "implementing", designer, handoffCount: handoffCount + 1 };
	if (transition === "take-over") return { phase: "taking-over", designer, handoffCount };
	return { phase: "reviewing", designer, handoffCount };
}

const CONTRACT_EXAMPLE = [
	"   ```ts",
	`   // ${CONTRACT_BEGIN_LINE}`,
	"   // collectCombatEvents: the ordered events of one resolved hit.",
	"   // - Rejected hit -> []. Otherwise HitResolved first; Evaded ends the list.",
	"   // - Then CriticalHit, BarrierBroken (barrier > 0 -> 0), Death (alive -> dead only).",
	"   // - Must not mutate the hit or change damage math.",
	"   // Acceptance: lethal crit on a shielded target -> [HitResolved, CriticalHit, BarrierBroken, Death].",
	`   // ${CONTRACT_END_LINE}`,
	"   export function collectCombatEvents(hit: ResolvedHit): CombatEvent[] {",
	'     throw new Error("not implemented");',
	"   }",
	"   ```",
];

/** Hidden note for a complex or expert model, sent after its first tool turn on a task. */
export function designerNote(): string {
	return [
		`${DESIGNER_NOTE_TAG} Design the change; an implementer writes the code.`,
		"If the task needs more than a few lines of code, once the design is settled:",
		"1. Write the design into the files: each new or changed function with its exact signature (the project's real",
		"   types) and a stub body, under a contract block of whole comment lines in the file's comment syntax:",
		...CONTRACT_EXAMPLE,
		"   The contract says the behavior, edge cases, invariants, what must not change, and acceptance cases. Settle",
		"   every decision there (where data comes from, error messages); the implementer must not design anything.",
		"2. Name or write the tests that prove it, and the check commands.",
		`3. Call ${HANDOFF_TOOL_NAME} with the brief: the files and functions to fill, constraints, and the checks to run.`,
		"   Then end your turn: the implementer works next, and you review its work afterwards.",
		"For a question, a plan, or a tiny edit, ignore this note and just answer.",
	].join("\n");
}

/** The hand-off tool's result: the first thing the implementer reads. */
export function implementerBrief(brief: string): string {
	return [
		"Handed off. You are now the implementer; the designer reviews your work when you finish.",
		"",
		"## Brief from the designer",
		"",
		brief.trim(),
		"",
		"## Rules",
		`- Fill in every stub under a \`${CONTRACT_BEGIN_LINE}\` block so it does exactly what its contract says.`,
		"- Keep the signatures and the contract blocks unchanged; the reviewer removes the blocks after sign-off.",
		"- Write or finish the tests the brief names, then run the checks and fix what fails.",
		"- If a contract is wrong, unclear or contradicts the code, do not redesign it: stop and say what you found (file:line).",
		`- Start on the code at once. Do not call context or delegation tools (${[...IMPLEMENTER_BLOCKED_TOOLS].join(", ")}): they are blocked while you implement.`,
		"- Do not end your turn before you edited the files and ran the checks. A turn that changes no file counts as not done",
		"  and the task goes back to the designer.",
		"- Finish with a short report: what you implemented, the commands you ran with their real results, open doubts.",
	].join("\n");
}

/** Sent when the implementer settles: the designer takes over again as reviewer. */
export function reviewRequest(): string {
	return [
		`${REVIEW_REQUEST_TAG} The implementer finished; its report is above. Review its work:`,
		"1. Read the changed code against each contract block and the user's request; run the tests and checks yourself.",
		`2. If anything is wrong or missing, call ${HANDOFF_TOOL_NAME} again with exact fix steps (file, function, the`,
		"   change, the test that proves it). Keep the contract blocks while fixes are pending.",
		`3. If the user must decide something, ask them and keep the contract blocks. Otherwise, once the code is correct,`,
		`   call ${APPROVE_TOOL_NAME}: it deletes the contract blocks. Then rerun the checks and report to the user.`,
		"4. If the implementer left part of the brief undone, do not send the same brief again: write that part yourself.",
	].join("\n");
}

/** Sent instead of the review request when the implementer changed no file: the designer finishes the work. */
export function takeOverRequest(): string {
	return [
		`${TAKE_OVER_TAG} The implementer ended its turn without changing any file: the brief was not implemented.`,
		`Do not call ${HANDOFF_TOOL_NAME} again: it is refused for this task.`,
		"If the implementer reported a blocker (a wrong or unclear contract, a failing prerequisite, or a missing decision), that blocker is yours to resolve first: fix the contract from repository evidence and continue, or, when only the user can decide, ask them and end with a line starting DESIGN-BLOCKED: that names the question, keeping the contract blocks.",
		"1. Implement the brief yourself: fill the stubs as their contract blocks say, write the tests, run the checks.",
		`2. Call ${APPROVE_TOOL_NAME} to delete the contract blocks, rerun the checks, and tell the user that the`,
		"   implementer changed nothing and you wrote the code yourself.",
	].join("\n");
}

const COMMENT_LEAD = String.raw`(?:\/\/+|#+|--|;+|\/\*+|\*+|<!--|"""|''')?`;
const CONTRACT_MARKER_LINE = new RegExp(String.raw`^\s*${COMMENT_LEAD}\s*@handoff-contract\s+(begin|end)\b`, "i");

export type ContractRemoval =
	| { kind: "cleaned"; text: string; removedBlockCount: number }
	| { kind: "malformed"; reason: string };

/** Deletes every contract block, marker lines included; a block without its partner leaves the text untouched. */
export function removeContractBlocks(text: string): ContractRemoval {
	const lines = text.split(/(?<=\n)/);
	const keptLines: string[] = [];
	let openedAtLine: number | undefined;
	let removedBlockCount = 0;
	for (const [index, line] of lines.entries()) {
		const marker = CONTRACT_MARKER_LINE.exec(line)?.[1]?.toLowerCase();
		const lineNumber = index + 1;
		if (marker === "begin") {
			if (openedAtLine !== undefined) return { kind: "malformed", reason: `line ${lineNumber} opens a contract block inside the one opened at line ${openedAtLine}` };
			openedAtLine = lineNumber;
			continue;
		}
		if (marker === "end") {
			if (openedAtLine === undefined) return { kind: "malformed", reason: `line ${lineNumber} closes a contract block that was never opened` };
			openedAtLine = undefined;
			removedBlockCount++;
			continue;
		}
		if (openedAtLine === undefined) keptLines.push(line);
	}
	if (openedAtLine !== undefined) return { kind: "malformed", reason: `the contract block opened at line ${openedAtLine} is never closed` };
	return { kind: "cleaned", text: keptLines.join(""), removedBlockCount };
}
