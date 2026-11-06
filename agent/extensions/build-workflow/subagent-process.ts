/**
 * A /build subagent: a `pi --mode rpc` child process on its own session file. Sends it prompts (steering
 * when it is busy), tracks its model, cost, time and tools from the event stream, forwards its dialogs to
 * the user and reports each settled turn with its last answer.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { ROUTE_DECISION_ENTRY_TYPE } from "../auto-model/route-decision.ts";
import { AgentTracker, type AssistantMessageLike } from "./agent-activity.ts";
import { SUBAGENT_ENV_VAR } from "./workflow-state.ts";

const SESSION_FORMAT_VERSION = 3;
const STOP_GRACE_MS = 3000;
const MAX_STDERR_CHARS = 2000;

/** The user's side of the dialogs a subagent opens, e.g. a dangerous-command guard asking to confirm. */
export interface SubagentDialogs {
	select(title: string, options: string[]): Promise<string | undefined>;
	confirm(title: string, message: string): Promise<boolean>;
	input(title: string, placeholder: string | undefined): Promise<string | undefined>;
}

export interface SubagentOptions {
	/** Shown in dialogs and errors, e.g. "Implementer". */
	name: string;
	cwd: string;
	sessionPath: string;
	dialogs: SubagentDialogs;
	onSettled: (lastAnswer: string, isAborted: boolean) => void;
	onExit: (reason: string) => void;
}

interface SessionCustomEntry {
	customType: string;
	data: unknown;
}

/**
 * Writes a session file holding only custom entries (workflow state, route pin). Pi's SessionManager only
 * writes a file once it has a conversation, so the header and entries are written here in its format.
 */
export function createSubagentSessionFile(
	sessionPath: string,
	cwd: string,
	parentSession: string | undefined,
	entries: readonly SessionCustomEntry[],
): void {
	const timestamp = new Date().toISOString();
	const header = { type: "session", version: SESSION_FORMAT_VERSION, id: randomUUID(), timestamp, cwd, parentSession };
	let parentId: string | null = null;
	const lines = [JSON.stringify(header)];
	for (const entry of entries) {
		const id = randomUUID().slice(0, 8);
		lines.push(JSON.stringify({ type: "custom", id, parentId, timestamp, customType: entry.customType, data: entry.data }));
		parentId = id;
	}
	writeFileSync(sessionPath, `${lines.join("\n")}\n`, { flag: "wx" });
}

/** A JSON line, or undefined when it is not one, e.g. a line the child is still writing. */
function parseJsonLine(line: string): unknown {
	try {
		return JSON.parse(line);
	} catch {
		// Not a complete JSON record: skipped, the caller only reads complete records.
		return undefined;
	}
}

/** The auto model's latest route reason in a session file; undefined when it never routed there. */
function readRouteReason(sessionPath: string): string | undefined {
	let content: string;
	try {
		content = readFileSync(sessionPath, "utf8");
	} catch {
		// The child has not written its first entry yet; there is no reason to show.
		return undefined;
	}
	const lines = content.split("\n");
	for (let index = lines.length - 1; index >= 0; index--) {
		const line = lines[index];
		if (!line.includes(ROUTE_DECISION_ENTRY_TYPE)) continue;
		const entry = parseJsonLine(line) as { customType?: string; data?: { reason?: unknown } } | undefined;
		if (entry?.customType === ROUTE_DECISION_ENTRY_TYPE && typeof entry.data?.reason === "string") return entry.data.reason;
	}
	return undefined;
}

/** The same Pi binary and version as the parent: its runtime and entry script. */
function piCommand(): { command: string; args: string[] } {
	const entryScript = process.argv[1];
	return entryScript ? { command: process.execPath, args: [entryScript] } : { command: "pi", args: [] };
}

interface UiRequest {
	id: string;
	method: string;
	title?: string;
	message?: string;
	options?: string[];
	placeholder?: string;
}

/** What the orchestrator uses of a subagent; tests stand in a fake for the real process. */
export interface Subagent {
	readonly name: string;
	readonly tracker: AgentTracker;
	readonly isRunning: boolean;
	readonly isWorking: boolean;
	start(): void;
	prompt(message: string): void;
	sendUserMessage(text: string): void;
	abortTurn(): void;
	stop(): Promise<void>;
}

export type LaunchSubagent = (options: SubagentOptions) => Subagent;

export const launchSubagentProcess: LaunchSubagent = (options) => new SubagentProcess(options);

export class SubagentProcess implements Subagent {
	readonly name: string;
	readonly sessionPath: string;
	readonly tracker = new AgentTracker();
	private readonly options: SubagentOptions;
	private child: ChildProcess | undefined;
	private stdoutBuffer = "";
	private stderrTail = "";
	private lastAnswer = "";
	private isStopping = false;

	constructor(options: SubagentOptions) {
		this.options = options;
		this.name = options.name;
		this.sessionPath = options.sessionPath;
	}

	get isRunning(): boolean {
		return this.child !== undefined;
	}

	get isWorking(): boolean {
		return this.tracker.stats.workingSinceMs !== undefined;
	}

