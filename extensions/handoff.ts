/**
 * Optional wrap-up/handoff nudge.
 *
 * Injected as a steering message well before the compaction threshold, when the
 * agent can still finish cleanly: write durable state to disk, then wrap up. The
 * next context re-reads those files, so the summary only has to carry the delta.
 *
 * Disabled by default. It interrupts the current line of work, which is fine
 * when a human is driving and can restart the context, and a liability for
 * long-running agents.
 */

import type { HandoffNudgeConfig } from "./types";

export const DEFAULT_HANDOFF_NUDGE = {
	enabled: false,
	atRatio: 0.4,
	oncePerCompaction: true,
	modes: ["tui"] as const,
};

export interface ResolvedHandoffNudge {
	enabled: boolean;
	atRatio: number;
	atTokens?: number;
	oncePerCompaction: boolean;
	modes: readonly string[];
	message?: string;
}

export function resolveHandoffNudge(config: HandoffNudgeConfig | undefined): ResolvedHandoffNudge {
	return { ...DEFAULT_HANDOFF_NUDGE, ...(config ?? {}) };
}

export const DEFAULT_HANDOFF_MESSAGE = [
	"Context usage is approaching the compaction threshold.",
	"Before continuing, persist anything that must survive compaction:",
	"update the plan or handoff notes in the repo, commit work in progress,",
	"and record the exact next step. Then finish the current task cleanly and",
	"stop starting new multi-step work.",
].join(" ");

/**
 * Decide whether to fire the nudge for this turn.
 *
 * Pure so the gating (disabled by default, interactive modes only, once per
 * compaction) is directly testable.
 */
export function shouldFireNudge(
	state: { fired: boolean },
	input: {
		enabled: boolean;
		mode: string | undefined;
		modes: readonly string[];
		correctedTokens: number | null;
		threshold: number;
		oncePerCompaction: boolean;
	},
): boolean {
	if (!input.enabled) return false;
	if (input.correctedTokens === null) return false;
	if (input.oncePerCompaction && state.fired) return false;
	if (input.modes.length > 0 && (!input.mode || !input.modes.includes(input.mode))) {
		return false;
	}
	return input.correctedTokens >= input.threshold;
}
