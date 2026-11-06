import assert from "node:assert/strict";
import { test } from "node:test";
import { findRoutePin, ROUTE_PIN_ENTRY_TYPE } from "./route-pin.ts";

const pin = (data: unknown) => ({ type: "custom", customType: ROUTE_PIN_ENTRY_TYPE, data });
const message = { type: "message" };

test("routes normally in a session that never set a pin", () => {
	assert.deepEqual(findRoutePin([message]), { route: "normal" });
});

test("the latest pin wins", () => {
	const entries = [pin({ route: "tier", tier: "expert" }), message, pin({ route: "difficulty" }), message];
	assert.deepEqual(findRoutePin(entries), { route: "difficulty" });
});

test("a normal pin removes an earlier one", () => {
	assert.deepEqual(findRoutePin([pin({ route: "tier", tier: "expert" }), pin({ route: "normal" })]), { route: "normal" });
});

test("an unknown tier falls back to normal routing", () => {
	assert.deepEqual(findRoutePin([pin({ route: "tier", tier: "legendary" })]), { route: "normal" });
});

test("a tier pin keeps its preferred provider", () => {
	const entry = { type: "custom", customType: ROUTE_PIN_ENTRY_TYPE, data: { route: "tier", tier: "expert", preferredProvider: "openai" } };
	assert.deepEqual(findRoutePin([entry]), { route: "tier", tier: "expert", preferredProvider: "openai" });
});
