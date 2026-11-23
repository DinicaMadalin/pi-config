/** The main chat's way to end a /build run when the user asks, with the same effect as /build stop. */
import { isAwaitingUser, type WorkflowPhase } from "./workflow-state.ts";

export const STOP_TOOL_NAME = "stop_build";

export interface StopBuildRequest {
	phase: WorkflowPhase;
	hasUI: boolean;
	/** Asks the user; true when they agree to stop. */
	confirmStop: (phase: WorkflowPhase) => Promise<boolean>;
	/** Ends the run like /build stop: agents stop, routing returns to normal, the worktree and its changes stay. */
	endRun: () => void;
}

/**
 * A run that only waits on the user stops at once. While agents still work, the user confirms first, so a misread
 * chat message cannot kill work in progress; without a UI to ask, it refuses.
 */
export async function stopBuildFromChat(request: StopBuildRequest): Promise<string> {
	const { phase } = request;
	if (phase === "idle") return "No /build run is open; nothing to stop";
	if (isAwaitingUser(phase)) {
		request.endRun();
		return `Stopped the /build run (it was waiting on the user in the ${phase} phase); its changes stay uncommitted`;
	}
	if (!request.hasUI) return `Not stopped: agents are still working (${phase} phase) and this session has no UI to confirm; use /build stop`;
	if (!(await request.confirmStop(phase))) return `Not stopped: the user chose to keep the run going (${phase} phase)`;
	request.endRun();
	return `Stopped the /build run in the ${phase} phase; its changes stay uncommitted`;
}
