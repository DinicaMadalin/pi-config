/**
 * One herdr pane beside Pi that runs commands visibly, reused for each run, and reports how each ended.
 * Each run prints a title line and an exit line, both tagged with a fresh token: herdr's wait-output also
 * searches old output, and the token keeps an earlier run's lines from matching.
 */
import { randomBytes } from "node:crypto";
import { HERDR_TIMEOUT_CODE, HerdrCommandError, type HerdrClient, shellQuote } from "./herdr-cli.ts";

/** Enough lines for the end of a long test run's output. */
const OUTPUT_LINES = 400;
const EXIT_LINE_PREFIX = "■ exit";

export interface PaneCommand {
	/** Shown above the command's output: "lint", "Claude Code second opinion". */
	title: string;
	/** The program and its arguments, run without a shell of yours in between. */
	argv: readonly string[];
	cwd: string;
	timeoutMs: number;
}

export interface PaneCommandOutcome {
	exitCode: number;
	timedOut: boolean;
	/** What the command printed, as the pane shows it. */
	output: string;
}

export interface PaneCommandLines {
	/** The shell line typed into the pane. */
	commandLine: string;
	/** The line printed before the command runs. */
	titleLine: string;
	/** Matches the line printed at the end; group 1 is the exit code. */
	exitPattern: string;
}

/**
 * The line to type for a command. It runs in `sh` whatever your pane's shell is. `$?` is not digits, so the
 * typed line itself never matches the exit pattern.
 */
export function paneCommandLines(command: Pick<PaneCommand, "title" | "argv" | "cwd">, token: string): PaneCommandLines {
	const titleLine = `▶ ${command.title} [${token}]`;
	const script = `echo "$1"; cd "$2" && shift 2 && "$@"; echo "${EXIT_LINE_PREFIX} $? [${token}]"`;
	const commandLine = ["sh", "-c", script, "pi-pane", titleLine, command.cwd, ...command.argv].map(shellQuote).join(" ");
	return { commandLine, titleLine, exitPattern: `${EXIT_LINE_PREFIX} (\\d+) \\[${token}\\]` };
}

/** The output between the title line and the exit line; to the end when there is no exit line (timed out). */
export function outputBetween(paneText: string, titleLine: string, exitLine: string | undefined): string {
	const lines = paneText.split("\n");
	const startIndex = lines.findLastIndex((line) => line.trim() === titleLine);
	const endIndex = exitLine === undefined ? -1 : lines.findLastIndex((line) => line.trim() === exitLine.trim());
	const from = startIndex === -1 ? 0 : startIndex + 1;
	return lines.slice(from, endIndex === -1 ? undefined : endIndex).join("\n").trim();
}

export class CommandPane {
	private paneId: string | undefined;

	constructor(
		private readonly client: HerdrClient,
		/** The pane it opens beside: Pi's own. */
		private readonly anchorPaneId: string,
		private readonly direction: "right" | "down",
	) {}

	async run(command: PaneCommand): Promise<PaneCommandOutcome> {
		const paneId = await this.ensurePane(command.cwd);
		const lines = paneCommandLines(command, randomBytes(6).toString("hex"));
		await this.client.runInPane(paneId, lines.commandLine);
		try {
			const match = await this.client.waitForPaneOutput(paneId, lines.exitPattern, command.timeoutMs, OUTPUT_LINES);
			const exitCode = Number(new RegExp(lines.exitPattern).exec(match.matchedLine)?.[1] ?? 1);
			return { exitCode, timedOut: false, output: outputBetween(match.text, lines.titleLine, match.matchedLine) };
		} catch (error) {
			if (!(error instanceof HerdrCommandError) || error.code !== HERDR_TIMEOUT_CODE) throw error;
			// Stops the command so the pane is free for the next run.
			await this.client.sendPaneKeys(paneId, ["ctrl+c"]);
			const paneText = await this.client.readPane(paneId, OUTPUT_LINES);
			return { exitCode: 1, timedOut: true, output: outputBetween(paneText, lines.titleLine, undefined) };
		}
	}

	/** Closes the pane when Pi ends; it is ours alone. */
	async close(): Promise<void> {
		const paneId = this.paneId;
		this.paneId = undefined;
		if (paneId) await this.client.closePane(paneId);
	}

	/** The pane from earlier runs, or a new one when there is none (or you closed it). */
	private async ensurePane(cwd: string): Promise<string> {
		if (this.paneId && (await this.client.hasPane(this.paneId))) return this.paneId;
		const pane = await this.client.splitPane({ targetPaneId: this.anchorPaneId, direction: this.direction, cwd });
		this.paneId = pane.paneId;
		return pane.paneId;
	}
}
