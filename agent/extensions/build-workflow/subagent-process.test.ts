import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { COMPACTION_RECOVERY_ENTRY_TYPE } from "../auto-model/compaction-recovery.ts";
import { readCompactionRecoveryStatus, SubagentProcess } from "./subagent-process.ts";

function sessionFile(t: TestContext, entries: readonly unknown[]): string {
	const folder = mkdtempSync(join(tmpdir(), "subagent-recovery-"));
	t.after(() => rmSync(folder, { recursive: true, force: true }));
	const path = join(folder, "session.jsonl");
	writeFileSync(path, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
	return path;
}

const recoveryEntry = (data: unknown) => ({ type: "custom", id: "r1", customType: COMPACTION_RECOVERY_ENTRY_TYPE, data });
const failedAnswer = {
	type: "message",
	message: { role: "assistant", stopReason: "error", errorMessage: '503 {"error":{"code":"preflight_compress_failed"}}', content: [] },
};

function createSubagentProcessWithSettlements(sessionPath: string) {
	const settlements: { answer: string; aborted: boolean }[] = [];
	const process = new SubagentProcess({
		name: "Reviewer",
		cwd: tmpdir(),
		sessionPath,
		dialogs: {
			select: async () => undefined,
			confirm: async () => false,
			input: async () => undefined,
		},
		isProjectTrusted: true,
		onSettled: (answer, aborted) => settlements.push({ answer, aborted }),
		onExit: () => {},
	});
	const handleRecord = (record: Record<string, unknown>) =>
		(process as unknown as { handleRecord(record: Record<string, unknown>): void }).handleRecord(record);
	return { process, settlements, handleRecord };
}

test("a session whose last recovery entry is compacting holds the settle for the continued turn", (t) => {
	const path = sessionFile(t, [{ type: "session", version: 3 }, failedAnswer, recoveryEntry({ status: "compacting" })]);
	assert.equal(readCompactionRecoveryStatus(path, 0), "compacting");
});

test("the latest recovery entry wins: a continued or failed recovery no longer holds the settle", (t) => {
	const continued = sessionFile(t, [recoveryEntry({ status: "compacting" }), recoveryEntry({ status: "continued" }), { type: "message", message: { role: "assistant", stopReason: "stop", content: [] } }]);
	assert.equal(readCompactionRecoveryStatus(continued, 0), "continued");
	const failed = sessionFile(t, [recoveryEntry({ status: "compacting" }), recoveryEntry({ status: "failed", reason: "Auto model: compaction failed" })]);
	assert.equal(readCompactionRecoveryStatus(failed, 0), "failed");
});

test("a session without recovery entries, a malformed one, or a missing file has no recovery status", (t) => {
	assert.equal(readCompactionRecoveryStatus(sessionFile(t, [{ type: "session", version: 3 }, failedAnswer]), 0), undefined);
	const malformed = sessionFile(t, [recoveryEntry({ status: "compacting" })]);
	writeFileSync(malformed, `{"type":"custom","customType":"${COMPACTION_RECOVERY_ENTRY_TYPE}","data":{"status":"comp`, { flag: "a" });
	assert.equal(readCompactionRecoveryStatus(malformed, 0), "compacting");
	assert.equal(readCompactionRecoveryStatus(malformed, statSync(malformed).size), undefined);
	assert.equal(readCompactionRecoveryStatus(join(tmpdir(), "missing-subagent-session.jsonl"), 0), undefined);
});

test("a compacting entry left by an earlier run does not hold the next settle", (t) => {
	const path = sessionFile(t, [{ type: "session", version: 3 }, recoveryEntry({ status: "compacting" })]);
	const { process, settlements, handleRecord } = createSubagentProcessWithSettlements(path);
	handleRecord({ type: "agent_start" });
	handleRecord({
		type: "message_end",
		message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "fresh answer" }] },
	});
	handleRecord({ type: "agent_settled", aborted: false });
	assert.deepEqual(settlements, [{ answer: "fresh answer", aborted: false }]);
	assert.equal(process.isWorking, false);
});

test("a stale compacting entry does not hold a failed settle either", (t) => {
	const path = sessionFile(t, [{ type: "session", version: 3 }, recoveryEntry({ status: "compacting" })]);
	const { process, settlements, handleRecord } = createSubagentProcessWithSettlements(path);
	handleRecord({ type: "agent_start" });
	handleRecord({
		type: "message_end",
		message: { role: "assistant", stopReason: "error", content: [{ type: "text", text: "failed response" }] },
	});
	handleRecord({ type: "agent_settled", aborted: false });
	assert.deepEqual(settlements, [{ answer: "failed response", aborted: false }]);
	assert.equal(process.isWorking, false);
});

test("a compacting entry after a successful answer does not hold the settle", (t) => {
	const path = sessionFile(t, [{ type: "session", version: 3 }]);
	const { process, settlements, handleRecord } = createSubagentProcessWithSettlements(path);
	handleRecord({ type: "agent_start" });
	handleRecord({
		type: "message_end",
		message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "fresh answer" }] },
	});
	writeFileSync(path, `${JSON.stringify(recoveryEntry({ status: "compacting" }))}\n`, { flag: "a" });
	handleRecord({ type: "agent_settled", aborted: false });
	assert.deepEqual(settlements, [{ answer: "fresh answer", aborted: false }]);
	assert.equal(process.isWorking, false);
});

test("a failed compression settle stays working until recovery fails or the continued turn settles", (t) => {
	const path = sessionFile(t, [{ type: "session", version: 3 }]);
	const settlements: { answer: string; aborted: boolean }[] = [];
	const process = new SubagentProcess({
		name: "Reviewer",
		cwd: tmpdir(),
		sessionPath: path,
		dialogs: {
			select: async () => undefined,
			confirm: async () => false,
			input: async () => undefined,
		},
		isProjectTrusted: true,
		onSettled: (answer, aborted) => settlements.push({ answer, aborted }),
		onExit: () => {},
	});
	const handleRecord = (record: Record<string, unknown>) =>
		(process as unknown as { handleRecord(record: Record<string, unknown>): void }).handleRecord(record);

	handleRecord({ type: "agent_start" });
	handleRecord({
		type: "message_end",
		message: { role: "assistant", stopReason: "error", content: [{ type: "text", text: "failed response" }] },
	});
	writeFileSync(path, `${JSON.stringify(recoveryEntry({ status: "compacting" }))}\n`, { flag: "a" });
	handleRecord({ type: "agent_settled", aborted: false });
	assert.deepEqual(settlements, []);
	assert.equal(process.isWorking, true);

	const failedRecovery = recoveryEntry({ status: "failed", reason: "compaction failed" });
	handleRecord({ type: "entry_appended", entry: failedRecovery });
	assert.deepEqual(settlements, [{ answer: "failed response", aborted: false }]);
	assert.equal(process.isWorking, false);

	writeFileSync(path, `${JSON.stringify(recoveryEntry({ status: "continued" }))}\n`, { flag: "a" });
	handleRecord({ type: "agent_start" });
	handleRecord({
		type: "message_end",
		message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "recovered response" }] },
	});
	handleRecord({ type: "agent_settled", aborted: false });
	assert.deepEqual(settlements, [
		{ answer: "failed response", aborted: false },
		{ answer: "recovered response", aborted: false },
	]);
});
