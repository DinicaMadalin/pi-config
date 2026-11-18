import assert from "node:assert/strict";
import { test } from "node:test";
import { piCommandFor } from "./subagent-process.ts";

test("a Bun-compiled pi relaunches itself without its virtual entry path, which it would read as a prompt", () => {
	assert.deepEqual(piCommandFor(["/usr/bin/pi", "/$bunfs/root/pi"], "/usr/bin/pi"), { command: "/usr/bin/pi", args: [] });
	assert.deepEqual(piCommandFor(["C:\\pi.exe", "B:/~BUN/root/pi.exe"], "C:\\pi.exe"), { command: "C:\\pi.exe", args: [] });
});

test("a pi run as a script under node relaunches the same runtime and entry script", () => {
	assert.deepEqual(piCommandFor(["/usr/bin/node", "/opt/pi/cli.js"], "/usr/bin/node"), { command: "/usr/bin/node", args: ["/opt/pi/cli.js"] });
});

test("without an entry script it falls back to pi on the PATH", () => {
	assert.deepEqual(piCommandFor(["/usr/bin/node"], "/usr/bin/node"), { command: "pi", args: [] });
});
