/**
 * Corrected context accounting.
 *
 * Pi measures context two ways. With a clean transcript it uses the provider's
 * own numbers (`usage.totalTokens`), which are exact. As soon as the session
 * contains a `context_edit` it switches to estimating the projection at
 * 3.5 chars/token, because the provider numbers no longer describe what would be
 * sent next.
 *
 * That estimator is the weak link for local models. A Qwen tokenizer measured
 * against llama.cpp reports tool output at roughly 2.4 chars/token, so a 3.5
 * estimate under-counts by about 46%: a threshold configured at 128k would fire
 * near 190k real tokens.
 *
 * This module keeps a real-token baseline and calibrates the estimator's error
 * from observed usage, so thresholds can be expressed in tokens the server
 * actually counts.
 */

import { CHARS_PER_TOKEN } from "./pruning";
import type { PiUsage } from "./types";

const MIN_RATIO = 1;
const MAX_RATIO = 3;
/** Weight of a fresh sample when smoothing the ratio. */
const EMA_ALPHA = 0.4;

export interface AccountingDiagnostics {
	/** Real tokens in the last valid provider response. */
	baselineReal: number | null;
	/** Corrected real-token estimate for the current context. */
	correctedTokens: number | null;
	/** Estimated real tokens removed by pruning since the baseline. */
	prunedRealTokens: number;
	/** Learned chars-per-token correction: real tokens / estimated tokens. */
	ratio: number;
	/** True once at least one usage sample has been seen. */
	calibrated: boolean;
}

/**
 * Convert provider usage to the context size it represents, mirroring Pi's
 * `calculateContextTokens`. Aborted, errored and all-zero responses carry no
 * usable measurement.
 */
export function contextTokensFromUsage(
	usage: PiUsage | undefined,
	stopReason?: string,
): number | null {
	if (!usage || stopReason === "aborted" || stopReason === "error") return null;
	const total =
		usage.totalTokens ||
		(usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
	return total > 0 ? total : null;
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

export class ContextAccountant {
	private baselineReal: number | null = null;
	private pendingTrailingEstimate = 0;
	private prunedCharsSinceBaseline = 0;
	private ratio = 1;
	private calibrated = false;

	/**
	 * Record one completed turn.
	 *
	 * @param projectedEstimate Pi's estimate of the whole projection, taken at the
	 *   same moment as `usage` is read.
	 * @param trailingEstimate Estimate of the messages appended *after* the request
	 *   that produced `usage` — the assistant reply and its tool results.
	 */
	observeTurn(observation: {
		usage?: PiUsage;
		stopReason?: string;
		projectedEstimate: number;
		trailingEstimate: number;
	}): boolean {
		const trailing = Math.max(0, observation.trailingEstimate || 0);
		const real = contextTokensFromUsage(observation.usage, observation.stopReason);

		if (real === null) {
			// No usable measurement: keep the baseline and keep accumulating the
			// trailing content so nothing silently disappears from the count.
			this.pendingTrailingEstimate += trailing;
			return false;
		}

		const estimateAtRequest = Math.max(0, (observation.projectedEstimate || 0) - trailing);
		if (estimateAtRequest > 0) {
			const observed = clamp(real / estimateAtRequest, MIN_RATIO, MAX_RATIO);
			this.ratio = this.calibrated
				? this.ratio * (1 - EMA_ALPHA) + observed * EMA_ALPHA
				: observed;
			this.calibrated = true;
		}

		this.baselineReal = real;
		this.pendingTrailingEstimate = trailing;
		this.prunedCharsSinceBaseline = 0;
		return true;
	}

	/** Account for content this extension removed from the projection. */
	notePrunedChars(chars: number): void {
		if (chars > 0) this.prunedCharsSinceBaseline += chars;
	}

	/** Real-token estimate for the context that would be sent next. */
	getCorrected(): number | null {
		if (this.baselineReal === null) return null;
		const trailing = this.ratio * this.pendingTrailingEstimate;
		const pruned = (this.ratio * this.prunedCharsSinceBaseline) / CHARS_PER_TOKEN;
		return Math.max(0, Math.round(this.baselineReal + trailing - pruned));
	}

	getRatio(): number {
		return this.ratio;
	}

	getDiagnostics(): AccountingDiagnostics {
		return {
			baselineReal: this.baselineReal,
			correctedTokens: this.getCorrected(),
			prunedRealTokens: Math.round(
				(this.ratio * this.prunedCharsSinceBaseline) / CHARS_PER_TOKEN,
			),
			ratio: Number(this.ratio.toFixed(3)),
			calibrated: this.calibrated,
		};
	}

	/** Drop all state. Call after a compaction rewrites the context. */
	reset(): void {
		this.baselineReal = null;
		this.pendingTrailingEstimate = 0;
		this.prunedCharsSinceBaseline = 0;
	}
}
