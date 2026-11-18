/**
 * A /build subagent in a herdr pane: an interactive Pi you can watch and type into, instead of a hidden
 * `pi --mode rpc` process. Prompts go in through `herdr agent prompt`; herdr's agent state (from the herdr Pi
 * integration) tells when a turn settled; the model, cost, tools and last answer come from the session file,
 * which Pi appends to as it works. Dialogs show in the pane itself, and herdr reports them as "blocked".
 */
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { HerdrCommandError, type HerdrAgentStatus, type HerdrClient, shellQuote } from "../herdr-tools/herdr-cli.ts";
import { helperGroupOf, HelperPaneGroups, type ReportLayoutError } from "./helper-pane-groups.ts";
import { ROUTE_DECISION_ENTRY_TYPE } from "../auto-model/route-decision.ts";
import { MAX_TIER_ENV_VAR, type DifficultyTier } from "../auto-model/difficulty-tiers.ts";
import { AgentTracker, type AssistantMessageLike } from "./agent-activity.ts";
import { type LaunchSubagent, moveSessionToCwd, piCommand, readRouteReason, type Subagent, type SubagentOptions, type SubagentPane } from "./subagent-process.ts";
import { PROJECT_TRUST_ENV_VAR, SUBAGENT_ENV_VAR } from "./workflow-state.ts";

const POLL_INTERVAL_MS = 1000;
/** Pi loads its extensions before herdr sees it ready; a cold start takes a few seconds. */
const READY_TIMEOUT_MS = 60_000;
/** herdr failing this many polls in a row means the pane is unreachable: the subagent counts as stopped. */
const MAX_FAILED_POLLS = 5;
/** Pi exits on a second Ctrl+C; this is how long it gets before its pane is closed anyway. */
const EXIT_GRACE_MS = 1500;
const CRASH_OUTPUT_LINES = 20;
/** herdr accepts agent names of at most 32 characters. */
const MAX_AGENT_NAME_LENGTH = 32;

/** The shell line that starts the subagent's Pi in its pane, with the same environment the RPC process gets. */
export function subagentCommandLine(
	pi: { command: string; args: string[] },
	sessionPath: string,
	maxTier: DifficultyTier | undefined,
	isProjectTrusted: boolean,
): string {
	const assignments = [
		`${SUBAGENT_ENV_VAR}=1`,
		`${PROJECT_TRUST_ENV_VAR}=${isProjectTrusted ? "1" : "0"}`,
		...(maxTier ? [`${MAX_TIER_ENV_VAR}=${maxTier}`] : []),
	];
	const words = ["env", "-u", MAX_TIER_ENV_VAR, ...assignments, pi.command, ...pi.args, "--session", sessionPath, "--model", "auto/auto"];
	return words.map(shellQuote).join(" ");
}

/** What a session file line means for the tracker. */
export type SessionStep =
	| { kind: "answer"; message: AssistantMessageLike; stopReason: string | undefined; toolCalls: { name: string; args: unknown }[] }
	| { kind: "tool-result"; isError: boolean }
	| { kind: "route-reason"; reason: string }
	| { kind: "other" };

export function readSessionStep(line: string): SessionStep {
	let entry: { type?: string; customType?: string; data?: { reason?: unknown }; message?: Record<string, unknown> };
	try {
		entry = JSON.parse(line);
	} catch {
		// A line Pi is still writing: the next read gets it whole.
		return { kind: "other" };
	}
	if (entry.type === "custom" && entry.customType === ROUTE_DECISION_ENTRY_TYPE && typeof entry.data?.reason === "string") {
		return { kind: "route-reason", reason: entry.data.reason };
	}
	const message = entry.type === "message" ? entry.message : undefined;
	if (message?.role === "toolResult") return { kind: "tool-result", isError: message.isError === true };
	if (message?.role !== "assistant") return { kind: "other" };
	const content = Array.isArray(message.content) ? (message.content as { type?: string; name?: unknown; arguments?: unknown }[]) : [];
	const toolCalls = content.filter((block) => block?.type === "toolCall").map((block) => ({ name: String(block.name), args: block.arguments }));
	const stopReason = typeof message.stopReason === "string" ? message.stopReason : undefined;
	return { kind: "answer", message: message as unknown as AssistantMessageLike, stopReason, toolCalls };
}

