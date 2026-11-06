/**
 * Which controls the agents overview offers for the selected agent and the run's phase, so the key bar and
 * the key handling always agree. Pure: the overview asks, then calls OverviewActions with the command.
 */
import type { BuildAgentKey, BuildTimeline } from "./build-timeline.ts";
import type { SubagentRole } from "./workflow-state.ts";

export type AgentControl = "stop-turn" | "restart";
export type RunControl = "fix-again" | "re-review" | "accept";

export type ControlCommand =
	| { kind: "agent"; role: SubagentRole; control: AgentControl }
	| { kind: "run"; control: RunControl }
	| { kind: "cancel-delegate"; runId: string };

export interface ControlKey {
	/** The key as typed: "s", "R". */
	key: string;
	/** Short label for the key bar: "stop turn". */
	label: string;
	/** Asked as "Press A again to …"; set for controls that throw work away or skip a review. */
	confirmation?: string;
	command: ControlCommand;
}

/** The selected row, as far as controls care. */
export type SelectedAgent =
	| { kind: "build"; agent: BuildAgentKey }
	| { kind: "delegate"; runId: string; role: string; isRunning: boolean }
	| { kind: "none" };

function isSubagent(agent: BuildAgentKey): agent is SubagentRole {
	return agent !== "planner";
}

function agentControls(timeline: BuildTimeline, agent: BuildAgentKey): ControlKey[] {
	if (!isSubagent(agent) || timeline.isFinished) return [];
	const row = timeline.stages.find((stage) => stage.agent === agent && (stage.status === "working" || stage.status === "paused"));
	if (!row) return [];
	const isWorking = row.status === "working";
	const restart: ControlKey = {
		key: "r",
		label: "restart",
		command: { kind: "agent", role: agent, control: "restart" },
	};
	if (!isWorking) return [restart];
	return [
		{ key: "s", label: "stop turn", command: { kind: "agent", role: agent, control: "stop-turn" } },
		{ ...restart, confirmation: `restart the ${row.role} (its current turn is lost)` },
	];
}

function runControls(timeline: BuildTimeline): ControlKey[] {
	if (timeline.isFinished) return [];
	const reReview: ControlKey = { key: "R", label: "review again", command: { kind: "run", control: "re-review" } };
	switch (timeline.phase) {
		case "review-failed":
			return [
				{ key: "F", label: "fix again", command: { kind: "run", control: "fix-again" } },
				reReview,
				{
					key: "A",
					label: "accept anyway",
					confirmation: "accept the work although the reviewers still have findings",
					command: { kind: "run", control: "accept" },
				},
			];
		case "awaiting-ship":
		case "awaiting-pr":
			return [reReview];
		default:
			return [];
	}
}

/** The selected agent's controls first, then the run's. */
export function controlsFor(timeline: BuildTimeline | undefined, selected: SelectedAgent): ControlKey[] {
	if (selected.kind === "delegate") {
		if (!selected.isRunning) return [];
		return [
			{
				key: "x",
				label: "cancel run",
				confirmation: `cancel the ${selected.role} run ${selected.runId}`,
				command: { kind: "cancel-delegate", runId: selected.runId },
			},
		];
	}
	if (!timeline) return [];
	const forAgent = selected.kind === "build" ? agentControls(timeline, selected.agent) : [];
	return [...forAgent, ...runControls(timeline)];
}
