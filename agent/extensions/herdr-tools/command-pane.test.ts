import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { CommandPane, outputBetween, paneCommandLines } from "./command-pane.ts";
import { type CommandOutput, HerdrClient } from "./herdr-cli.ts";

test("the typed line runs the command in its folder between a title line and an exit line with the code", () => {
	const lines = paneCommandLines({ title: "test", argv: ["sh", "-c", 'pwd; echo "it\'s $1"; exit 3', "inner", "done"], cwd: "/tmp" }, "abc123");
	const printed = execFileSync("bash", ["-c", lines.commandLine], { encoding: "utf8" });
	assert.equal(printed, "▶ test [abc123]\n/tmp\nit's done\n■ exit 3 [abc123]\n");
	const exitLine = printed.trim().split("\n").at(-1) ?? "";
	assert.equal(new RegExp(lines.exitPattern).exec(exitLine)?.[1], "3");
	assert.equal(new RegExp(lines.exitPattern).test(lines.commandLine), false);
});

test("the output is what lies between the latest title line and its exit line", () => {
	const paneText = ["$ old", "▶ lint [t1]", "old output", "■ exit 0 [t1]", "$ sh -c …", "▶ lint [t2]", "error A", "error B", "■ exit 1 [t2]", "$"].join("\n");
	assert.equal(outputBetween(paneText, "▶ lint [t2]", "■ exit 1 [t2]"), "error A\nerror B");
	assert.equal(outputBetween("▶ lint [t3]\nstill running", "▶ lint [t3]", undefined), "still running");
});

/** A herdr that has one pane and answers each command type from the given handlers. */
function fakeHerdr(waitAnswer: CommandOutput): { client: HerdrClient; calls: string[][] } {
	const calls: string[][] = [];
	let hasPane = false;
	const client = new HerdrClient(async (args) => {
		calls.push([...args]);
		const command = `${args[0]} ${args[1]}`;
		if (command === "pane get") {
			return hasPane ? { code: 0, stdout: JSON.stringify({ result: { pane: { pane_id: "w1:p2" } } }), stderr: "" } : notFound;
		}
		if (command === "pane split") {
			hasPane = true;
			return { code: 0, stdout: JSON.stringify({ result: { pane: { pane_id: "w1:p2", workspace_id: "w1" } } }), stderr: "" };
		}
		if (command === "pane wait-output") return waitAnswer;
		if (command === "pane read") return { code: 0, stdout: "▶ slow [x]\nwaiting\n^C", stderr: "" };
		return { code: 0, stdout: "", stderr: "" };
	});
	return { client, calls };
}
const notFound: CommandOutput = { code: 1, stdout: "", stderr: JSON.stringify({ error: { code: "pane_not_found", message: "no pane" } }) };

test("the pane is opened once and reused for the next command", async () => {
	const matched = { code: 0, stdout: JSON.stringify({ result: { matched_line: "■ exit 0 [x]", read: { text: "" } } }), stderr: "" };
	const { client, calls } = fakeHerdr(matched);
	const pane = new CommandPane(client, "w1:p1", "down");
	const command = { title: "t", argv: ["true"], cwd: "/repo", timeoutMs: 1000 };
	await pane.run(command);
	await pane.run(command);
	assert.equal(calls.filter((call) => call[1] === "split").length, 1);
	assert.deepEqual(calls.find((call) => call[1] === "split")?.slice(0, 5), ["pane", "split", "w1:p1", "--direction", "down"]);
});

test("a command that outlives its time is stopped with Ctrl+C and reported as timed out", async () => {
	const timedOut = { code: 1, stdout: "", stderr: JSON.stringify({ error: { code: "timeout", message: "timed out" } }) };
	const { client, calls } = fakeHerdr(timedOut);
	const outcome = await new CommandPane(client, "w1:p1", "down").run({ title: "slow", argv: ["sleep", "9"], cwd: "/repo", timeoutMs: 10 });
	assert.equal(outcome.timedOut, true);
	assert.ok(calls.some((call) => call[1] === "send-keys" && call.includes("ctrl+c")));
});

test("a herdr failure other than a timeout is not taken for a failed command", async () => {
	const broken = { code: 1, stdout: "", stderr: JSON.stringify({ error: { code: "server_unavailable", message: "no server" } }) };
	const { client } = fakeHerdr(broken);
	await assert.rejects(new CommandPane(client, "w1:p1", "down").run({ title: "t", argv: ["true"], cwd: "/repo", timeoutMs: 10 }), /no server/);
});