const NEWLINE_BYTE = 0x0a;

/**
 * Reads the whole lines appended to a file since the last call. An unfinished last line stays for the next
 * call; reading stops at a newline byte, so a character Pi is still writing is never cut in half.
 */
export class AppendedLines {
	private offset = 0;

	constructor(private readonly path: string) {}

	/** Starts after what the file holds now: earlier turns of a resumed session are not news. */
	skipExisting(): void {
		this.offset = fileSize(this.path);
	}

	read(): string[] {
		const size = fileSize(this.path);
		if (size <= this.offset) return [];
		const bytes = new Uint8Array(size - this.offset);
		const descriptor = openSync(this.path, "r");
		try {
			readSync(descriptor, bytes, 0, bytes.length, this.offset);
		} finally {
			closeSync(descriptor);
		}
		const lastNewline = bytes.lastIndexOf(NEWLINE_BYTE);
		if (lastNewline === -1) return [];
		this.offset += lastNewline + 1;
		const text = Buffer.from(bytes.subarray(0, lastNewline)).toString("utf8");
		return text.split("\n").filter((line) => line.trim() !== "");
	}
}

function fileSize(path: string): number {
	try {
		return statSync(path).size;
	} catch {
		// Pi has not written the file yet.
		return 0;
	}
}

type Lifecycle = "starting" | "ready" | "ended";

export class HerdrSubagent implements Subagent {
	readonly name: string;
	readonly maxTier: DifficultyTier | undefined;
	readonly tracker = new AgentTracker();
	private readonly options: SubagentOptions;
	private readonly client: HerdrClient;
	private readonly panes: HelperPanes;
	/** Its own pane in its group's tab, closed when the helper ends. */
	private openingPane: Promise<void> | undefined;
	private closingPane: Promise<void> | undefined;
	private stopping: Promise<void> | undefined;
	private hasStartedPi = false;
	private readonly sessionLines: AppendedLines;
	private lifecycle: Lifecycle = "starting";
	private paneId: string | undefined;
	private herdrStatus: HerdrAgentStatus = "unknown";
	/** The turn in progress: started by a prompt, or seen working (you typed in the pane). */
	private turn: { hasAnswer: boolean; stopReason?: string } | undefined;
	private lastAnswer = "";
	private queuedPrompts: string[] = [];
	private sending: Promise<void> = Promise.resolve();
	private pollTimer: ReturnType<typeof setInterval> | undefined;
	private isPolling = false;
	private failedPolls = 0;
	private hasReportedBlocked = false;

	constructor(options: SubagentOptions, client: HerdrClient, panes: HelperPanes) {
		this.options = options;
		this.name = options.name;
		this.maxTier = options.maxTier;
		this.client = client;
		this.panes = panes;
		this.sessionLines = new AppendedLines(options.sessionPath);
	}

	get isRunning(): boolean {
		return this.lifecycle !== "ended";
	}

	get isWorking(): boolean {
		return this.tracker.stats.workingSinceMs !== undefined;
	}

	get pane(): SubagentPane | undefined {
		return this.paneId ? { id: this.paneId, status: this.lifecycle === "starting" ? "starting" : this.herdrStatus } : undefined;
	}

	start(): void {
		if (this.openingPane || !this.isRunning) return;
		this.openingPane = this.openPane();
		void this.launch();
	}

	private async openPane(): Promise<void> {
		this.paneId = await this.panes.open((error) => this.reportError(error));
	}

	prompt(message: string): void {
		this.tracker.activity.add("note", `→ ${message.split("\n")[0]}`, Date.now());
		this.submit(message);
	}

	sendUserMessage(text: string): void {
		this.tracker.activity.add("you", text, Date.now());
		this.submit(text);
	}

