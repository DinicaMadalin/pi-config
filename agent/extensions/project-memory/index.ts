/**
 * Project memory: durable per-repo notes plus session handoffs, both under `<repo>/.scratch/`.
 *
 * - Every prompt gets the repo's notes (`.scratch/project-notes.md`) in the system prompt.
 * - The agent saves decisions, gotchas, and rules it learns with the `save_project_note` tool.
 * - /note [decision|gotcha|rule|fact:] <text> saves a note; /notes opens the notebook for editing.
 * - Agreed plan: when the user confirms the goal and approach, the agent saves the final plan to
 *   `.scratch/handoffs/` with `save_agreed_plan`. /handoff [focus] opens that plan for review (or
 *   writes it from the conversation if none was saved) and offers a fresh session to execute it.
 */
import { StringEnum } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { BorderedLoader, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	formatNoteLine,
	MAX_NOTES_PROMPT_CHARS,
	NOTE_KINDS,
	NOTES_RELATIVE_PATH,
	parseNoteCommand,
	projectRootFor,
	readNotesFile,
	saveNote,
	selectNotesForPrompt,
	writeNotesFile,
} from "./project-notes.ts";
import {
	AGREED_PLAN_SECTIONS,
	executePlanPrompt,
	findSavedPlanPath,
	readPlan,
	SAVE_PLAN_TOOL_NAME,
	saveAgreedPlan,
	updatePlan,
} from "./agreed-plan-files.ts";
import { messagesForPlan, pickPlanWriterModel, writeAgreedPlan } from "./session-handoff.ts";

function notesPromptSection(projectRoot: string): string | undefined {
	const notesFile = readNotesFile(projectRoot);
	if (!notesFile) return undefined;
	const { text, omittedCount } = selectNotesForPrompt(notesFile, MAX_NOTES_PROMPT_CHARS);
	if (!text) return undefined;
	const omittedLine = omittedCount > 0 ? `\n(${omittedCount} older notes omitted; read ${NOTES_RELATIVE_PATH} for all of them.)` : "";
	return `\n\n## Project notes\nDurable facts saved by earlier sessions in this repo (${NOTES_RELATIVE_PATH}). Trust them unless the code proves otherwise; if a note is wrong, tell the user.\n${text}${omittedLine}`;
}

