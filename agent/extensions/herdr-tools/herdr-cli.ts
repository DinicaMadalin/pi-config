/**
 * A narrow door to herdr (the terminal workspace manager for coding agents) through its `herdr` CLI. Every
 * command answers JSON: `{"result": …}` on success, `{"error": {code, message}}` on stderr when it fails.
 * Only works inside a herdr pane (HERDR_ENV=1); callers check isInsideHerdr() first and keep their old path otherwise.
 */
import { execFile } from "node:child_process";

const DEFAULT_COMMAND_TIMEOUT_MS = 15_000;
const AGENT_DETECTION_RETRY_MS = 500;
const AGENT_NOT_FOUND_CODE = "agent_not_found";
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

export type HerdrAgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

export interface HerdrAgent {
	paneId: string;
	workspaceId: string;
	agent: string;
	status: HerdrAgentStatus;
	cwd: string;
	isFocused: boolean;
}

export interface HerdrPane {
	paneId: string;
	workspaceId: string;
}

/** A tab's panes and splits as herdr lays them out, in terminal cells and split ratios. */
export interface PaneLayout {
	panes: { paneId: string; x: number; width: number }[];
	splits: { direction: "right" | "down"; ratio: number; x: number; y: number }[];
}

export interface PaneLocation {
	paneId: string;
	tabId: string;
	workspaceId: string;
}

export interface HerdrTabInfo {
	tabId: string;
	label: string;
}

export type ResizeDirection = "left" | "right" | "up" | "down";

export interface HerdrTab {
	tabId: string;
	workspaceId: string;
	rootPaneId: string;
}

export interface HerdrWorktree {
	workspaceId: string;
	rootPaneId: string;
	path: string;
}

export type NotificationSound = "none" | "done" | "request";

export interface CommandOutput {
	code: number;
	stdout: string;
	stderr: string;
}

/** Runs `herdr <args>`; tests pass a fake. */
export type HerdrCommandRunner = (args: readonly string[], timeoutMs: number) => Promise<CommandOutput>;

export function isInsideHerdr(env: NodeJS.ProcessEnv = process.env): boolean {
	return env.HERDR_ENV === "1" && Boolean(env.HERDR_PANE_ID);
}

/** The workspace of the pane Pi runs in: where a helper's tab goes when the run has no worktree workspace. */
export function ownWorkspaceId(env: NodeJS.ProcessEnv = process.env): string | undefined {
	return env.HERDR_WORKSPACE_ID || undefined;
}

export class HerdrCommandError extends Error {
	readonly code: string;

	constructor(action: string, code: string, detail: string) {
		super(`herdr could not ${action}: ${detail}`);
		this.code = code;
	}
}

const runHerdrBinary: HerdrCommandRunner = (args, timeoutMs) =>
	new Promise((resolve) => {
		execFile("herdr", [...args], { timeout: timeoutMs, maxBuffer: MAX_OUTPUT_BYTES, encoding: "utf8" }, (error, stdout, stderr) => {
			const exitCode = error ? (typeof error.code === "number" ? error.code : 1) : 0;
			resolve({ code: exitCode, stdout, stderr: stderr || (error && typeof error.code !== "number" ? error.message : "") });
		});
	});

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		// Not JSON: the caller reports the raw text instead.
		return undefined;
	}
}

/** The `result` of a successful command, or a HerdrCommandError with herdr's own code and message. */
export function readHerdrResult(action: string, output: CommandOutput): Record<string, unknown> {
	if (output.code === 0) {
		// Some commands (`pane run`, `pane send-keys`) print nothing when they succeed.
		if (output.stdout.trim() === "") return {};
		const parsed = parseJson(output.stdout) as { result?: Record<string, unknown> } | undefined;
		if (parsed?.result) return parsed.result;
		throw new HerdrCommandError(action, "unreadable", `unexpected output: ${output.stdout.slice(0, 200)}`);
	}
	const parsed = parseJson(output.stderr.trim()) as { error?: { code?: string; message?: string } } | undefined;
	const code = parsed?.error?.code ?? "failed";
	const detail = parsed?.error?.message ?? (output.stderr.trim() || `exit code ${output.code}`);
	throw new HerdrCommandError(action, code, detail);
}