	start(): void {
		const { command, args } = piCommand();
		const child = spawn(command, [...args, "--mode", "rpc", "--session", this.sessionPath, "--model", "auto/auto"], {
			cwd: this.options.cwd,
			env: { ...process.env, [SUBAGENT_ENV_VAR]: "1" },
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.child = child;
		child.stdout?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => this.readStdout(chunk));
		child.stderr?.setEncoding("utf8");
		child.stderr?.on("data", (chunk: string) => {
			this.stderrTail = (this.stderrTail + chunk).slice(-MAX_STDERR_CHARS);
		});
		child.on("error", (error) => this.handleExit(`failed to start: ${error.message}`));
		child.on("exit", (code, signal) => this.handleExit(signal ? `stopped by ${signal}` : `exited with code ${code}`));
	}

	/** Starts a turn, or steers the running one so the message arrives at its next step. */
	prompt(message: string): void {
		this.tracker.activity.add("note", `→ ${message.split("\n")[0]}`, Date.now());
		this.send({ type: "prompt", message, streamingBehavior: "steer" });
		this.tracker.startTurn(Date.now());
	}

	/** A message the user typed in the agents overview. */
	sendUserMessage(text: string): void {
		this.tracker.activity.add("you", text, Date.now());
		this.send({ type: "prompt", message: text, streamingBehavior: "steer" });
		this.tracker.startTurn(Date.now());
	}

	/** Stops the current turn; the process stays, ready for the next prompt. */
	abortTurn(): void {
		this.tracker.activity.add("note", "Turn stopped by you", Date.now());
		this.send({ type: "abort" });
	}

	/** Ends the process; resolves once it exited, so a new process may take over its session file. */
	stop(): Promise<void> {
		const child = this.child;
		if (!child) return Promise.resolve();
		this.isStopping = true;
		const exited = new Promise<void>((resolve) => {
			child.once("exit", () => resolve());
			child.once("error", () => resolve());
		});
		this.send({ type: "abort" });
		child.stdin?.end();
		setTimeout(() => {
			if (this.child === child) child.kill("SIGTERM");
		}, STOP_GRACE_MS).unref();
		return exited;
	}

	private send(command: Record<string, unknown>): void {
		this.child?.stdin?.write(`${JSON.stringify(command)}\n`);
	}

	private handleExit(reason: string): void {
		if (!this.child) return;
		this.child = undefined;
		this.tracker.endTurn(Date.now());
		if (this.isStopping) return;
		const stderr = this.stderrTail.trim().split("\n").at(-1);
		this.options.onExit(stderr ? `${reason}: ${stderr}` : reason);
	}

	// RPC records are split on LF only: JSON strings may contain U+2028, which Node's readline treats as a break.
	private readStdout(chunk: string): void {
		this.stdoutBuffer += chunk;
		let newlineIndex = this.stdoutBuffer.indexOf("\n");
		while (newlineIndex !== -1) {
			const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
			this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
			if (line.startsWith("{")) this.handleLine(line);
			newlineIndex = this.stdoutBuffer.indexOf("\n");
		}
	}

	/** A malformed record is shown in the activity instead of breaking the parent session. */
	private handleLine(line: string): void {
		const record = parseJsonLine(line);
		if (typeof record !== "object" || record === null) {
			this.tracker.activity.add("error", `Unreadable output from the subagent: ${line.slice(0, 120)}`, Date.now());
			return;
		}
		this.handleRecord(record as Record<string, unknown>);
	}

	private handleRecord(record: Record<string, unknown>): void {
		const nowMs = Date.now();
		const tracker = this.tracker;
		switch (record.type) {
			case "agent_start":
				this.lastAnswer = "";
				tracker.startTurn(nowMs);
				return;
			case "tool_execution_start":
				if (!record.parentToolCallId) tracker.startTool(String(record.toolName), record.args, nowMs);
				return;
			case "tool_execution_end":
				if (!record.parentToolCallId) tracker.endTool(record.isError === true, nowMs);
				return;
			case "message_end": {
				const message = record.message as AssistantMessageLike | undefined;
				if (message?.role !== "assistant") return;
				this.lastAnswer = tracker.recordAnswer(message, nowMs);
				tracker.stats.routeReason ??= readRouteReason(this.sessionPath);
				return;
			}
			case "agent_settled":
				tracker.endTurn(nowMs);
				tracker.stats.routeReason = readRouteReason(this.sessionPath) ?? tracker.stats.routeReason;
				this.options.onSettled(this.lastAnswer, record.aborted === true);
				return;
			case "response":
				if (record.success === false) tracker.activity.add("error", `${String(record.command)}: ${String(record.error)}`, nowMs);
				return;
			case "extension_ui_request":
				void this.answerDialog(record as unknown as UiRequest);
				return;
		}
	}

	private async answerDialog(request: UiRequest): Promise<void> {
		const dialogs = this.options.dialogs;
		const title = `${this.name}: ${request.title ?? ""}`;
		switch (request.method) {
			case "select": {
				const value = await dialogs.select(title, request.options ?? []);
				this.send({ type: "extension_ui_response", id: request.id, ...(value === undefined ? { cancelled: true } : { value }) });
				return;
			}
			case "confirm": {
				const confirmed = await dialogs.confirm(title, request.message ?? "");
				this.send({ type: "extension_ui_response", id: request.id, confirmed });
				return;
			}
			case "input":
			case "editor": {
				const value = await dialogs.input(title, request.placeholder);
				this.send({ type: "extension_ui_response", id: request.id, ...(value === undefined ? { cancelled: true } : { value }) });
				return;
			}
			case "notify":
				if (request.message) this.tracker.activity.add("note", request.message, Date.now());
				return;
		}
	}
}