export default function (pi: ExtensionAPI) {
	pi.on("before_agent_start", (event, ctx) => {
		const notesSection = notesPromptSection(projectRootFor(ctx.cwd));
		if (!notesSection) return undefined;
		return { systemPrompt: event.systemPrompt + notesSection };
	});

	pi.registerTool({
		name: "save_project_note",
		label: "Save project note",
		description:
			"Save a durable fact about this repository so future sessions know it without rediscovering it. " +
			"Use for decisions with their reason, non-obvious gotchas, project rules the user states, and facts that took real digging to find. " +
			"Never for task progress, temporary state, or anything already obvious from the code or README.",
		promptSnippet: "Save durable repo knowledge (decisions, gotchas, rules) for future sessions",
		promptGuidelines: [
			"When you discover a non-obvious fact about this repo, make a decision with the user, or the user states a lasting rule, save it with save_project_note in one self-contained sentence.",
		],
		parameters: Type.Object({
			kind: StringEnum(NOTE_KINDS, { description: "decision, gotcha, rule, or fact" }),
			text: Type.String({ description: "One self-contained sentence; include the reason for decisions" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const noteLine = formatNoteLine(params.kind, params.text, new Date());
			const saved = saveNote(projectRootFor(ctx.cwd), noteLine);
			const outcome = saved.kind === "saved" ? `Saved to ${saved.notesPath}` : `Already in ${saved.notesPath}, not saved again`;
			return { content: [{ type: "text", text: outcome }], details: { noteLine, outcome: saved.kind } };
		},
	});

	pi.registerCommand("note", {
		description: "Save a project note: /note [decision|gotcha|rule|fact:] <text>",
		handler: async (args, ctx) => {
			const parsedNote = parseNoteCommand(args);
			if (!parsedNote) {
				ctx.ui.notify("Usage: /note [decision|gotcha|rule|fact:] <text>", "warning");
				return;
			}
			const saved = saveNote(projectRootFor(ctx.cwd), formatNoteLine(parsedNote.kind, parsedNote.text, new Date()));
			ctx.ui.notify(saved.kind === "saved" ? `Noted (${parsedNote.kind}) in ${saved.notesPath}` : "Already noted", "info");
		},
	});

	pi.registerCommand("notes", {
		description: "Review and edit this repo's project notes",
		handler: async (_args, ctx) => {
			const projectRoot = projectRootFor(ctx.cwd);
			const notesFile = readNotesFile(projectRoot);
			if (!notesFile) {
				ctx.ui.notify(`No notes yet in ${projectRoot}. Add one with /note <text>.`, "info");
				return;
			}
			if (ctx.mode !== "tui") {
				ctx.ui.notify(notesFile, "info");
				return;
			}
			const editedNotes = await ctx.ui.editor(`Project notes (${NOTES_RELATIVE_PATH})`, notesFile);
			if (editedNotes === undefined || editedNotes === notesFile) return;
			writeNotesFile(projectRoot, editedNotes.endsWith("\n") ? editedNotes : `${editedNotes}\n`);
			ctx.ui.notify("Project notes saved", "info");
		},
	});

	pi.registerTool({
		name: SAVE_PLAN_TOOL_NAME,
		label: "Save agreed plan",
		description:
			"Save the final plan the user agreed to as a markdown file in the repo's .scratch/handoffs/. " +
			"Call it only after the user explicitly agrees with both the goal and the approach, before starting the work. " +
			`The plan starts with "# <title>" and has these sections:\n${AGREED_PLAN_SECTIONS}`,
		promptSnippet: "Save the final plan once the user agrees with the goal and approach",
		promptGuidelines: [
			`After discussing a task, when the user clearly agrees with the goal and how it will be done, save the agreed plan with ${SAVE_PLAN_TOOL_NAME} before implementing, then tell the user its path. Save again if the plan changes after that.`,
		],
		parameters: Type.Object({
			plan: Type.String({ description: "The complete plan in markdown, starting with '# <title>'" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const planPath = saveAgreedPlan(projectRootFor(ctx.cwd), params.plan, new Date());
			return { content: [{ type: "text", text: `Plan saved to ${planPath}` }], details: { planPath } };
		},
	});

	pi.registerCommand("handoff", {
		description: "Review the agreed plan (written from the conversation if not saved yet) and execute it in a fresh session: /handoff [focus]",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/handoff needs interactive mode", "error");
				return;
			}
			if (!ctx.isIdle()) {
				ctx.ui.notify("Wait for the agent to finish, then /handoff", "warning");
				return;
			}
			const messages = messagesForPlan(ctx.sessionManager.getBranch());
			if (messages.length === 0) {
				ctx.ui.notify("Nothing to plan from yet: discuss the task with the agent first", "warning");
				return;
			}

			const focus = args.trim();
			const savedPlanPath = focus ? undefined : findSavedPlanPath(messages);
			let planPath = savedPlanPath;
			if (!planPath) {
				const writtenPlan = await writePlanWithLoader(ctx, messages, focus);
				if (!writtenPlan) return;
				planPath = saveAgreedPlan(projectRootFor(ctx.cwd), writtenPlan, new Date());
			}

			const plan = readPlan(planPath);
			const reviewedPlan = await ctx.ui.editor(`Agreed plan (${planPath})`, plan);
			if (reviewedPlan === undefined) {
				ctx.ui.notify(`Handoff cancelled; the plan is saved at ${planPath}`, "info");
				return;
			}
			if (reviewedPlan !== plan) updatePlan(planPath, reviewedPlan);

			const startFresh = await ctx.ui.confirm("Plan saved", `${planPath}\n\nStart a fresh session that executes it?`);
			if (!startFresh) return;
			const executePrompt = executePlanPrompt(planPath, readPlan(planPath));
			const switched = await ctx.newSession({
				parentSession: ctx.sessionManager.getSessionFile(),
				withSession: async (newSessionCtx) => {
					newSessionCtx.ui.setEditorText(executePrompt);
					newSessionCtx.ui.notify("Plan loaded. Send it to start.", "info");
				},
			});
			if (switched.cancelled) ctx.ui.notify(`New session cancelled; the plan is saved at ${planPath}`, "info");
		},
	});
}

/** Writes the plan from the conversation behind a cancellable loader; undefined when cancelled or failed. */
async function writePlanWithLoader(ctx: ExtensionCommandContext, messages: AgentMessage[], focus: string): Promise<string | undefined> {
	const planWriter = pickPlanWriterModel(ctx, messages);
	if (!planWriter) {
		ctx.ui.notify("No model to write the plan: select a model, or send one prompt in auto mode first", "error");
		return undefined;
	}
	let failure: string | undefined;
	const plan = await ctx.ui.custom<string | undefined>((tui, theme, _keybindings, done) => {
		const loader = new BorderedLoader(tui, theme, `Writing the agreed plan with ${planWriter.id}…`);
		loader.onAbort = () => done(undefined);
		writeAgreedPlan(ctx, planWriter, messages, focus, loader.signal)
			.then(done)
			.catch((error: unknown) => {
				failure = error instanceof Error ? error.message : String(error);
				done(undefined);
			});
		return loader;
	});
	if (failure) ctx.ui.notify(`Writing the plan failed: ${failure}`, "error");
	else if (!plan) ctx.ui.notify("Handoff cancelled", "info");
	return plan || undefined;
}