	abortTurn(): void {
		if (!this.paneId) return;
		this.tracker.activity.add("note", "Turn stopped by you", Date.now());
		this.client.sendAgentKeys(this.paneId, ["esc"]).catch((error: unknown) => this.reportError(error));
	}

	/** Ends Pi and closes only its owned pane; the session file stays for a later restart. */
	stop(): Promise<void> {
		this.stopping ??= this.stopAgent();
		return this.stopping;
	}

	private async stopAgent(): Promise<void> {
		if (this.lifecycle === "ended") {
			await this.closingPane;
			return;
		}
		this.lifecycle = "ended";
		this.stopPolling();
		this.tracker.endTurn(Date.now());
		// stop() must wait for a pane still being opened so shutdown cannot leave it behind.
		await this.openingPane?.catch((error: unknown) => this.reportError(error));
		if (this.paneId && this.hasStartedPi) {
			await this.client.sendAgentKeys(this.paneId, ["ctrl+c", "ctrl+c"]).catch((error: unknown) => this.reportError(error));
			await new Promise((resolve) => setTimeout(resolve, EXIT_GRACE_MS));
		}
		await this.closeOwnedPane();
	}

	private async closeOwnedPane(): Promise<void> {
		if (!this.paneId) return;
		this.closingPane ??= this.panes.close(this.paneId, (error) => this.reportError(error)).catch((error: unknown) => this.reportError(error));
		await this.closingPane;
	}

	private async launch(): Promise<void> {
		try {
			await this.openingPane;
			if (!this.isRunning || !this.paneId) return;
			const paneId = this.paneId;
			moveSessionToCwd(this.options.sessionPath, this.options.cwd);
			this.hasStartedPi = true;
			await this.client.runInPane(paneId, subagentCommandLine(piCommand(), this.options.sessionPath, this.maxTier, this.options.isProjectTrusted));
			if (!this.isRunning) return;
			await this.client.waitForAgentReady(paneId, READY_TIMEOUT_MS);
			if (!this.isRunning) return;
			await this.nameAgent(paneId);
			if (!this.isRunning) return;
			this.lifecycle = "ready";
			this.herdrStatus = "idle";
			this.sessionLines.skipExisting();
			this.pollTimer = setInterval(() => void this.poll(), POLL_INTERVAL_MS);
			this.pollTimer.unref?.();
			for (const message of this.queuedPrompts.splice(0)) this.send(message);
		} catch (error) {
			await this.end(`could not start in herdr: ${(error as Error).message}`);
		}
	}

	private submit(text: string): void {
		this.tracker.startTurn(Date.now());
		this.turn = { hasAnswer: false };
		if (this.lifecycle === "ready") this.send(text);
		else this.queuedPrompts.push(text);
	}

	/** In order: a prompt sent while another is still being typed would interleave with it. */
	private send(text: string): void {
		const paneId = this.paneId;
		if (!paneId) return;
		this.sending = this.sending.then(() =>
			this.client.promptAgent(paneId, text).catch((error: unknown) => {
				this.reportError(error);
				if (error instanceof HerdrCommandError && error.code === "agent_blocked") this.options.onWaitingForUser?.();
			}),
		);
	}

	/** A name that says what the helper is; herdr keeps calling it "pi" otherwise. */
	private async nameAgent(paneId: string): Promise<void> {
		const agentName = this.options.agentName ?? this.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
		await this.client.renameAgent(paneId, agentName.slice(0, MAX_AGENT_NAME_LENGTH)).catch((error: unknown) => this.reportError(error));
	}

	private async poll(): Promise<void> {
		if (this.isPolling || this.lifecycle !== "ready" || !this.paneId) return;
		this.isPolling = true;
		try {
			// State first, then the file: Pi writes its last message before it reports idle.
			const agent = await this.client.getAgent(this.paneId);
			if (this.lifecycle !== "ready") return;
			if (!agent) {
				await this.end(await this.exitReason(this.paneId));
				return;
			}
			this.failedPolls = 0;
			this.herdrStatus = agent.status;
			this.readSessionSteps();
			this.followStatus(agent.status);
		} catch (error) {
			this.failedPolls++;
			if (this.failedPolls >= MAX_FAILED_POLLS) await this.end(`herdr stopped answering: ${(error as Error).message}`);
		} finally {
			this.isPolling = false;
		}
	}

