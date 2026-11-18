import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PaneScreen, parseClientMessage, screenClientCommand, screenSocketPath, takeLines } from "./pane-screen.ts";
import { plannerReturnFor } from "./planner-pane.ts";

test("each build space screen gets a short socket per workspace and screen", () => {
	assert.equal(screenSocketPath("w3", "diff", "/tmp"), "/tmp/pi-diff-w3.sock");
	assert.equal(screenSocketPath("w:3/x", "diff", "/tmp"), "/tmp/pi-diff-w_3_x.sock");
	assert.equal(screenClientCommand("/tmp/a b.sock", "/x/client.ts"), "node --no-warnings /x/client.ts '/tmp/a b.sock'");
});

test("client messages are a size or keys; anything else is ignored", () => {
	assert.deepEqual(parseClientMessage('{"size":{"rows":40,"columns":120}}'), { kind: "size", size: { rows: 40, columns: 120 } });
	assert.deepEqual(parseClientMessage('{"keys":"\\u001b[A"}'), { kind: "keys", keys: "\u001b[A" });
	assert.equal(parseClientMessage('{"size":{"rows":0,"columns":120}}'), undefined);
	assert.equal(parseClientMessage("not json"), undefined);
});

test("received text splits into whole lines and keeps the unfinished tail", () => {
	assert.deepEqual(takeLines("ab", "c\nde\nf"), { lines: ["abc", "de"], pending: "f" });
	assert.deepEqual(takeLines("", "x"), { lines: [], pending: "x" });
});

test("the screen learns the pane size, takes its keys and pushes frames until it ends", async () => {
	const socketPath = join(mkdtempSync(join(tmpdir(), "pane-screen-")), "s.sock");
	const screen = new PaneScreen(socketPath);
	const keys: string[] = [];
	let connected = 0;
	await screen.listen((typed) => keys.push(typed), () => connected++);
	const socket = connect(socketPath);
	socket.setEncoding("utf8");
	let received = "";
	socket.on("data", (chunk: string) => {
		received += chunk;
	});
	await new Promise<void>((resolve) => socket.on("connect", () => resolve()));
	socket.write('{"size":{"rows":10,"columns":50}}\n{"keys":"j"}\n');
	await waitFor(() => connected === 1 && keys.length === 1);
	assert.deepEqual(screen.size, { rows: 10, columns: 50 });
	assert.deepEqual(keys, ["j"]);
	screen.show(["one", "two"]);
	await waitFor(() => received.includes("two"));
	assert.deepEqual(JSON.parse(received.trim()), { frame: ["one", "two"] });
	await screen.end();
	await waitFor(() => received.includes('"end":true'));
	assert.equal(screen.size, undefined);
});

test("the in-pane client paints the frames and exits when the run ends", async () => {
	const socketPath = join(mkdtempSync(join(tmpdir(), "pane-screen-")), "s.sock");
	const screen = new PaneScreen(socketPath);
	await screen.listen(() => {}, () => screen.show(["hello from the planner"]));
	const client = spawn(process.execPath, ["--no-warnings", join(import.meta.dirname, "pane-screen-client.ts"), socketPath], { stdio: ["pipe", "pipe", "pipe"] });
	let painted = "";
	client.stdout.setEncoding("utf8");
	client.stdout.on("data", (chunk: string) => {
		painted += chunk;
	});
	await waitFor(() => painted.includes("hello from the planner"));
	const exitCode = new Promise<number | null>((resolve) => client.on("exit", resolve));
	await screen.end();
	assert.equal(await exitCode, 0);
});

test("planner returns beside its surviving neighbour, otherwise into a new tab", () => {
	const home = { workspaceId: "w1", tabId: "w1:t1", tabLabel: "Chat", neighbourPaneId: "w1:p2" };
	assert.deepEqual(plannerReturnFor(home, new Set(["w1:p2"])), { kind: "beside-neighbour", tabId: "w1:t1", neighbourPaneId: "w1:p2" });
	assert.deepEqual(plannerReturnFor(home, new Set()), { kind: "new-tab", workspaceId: "w1", label: "Chat" });
});

async function waitFor(isDone: () => boolean, timeoutMs = 5000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!isDone()) {
		if (Date.now() > deadline) throw new Error("Timed out waiting for the pane screen");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}
