/**
 * Work streams: the parts of an agreed plan that separate implementers build in parallel, in the same folder.
 * The planner splits the work in a "## Work streams" section, one "### <name>" subsection per stream with the
 * files it owns and what to do there. A plan without the section is one stream.
 * The implementers stay with the planner's session: a later plan's streams go to the implementers that built the
 * stream of that name before (else in order), so each keeps its context. Pure, so it can be unit tested.
 */

import type { DifficultyTier } from "../auto-model/difficulty-tiers.ts";

/** More implementers would mostly step on each other's files and multiply the cost. */
export const MAX_IMPLEMENTERS = 3;

export const IMPLEMENTER_ROLES = ["implementer", "implementer-2", "implementer-3"] as const;
export type ImplementerRole = (typeof IMPLEMENTER_ROLES)[number];

export const WORK_STREAMS_HEADING = "## Work streams";

export interface WorkStream {
	name: string;
	/** The subsection's text: the files the stream owns and what to do in them. */
	text: string;
	/** The planner marked the heading STRONG_MODEL_MARKER: its implementer may get a complex-tier model. */
	needsStrongModel: boolean;
}

/** Written after a stream's name in its heading when its steps still need real design work. */
export const STRONG_MODEL_MARKER = "(needs a strong model)";

const WHOLE_PLAN_STREAM: WorkStream = { name: "", text: "", needsStrongModel: false };

/** An implementer of the planner's session: its stream in the current plan and its session file. */
export interface ImplementerSeat {
	role: ImplementerRole;
	stream: string;
	sessionPath: string;
}

/** The plan's streams in order; the whole plan as one unnamed stream when it has no work streams section. */
export function parseWorkStreams(plan: string): WorkStream[] {
	const lines = plan.split("\n");
	const sectionStart = lines.findIndex((line) => line.trim().toLowerCase() === WORK_STREAMS_HEADING.toLowerCase());
	if (sectionStart === -1) return [{ ...WHOLE_PLAN_STREAM }];
	const streams: WorkStream[] = [];
	for (const line of lines.slice(sectionStart + 1)) {
		if (/^##\s/.test(line)) break;
		const heading = /^###\s+(.*)$/.exec(line);
		if (heading) {
			const needsStrongModel = heading[1].toLowerCase().includes(STRONG_MODEL_MARKER);
			streams.push({ name: streamName(heading[1]), text: "", needsStrongModel });
			continue;
		}
		const current = streams.at(-1);
		if (current) current.text = current.text ? `${current.text}\n${line}` : line;
	}
	for (const stream of streams) stream.text = stream.text.trim();
	return streams.length > 0 ? streams : [{ ...WHOLE_PLAN_STREAM }];
}

/** "1. `API` endpoints (needs a strong model)" -> "API endpoints". */
function streamName(heading: string): string {
	const markerAt = heading.toLowerCase().indexOf(STRONG_MODEL_MARKER);
	const withoutMarker = markerAt === -1 ? heading : heading.slice(0, markerAt) + heading.slice(markerAt + STRONG_MODEL_MARKER.length);
	return withoutMarker
		.replace(/^\d+[.)]\s*/, "")
		.replace(/[`*_]/g, "")
		.trim();
}

/** At most MAX_IMPLEMENTERS streams: the extra ones join the last, so no work is dropped. */
export function capWorkStreams(streams: readonly WorkStream[]): WorkStream[] {
	if (streams.length <= MAX_IMPLEMENTERS) return [...streams];
	const kept = streams.slice(0, MAX_IMPLEMENTERS - 1);
	const merged = streams.slice(MAX_IMPLEMENTERS - 1);
	kept.push({
		name: merged.map((stream) => stream.name).join(" + "),
		text: merged.map((stream) => `#### ${stream.name}\n${stream.text}`).join("\n\n"),
		needsStrongModel: merged.some((stream) => stream.needsStrongModel),
	});
	return kept;
}

/** What to tell the planner when its plan has more streams than implementers; undefined when it fits. */
export function tooManyStreamsWarning(plan: string): string | undefined {
	const count = parseWorkStreams(plan).length;
	if (count <= MAX_IMPLEMENTERS) return undefined;
	return `The plan has ${count} work streams but at most ${MAX_IMPLEMENTERS} implementers run, so the last ones would be built by one implementer. Merge them into ${MAX_IMPLEMENTERS} and save the plan again.`;
}

/**
 * Which implementer builds which stream: one that built a stream of the same name keeps it, the others take
 * the free implementers in order; streams left over get a new implementer (newSession makes its session).
 * The result is in stream order.
 */
export function assignStreams(
	streams: readonly WorkStream[],
	crew: readonly ImplementerSeat[],
	newSession: (role: ImplementerRole) => string,
): ImplementerSeat[] {
	const free = [...crew];
	const takeSeat = (pick: (seat: ImplementerSeat) => boolean): ImplementerSeat | undefined => {
		const index = free.findIndex(pick);
		return index === -1 ? undefined : free.splice(index, 1)[0];
	};
	const byName = streams.map((stream) => takeSeat((seat) => stream.name !== "" && seat.stream === stream.name));
	const usedRoles = new Set(crew.map((seat) => seat.role));
	return streams.map((stream, index) => {
		const seat = byName[index] ?? takeSeat(() => true);
		if (seat) return { ...seat, stream: stream.name };
		const role = IMPLEMENTER_ROLES.find((candidate) => !usedRoles.has(candidate));
		if (!role) throw new Error(`Failed to assign work stream "${stream.name}": all ${MAX_IMPLEMENTERS} implementers are taken`);
		usedRoles.add(role);
		return { role, stream: stream.name, sessionPath: newSession(role) };
	});
}

/** The stream an implementer builds, by name; the single unnamed stream is the whole plan. */
export function streamOf(streams: readonly WorkStream[], name: string): WorkStream | undefined {
	return streams.find((stream) => stream.name === name);
}

/**
 * The strongest tier an implementer's model may come from. The expert planner spells out every step, so a cheap
 * model (trivial or standard, as the difficulty rating picks) builds it; a stream the planner marked gets up to complex.
 */
export const IMPLEMENTER_MAX_TIER: DifficultyTier = "standard";
export const STRONG_STREAM_MAX_TIER: DifficultyTier = "complex";

export function implementerMaxTier(stream: WorkStream | undefined): DifficultyTier {
	return stream?.needsStrongModel ? STRONG_STREAM_MAX_TIER : IMPLEMENTER_MAX_TIER;
}
