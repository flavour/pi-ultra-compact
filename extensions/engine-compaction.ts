/**
 * Engine-written compaction for the lower of the two compaction thresholds.
 *
 * A `turn_end` handler may return a `compaction` draft; Pi commits it and
 * rebuilds the projection before the next provider request. Unlike
 * `ctx.compact()` this does not abort the in-flight run, and unlike Pi's native
 * summarizer it costs no completion tokens — the engine's structured extraction
 * runs in-process.
 *
 * The summary it writes becomes `<previous-summary>` for Pi's native summarizer
 * once the higher threshold is crossed (`prepareCompaction` reads the latest
 * compaction entry and switches to its update prompt), so the two stages
 * compose into a ladder: cheap and lossy first, expensive and better later.
 */
import type {
	CompactionResult,
	Message,
	PiCompactionDraft,
	PiContextMessage,
	PiProjectedEntry,
} from "./types";
import { estimateMessagesTokens } from "./pruning";

export const DEFAULT_ENGINE_COMPACTION = {
	/** Lower compaction threshold, as a fraction of the context window. */
	atRatio: 0.5,
	/** Verbatim tail kept by the engine compaction when Pi settings are absent. */
	keepRecentTokens: 20000,
	/** Skip the pass unless it removes at least this fraction of the window. */
	minSavingRatio: 0.05,
};

export interface ResolvedEngineCompaction {
	atRatio: number;
	keepRecentTokens: number;
	minSavingRatio: number;
}

export interface EngineCompactionPolicyInput {
	engineAtRatio?: number;
	engineAtTokens?: number;
	keepRecentTokens?: number;
	minSavingRatio?: number;
}

/**
 * Resolve the engine stage's knobs. `atTokens` wins over `atRatio`; the kept-tail
 * size falls back to Pi's own `compaction.keepRecentTokens` when provided.
 */
export function resolveEngineCompaction(
	policy: EngineCompactionPolicyInput | undefined,
	piKeepRecentTokens: number | undefined,
): ResolvedEngineCompaction {
	const resolved = {
		atRatio: DEFAULT_ENGINE_COMPACTION.atRatio,
		keepRecentTokens: piKeepRecentTokens ?? DEFAULT_ENGINE_COMPACTION.keepRecentTokens,
		minSavingRatio: DEFAULT_ENGINE_COMPACTION.minSavingRatio,
	};
	if (typeof policy?.engineAtRatio === "number" && policy.engineAtRatio > 0) {
		resolved.atRatio = policy.engineAtRatio;
	}
	if (typeof policy?.keepRecentTokens === "number" && policy.keepRecentTokens > 0) {
		resolved.keepRecentTokens = policy.keepRecentTokens;
	}
	if (typeof policy?.minSavingRatio === "number" && policy.minSavingRatio >= 0) {
		resolved.minSavingRatio = policy.minSavingRatio;
	}
	return resolved;
}

/** Lower compaction threshold in real tokens. */
export function resolveEngineAt(
	contextWindow: number,
	policy: EngineCompactionPolicyInput | undefined,
	resolved: ResolvedEngineCompaction,
): number {
	const explicit = policy?.engineAtTokens;
	if (typeof explicit === "number" && explicit > 0) return explicit;
	return Math.floor(contextWindow * resolved.atRatio);
}

/**
 * Entry roles that may begin the kept tail. Mirrors Pi's `isCutPointMessage`:
 * a tool result is never a cut point, because keeping it without the assistant
 * message that called it would orphan it and the provider would reject the
 * request.
 */
const CUT_POINT_ROLES = new Set([
	"user",
	"assistant",
	"bashExecution",
	"custom",
	"branchSummary",
	"compactionSummary",
]);

export function isCutPointMessage(message: PiContextMessage | undefined): boolean {
	return !!message && CUT_POINT_ROLES.has(message.role);
}

/** Estimated tokens one projected entry currently contributes. */
export function estimateEntryTokens(entry: PiProjectedEntry): number {
	return estimateMessagesTokens(entry.messages);
}

