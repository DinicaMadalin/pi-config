import assert from "node:assert/strict";
import { test } from "node:test";
import { type CommandOutput, HerdrClient, HerdrCommandError, isInsideHerdr, parseHerdrAgent, readHerdrResult, shellQuote } from "./herdr-cli.ts";

const succeeded = (result: unknown): CommandOutput => ({ code: 0, stdout: JSON.stringify({ id: "cli", result }), stderr: "" });
const failed = (code: string, message: string): CommandOutput => ({ code: 1, stdout: "", stderr: JSON.stringify({ error: { code, message } }) });

/** A HerdrClient whose herdr answers from a list, recording each call's arguments. */
function fakeClient(answers: CommandOutput[]): { client: HerdrClient; calls: string[][] } {
	const calls: string[][] = [];
	const client = new HerdrClient(async (args) => {
		calls.push([...args]);
		const answer = answers.shift();
		if (!answer) throw new Error(`unexpected herdr call: ${args.join(" ")}`);
		return answer;
	});
	return { client, calls };
}

test("only a herdr pane counts as inside herdr", () => {
	assert.equal(isInsideHerdr({ HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1" }), true);
	assert.equal(isInsideHerdr({ HERDR_ENV: "1" }), false);
	assert.equal(isInsideHerdr({}), false);
});

test("a failed herdr command keeps herdr's error code and message", () => {
	assert.throws(
		() => readHerdrResult("close pane w1:p9", failed("pane_not_found", "no pane w1:p9")),
		(error: unknown) => error instanceof HerdrCommandError && error.code === "pane_not_found" && error.message.includes("no pane w1:p9"),
	);
	assert.deepEqual(readHerdrResult("run", { code: 0, stdout: "", stderr: "" }), {});
	assert.throws(() => readHerdrResult("list", { code: 0, stdout: "not json", stderr: "" }), /unexpected output/);
});

test("an agent from herdr's answer, with unknown states kept as unknown", () => {
	const agent = parseHerdrAgent({ pane_id: "w2:p3", workspace_id: "w2", agent: "pi", agent_status: "blocked", cwd: "/repo", focused: true });
	assert.deepEqual(agent, { paneId: "w2:p3", workspaceId: "w2", agent: "pi", status: "blocked", cwd: "/repo", isFocused: true });
	assert.equal(parseHerdrAgent({ pane_id: "w2:p3", agent_status: "sleeping" })?.status, "unknown");
	assert.equal(parseHerdrAgent({}), undefined);
});

test("waits for either idle or done before considering an agent ready for input", async () => {
	for (const status of ["idle", "done"] as const) {
		const { client, calls } = fakeClient([succeeded({ agent: { pane_id: "w2:p4", agent_status: status } })]);
		const agent = await client.waitForAgentReady("w2:p4", 10_000);
		assert.equal(agent.status, status);
		assert.deepEqual(calls[0].slice(0, 7), ["agent", "wait", "w2:p4", "--until", "idle", "--until", "done"]);
		assert.equal(calls[0][7], "--timeout");
		assert.ok(Number(calls[0][8]) > 0 && Number(calls[0][8]) <= 10_000);
	}
});

test("a split pane opens beside the given pane without taking focus", async () => {
	const { client, calls } = fakeClient([succeeded({ pane: { pane_id: "w2:p4", workspace_id: "w2" } })]);
	const pane = await client.splitPane({ targetPaneId: "w2:p1", direction: "right", cwd: "/repo" });
	assert.deepEqual(pane, { paneId: "w2:p4", workspaceId: "w2" });
	assert.deepEqual(calls[0], ["pane", "split", "w2:p1", "--direction", "right", "--cwd", "/repo", "--no-focus"]);
});

test("a helper tab opens in the run's workspace with a labeled full-size pane without taking focus", async () => {
	const { client, calls } = fakeClient([succeeded({ tab: { tab_id: "w9:t3" }, root_pane: { pane_id: "w9:p5", workspace_id: "w9" } })]);
	assert.deepEqual(await client.createTab("w9", "/repo/worktree", "Claude reviewer"), { tabId: "w9:t3", workspaceId: "w9", rootPaneId: "w9:p5" });
	assert.deepEqual(calls, [["tab", "create", "--workspace", "w9", "--cwd", "/repo/worktree", "--label", "Claude reviewer", "--no-focus"]]);
});

test("tab cleanup closes only the named tab, tolerates missing tabs, and reports other errors", async () => {
	const { client, calls } = fakeClient([succeeded({}), failed("tab_not_found", "gone"), failed("unavailable", "server unavailable")]);
	await client.closeTab("w9:t3");
	await client.closeTab("w9:t3");
	await assert.rejects(client.closeTab("w9:t3"), /server unavailable/);
	assert.deepEqual(calls, Array.from({ length: 3 }, () => ["tab", "close", "w9:t3"]));
});

test("a tab's layout reads pane columns and split ratios; a resize moves a pane's edge by a share", async () => {
	const layout = {
		panes: [{ pane_id: "w9:p1", rect: { x: 0, width: 115 } }, { pane_id: "w9:p2", rect: { x: 115, width: 115 } }],
		splits: [{ direction: "right", ratio: 0.5, rect: { x: 0, y: 0 } }],
	};
	const { client, calls } = fakeClient([succeeded({ layout }), succeeded({})]);
	assert.deepEqual(await client.paneLayout("w9:p1"), {
		panes: [{ paneId: "w9:p1", x: 0, width: 115 }, { paneId: "w9:p2", x: 115, width: 115 }],
		splits: [{ direction: "right", ratio: 0.5, x: 0, y: 0 }],
	});
	await client.resizePane("w9:p2", "left", 1 / 6);
	assert.deepEqual(calls, [["pane", "layout", "--pane", "w9:p1"], ["pane", "resize", "--pane", "w9:p2", "--direction", "left", "--amount", "0.1667"]]);
});

test("a helper's agent gets its role as name", async () => {
	const { client, calls } = fakeClient([succeeded({})]);
	await client.renameAgent("w9:p5", "openai-reviewer");
	assert.deepEqual(calls, [["agent", "rename", "w9:p5", "openai-reviewer"]]);
});

test("a pane without an agent has no agent; closing a pane that is gone is fine", async () => {
	const { client } = fakeClient([failed("agent_not_found", "no agent"), failed("pane_not_found", "gone")]);
	assert.equal(await client.getAgent("w2:p4"), undefined);
	await client.closePane("w2:p4");
});

test("reading a pane returns its text, which herdr prints as is", async () => {
	const { client } = fakeClient([{ code: 0, stdout: "line one\nline two\n", stderr: "" }]);
	assert.equal(await client.readPane("w2:p4", 20), "line one\nline two\n");
});

test("shell quoting keeps plain words and quotes the rest for any POSIX shell", () => {
	assert.equal(shellQuote("/usr/bin/pi"), "/usr/bin/pi");
	assert.equal(shellQuote("it's here"), `'it'\\''s here'`);
	assert.equal(shellQuote(""), "''");
});
