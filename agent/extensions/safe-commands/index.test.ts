import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerSafeCommands from "./index.ts";

interface RegisteredDelegate {
	id: string;
	decide(request: unknown, context?: unknown): { verdict: string; reason: string };
}

function loadDelegate(): RegisteredDelegate {
	const listeners = new Map<string, ((payload?: unknown) => void)[]>();
	let registered: RegisteredDelegate | undefined;

	const pi = {
		events: {
			on(event: string, listener: (payload?: unknown) => void) {
				const existing = listeners.get(event) ?? [];
				listeners.set(event, [...existing, listener]);
				return () => listeners.set(event, (listeners.get(event) ?? []).filter((other) => other !== listener));
			},
			emit(event: string, payload?: unknown) {
				if (event === "guardrails:delegate:register") {
					registered = (payload as { delegate: RegisteredDelegate }).delegate;
				}
				for (const listener of listeners.get(event) ?? []) listener(payload);
			},
		},
		on() {
			return () => undefined;
		},
	} as unknown as ExtensionAPI;

	registerSafeCommands(pi);
	assert.ok(registered, "the extension must offer its delegate to Guardrails");
	return registered;
}

function decide(command: string, cwd = "/home/dnk/projects/app"): { verdict: string; reason: string } {
	return loadDelegate().decide({ feature: "permissionGate", action: { kind: "command", command } }, { cwd });
}

test("Guardrails is offered a delegate named for routine cleanup", () => {
	assert.equal(loadDelegate().id, "safe-commands");
});

test("a scratch delete is allowed", () => {
	assert.equal(decide("rm -rf /tmp/probe").verdict, "allow");
});

test("a project delete is left to the normal prompt", () => {
	assert.equal(decide("rm -rf src").verdict, "ask");
});

test("another feature's actions are left alone", () => {
	const answer = loadDelegate().decide({ feature: "pathAccess", action: { kind: "command", command: "rm -rf /tmp/x" } });
	assert.equal(answer.verdict, "ask");
});

test("a non-command action is left alone", () => {
	assert.equal(loadDelegate().decide({ feature: "permissionGate", action: { kind: "path", path: "/tmp/x" } }).verdict, "ask");
});