function toAgentStatus(raw: unknown): HerdrAgentStatus {
	return raw === "idle" || raw === "working" || raw === "blocked" || raw === "done" ? raw : "unknown";
}

export function parseHerdrAgent(raw: unknown): HerdrAgent | undefined {
	const fields = raw as Record<string, unknown> | undefined;
	if (typeof fields?.pane_id !== "string") return undefined;
	return {
		paneId: fields.pane_id,
		workspaceId: String(fields.workspace_id ?? ""),
		agent: String(fields.agent ?? "unknown"),
		status: toAgentStatus(fields.agent_status),
		cwd: String(fields.cwd ?? ""),
		isFocused: fields.focused === true,
	};
}

export function parsePaneLayout(raw: unknown): PaneLayout {
	const layout = raw as { panes?: unknown[]; splits?: unknown[] } | undefined;
	const panes = (layout?.panes ?? []).flatMap((entry) => {
		const pane = entry as { pane_id?: unknown; rect?: { x?: unknown; width?: unknown } };
		return typeof pane.pane_id === "string" ? [{ paneId: pane.pane_id, x: Number(pane.rect?.x ?? 0), width: Number(pane.rect?.width ?? 0) }] : [];
	});
	const splits = (layout?.splits ?? []).flatMap((entry): PaneLayout["splits"] => {
		const split = entry as { direction?: unknown; ratio?: unknown; rect?: { x?: unknown; y?: unknown } };
		if (split.direction !== "right" && split.direction !== "down") return [];
		return [{ direction: split.direction, ratio: Number(split.ratio), x: Number(split.rect?.x ?? 0), y: Number(split.rect?.y ?? 0) }];
	});
	return { panes, splits };
}

function locationOf(raw: unknown, action: string): PaneLocation {
	const pane = raw as { pane_id?: unknown; tab_id?: unknown; workspace_id?: unknown } | undefined;
	if (typeof pane?.pane_id !== "string" || typeof pane.tab_id !== "string" || typeof pane.workspace_id !== "string") {
		throw new HerdrCommandError(action, "unreadable", "no pane location in the answer");
	}
	return { paneId: pane.pane_id, tabId: pane.tab_id, workspaceId: pane.workspace_id };
}

function paneOf(raw: unknown, action: string): HerdrPane {
	const pane = raw as { pane_id?: unknown; workspace_id?: unknown } | undefined;
	if (typeof pane?.pane_id !== "string") throw new HerdrCommandError(action, "unreadable", "no pane id in the answer");
	return { paneId: pane.pane_id, workspaceId: String(pane.workspace_id ?? "") };
}

/** The line that matched, and the searched text around it. */
export interface PaneOutputMatch {
	matchedLine: string;
	text: string;
}

/** herdr's error code when a wait ran out of time. */
export const HERDR_TIMEOUT_CODE = "timeout";

export interface SplitPaneRequest {
	/** The pane to split; the calling pane when undefined. */
	targetPaneId?: string;
	direction: "right" | "down";
	cwd: string;
	env?: Readonly<Record<string, string>>;
}

export class HerdrClient {
	private readonly runCommand: HerdrCommandRunner;

	constructor(runCommand: HerdrCommandRunner = runHerdrBinary) {
		this.runCommand = runCommand;
	}

	private async call(action: string, args: readonly string[], timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS): Promise<Record<string, unknown>> {
		return readHerdrResult(action, await this.runCommand(args, timeoutMs));
	}

	/** `pane read` and `agent read` print the screen text itself, not JSON; failures are JSON as usual. */
	private async readText(action: string, args: readonly string[]): Promise<string> {
		const output = await this.runCommand(args, DEFAULT_COMMAND_TIMEOUT_MS);
		if (output.code === 0) return output.stdout;
		readHerdrResult(action, output);
		return "";
	}

