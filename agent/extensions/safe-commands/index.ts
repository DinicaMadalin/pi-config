/**
 * safe-commands: answers Guardrails' permission prompts for routine work, so removing scratch files under /tmp or a
 * generated folder, dropping a scratch worktree, unstaging files, changing directory and a plain push to any branch
 * except main or master run without a prompt. Every
 * other command is handed back to the normal Guardrails prompt, and a command that carries anything else with it is
 * asked about too (see command-clearance.ts).
 *
 * Guardrails asks its registered decision delegates first (`guardrails:delegate:request`); a delegate that returns
 * "allow" for all parts skips the prompt.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	decideCommandClearance,
	type CommandClearance,
	type DangerousPattern,
	type GitBranchLookup,
} from "./command-clearance.ts";

const DELEGATE_ID = "safe-commands";
const DELEGATE_NAME = "Routine commands";
const GUARDRAILS_CONFIG_PATH = fileURLToPath(new URL("../guardrails.json", import.meta.url));
const DELEGATE_REQUEST_EVENT = "guardrails:delegate:request";
const DELEGATE_REGISTER_EVENT = "guardrails:delegate:register";
const GIT_LOOKUP_TIMEOUT_MS = 2_000;

interface GuardrailsDelegateRequest {
	feature?: unknown;
	action?: unknown;
}

interface GuardrailsDelegateContext {
	cwd?: unknown;
}

interface DelegateAnswer {
	verdict: "allow" | "ask";
	reason: string;
}

interface GuardrailsConfig {
	permissionGate?: {
		patterns?: DangerousPattern[];
		autoDenyPatterns?: DangerousPattern[];
	};
}

export default function (pi: ExtensionAPI) {
	const delegate = {
		id: DELEGATE_ID,
		name: DELEGATE_NAME,
		decide: (request: GuardrailsDelegateRequest, context?: GuardrailsDelegateContext): DelegateAnswer =>
			decideDelegateAnswer(request, context),
	};
	const registration = { delegate };

	const stopListening = pi.events.on(DELEGATE_REQUEST_EVENT, () => {
		pi.events.emit(DELEGATE_REGISTER_EVENT, registration);
	});
	pi.events.emit(DELEGATE_REGISTER_EVENT, registration);

	pi.on("session_shutdown", () => stopListening());
}

function decideDelegateAnswer(
	request: GuardrailsDelegateRequest,
	context: GuardrailsDelegateContext = {},
): DelegateAnswer {
	if (request.feature !== "permissionGate") return toAnswer(ask("safe-commands only judges shell commands"));

	const command = commandOf(request.action);
	if (command === undefined) return toAnswer(ask("the flagged action is not a shell command"));

	let clearance: CommandClearance;
	try {
		clearance = decideCommandClearance(command, loadDangerousPatterns(), { cwd: cwdOf(context), git: REPOSITORY_BRANCHES });
	} catch (error) {
		return toAnswer(ask(`the Guardrails patterns could not be read (${(error as Error).message})`));
	}
	return toAnswer(clearance);
}

function cwdOf(context: GuardrailsDelegateContext): string {
	return typeof context.cwd === "string" && context.cwd.length > 0 ? context.cwd : process.cwd();
}

function commandOf(action: unknown): string | undefined {
	if (!action || typeof action !== "object") return undefined;
	const { kind, command } = action as { kind?: unknown; command?: unknown };
	if (kind !== "command" || typeof command !== "string") return undefined;
	return command;
}

function loadDangerousPatterns(): DangerousPattern[] {
	const config = JSON.parse(readFileSync(GUARDRAILS_CONFIG_PATH, "utf8")) as GuardrailsConfig;
	const patterns = [
		...(config.permissionGate?.patterns ?? []),
		...(config.permissionGate?.autoDenyPatterns ?? []),
	];
	if (patterns.length === 0) {
		throw new Error(`${GUARDRAILS_CONFIG_PATH} lists no dangerous command patterns`);
	}
	return patterns;
}

function toAnswer(clearance: CommandClearance): DelegateAnswer {
	return { verdict: clearance.kind, reason: clearance.reason };
}

function ask(reason: string): CommandClearance {
	return { kind: "ask", reason };
}

const REPOSITORY_BRANCHES: GitBranchLookup = {
	currentBranch: (cwd) => readGitLine(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
	pushDestination: (cwd) => {
		const remoteBranch = readGitLine(cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{push}"]);
		// Without a push target git either pushes the current branch under its own name or refuses to push.
		if (remoteBranch === undefined) return readGitLine(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
		return remoteBranch.slice(remoteBranch.indexOf("/") + 1);
	},
};

/** Undefined when git fails or prints nothing; the caller then leaves the command to the normal prompt. */
function readGitLine(cwd: string, args: string[]): string | undefined {
	try {
		const output = execFileSync("git", args, {
			cwd,
			encoding: "utf8",
			timeout: GIT_LOOKUP_TIMEOUT_MS,
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		return output.length > 0 ? output : undefined;
	} catch {
		return undefined;
	}
}
