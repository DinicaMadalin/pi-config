/** The orchestrator's view of the planner's session (PlannerSeat), built on the Pi API. */
import { tmpdir } from "node:os";
import type { PlannerSeat } from "./build-orchestrator.ts";
import type { PlannerSession } from "./planner-session.ts";
import { findRuleFiles } from "./repo-files.ts";
import type { SubagentDialogs } from "./subagent-process.ts";
import { loadWorkChanges } from "./work-changes.ts";
import { BUILD_STAGE_ENTRY_TYPE, type StageRecord, stageRecordsSince, type WorkflowState } from "./workflow-state.ts";

const REPORT_MESSAGE_TYPE = "build-report";

/**
 * The subagents' dialogs, one at a time: two reviewers asking at once would otherwise stack dialogs over each other.
 */
function queuedDialogs(session: PlannerSession): SubagentDialogs {
	let previousDialog: Promise<unknown> = Promise.resolve();
	function enqueue<Answer>(open: () => Promise<Answer>, answerWithoutUI: Answer): Promise<Answer> {
		const dialog = previousDialog.then(() => (session.hasUI ? open() : answerWithoutUI));
		previousDialog = dialog.catch(() => undefined);
		return dialog;
	}
	return {
		select: (title, options) => enqueue(() => session.context.ui.select(title, options), undefined),
		confirm: (title, message) => enqueue(() => session.context.ui.confirm(title, message), false),
		input: (title, placeholder) => enqueue(() => session.context.ui.input(title, placeholder), undefined),
	};
}

function describeCount(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

export function createPlannerSeat(session: PlannerSession, finish: (next: WorkflowState, summary: string) => void): PlannerSeat {
	const pi = session.pi;
	const branch = () => session.context.sessionManager.getBranch();
	return {
		cwd: () => session.context.cwd,
		sessionDirectory: () => (session.context.sessionManager.getSessionFile() ? session.context.sessionManager.getSessionDir() : tmpdir()),
		plannerSessionPath: () => session.context.sessionManager.getSessionFile(),
		state: () => session.workflow,
		enterPhase: (next) => session.enterPhase(next),
		appendStage: (record) => pi.appendEntry<StageRecord>(BUILD_STAGE_ENTRY_TYPE, record),
		runStageRecords: () => stageRecordsSince(branch(), (state) => state.phase === "plan" || state.phase === "awaiting-implementation"),
		currentStageRecords: () => {
			const phase = session.workflow.phase;
			return stageRecordsSince(branch(), (state) => state.phase !== phase);
		},
		readPlan: (planPath) => session.readPlan(planPath),
		ruleFiles: () => findRuleFiles(session.run, session.context.cwd),
		describeChanges: async (baseCommit) => {
			if (!baseCommit) return undefined;
			const changes = await loadWorkChanges(session.run, baseCommit);
			if (!changes.ok) return `could not be counted (${changes.error})`;
			const { added, removed, files } = changes.value;
			return `+${added} −${removed} in ${describeCount(files.length, "file")}`;
		},
		askPlanner: (prompt) => session.sendToPlanner(prompt),
		postReport: (report) => pi.sendMessage({ customType: REPORT_MESSAGE_TYPE, content: report, display: true }),
		notify: (message, level) => session.notify(message, level),
		finish,
		dialogs: queuedDialogs(session),
	};
}
