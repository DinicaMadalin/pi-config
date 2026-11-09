import assert from "node:assert/strict";
import { test } from "node:test";
import { assignStreams, capWorkStreams, type ImplementerSeat, parseWorkStreams, tooManyStreamsWarning } from "./work-streams.ts";

const plan = (streams: string) => `# Export\n\n## Goal\nCSV\n\n## Work streams\n${streams}\n## Files\n- a.ts\n`;

test("a plan without work streams is one unnamed stream", () => {
	assert.deepEqual(parseWorkStreams("# Export\n\n## Goal\nCSV"), [{ name: "", text: "", needsStrongModel: false }]);
});

test("reads each stream's name and text up to the next section", () => {
	const streams = parseWorkStreams(plan("### 1. `API`\nsrc/api.ts\n\n### Tests\ntest/api.test.ts\n"));
	assert.deepEqual(streams, [
		{ name: "API", text: "src/api.ts", needsStrongModel: false },
		{ name: "Tests", text: "test/api.test.ts", needsStrongModel: false },
	]);
});

test("a stream marked as needing a strong model keeps its plain name", () => {
	const [sync, docs] = parseWorkStreams(plan("### 2. `sync` (Needs a strong model)\nsrc/sync.ts\n### docs\nREADME.md\n"));
	assert.deepEqual(sync, { name: "sync", text: "src/sync.ts", needsStrongModel: true });
	assert.equal(docs.needsStrongModel, false);
	const merged = capWorkStreams(parseWorkStreams(plan("### A\na\n### B\nb\n### C\nc\n### D (needs a strong model)\nd\n")));
	assert.equal(merged[2].needsStrongModel, true, "a merged stream needs a strong model when one of its parts does");
});

test("more streams than implementers join the last one, so no work is dropped", () => {
	const streams = parseWorkStreams(plan("### A\na\n### B\nb\n### C\nc\n### D\nd\n"));
	const capped = capWorkStreams(streams);
	assert.deepEqual(capped.map((stream) => stream.name), ["A", "B", "C + D"]);
	assert.ok(capped[2].text.includes("#### D\nd"));
	assert.ok(tooManyStreamsWarning(plan("### A\na\n### B\nb\n### C\nc\n### D\nd\n"))?.includes("4 work streams"));
	assert.equal(tooManyStreamsWarning(plan("### A\na\n")), undefined);
});

test("implementers keep the stream they built, take free streams in order, and new streams get new implementers", () => {
	const crew: ImplementerSeat[] = [
		{ role: "implementer", stream: "API", sessionPath: "/s/1" },
		{ role: "implementer-2", stream: "Tests", sessionPath: "/s/2" },
	];
	const streams = parseWorkStreams(plan("### Tests\nt\n### Docs\nd\n### UI\nu\n"));
	const created: string[] = [];
	const seats = assignStreams(streams, crew, (role) => {
		created.push(role);
		return `/s/new-${role}`;
	});
	assert.deepEqual(
		seats.map((seat) => [seat.role, seat.stream, seat.sessionPath]),
		[
			["implementer-2", "Tests", "/s/2"],
			["implementer", "Docs", "/s/1"],
			["implementer-3", "UI", "/s/new-implementer-3"],
		],
	);
	assert.deepEqual(created, ["implementer-3"]);
});

test("a single-stream plan reuses the first implementer of the session", () => {
	const crew: ImplementerSeat[] = [{ role: "implementer", stream: "", sessionPath: "/s/1" }];
	const seats = assignStreams(parseWorkStreams("# Fix"), crew, () => assert.fail("no new session expected"));
	assert.deepEqual(seats, [{ role: "implementer", stream: "", sessionPath: "/s/1" }]);
});
