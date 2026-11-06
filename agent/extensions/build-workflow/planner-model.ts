/**
 * /build runs the planner on the auto model, so each phase gets its tier through the route pin. The model you
 * had before is stored in the session and comes back when the run ends.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const AUTO_MODEL = { provider: "auto", id: "auto" } as const;
const PREVIOUS_MODEL_ENTRY_TYPE = "build-workflow-previous-model";

interface ModelRef {
	provider: string;
	id: string;
}

function isAutoModel(model: ModelRef | undefined): boolean {
	return model?.provider === AUTO_MODEL.provider && model.id === AUTO_MODEL.id;
}

/**
 * Switches to auto/auto for a run, remembering the model you had (none when you were on auto already, so an
 * older run's model does not come back); false when auto is not available.
 */
export async function useAutoModel(pi: ExtensionAPI, ctx: ExtensionContext): Promise<boolean> {
	const currentModel = ctx.model;
	if (isAutoModel(currentModel) || !currentModel) {
		pi.appendEntry<ModelRef | null>(PREVIOUS_MODEL_ENTRY_TYPE, null);
		return true;
	}
	const autoModel = ctx.modelRegistry.find(AUTO_MODEL.provider, AUTO_MODEL.id);
	if (!autoModel || !(await pi.setModel(autoModel))) {
		ctx.ui.notify("/build needs the auto model (auto/auto) to switch tiers per phase; it is not available", "error");
		return false;
	}
	pi.appendEntry<ModelRef | null>(PREVIOUS_MODEL_ENTRY_TYPE, { provider: currentModel.provider, id: currentModel.id });
	return true;
}

function findPreviousModel(ctx: ExtensionContext): ModelRef | undefined {
	const branch = ctx.sessionManager.getBranch();
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry.type === "custom" && entry.customType === PREVIOUS_MODEL_ENTRY_TYPE) return (entry.data as ModelRef | null) ?? undefined;
	}
	return undefined;
}

/** After the run: back to the model you had before /build switched to auto, if you have not switched since. */
export async function restorePreviousModel(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	const previous = findPreviousModel(ctx);
	if (!previous || !isAutoModel(ctx.model)) return;
	const model = ctx.modelRegistry.find(previous.provider, previous.id);
	if (model && (await pi.setModel(model))) return;
	ctx.ui.notify(`Could not switch back to ${previous.provider}/${previous.id}; staying on auto`, "warning");
}