	/** A new shell pane beside the target; the user's focus stays where it is. */
	async splitPane(request: SplitPaneRequest): Promise<HerdrPane> {
		const target = request.targetPaneId ? [request.targetPaneId] : ["--current"];
		const envArgs = Object.entries(request.env ?? {}).flatMap(([key, envValue]) => ["--env", `${key}=${envValue}`]);
		const result = await this.call("split a pane", ["pane", "split", ...target, "--direction", request.direction, "--cwd", request.cwd, ...envArgs, "--no-focus"]);
		return paneOf(result.pane, "split a pane");
	}

	/** A new labeled tab in the workspace with one full-size shell pane, without moving the user's focus. */
	async createTab(workspaceId: string, cwd: string, label: string): Promise<HerdrTab> {
		const action = `create tab ${label}`;
		const result = await this.call(action, ["tab", "create", "--workspace", workspaceId, "--cwd", cwd, "--label", label, "--no-focus"]);
		const tab = result.tab as { tab_id?: unknown } | undefined;
		const rootPane = paneOf(result.root_pane, action);
		if (typeof tab?.tab_id !== "string" || !tab.tab_id) throw new HerdrCommandError(action, "unreadable", "no tab id in the answer");
		return { tabId: tab.tab_id, workspaceId: rootPane.workspaceId || workspaceId, rootPaneId: rootPane.paneId };
	}

	/** Closes just this tab, never its workspace. */
	async closeTab(tabId: string): Promise<void> {
		try {
			await this.call(`close tab ${tabId}`, ["tab", "close", tabId]);
		} catch (error) {
			if (error instanceof HerdrCommandError && error.code === "tab_not_found") return;
			throw error;
		}
	}

	/** Where a pane sits now. */
	async paneLocation(paneId: string): Promise<PaneLocation> {
		const result = await this.call(`read pane ${paneId}`, ["pane", "get", paneId]);
		return locationOf(result.pane, `read pane ${paneId}`);
	}

	/** Every pane of the workspace, in all its tabs. */
	async listPanes(workspaceId: string): Promise<PaneLocation[]> {
		const action = `list the panes of workspace ${workspaceId}`;
		const result = await this.call(action, ["pane", "list", "--workspace", workspaceId]);
		const panes = Array.isArray(result.panes) ? result.panes : [];
		return panes.map((pane) => locationOf(pane, action));
	}

	/** The workspace's tabs, in tab bar order. */
	async listTabs(workspaceId: string): Promise<HerdrTabInfo[]> {
		const result = await this.call(`list the tabs of workspace ${workspaceId}`, ["tab", "list", "--workspace", workspaceId]);
		const tabs = Array.isArray(result.tabs) ? result.tabs : [];
		return tabs.flatMap((entry) => {
			const tab = entry as { tab_id?: unknown; label?: unknown };
			return typeof tab.tab_id === "string" ? [{ tabId: tab.tab_id, label: String(tab.label ?? "") }] : [];
		});
	}

	async renameTab(tabId: string, label: string): Promise<void> {
		await this.call(`rename tab ${tabId}`, ["tab", "rename", tabId, label]);
	}

	/** Moves the pane, with its running program, into a new labeled tab; herdr closes the tab it leaves empty. */
	async movePaneToNewTab(paneId: string, workspaceId: string, label: string): Promise<PaneLocation> {
		const action = `move pane ${paneId} to a new tab`;
		const result = await this.call(action, ["pane", "move", paneId, "--new-tab", "--workspace", workspaceId, "--label", label, "--no-focus"]);
		return locationOf((result.move_result as { pane?: unknown } | undefined)?.pane, action);
	}

	/** Moves the pane, with its running program, into a new workspace of its own. */
	async movePaneToNewWorkspace(paneId: string, label: string): Promise<PaneLocation> {
		const action = `move pane ${paneId} to a new workspace`;
		const result = await this.call(action, ["pane", "move", paneId, "--new-workspace", "--label", label, "--no-focus"]);
		return locationOf((result.move_result as { pane?: unknown } | undefined)?.pane, action);
	}

	/** Moves the pane, with its running program, beside a pane of another tab. */
	async movePaneBeside(paneId: string, tabId: string, targetPaneId: string, direction: "right" | "down"): Promise<PaneLocation> {
		const action = `move pane ${paneId} into tab ${tabId}`;
		const result = await this.call(action, ["pane", "move", paneId, "--tab", tabId, "--split", direction, "--target-pane", targetPaneId, "--no-focus"]);
		return locationOf((result.move_result as { pane?: unknown } | undefined)?.pane, action);
	}

