/**
 * prompt-rewriter: before a typed message goes to the model, Jev judges whether it needs a rewrite; if so a cheap
 * model rewrites it into a clear, structured prompt with the same meaning (asking you up to three questions when Jev
 * finds it ambiguous), Jev checks the rewrite kept the meaning, and you send, edit, or skip it. /build tasks get the
 * same treatment (see rewrite-request.ts). The steps are in prompt-improver.ts.
 *
 * - /rewrite on|off turns it on or off (saved in ~/.pi/agent/prompt-rewriter.json); /rewrite shows the state.
 * - Clear messages, short replies, commands and structured prompts go as typed; so does anything when the rewrite fails.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { decideRewrite } from "./rewrite-policy.ts";
import { REWRITE_REQUEST_EVENT, type RewriteOutcome, type RewriteRequest } from "./rewrite-request.ts";
import { improvePrompt } from "./prompt-improver.ts";

const SETTINGS_PATH = join(homedir(), ".pi", "agent", "prompt-rewriter.json");
const ORIGINAL_ENTRY_TYPE = "prompt-rewriter-original";

function loadIsEnabled(): boolean {
	if (!existsSync(SETTINGS_PATH)) return true;
	try {
		return (JSON.parse(readFileSync(SETTINGS_PATH, "utf8")) as { enabled?: unknown }).enabled !== false;
	} catch (error) {
		throw new Error(`Failed to read ${SETTINGS_PATH}: ${(error as Error).message}`);
	}
}

function saveIsEnabled(isEnabled: boolean): void {
	writeFileSync(SETTINGS_PATH, `${JSON.stringify({ enabled: isEnabled }, null, 2)}\n`);
}

export default function (pi: ExtensionAPI) {
	let isEnabled = loadIsEnabled();

	/** Keeps your original wording in the session whenever something else was sent. */
	async function improveAndRecord(ctx: ExtensionContext, original: string): Promise<RewriteOutcome> {
		const outcome = await improvePrompt(ctx, original);
		if (outcome.kind === "send" && outcome.text !== original) pi.appendEntry(ORIGINAL_ENTRY_TYPE, { original, sent: outcome.text });
		return outcome;
	}

	pi.on("input", async (event, ctx) => {
		if (!isEnabled || event.source !== "interactive" || event.streamingBehavior || !ctx.hasUI) return { action: "continue" };
		if (decideRewrite(event.text).kind === "skip") return { action: "continue" };
		const outcome = await improveAndRecord(ctx, event.text);
		if (outcome.kind === "cancelled") {
			ctx.ui.setEditorText(event.text);
			ctx.ui.notify("Not sent; your message is back in the editor", "info");
			return { action: "handled" };
		}
		if (outcome.text === event.text) return { action: "continue" };
		return { action: "transform", text: outcome.text, ...(event.images && { images: event.images }) };
	});

	pi.events.on(REWRITE_REQUEST_EVENT, (data) => {
		const request = data as RewriteRequest;
		const { ctx, text } = request;
		if (!isEnabled || !ctx.hasUI || decideRewrite(text).kind === "skip") return;
		request.outcome = improveAndRecord(ctx, text);
	});

	pi.registerCommand("rewrite", {
		description: "Rewrite typed prompts into clear, structured ones before sending: /rewrite on|off",
		handler: async (args, ctx) => {
			const setting = args.trim().toLowerCase();
			if (setting === "on" || setting === "off") {
				isEnabled = setting === "on";
				saveIsEnabled(isEnabled);
			} else if (setting) {
				ctx.ui.notify("Usage: /rewrite on|off", "warning");
				return;
			}
			ctx.ui.notify(`Prompt rewriting is ${isEnabled ? "on" : "off"}`, "info");
		},
	});
}
