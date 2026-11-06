/**
 * Pure state machine of the /build workflow: plan (expert, in your session) -> implement (a subagent, model
 * picked by difficulty) -> review (two expert subagents, one on Claude and one on OpenAI, in parallel) -> at
 * most one fix (the implementer again) and re-review (both reviewers again). The implementer's questions go to
 * the planner, which answers or asks you. A re-review that still has findings waits for your decision.
 * Work started from a GitHub issue (/issue) waits for the user to open a draft PR after a passing review;
 * other /build work waits for the user to ship it (new branch, commit, push).
 * A plan saved again during a run is a plan change; planChangeReaction says what each phase does with it.
 * No Pi runtime imports, so every transition can be unit tested.
 */
import type { RoutePin } from "../auto-model/route-pin.ts";

export const WORKFLOW_STATE_ENTRY_TYPE = "build-workflow-state";

/** Marker lines the agent ends a turn with; the workflow reads them to move to the next phase. */
export const IMPLEMENTATION_DONE_MARKER = "IMPLEMENTATION: done";
export const IMPLEMENTATION_BLOCKED_MARKER = "IMPLEMENTATION: blocked";
export const REVIEW_PASS_MARKER = "REVIEW_VERDICT: pass";
export const REVIEW_FIX_MARKER = "REVIEW_VERDICT: fix";
/** The planner ends its answer to an implementer question with one of these. */
export const PLANNER_ANSWER_READY_MARKER = "IMPLEMENTER_ANSWER: ready";
export const PLANNER_NEEDS_USER_MARKER = "IMPLEMENTER_ANSWER: needs-user";

/** Set in the environment of the subagent processes, so their build-workflow only guards file edits. */
export const SUBAGENT_ENV_VAR = "PI_BUILD_SUBAGENT";

/** A GitHub issue the run works from. */
export interface TrackedIssue {
	number: number;
	title: string;
	url: string;
}

/** The GitHub issue an /issue run fixes, and the branch created for it from the default branch. */
export interface IssueRef extends TrackedIssue {
	branch: string;
	/** Default branch the work branched from and the PR targets, e.g. "main". */
	baseBranch: string;
}

/** Each review is done twice, by an expert of each vendor, so one vendor's blind spots do not pass unseen. */
export const REVIEWER_VENDORS = ["anthropic", "openai"] as const;
/** Also the Pi provider the reviewer's route prefers. */
export type ReviewerVendor = (typeof REVIEWER_VENDORS)[number];

export type SubagentRole = "implementer" | `${ReviewerVendor}-reviewer`;

export const REVIEWER_NAMES: Record<ReviewerVendor, string> = { anthropic: "Claude reviewer", openai: "OpenAI reviewer" };

export const SUBAGENT_NAMES: Record<SubagentRole, string> = {
	implementer: "Implementer",
	"anthropic-reviewer": REVIEWER_NAMES.anthropic,
	"openai-reviewer": REVIEWER_NAMES.openai,
};

export function reviewerRole(vendor: ReviewerVendor): SubagentRole {
	return `${vendor}-reviewer`;
}

export interface FeatureWork {
	planPath: string;
	/** HEAD when implementation started; the reviewer diffs against it. Undefined outside a git repo. */
	baseCommit?: string;
	issue?: IssueRef;
	/** The issue /build posted the agreed plan to; the implementer and reviewer read the plan from it. */
	planIssue?: TrackedIssue;
	/** Session files of the subagents, so a reload can resume them with their context. */
	implementerSession?: string;
	reviewerSessions?: Partial<Record<ReviewerVendor, string>>;
	/** The plan's version since implementation started: missing for the first, 2 after the first change. */
	planRevision?: number;
	/** Shipping committed the work on this branch but has not pushed it yet; shipping again only pushes. */
	committedBranch?: string;
}

/** Phases where the subagents work. */
export type DelegatedPhase = "implement" | "review" | "fix" | "re-review";
export const DELEGATED_PHASES: readonly DelegatedPhase[] = ["implement", "review", "fix", "re-review"];

export type ReviewPhase = "review" | "re-review";

export type WorkflowState =
	| { phase: "idle" }
	| { phase: "plan"; task: string; issue?: IssueRef }
	| { phase: "awaiting-implementation"; task: string; planPath: string; issue?: IssueRef }
	| ({ phase: "implement" | "fix" } & FeatureWork)
	/** planChangeAfterReview: the plan changed during the review; its outcome goes into a change round. */
	| ({ phase: ReviewPhase; planChangeAfterReview?: boolean } & FeatureWork)
	/** The re-review still has findings and the fix round is used up: you decide what happens next. */
	| ({ phase: "review-failed"; findings: string } & FeatureWork)
	| ({ phase: "awaiting-pr" } & FeatureWork & { issue: IssueRef })
	| ({ phase: "awaiting-ship" } & FeatureWork);