	/** Zooming focuses the pane; un-zooming gives its tab's columns back. */
	async zoomPane(paneId: string, isZoomed: boolean): Promise<void> {
		await this.call(`zoom pane ${paneId}`, ["pane", "zoom", paneId, isZoomed ? "--on" : "--off"]);
	}

	/** The layout of the tab holding the pane. */
	async paneLayout(paneId: string): Promise<PaneLayout> {
		const result = await this.call(`read the layout of pane ${paneId}`, ["pane", "layout", "--pane", paneId]);
		return parsePaneLayout(result.layout);
	}

	/** Moves the pane's split edge on that side by `amount` of the split's size (0–1). */
	async resizePane(paneId: string, direction: ResizeDirection, amount: number): Promise<void> {
		await this.call(`resize pane ${paneId}`, ["pane", "resize", "--pane", paneId, "--direction", direction, "--amount", amount.toFixed(4)]);
	}

	/** Names the agent so herdr's agent list shows a helper instead of four agents called "pi". */
	async renameAgent(paneId: string, name: string): Promise<void> {
		await this.call(`rename the agent in pane ${paneId}`, ["agent", "rename", paneId, name]);
	}

	/** Queues a shell command line in the pane; success means it was typed, not that it ran. */
	async runInPane(paneId: string, commandLine: string): Promise<void> {
		await this.call(`run a command in pane ${paneId}`, ["pane", "run", paneId, commandLine]);
	}

	/** Whether the pane still exists. */
	async hasPane(paneId: string): Promise<boolean> {
		try {
			await this.call(`read pane ${paneId}`, ["pane", "get", paneId]);
			return true;
		} catch (error) {
			if (error instanceof HerdrCommandError && error.code === "pane_not_found") return false;
			throw error;
		}
	}

	async closePane(paneId: string): Promise<void> {
		try {
			await this.call(`close pane ${paneId}`, ["pane", "close", paneId]);
		} catch (error) {
			if (error instanceof HerdrCommandError && error.code === "pane_not_found") return;
			throw error;
		}
	}

	/** Recent text of the pane, soft wraps joined. */
	async readPane(paneId: string, lines: number): Promise<string> {
		return this.readText(`read pane ${paneId}`, ["pane", "read", paneId, "--source", "recent-unwrapped", "--lines", String(lines)]);
	}

	async sendPaneKeys(paneId: string, keys: readonly string[]): Promise<void> {
		await this.call(`send keys to pane ${paneId}`, ["pane", "send-keys", paneId, ...keys]);
	}

	/** Waits until the pane shows text matching the pattern, searching the last `lines` lines (existing output too). */
	async waitForPaneOutput(paneId: string, pattern: string, timeoutMs: number, lines: number): Promise<PaneOutputMatch> {
		const result = await this.call(
			`wait for output in pane ${paneId}`,
			["pane", "wait-output", paneId, "--regex", pattern, "--source", "recent-unwrapped", "--lines", String(lines), "--timeout", String(timeoutMs)],
			timeoutMs + DEFAULT_COMMAND_TIMEOUT_MS,
		);
		const read = result.read as { text?: unknown } | undefined;
		return { matchedLine: String(result.matched_line ?? ""), text: typeof read?.text === "string" ? read.text : "" };
	}

	/** The agent in the pane, or undefined when the pane holds no recognized agent (or is gone). */
	async getAgent(target: string): Promise<HerdrAgent | undefined> {
		try {
			const result = await this.call(`read agent ${target}`, ["agent", "get", target]);
			return parseHerdrAgent(result.agent);
		} catch (error) {
			if (error instanceof HerdrCommandError && error.code === AGENT_NOT_FOUND_CODE) return undefined;
			throw error;
		}
	}