	private followStatus(status: HerdrAgentStatus): void {
		const nowMs = Date.now();
		if (status === "working") {
			this.tracker.startTurn(nowMs);
			this.turn ??= { hasAnswer: false };
			this.hasReportedBlocked = false;
			return;
		}
		if (status === "blocked") {
			if (this.hasReportedBlocked) return;
			this.hasReportedBlocked = true;
			this.tracker.activity.add("note", "Waits for you in its herdr pane", nowMs);
			this.options.onWaitingForUser?.();
			return;
		}
		const turn = this.turn;
		const isSettled = (status === "idle" || status === "done") && turn?.hasAnswer === true && turn.stopReason !== "toolUse";
		if (!turn || !isSettled) return;
		this.turn = undefined;
		this.tracker.endTurn(nowMs);
		this.tracker.stats.routeReason = readRouteReason(this.options.sessionPath) ?? this.tracker.stats.routeReason;
		this.options.onSettled(this.lastAnswer, turn.stopReason === "aborted");
	}

	private readSessionSteps(): void {
		const nowMs = Date.now();
		for (const line of this.sessionLines.read()) {
			const step = readSessionStep(line);
			switch (step.kind) {
				case "answer":
					this.lastAnswer = this.tracker.recordAnswer(step.message, nowMs);
					for (const call of step.toolCalls) this.tracker.startTool(call.name, call.args, nowMs);
					if (this.turn) this.turn = { hasAnswer: true, stopReason: step.stopReason };
					break;
				case "tool-result":
					this.tracker.endTool(step.isError, nowMs);
					break;
				case "route-reason":
					this.tracker.stats.routeReason = step.reason;
					break;
			}
		}
	}

	/** Pi left its pane: the pane's last lines say why; the pane is closed so a restart starts clean. */
	private async exitReason(paneId: string): Promise<string> {
		if (!(await this.client.hasPane(paneId))) return "its herdr pane was closed";
		const output = await this.client.readPane(paneId, CRASH_OUTPUT_LINES).catch(() => "");
		const lastLine = output.split("\n").map((line) => line.trim()).filter(Boolean).at(-1);
		return lastLine ? `Pi exited in its herdr pane: ${lastLine}` : "Pi exited in its herdr pane";
	}

	private async end(reason: string): Promise<void> {
		if (this.lifecycle === "ended") return;
		this.lifecycle = "ended";
		this.stopPolling();
		this.tracker.endTurn(Date.now());
		await this.closeOwnedPane();
		this.options.onExit(reason);
	}

	private stopPolling(): void {
		if (this.pollTimer) clearInterval(this.pollTimer);
		this.pollTimer = undefined;
	}

	private reportError(error: unknown): void {
		this.tracker.activity.add("error", (error as Error).message, Date.now());
	}
}

/** Opening and closing the one pane a helper owns. */
export interface HelperPanes {
	open(reportError: ReportLayoutError): Promise<string>;
	close(paneId: string, reportError: ReportLayoutError): Promise<void>;
}

/**
 * Helpers of a role group share one tab in the run's workspace ("Implementers", "Reviewers"), each in its own
 * full-height column; see helper-pane-groups.ts.
 */
export function herdrSubagentLauncher(client: HerdrClient, workspaceIdOf: () => string | undefined): LaunchSubagent {
	const groups = new HelperPaneGroups(client);
	return (options) => {
		const group = helperGroupOf(options.agentName ?? options.name.toLowerCase());
		const panes: HelperPanes = {
			open: (reportError) => {
				const workspaceId = workspaceIdOf();
				if (!workspaceId) return Promise.reject(new Error(`No herdr workspace to put the ${options.name} in`));
				return groups.openPane(workspaceId, group, options.cwd, reportError);
			},
			close: (paneId, reportError) => groups.closePane(paneId, reportError),
		};
		return new HerdrSubagent(options, client, panes);
	};
}
