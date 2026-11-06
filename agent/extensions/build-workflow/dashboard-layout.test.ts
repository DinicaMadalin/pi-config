import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { canShowSidePanel, DEFAULT_LAYOUT, loadLayout, parseLayout, saveLayout } from "./dashboard-layout.ts";

test("the side panel only shows when it is on and the terminal can spare the columns", () => {
	assert.equal(canShowSidePanel({ strip: "full", sidePanel: "right" }, 200), true);
	assert.equal(canShowSidePanel({ strip: "full", sidePanel: "left" }, 159), false);
	assert.equal(canShowSidePanel({ strip: "full", sidePanel: "off" }, 300), false);
});

test("a saved layout survives a restart; unknown values fall back to the default", () => {
	const layoutPath = join(mkdtempSync(join(tmpdir(), "dashboard-")), "nested", "dashboard.json");
	assert.deepEqual(loadLayout(layoutPath), DEFAULT_LAYOUT);
	saveLayout(layoutPath, { strip: "compact", sidePanel: "left" });
	assert.deepEqual(loadLayout(layoutPath), { strip: "compact", sidePanel: "left" });
	assert.deepEqual(parseLayout({ strip: "huge", sidePanel: "left" }), { strip: "full", sidePanel: "left" });
	assert.deepEqual(parseLayout(null), DEFAULT_LAYOUT);
});

test("a layout file that is not JSON is reported with its path", () => {
	const layoutPath = join(mkdtempSync(join(tmpdir(), "dashboard-")), "dashboard.json");
	writeFileSync(layoutPath, "{oops");
	assert.throws(() => loadLayout(layoutPath), /Failed to read the dashboard layout from .*dashboard\.json/);
});
