/**
 * Pure state machine of the /build workflow: plan (expert, in your session) -> implement (a subagent, model
 * picked by difficulty) -> review (two expert subagents, one on Claude and one on OpenAI, in parallel) -> at
 * most one fix (the implementer again) and re-review (both reviewers again). The implementer's questions go to the planner, which answers or asks you.
 * Work started from a GitHub issue (/issue) waits for the user to open a draft PR after a passing review;
 * other /build work waits for the user to ship it (new branch, commit, push).
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
}

export type WorkflowState =
	| { phase: "idle" }
	| { phase: "plan"; task: string; issue?: IssueRef }
	| { phase: "awaiting-implementation"; task: string; planPath: string; issue?: IssueRef }
	| ({ phase: "implement" } & FeatureWork)
	| ({ phase: "review" } & FeatureWork)
	| ({ phase: "fix" } & FeatureWork)
	| ({ phase: "re-review" } & FeatureWork)
	| ({ phase: "awaiting-pr" } & FeatureWork & { issue: IssueRef })
	| ({ phase: "awaiting-ship" } & FeatureWork);

export type WorkflowPhase = WorkflowState["phase"];

export const IDLE_WORKFLOW: WorkflowState = { phase: "idle" };

/** Route of a subagent's session: the reviewer uses the expert; Jev picks the implementer's model by difficulty. */
export function routeForPhase(phase: WorkflowPhase): RoutePin {
	switch (phase) {
		case "plan":
		case "awaiting-implementation":
		case "review":
		case "re-review":
			return { route: "tier", tier: "expert" };
		case "implement":
		case "fix":
			return { route: "difficulty" };
		case "idle":
		case "awaiting-pr":
		case "awaiting-ship":
			return { route: "normal" };
	}
}

/** A reviewer's route: the expert tier with its vendor's models first, the other vendor's as fallback. */
export function reviewerRoute(vendor: ReviewerVendor): RoutePin {
	return { route: "tier", tier: "expert", preferredProvider: vendor };
}

/** The run's work is reviewed and waits for the user: a draft PR for /issue, shipping for /build. */
export function isAwaitingUserRelease(phase: WorkflowPhase): phase is "awaiting-pr" | "awaiting-ship" {
	return phase === "awaiting-pr" || phase === "awaiting-ship";
}

/** Route of the planner's session: the expert for the whole run, since it answers the implementer's questions. */
export function plannerRouteForPhase(phase: WorkflowPhase): RoutePin {
	return phase === "idle" || isAwaitingUserRelease(phase) ? { route: "normal" } : { route: "tier", tier: "expert" };
}

/** In a subagent's session: only the implementer edits; the reviewer must not change files. */
export function canEditFiles(phase: WorkflowPhase): boolean {
	return phase === "idle" || phase === "implement" || phase === "fix" || isAwaitingUserRelease(phase);
}

/** In the planner's session: no edits while a run is on, so the planner never races the implementer. */
export function canPlannerEditFiles(phase: WorkflowPhase): boolean {
	return phase === "idle" || isAwaitingUserRelease(phase);
}

/** The run is in a subagent's hands: implementing, reviewing or fixing. */
export function isDelegatedPhase(phase: WorkflowPhase): phase is "implement" | "review" | "fix" | "re-review" {
	return phase === "implement" || phase === "review" || phase === "fix" || phase === "re-review";
}

interface SessionEntryLike {
	type: string;
	customType?: string;
	data?: unknown;
}

export function findWorkflowState(branchEntries: readonly SessionEntryLike[]): WorkflowState {
	for (let index = branchEntries.length - 1; index >= 0; index--) {
		const entry = branchEntries[index];
		if (entry.type === "custom" && entry.customType === WORKFLOW_STATE_ENTRY_TYPE) return entry.data as WorkflowState;
	}
	return IDLE_WORKFLOW;
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

/** What the workflow does after an agent turn settles in a phase. */
export type WorkflowStep =
	| { kind: "wait"; reason: string }
	| { kind: "ask-planner"; implementerAnswer: string }
	| { kind: "advance"; next: WorkflowState }
	| { kind: "finish"; summary: string };

function featureWorkOf(state: FeatureWork): FeatureWork {
	const work: FeatureWork = { planPath: state.planPath, baseCommit: state.baseCommit };
	if (state.issue) work.issue = state.issue;
	if (state.planIssue) work.planIssue = state.planIssue;
	if (state.implementerSession) work.implementerSession = state.implementerSession;
	if (state.reviewerSessions) work.reviewerSessions = state.reviewerSessions;
	return work;
}

/** After a passing review the user releases the work: /issue opens a draft PR, /build ships a branch. */
function stepAfterPassingReview(work: FeatureWork): WorkflowStep {
	if (!work.issue) return { kind: "advance", next: { phase: "awaiting-ship", ...featureWorkOf(work) } };
	return { kind: "advance", next: { phase: "awaiting-pr", ...featureWorkOf(work), issue: work.issue } };
}

/** What a subagent's settled turn means for the run; the implementer's questions and stalls go to the planner. */
export function stepAfterTurn(state: WorkflowState, lastAnswer: string): WorkflowStep {
	switch (state.phase) {
		case "idle":
		case "plan":
		case "awaiting-implementation":
			return { kind: "wait", reason: "the plan needs your agreement" };
		case "awaiting-pr":
			return { kind: "wait", reason: "run /issue pr to open the draft pull request" };
		case "awaiting-ship":
			return { kind: "wait", reason: "run /build ship to commit and push the work on a new branch" };
		case "implement":
		case "fix": {
			const marker = lastMarker(lastAnswer, [IMPLEMENTATION_DONE_MARKER, IMPLEMENTATION_BLOCKED_MARKER]);
			if (marker !== IMPLEMENTATION_DONE_MARKER) return { kind: "ask-planner", implementerAnswer: lastAnswer };
			return { kind: "advance", next: { phase: state.phase === "implement" ? "review" : "re-review", ...featureWorkOf(state) } };
		}
		case "review": {
			const verdict = lastMarker(lastAnswer, [REVIEW_PASS_MARKER, REVIEW_FIX_MARKER]);
			if (verdict === REVIEW_PASS_MARKER) return stepAfterPassingReview(state);
			if (verdict === REVIEW_FIX_MARKER) {
				return { kind: "advance", next: { phase: "fix", ...featureWorkOf(state) } };
			}
			return { kind: "wait", reason: "the review ended without a verdict" };
		}
		case "re-review": {
			const verdict = lastMarker(lastAnswer, [REVIEW_PASS_MARKER, REVIEW_FIX_MARKER]);
			if (verdict === REVIEW_PASS_MARKER) return stepAfterPassingReview(state);
			return { kind: "finish", summary: "the re-review still has findings; the fix round is used up, over to you" };
		}
	}
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

/** A subagent stage that finished, stored in the planner's session for the agents overview and the report. */
export interface StageRecord {
	stage: "implement" | "review" | "fix" | "re-review";
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