export type WorkflowPhase = WorkflowState["phase"];
export type DelegatedState = Extract<WorkflowState, { phase: DelegatedPhase }>;
/** States once implementation started: they carry the run's plan, commit and subagent sessions. */
export type FeatureState = Extract<WorkflowState, { phase: DelegatedPhase | "review-failed" | "awaiting-pr" | "awaiting-ship" }>;

const WORKFLOW_PHASES: readonly WorkflowPhase[] = [
	"idle",
	"plan",
	"awaiting-implementation",
	...DELEGATED_PHASES,
	"review-failed",
	"awaiting-pr",
	"awaiting-ship",
];

export const IDLE_WORKFLOW: WorkflowState = { phase: "idle" };

/** The run is in a subagent's hands: implementing, reviewing or fixing. */
export function isDelegatedState(state: WorkflowState): state is DelegatedState {
	return (DELEGATED_PHASES as readonly WorkflowPhase[]).includes(state.phase);
}

export function isDelegatedPhase(phase: WorkflowPhase): phase is DelegatedPhase {
	return (DELEGATED_PHASES as readonly WorkflowPhase[]).includes(phase);
}

/** Implementation started: the state carries the run's plan, commit and subagent sessions. */
export function isFeatureState(state: WorkflowState): state is FeatureState {
	return isDelegatedState(state) || isAwaitingUser(state.phase);
}

/** The run waits for you: a decision after a failed re-review, a draft PR for /issue, shipping for /build. */
export function isAwaitingUser(phase: WorkflowPhase): phase is "review-failed" | "awaiting-pr" | "awaiting-ship" {
	return phase === "review-failed" || phase === "awaiting-pr" || phase === "awaiting-ship";
}

/** Route of a subagent's session: the reviewer uses the expert; Jev picks the implementer's model by difficulty. */
export function routeForPhase(phase: WorkflowPhase): RoutePin {
	if (phase === "implement" || phase === "fix") return { route: "difficulty" };
	if (phase === "review" || phase === "re-review") return { route: "tier", tier: "expert" };
	return plannerRouteForPhase(phase);
}

/** A reviewer's route: the expert tier with its vendor's models first, the other vendor's as fallback. */
export function reviewerRoute(vendor: ReviewerVendor): RoutePin {
	return { route: "tier", tier: "expert", preferredProvider: vendor };
}

/** Route of the planner's session: the expert for the whole run, since it answers the implementer's questions. */
export function plannerRouteForPhase(phase: WorkflowPhase): RoutePin {
	return phase === "idle" || isAwaitingUser(phase) ? { route: "normal" } : { route: "tier", tier: "expert" };
}

/** In a subagent's session: only the implementer edits; the reviewers must not change files. */
export function canEditFiles(phase: WorkflowPhase): boolean {
	return phase === "idle" || phase === "implement" || phase === "fix";
}

/**
 * In the planner's session: no edits during a run, so the planner never races the implementer and nothing
 * unreviewed gets shipped. Changes go through the plan: saving it again starts a change round.
 */
export function canPlannerEditFiles(phase: WorkflowPhase): boolean {
	return phase === "idle";
}

interface SessionEntryLike {
	type: string;
	customType?: string;
	data?: unknown;
}

/** A stored state, or undefined when the entry data is not one (e.g. written by an older version). */
function parseWorkflowState(data: unknown): WorkflowState | undefined {
	if (typeof data !== "object" || data === null) return undefined;
	const phase = (data as { phase?: unknown }).phase;
	if (!WORKFLOW_PHASES.includes(phase as WorkflowPhase)) return undefined;
	if (phase !== "idle" && phase !== "plan" && typeof (data as { planPath?: unknown }).planPath !== "string") return undefined;
	return data as WorkflowState;
}

export function findWorkflowState(branchEntries: readonly SessionEntryLike[]): WorkflowState {
	for (let index = branchEntries.length - 1; index >= 0; index--) {
		const entry = branchEntries[index];
		if (entry.type !== "custom" || entry.customType !== WORKFLOW_STATE_ENTRY_TYPE) continue;
		return parseWorkflowState(entry.data) ?? IDLE_WORKFLOW;
	}
	return IDLE_WORKFLOW;
}

/**
 * The run the planner's session is in. A subagent's session starts in its own stage (implement, review), and
 * /resume lists it like any session; opened by hand it is a plain session, so its stage must not block edits
 * there or pass for an interrupted run. A /build started in it later counts again.
 */