export interface EngineCutPoint {
	/** Index of the first entry that stays in context. */
	cutIndex: number;
	/** Estimated tokens in the entries being summarized away. */
	summarizedTokens: number;
	/** Estimated tokens in the retained tail. */
	keptTokens: number;
}

/**
 * Choose where the engine compaction cuts, following Pi's `findProjectedCutPoint`
 * rule: walk backwards until `keepRecentTokens` is reached, then advance to the
 * next entry that may legally begin the tail.
 */
export function findEngineCutPoint(
	entries: readonly PiProjectedEntry[],
	boundaryStart: number,
	keepRecentTokens: number,
): EngineCutPoint | undefined {
	const end = entries.length;
	const cutPoints: number[] = [];
	for (let i = boundaryStart; i < end; i++) {
		const entry = entries[i];
		if (entry.sourceEntry.type !== "compaction" && entry.messages.some(isCutPointMessage)) {
			cutPoints.push(i);
		}
	}
	if (cutPoints.length === 0) return undefined;

	let accumulated = 0;
	let cutIndex = cutPoints[0];
	for (let i = end - 1; i >= boundaryStart; i--) {
		const tokens = estimateEntryTokens(entries[i]);
		if (tokens === 0) continue;
		accumulated += tokens;
		if (accumulated >= keepRecentTokens) {
			cutIndex = cutPoints.find((candidate) => candidate >= i) ?? cutPoints[cutPoints.length - 1];
			break;
		}
	}

	if (cutIndex <= boundaryStart) return undefined;
	const summarizedTokens = entries
		.slice(boundaryStart, cutIndex)
		.reduce((sum, entry) => sum + estimateEntryTokens(entry), 0);
	if (summarizedTokens === 0) return undefined;

	return { cutIndex, summarizedTokens, keptTokens: accumulated };
}

export interface EngineCompactionPlan {
	draft: PiCompactionDraft;
	/** Ids of the entries leaving the projection. */
	summarizedIds: string[];
	summarizedTokens: number;
	keptTokens: number;
	result: CompactionResult;
}

/**
 * Build a compaction draft from the projected entries. Returns undefined when
 * there is nothing to summarize, or when the engine produced no usable text.
 */
export async function planEngineCompaction(
	entries: readonly PiProjectedEntry[],
	options: {
		keepRecentTokens: number;
		summarize: (messages: Message[], previousSummary?: string) => Promise<CompactionResult>;
	},
): Promise<EngineCompactionPlan | undefined> {
	// An earlier compaction's summary is projected first; everything before it is
	// already out of context and must not be summarized a second time.
	let boundaryStart = 0;
	let previousSummary: string | undefined;
	const prevIndex = entries.findIndex(
		(entry) => entry.sourceEntry.type === "compaction" && entry.messages.length > 0,
	);
	if (prevIndex >= 0) {
		previousSummary = entries[prevIndex].sourceEntry.summary;
		boundaryStart = prevIndex + 1;
	}

	const cut = findEngineCutPoint(entries, boundaryStart, options.keepRecentTokens);
	if (!cut) return undefined;

	const summarized = entries.slice(boundaryStart, cut.cutIndex);
	// Pi hands the engine duck-typed provider messages on the native path too, so
	// the same tolerance applies here.
	const messages = summarized.flatMap((entry) => entry.messages) as unknown as Message[];
	if (messages.length === 0) return undefined;

	const result = await options.summarize(messages, previousSummary);
	if (!result || typeof result.summary !== "string" || result.summary.trim() === "") {
		return undefined;
	}

	return {
		draft: {
			type: "compaction",
			summary: result.summary,
			firstKeptEntryId: entries[cut.cutIndex].sourceEntry.id,
			details: {
				ultracompact: true,
				stage: "engine",
				readFiles: result.readFiles,
				modifiedFiles: result.modifiedFiles,
				compressionRatio: result.compressionRatio,
				tokensAfter: result.tokensAfter,
			},
		},
		summarizedIds: summarized.map((entry) => entry.sourceEntry.id),
		summarizedTokens: cut.summarizedTokens,
		keptTokens: cut.keptTokens,
		result,
	};
}
