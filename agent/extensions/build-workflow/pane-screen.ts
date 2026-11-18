/**
 * The planner's side of a screen shown in a herdr tab: a Unix socket the in-pane client (pane-screen-client.ts)
 * connects to. The client reports its size and the keys typed there; the planner pushes whole frames back.
 * One client at a time: a newer connection (after the client reconnects) replaces the older one.
 */
import { rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { shellQuote } from "../herdr-tools/herdr-cli.ts";

export interface PaneSize {
	rows: number;
	columns: number;
}

/** What the client sends: its size when it connects or resizes, and keys as typed. */
export type ClientMessage = { kind: "size"; size: PaneSize } | { kind: "keys"; keys: string };

const CLIENT_SCRIPT = fileURLToPath(new URL("./pane-screen-client.ts", import.meta.url));

/** Short and per workspace: Unix socket paths are limited to about 100 bytes. */
export function screenSocketPath(workspaceId: string, screen: string, folder = tmpdir()): string {
	return join(folder, `pi-${screen}-${workspaceId.replace(/[^\w-]/g, "_")}.sock`);
}

/** The shell command the herdr tab runs to show the screen. */
export function screenClientCommand(socketPath: string, clientScript = CLIENT_SCRIPT): string {
	return `node --no-warnings ${shellQuote(clientScript)} ${shellQuote(socketPath)}`;
}

/** One newline-delimited JSON line from the client; undefined for anything else. */
export function parseClientMessage(line: string): ClientMessage | undefined {
	let message: { size?: { rows?: unknown; columns?: unknown }; keys?: unknown };
	try {
		message = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (typeof message.keys === "string") return { kind: "keys", keys: message.keys };
	const rows = Number(message.size?.rows);
	const columns = Number(message.size?.columns);
	return rows > 0 && columns > 0 ? { kind: "size", size: { rows, columns } } : undefined;
}

/** Splits received text into whole lines, keeping the unfinished tail for the next chunk. */
export function takeLines(pending: string, chunk: string): { lines: string[]; pending: string } {
	const lines = (pending + chunk).split("\n");
	const rest = lines.pop() ?? "";
	return { lines, pending: rest };
}

export class PaneScreen {
	readonly socketPath: string;
	private server: Server | undefined;
	private client: Socket | undefined;
	private clientSize: PaneSize | undefined;
	private onKeys: (keys: string) => void = () => {};
	private onConnect: () => void = () => {};

	constructor(socketPath: string) {
		this.socketPath = socketPath;
	}

	/** The connected pane's size; undefined while no client is there. */
	get size(): PaneSize | undefined {
		return this.client ? this.clientSize : undefined;
	}

	/** Keys typed in the pane, and a fresh connection (or a resize) that wants a frame right away. */
	listen(onKeys: (keys: string) => void, onConnect: () => void): Promise<void> {
		this.onKeys = onKeys;
		this.onConnect = onConnect;
		if (this.server) return Promise.resolve();
		// A planner that ended without closing (crash, kill) leaves its socket file behind.
		rmSync(this.socketPath, { force: true });
		const server = createServer((socket) => this.accept(socket));
		this.server = server;
		return new Promise((resolve, reject) => {
			server.once("error", reject);
			server.listen(this.socketPath, () => {
				server.off("error", reject);
				resolve();
			});
		});
	}

	/** Sends the frame to the pane; does nothing while no client is connected. */
	show(lines: readonly string[]): void {
		if (!this.client || this.client.destroyed) return;
		this.client.write(`${JSON.stringify({ frame: lines })}\n`);
	}

	/** Tells the client to give the shell back, then stops listening. */
	async end(): Promise<void> {
		const client = this.client;
		this.client = undefined;
		if (client && !client.destroyed) await new Promise<void>((resolve) => client.end(`${JSON.stringify({ end: true })}\n`, resolve));
		await this.stopListening();
	}

	/** Stops listening and leaves the client waiting to reconnect, as across a /reload. */
	async stopListening(): Promise<void> {
		this.client?.destroy();
		this.client = undefined;
		const server = this.server;
		this.server = undefined;
		if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
		rmSync(this.socketPath, { force: true });
	}

	private accept(socket: Socket): void {
		this.client?.destroy();
		this.client = socket;
		this.clientSize = undefined;
		let pending = "";
		socket.setEncoding("utf8");
		socket.on("error", () => socket.destroy());
		socket.on("close", () => {
			if (this.client === socket) this.client = undefined;
		});
		socket.on("data", (chunk: string) => {
			const taken = takeLines(pending, chunk);
			pending = taken.pending;
			for (const line of taken.lines) this.handle(parseClientMessage(line));
		});
	}

	private handle(message: ClientMessage | undefined): void {
		if (!message) return;
		if (message.kind === "keys") {
			this.onKeys(message.keys);
			return;
		}
		this.clientSize = message.size;
		this.onConnect();
	}
}