export function findPlannerWorkflowState(branchEntries: readonly SessionEntryLike[]): WorkflowState {
	const states = branchEntries
		.filter((entry) => entry.type === "custom" && entry.customType === WORKFLOW_STATE_ENTRY_TYPE)
		.map((entry) => parseWorkflowState(entry.data));
	const firstState = states[0];
	const isSubagentSession = firstState !== undefined && isDelegatedPhase(firstState.phase);
	if (!isSubagentSession) return findWorkflowState(branchEntries);
	const hasPlannerRun = states.some((state) => state?.phase === "plan" || state?.phase === "awaiting-implementation");
	return hasPlannerRun ? findWorkflowState(branchEntries) : IDLE_WORKFLOW;
}

/** The plan of the session's last run that got as far as an agreed plan, e.g. to start a new run from it. */
export function findLastRunPlan(branchEntries: readonly SessionEntryLike[]): { task: string; planPath: string } | undefined {
	for (let index = branchEntries.length - 1; index >= 0; index--) {
		const entry = branchEntries[index];
		if (entry.type !== "custom" || entry.customType !== WORKFLOW_STATE_ENTRY_TYPE) continue;
		const state = parseWorkflowState(entry.data);
		if (state?.phase === "awaiting-implementation") return { task: state.task, planPath: state.planPath };
	}
	return undefined;
}

/** Last marker line wins, so a quoted marker earlier in the answer does not count. */
function lastMarker(answer: string, markers: readonly string[]): string | undefined {
	const markerLines = answer
		.split("\n")
		.map((line) => line.trim().replace(/^[`*_]+|[`*_]+$/g, ""))
		.filter((line) => markers.some((marker) => line.startsWith(marker)));
	const lastLine = markerLines.at(-1);
	return markers.find((marker) => lastLine?.startsWith(marker));
}

export function hasReviewVerdict(answer: string): boolean {
	return lastMarker(answer, [REVIEW_PASS_MARKER, REVIEW_FIX_MARKER]) !== undefined;
}

/** What the workflow does after an agent turn settles in a phase. */
export type WorkflowStep =
	| { kind: "wait"; reason: string }
	| { kind: "ask-planner"; implementerAnswer: string }
	| { kind: "advance"; next: WorkflowState };

/** The run's lasting facts, without the fields that only belong to one phase. */
export function featureWorkOf(state: FeatureWork): FeatureWork {
	const work: FeatureWork = { planPath: state.planPath, baseCommit: state.baseCommit };
	if (state.issue) work.issue = state.issue;
	if (state.planIssue) work.planIssue = state.planIssue;
	if (state.implementerSession) work.implementerSession = state.implementerSession;
	if (state.reviewerSessions) work.reviewerSessions = state.reviewerSessions;
	if (state.planRevision) work.planRevision = state.planRevision;
	if (state.committedBranch) work.committedBranch = state.committedBranch;
	return work;
}

/** After a passing review the user releases the work: /issue opens a draft PR, /build ships a branch. */
export function releaseStateOf(work: FeatureWork): WorkflowState {
	if (!work.issue) return { phase: "awaiting-ship", ...featureWorkOf(work) };
	return { phase: "awaiting-pr", ...featureWorkOf(work), issue: work.issue };
}

/** What a subagent stage's settled turn means for the run; the implementer's questions and stalls go to the planner. */
export function stepAfterTurn(state: DelegatedState, stageAnswer: string): WorkflowStep {
	switch (state.phase) {
		case "implement":
		case "fix": {
			const marker = lastMarker(stageAnswer, [IMPLEMENTATION_DONE_MARKER, IMPLEMENTATION_BLOCKED_MARKER]);
			if (marker !== IMPLEMENTATION_DONE_MARKER) return { kind: "ask-planner", implementerAnswer: stageAnswer };
			return { kind: "advance", next: { phase: state.phase === "implement" ? "review" : "re-review", ...featureWorkOf(state) } };
		}
		case "review":
		case "re-review": {
			if (state.planChangeAfterReview) return { kind: "advance", next: { phase: "implement", ...featureWorkOf(state) } };
			const verdict = lastMarker(stageAnswer, [REVIEW_PASS_MARKER, REVIEW_FIX_MARKER]);
			if (verdict === REVIEW_PASS_MARKER) return { kind: "advance", next: releaseStateOf(state) };
			if (verdict === undefined) return { kind: "wait", reason: "a reviewer ended without a verdict" };
			if (state.phase === "review") return { kind: "advance", next: { phase: "fix", ...featureWorkOf(state) } };
			return { kind: "advance", next: { phase: "review-failed", ...featureWorkOf(state), findings: stageAnswer } };
		}
	}
}

