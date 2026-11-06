/**
 * The session at a glance, for the dashboard strip: what it cost, how full the context is, and which model
 * answers. Under the auto model the session's model is "auto"; the model that really answered is on the
 * last assistant message, and the tier it was routed to on the auto model's last route decision.
 */
import { ROUTE_DECISION_ENTRY_TYPE } from "../auto-model/route-decision.ts";

export interface SessionGauge {
	costUsd: number;
	/** Undefined while Pi does not know it, e.g. right after a compaction. */
	contextPercent: number | undefined;
	/** Undefined before the first answer under the auto model. */
	model: string | undefined;
	thinkingLevel: string | undefined;
	/** The auto model's tier for the last task, e.g. "complex"; undefined when a model was picked by hand. */
	tier: string | undefined;
}

export interface GaugeEntry {
	type: string;
	customType?: string;
	data?: unknown;
	message?: { role?: string; model?: string; thinkingLevel?: string; usage?: { cost?: { total?: number } } };
}

export interface SessionModel {
	provider: string;
	id: string;
	thinkingLevel: string;
}

const AUTO_PROVIDER = "auto";

export function readSessionGauge(entries: readonly GaugeEntry[], sessionModel: SessionModel | undefined, contextPercent: number | null | undefined): SessionGauge {
	let costUsd = 0;
	let lastAnswer: GaugeEntry["message"];
	let lastTier: string | undefined;
	for (const entry of entries) {
		if (entry.type === "message" && entry.message?.role === "assistant") {
			costUsd += entry.message.usage?.cost?.total ?? 0;
			lastAnswer = entry.message;
		}
		if (entry.type === "custom" && entry.customType === ROUTE_DECISION_ENTRY_TYPE) {
			const tier = (entry.data as { tier?: unknown } | undefined)?.tier;
			if (typeof tier === "string") lastTier = tier;
		}
	}
	const gaugeContext = contextPercent ?? undefined;
	if (sessionModel && sessionModel.provider !== AUTO_PROVIDER) {
		return { costUsd, contextPercent: gaugeContext, model: sessionModel.id, thinkingLevel: sessionModel.thinkingLevel, tier: undefined };
	}
	return { costUsd, contextPercent: gaugeContext, model: lastAnswer?.model, thinkingLevel: lastAnswer?.thinkingLevel, tier: lastTier };
}
