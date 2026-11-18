/**
 * Runs inside a herdr tab of the build space and shows a screen the planner draws: it reports the pane's size
 * and keys over a Unix socket (pane-screen.ts) and paints every frame it gets back. After a /reload it waits
 * for the planner and reconnects; when the run ends the planner says "end" and the shell comes back.
 * Started as `node pane-screen-client.ts <socket>`: plain Node, node: modules only, no imports from Pi.
 */
import { connect, type Socket } from "node:net";

const RECONNECT_DELAY_MS = 1000;
const CTRL_C = "\u0003";
const ENTER_SCREEN = "\u001b[?1049h\u001b[?25l";
const LEAVE_SCREEN = "\u001b[?25h\u001b[?1049l";
const CLEAR_TO_LINE_END = "\u001b[K";
const CLEAR_BELOW = "\u001b[J";
const CURSOR_HOME = "\u001b[H";

const socketPath = process.argv[2];
if (!socketPath) {
	process.stderr.write("usage: pane-screen-client.ts <socket>\n");
	process.exit(2);
}

let socket: Socket | undefined;
let pendingText = "";
let isLeaving = false;

function paint(lines: readonly string[]): void {
	process.stdout.write(CURSOR_HOME + lines.map((line) => line + CLEAR_TO_LINE_END).join("\r\n") + CLEAR_BELOW);
}

function sendMessage(message: object): void {
	socket?.write(`${JSON.stringify(message)}\n`);
}

function sendSize(): void {
	sendMessage({ size: { rows: process.stdout.rows ?? 24, columns: process.stdout.columns ?? 80 } });
}

function leave(): void {
	if (isLeaving) return;
	isLeaving = true;
	socket?.destroy();
	process.stdout.write(LEAVE_SCREEN);
	if (process.stdin.isTTY) process.stdin.setRawMode(false);
	process.exit(0);
}

function handleLine(line: string): void {
	if (line.trim() === "") return;
	const message = JSON.parse(line) as { frame?: unknown; end?: unknown };
	if (message.end === true) leave();
	if (Array.isArray(message.frame)) paint(message.frame.map(String));
}

function connectToPlanner(): void {
	const connection = connect(socketPath);
	connection.setEncoding("utf8");
	connection.on("connect", () => {
		socket = connection;
		pendingText = "";
		sendSize();
	});
	connection.on("data", (chunk: string) => {
		pendingText += chunk;
		const lines = pendingText.split("\n");
		pendingText = lines.pop() ?? "";
		for (const line of lines) handleLine(line);
	});
	// The planner reloads or has not started yet: wait for it rather than give the shell back mid-run.
	connection.on("error", () => {});
	connection.on("close", () => {
		if (socket === connection) socket = undefined;
		if (isLeaving) return;
		paint(["Waiting for the planner… (Ctrl+C gives the shell back)"]);
		setTimeout(connectToPlanner, RECONNECT_DELAY_MS);
	});
}

process.stdout.write(ENTER_SCREEN);
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.setEncoding("utf8");
process.stdin.on("data", (keys: string) => {
	if (keys === CTRL_C) leave();
	else sendMessage({ keys });
});
process.stdout.on("resize", sendSize);
process.on("SIGTERM", leave);
paint(["Connecting to the planner…"]);
connectToPlanner();