/**
 * What saving the plan again means in each phase:
 * - ask-to-start: still planning, so you are asked how to start (again)
 * - tell-implementer: the implementer gets the change right away
 * - ask-about-review: the reviewers check the old plan; you choose to stop them or apply the change after them
 * - change-round: the work was reviewed; the implementer applies the change and both reviewers review again
 * - offer-new-run: no run is on; you may start a new one from the saved plan
 */
export type PlanChangeReaction = "ask-to-start" | "tell-implementer" | "ask-about-review" | "change-round" | "offer-new-run";

export function planChangeReaction(phase: WorkflowPhase): PlanChangeReaction {
	switch (phase) {
		case "plan":
		case "awaiting-implementation":
			return "ask-to-start";
		case "implement":
		case "fix":
			return "tell-implementer";
		case "review":
		case "re-review":
			return "ask-about-review";
		case "review-failed":
		case "awaiting-pr":
		case "awaiting-ship":
			return "change-round";
		case "idle":
			return "offer-new-run";
	}
}

/** The run's state once a plan change was counted. */
export function withPlanRevision<State extends FeatureWork>(state: State): State {
	return { ...state, planRevision: (state.planRevision ?? 1) + 1 };
}

export interface ReviewerAnswer {
	vendor: ReviewerVendor;
	answer: string;
}

/**
 * Both reviewers' reports as one answer that ends with the joint verdict: pass only when every reviewer
 * passes, fix when any asks for fixes, no verdict when a reviewer gave none and nobody asked for fixes.
 */
export function mergeReviews(reviews: readonly ReviewerAnswer[]): string {
	const verdicts = reviews.map((review) => lastMarker(review.answer, [REVIEW_PASS_MARKER, REVIEW_FIX_MARKER]));
	const reports = reviews.map((review) => {
		const report = review.answer
			.split("\n")
			.filter((line) => !line.includes(REVIEW_PASS_MARKER) && !line.includes(REVIEW_FIX_MARKER))
			.join("\n")
			.trim();
		return `## ${REVIEWER_NAMES[review.vendor]}\n\n${report}`;
	});
	const jointVerdict = verdicts.includes(REVIEW_FIX_MARKER)
		? REVIEW_FIX_MARKER
		: verdicts.length > 0 && verdicts.every((verdict) => verdict === REVIEW_PASS_MARKER)
			? REVIEW_PASS_MARKER
			: undefined;
	return [...reports, ...(jointVerdict ? [jointVerdict] : [])].join("\n\n");
}

export type PlannerAnswer = { kind: "ready"; answer: string } | { kind: "needs-user" } | { kind: "none" };

/** Reads the planner's reply to an implementer question; the answer is the reply without its marker line. */
export function readPlannerAnswer(reply: string): PlannerAnswer {
	const marker = lastMarker(reply, [PLANNER_ANSWER_READY_MARKER, PLANNER_NEEDS_USER_MARKER]);
	if (marker === PLANNER_NEEDS_USER_MARKER) return { kind: "needs-user" };
	if (marker !== PLANNER_ANSWER_READY_MARKER) return { kind: "none" };
	const answer = reply
		.split("\n")
		.filter((line) => !line.includes(PLANNER_ANSWER_READY_MARKER))
		.join("\n")
		.trim();
	return { kind: "ready", answer };
}

export const BUILD_STAGE_ENTRY_TYPE = "build-workflow-stage";

/** The run report, posted to the planner's session as a custom message when a run ends or waits for you. */
export const REPORT_MESSAGE_TYPE = "build-report";

/** A subagent stage that finished, stored in the planner's session for the agents overview and the report. */
export interface StageRecord {
	stage: DelegatedPhase;
	/** Which reviewer, in the review stages. */
	reviewer?: ReviewerVendor;
	model?: string;
	thinkingLevel?: string;
	routeReason?: string;
	activeMs: number;
	costUsd: number;
	/** The subagent's last answer: its report, or the review's findings. */
	report: string;
}

/**
 * Stage records stored after the latest state for which isBefore holds, oldest first. E.g. the run's records
 * stop at its plan phase; the current review's records stop at the first state of another phase.
 */
export function stageRecordsSince(branchEntries: readonly SessionEntryLike[], isBefore: (state: WorkflowState) => boolean): StageRecord[] {
	const records: StageRecord[] = [];
	for (let index = branchEntries.length - 1; index >= 0; index--) {
		const entry = branchEntries[index];
		if (entry.type !== "custom") continue;
		if (entry.customType === BUILD_STAGE_ENTRY_TYPE) records.unshift(entry.data as StageRecord);
		if (entry.customType !== WORKFLOW_STATE_ENTRY_TYPE) continue;
		const state = parseWorkflowState(entry.data);
		if (state && isBefore(state)) break;
	}
	return records;
}
