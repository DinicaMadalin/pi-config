/**
 * Routing corrections, inferred after the fact and stored across sessions.
 * When the user's next prompt shows the previous task got the wrong tier (they complain, or the
 * task was far easier than its tier), Jev's hindsight verdict becomes a correction. Recent
 * corrections are shown to Jev as calibration, so similar prompts get the corrected tier next time.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DIFFICULTY_TIERS, type DifficultyTier, shiftTier } from "./difficulty-tiers.ts";

export const ROUTING_FEEDBACK_PATH = join(homedir(), ".pi", "agent", "auto-model-feedback.json");
const MAX_STORED_CORRECTIONS = 60;
const MAX_CALIBRATION_EXAMPLES = 8;
const MAX_STORED_PROMPT_CHARS = 400;

export interface RoutingCorrection {
	prompt: string;
	routedTier: DifficultyTier;
	correctTier: DifficultyTier;
	projectDir: string;
	recordedAtIso: string;
}

function isDifficultyTier(raw: unknown): raw is DifficultyTier {
	return DIFFICULTY_TIERS.includes(raw as DifficultyTier);
}

function parseCorrection(raw: unknown, index: number): RoutingCorrection {
	const candidate = raw as Partial<RoutingCorrection> | null;
	const isValid =
		typeof candidate === "object" &&
		candidate !== null &&
		typeof candidate.prompt === "string" &&
		isDifficultyTier(candidate.routedTier) &&
		isDifficultyTier(candidate.correctTier) &&
		typeof candidate.projectDir === "string" &&
		typeof candidate.recordedAtIso === "string";
	if (!isValid) throw new Error(`${ROUTING_FEEDBACK_PATH}: correction #${index} is malformed; fix or delete the file`);
	return candidate as RoutingCorrection;
}

export function loadRoutingCorrections(): RoutingCorrection[] {
	if (!existsSync(ROUTING_FEEDBACK_PATH)) return [];
	const parsed: unknown = JSON.parse(readFileSync(ROUTING_FEEDBACK_PATH, "utf8"));
	const corrections = (parsed as { corrections?: unknown }).corrections;
	if (!Array.isArray(corrections)) throw new Error(`${ROUTING_FEEDBACK_PATH}: expected { "corrections": [...] }`);
	return corrections.map(parseCorrection);
}

export function recordRoutingCorrection(correction: RoutingCorrection): void {
	const stored = { ...correction, prompt: correction.prompt.slice(0, MAX_STORED_PROMPT_CHARS) };
	const corrections = [...loadRoutingCorrections(), stored].slice(-MAX_STORED_CORRECTIONS);
	mkdirSync(dirname(ROUTING_FEEDBACK_PATH), { recursive: true });
	writeFileSync(ROUTING_FEEDBACK_PATH, `${JSON.stringify({ corrections }, null, "\t")}\n`);
}

/** Newest corrections first, the current project's before other projects'. */
export function pickCalibrationExamples(corrections: RoutingCorrection[], projectDir: string): RoutingCorrection[] {
	const newestFirst = [...corrections].reverse();
	const fromThisProject = newestFirst.filter((correction) => correction.projectDir === projectDir);
	const fromOtherProjects = newestFirst.filter((correction) => correction.projectDir !== projectDir);
	return [...fromThisProject, ...fromOtherProjects].slice(0, MAX_CALIBRATION_EXAMPLES);
}

export const PREVIOUS_TIER_FITS = ["too_weak", "right", "too_strong"] as const;
export type PreviousTierFit = (typeof PREVIOUS_TIER_FITS)[number];

/** Below this, a hindsight verdict is too unsure to teach the router anything. */
export const MIN_TIER_FIT_CONFIDENCE = 0.5;

/** The tier the previous task should have had, or undefined when its tier was right or the verdict is unsure. */
export function correctedTierFromFit(routedTier: DifficultyTier, fit: PreviousTierFit, confidence: number): DifficultyTier | undefined {
	if (fit === "right" || confidence < MIN_TIER_FIT_CONFIDENCE) return undefined;
	const correctTier = shiftTier(routedTier, fit === "too_weak" ? 1 : -1);
	return correctTier === routedTier ? undefined : correctTier;
}

/** A follow-up to an answer that fell short is usually a redo: give it at least the corrected tier. */
export function raiseToCorrectedTier(ratedTier: DifficultyTier, correctedPreviousTier: DifficultyTier | undefined): DifficultyTier {
	if (!correctedPreviousTier) return ratedTier;
	return DIFFICULTY_TIERS.indexOf(correctedPreviousTier) > DIFFICULTY_TIERS.indexOf(ratedTier) ? correctedPreviousTier : ratedTier;
}