	/**
	 * Waits until the agent in the pane is ready for input after its program started. herdr only knows the agent
	 * once the program reported itself, so "not found" is retried until the time is up. Pi can be prompt-ready as
	 * `done`, so wait for both `idle` and `done`; `blocked` is not ready for a prompt.
	 */
	async waitForAgentReady(paneId: string, timeoutMs: number): Promise<HerdrAgent> {
		const action = `wait for the agent in pane ${paneId}`;
		const deadlineMs = Date.now() + timeoutMs;
		for (;;) {
			const remainingMs = Math.max(1, deadlineMs - Date.now());
			try {
				const result = await this.call(action, ["agent", "wait", paneId, "--until", "idle", "--until", "done", "--timeout", String(remainingMs)], remainingMs + DEFAULT_COMMAND_TIMEOUT_MS);
				const agent = parseHerdrAgent(result.agent);
				if (!agent) throw new HerdrCommandError(action, "unreadable", "no agent in the answer");
				return agent;
			} catch (error) {
				const isNotThereYet = error instanceof HerdrCommandError && error.code === AGENT_NOT_FOUND_CODE;
				if (!isNotThereYet || Date.now() >= deadlineMs) throw error;
				await new Promise((resolve) => setTimeout(resolve, AGENT_DETECTION_RETRY_MS));
			}
		}
	}

	/** Submits text to the agent as if typed, then Enter; does not wait for the turn. */
	async promptAgent(target: string, text: string): Promise<void> {
		await this.call(`prompt agent ${target}`, ["agent", "prompt", target, text]);
	}

	/** Submits text and waits until the agent settles; resolves to its state then. */
	async promptAgentAndWait(target: string, text: string, timeoutMs: number): Promise<HerdrAgent | undefined> {
		const result = await this.call(`prompt agent ${target}`, ["agent", "prompt", target, text, "--wait", "--timeout", String(timeoutMs)], timeoutMs + DEFAULT_COMMAND_TIMEOUT_MS);
		return parseHerdrAgent(result.agent);
	}

	async sendAgentKeys(target: string, keys: readonly string[]): Promise<void> {
		await this.call(`send keys to agent ${target}`, ["agent", "send-keys", target, ...keys]);
	}

	/** Moves the user's focus to the agent's pane. */
	async focusAgent(target: string): Promise<void> {
		await this.call(`focus agent ${target}`, ["agent", "focus", target]);
	}

	/** Recent text of the agent's screen, soft wraps joined. */
	async readAgent(target: string, lines: number): Promise<string> {
		return this.readText(`read agent ${target}`, ["agent", "read", target, "--source", "recent-unwrapped", "--lines", String(lines)]);
	}

	/** Every agent of the herdr session, in all workspaces. */
	async listAgents(): Promise<HerdrAgent[]> {
		const result = await this.call("list agents", ["agent", "list"]);
		const agents = Array.isArray(result.agents) ? result.agents : [];
		return agents.map(parseHerdrAgent).filter((agent): agent is HerdrAgent => agent !== undefined);
	}

	async showNotification(title: string, body: string, sound: NotificationSound): Promise<void> {
		await this.call("show a notification", ["notification", "show", title, "--body", body, "--sound", sound]);
	}

	/** Opens an existing git worktree as its own herdr workspace, without moving the user's focus. */
	async openWorktree(repoCwd: string, worktreePath: string, label: string): Promise<HerdrWorktree> {
		const action = `open worktree ${worktreePath}`;
		const result = await this.call(action, ["worktree", "open", "--cwd", repoCwd, "--path", worktreePath, "--label", label, "--no-focus"]);
		const workspace = result.workspace as { workspace_id?: unknown } | undefined;
		const rootPane = paneOf(result.root_pane, action);
		return { workspaceId: String(workspace?.workspace_id ?? rootPane.workspaceId), rootPaneId: rootPane.paneId, path: worktreePath };
	}

	/** Removes the worktree's checkout and closes its workspace; herdr refuses when it has uncommitted changes. */
	async removeWorktree(workspaceId: string): Promise<void> {
		await this.call(`remove the worktree of workspace ${workspaceId}`, ["worktree", "remove", "--workspace", workspaceId]);
	}
}

/** Quotes a word for a POSIX shell command line typed into a pane. */
export function shellQuote(word: string): string {
	if (/^[\w@%+=:,./-]+$/.test(word)) return word;
	return `'${word.replace(/'/g, `'\\''`)}'`;
}
