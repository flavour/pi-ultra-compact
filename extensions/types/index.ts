/**
 * Types for pi-ultra-compact extension
 */

/** Eviction levels for graduated content stripping */
export enum EvictionLevel {
	/** Remove assistant thinking/reasoning blocks */
	STRIP_REASONING = 1,
	/** Remove large tool outputs (directory listings, grep results) */
	STRIP_BULK_OUTPUT = 2,
	/** Remove all non-error tool results */
	STRIP_ARTIFACTS = 3,
	/** Remove entire non-protected messages */
	FULL_REMOVAL = 4,
}

/** Stats from an eviction pass */
export interface EvictionStats {
	/** How many messages were modified */
	messagesStripped: number;
	/** Tokens saved by eviction */
	tokensSaved: number;
	/** The highest eviction level that was needed (1-4) */
	levelUsed: EvictionLevel;
}

/**
 * Policy for the non-LLM pruning pass (context edits, no summarization).
 *
 * Pruning rewrites older entries' *model-visible* content through Pi's
 * `context_edit` entries. The transcript keeps the originals; only the
 * projection changes, so the pass is reversible and costs no LLM call.
 */
export interface PruningPolicy {
	/** Default: true */
	enabled?: boolean;
	/**
	 * Lower threshold. Pruning engages once corrected context usage reaches this
	 * fraction of the context window. Default: 0.35
	 */
	atRatio?: number;
	/** Explicit token override for `atRatio`. */
	atTokens?: number;
	/** Pruning drains usage down to this fraction, then stops. Default: 0.28 */
	targetRatio?: number;
	/**
	 * Highest eviction level to apply. Levels 1-3 are supported by pruning;
	 * whole-message removal is left to summarization, which can restate what it
	 * dropped. Default: STRIP_ARTIFACTS (3).
	 */
	maxLevel?: EvictionLevel;
	/** Assistant turns (and their tool results) never touched. Default: 4 */
	keepRecentTurns?: number;
	/** Skip tool results smaller than this many characters. Default: 400 */
	minEntryChars?: number;
	/** Tool results at least this large get an excerpt instead of a marker. Default: 4000 */
	bulkMinChars?: number;
	/** Characters of head excerpt kept for bulk results. Default: 1200 */
	bulkExcerptChars?: number;
	/**
	 * Which eligible entry to prune first. "newest" keeps the longest unchanged
	 * prefix, so llama.cpp prompt caching still covers the bulk of the prompt and
	 * only the tail is re-prefilled. Default: "newest"
	 */
	order?: "newest" | "oldest";
	/** Skip editing entries that already carry a context edit. Default: true */
	skipAlreadyEdited?: boolean;
}

/** How the extension escalates from pruning to summarization. */
export interface SummarizationPolicy {
	/**
	 * Higher threshold. Reaching it means pruning alone can no longer hold the
	 * context down, so an LLM summary is needed. Resolved from Pi's effective
	 * `contextWindow - reserveTokens` when omitted. Default: undefined (Pi settings)
	 */
	atTokens?: number;
	atRatio?: number;
	/**
	 * What to do when the higher threshold is crossed mid-run.
	 *
	 * - "native" (default): do nothing; Pi's own threshold/overflow machinery runs.
	 * - "compact": call `ctx.compact()`. Note Pi aborts the in-flight run first,
	 *   so this is only appropriate when a human is driving.
	 * - "steer": inject a wrap-up instruction as a steering message. No abort.
	 */
	escalation?: "native" | "compact" | "steer";
	/**
	 * Who writes the summary once compaction runs.
	 *
	 * - "engine-then-pi" (default): the engine writes one at the *lower* threshold
	 *   (`engineAtTokens`/`engineAtRatio`) with no LLM call and no aborted run;
	 *   Pi's native summarizer writes the next one at the higher threshold, using
	 *   the engine summary as `<previous-summary>`.
	 * - "pi": only Pi's native summarizer writes summaries, at the higher threshold.
	 * - "engine": only the engine writes them, and only when Pi triggers.
	 */
	summaryMode?: "pi" | "engine" | "engine-then-pi";
	/**
	 * Lower compaction threshold for the engine stage, in real tokens. Wins over
	 * `engineAtRatio`. Default: undefined (ratio below)
	 */
	engineAtTokens?: number;
	/** Default: 0.5 */
	engineAtRatio?: number;
	/** Verbatim tail the engine compaction keeps. Default: Pi's keepRecentTokens */
	keepRecentTokens?: number;
	/** Skip the engine pass unless it removes this fraction of the window. Default: 0.05 */
	minSavingRatio?: number;
}

/** Optional wrap-up nudge. Off by default: it interrupts long-running agents. */
export interface HandoffNudgeConfig {
	/** Default: false */
	enabled?: boolean;
	/** Fire at this fraction of the context window. Default: 0.4 */
	atRatio?: number;
	/** Explicit token override for `atRatio`. */
	atTokens?: number;
	/** Fire at most once between compactions. Default: true */
	oncePerCompaction?: boolean;
	/** Only fire in these run modes. Default: ["tui"] */
	modes?: Array<"tui" | "rpc" | "json" | "print">;
	/** Steering text injected when the nudge fires. */
	message?: string;
}

/** Configuration for ultra-compact compaction */
export interface UltraCompactConfig {
	/** Non-LLM pruning pass (default: enabled) */
	pruning?: PruningPolicy;
	/** Escalation from pruning to LLM summarization */
	summarization?: SummarizationPolicy;
	/** Wrap-up/handoff steering message (default: disabled) */
	handoffNudge?: HandoffNudgeConfig;
	/** Token threshold to trigger automatic compaction */
	thresholdTokens?: number;
	/** Percentage of context to keep (0.0 - 1.0) */
	keepPercentage?: number;
	/** Maximum tokens to keep after compaction */
	maxKeepTokens?: number;
	/** Enable automatic compaction */
	autoCompact?: boolean;
	/**
	 * Step aside when the model's provider compacts natively (OpenAI Codex
	 * encrypted checkpoints). The compaction entry is left to the extension that
	 * owns those checkpoints, so a text summary cannot orphan the provider chain.
	 * Default: true
	 */
	deferToNativeCompaction?: boolean;
	/** Custom prompt for summarization */
	customPrompt?: string;
	/** Minimum messages required for structured summary (avoids bloat) */
	minMessagesForCompression?: number;
	/** Use Pi's model for smart LLM summarization (optional) */
	useLLM?: boolean;
	/** Max eviction aggressiveness (graduated eviction cap, default FULL_REMOVAL) */
	maxEvictionLevel?: EvictionLevel;
	/** Enable cache-aware compaction (immutable prefix, append-only summaries) */
	cacheAware?: boolean;
	/** Soft watermark for preemptive compaction (default 0.70 = 70%) */
	preemptiveWatermark?: number;
	/**
	 * Hard cap on context usage (0-1). Compaction fires when tokens reach this
	 * fraction of the context window, even if the percentage threshold hasn't
	 * been hit. Default: 0.5 (50%). Set lower for smaller models.
	 */
	hardWatermark?: number;
	/** Tokens to reserve for model output during preemptive check */
	outputHeadroom?: number;
	/** Max failures before circuit breaker trips (default 3) */
	circuitBreakerMaxFailures?: number;
	/** Turns before circuit breaker resets (default 5) */
	circuitBreakerCooldown?: number;
}

/** Result of a compaction operation */
export interface CompactionResult {
	/** The generated summary */
	summary: string;
	/** Number of tokens before compaction */
	tokensBefore: number;
	/** Estimated tokens after compaction */
	tokensAfter: number;
	/** Compression ratio achieved */
	compressionRatio: number;
	/** Files that were read during the session */
	readFiles: string[];
	/** Files that were modified during the session */
	modifiedFiles: string[];
	/** Timestamp of the compaction */
	timestamp: number;
}

/** Tier of compaction to perform */
export enum CompactionTier {
	/** No compaction needed */
	NONE = 0,
	/** Fast tool-output pruning only (no LLM) */
	MICRO = 1,
	/** Full structured summarization */
	FULL = 2,
}

/** Stats from a micro-compaction pass */
export interface MicroCompactStats {
	tokensSaved: number;
	messagesStripped: number;
	filesCollapsed: string[];
}

/** State for the circuit breaker mechanism */
export interface CircuitBreakerState {
	failures: number;
	trippedAtTurn: number;
	turn: number;
}

/** Entry for tracking compaction history */
export interface CompactionEntry {
	id: string;
	timestamp: number;
	summary: string;
	tokensBefore: number;
	tokensAfter: number;
	compressionRatio: number;
}

/** Text content block in Pi messages */
export interface TextContent {
	type: "text";
	text: string;
}

/** Image content block in Pi messages */
export interface ImageContent {
	type: "image";
	source?: { type: "base64"; media_type: string; data: string };
}

/** Message structure for Pi sessions */
export interface Message {
	id: string;
	role: "user" | "assistant" | "tool" | "system";
	content: string | (TextContent | ImageContent)[];
	timestamp: number;
	tokens?: number;
}

/** Session context for compaction */
export interface SessionContext {
	messages: Message[];
	currentTokens: number;
	maxTokens: number;
	summary?: string;
}

// ─── Pi Extension API Types ────────────────────────────────────────────────

/** Model information from Pi runtime context */
export interface PiModel {
	id: string;
	contextWindow?: number;
}

/** UI notification helpers from Pi context */
export interface PiUI {
	notify?: (message: string, level: "info" | "warn" | "error") => void;
}

/** Pi runtime context passed to event handlers */
export interface PiContext {
	model?: PiModel;
	ui?: PiUI;
}

// ─── Pi context-projection shapes (structural, version-independent) ───────

/** Text block in a Pi model message. */
export interface PiTextContent {
	type: "text";
	text: string;
	textSignature?: string;
}

/** Reasoning block. `redacted` payloads must survive round-trips. */
export interface PiThinkingContent {
	type: "thinking";
	thinking: string;
	thinkingSignature?: string;
	redacted?: boolean;
}

/** Image block in a Pi model message. */
export interface PiImageContent {
	type: "image";
	data: string;
	mimeType?: string;
}

/** Tool call block. Pairing with a tool result must never be broken. */
export interface PiToolCall {
	type: "toolCall";
	id: string;
	name: string;
	arguments?: Record<string, unknown>;
}

export type PiContentBlock = PiTextContent | PiThinkingContent | PiImageContent | PiToolCall;

/** Provider usage reported on an assistant message. */
export interface PiUsage {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	totalTokens?: number;
}

/** A message as it appears in Pi's session projection. */
export interface PiContextMessage {
	role: "user" | "assistant" | "toolResult" | "custom" | string;
	content: string | PiContentBlock[];
	isError?: boolean;
	toolCallId?: string;
	toolName?: string;
	usage?: PiUsage;
	stopReason?: string;
}

/** One session entry plus the messages it currently contributes to context. */
export interface PiProjectedEntry {
	sourceEntry: {
		id: string;
		type: string;
		message?: PiContextMessage;
		customType?: string;
		/** Present on compaction entries. */
		summary?: string;
	};
	messages: PiContextMessage[];
}

/** Draft context edit returned from a boundary event handler. */
export interface PiContextEditDraft {
	type: "context_edit";
	targetId: string;
	replacement: { content: string | PiContentBlock[] } | null;
}

/**
 * Draft compaction entry returned from a boundary event handler. Pi computes
 * `tokensBefore` itself and marks the entry as extension-written when it commits
 * the draft.
 */
export interface PiCompactionDraft {
	type: "compaction";
	summary: string;
	/** Null creates a self-retaining compaction that keeps no preceding entries. */
	firstKeptEntryId: string | null;
	details?: unknown;
}

/** Plan produced by the pruning pass. */
export interface PruningPlan {
	drafts: PiContextEditDraft[];
	/** Characters removed from model-visible content. */
	charsRemoved: number;
	/** Savings in Pi's estimate units (chars / 3.5). */
	estimatedTokensSaved: number;
	entriesConsidered: number;
	levelUsed: EvictionLevel | 0;
}

/** Preparation object passed in the before_compact event */
export interface CompactPreparation {
	tokensBefore: number;
	messagesToSummarize: Message[];
	firstKeptEntryId?: string;
	previousSummary?: string;
}

/** before_compact event payload */
export interface BeforeCompactEvent {
	preparation?: CompactPreparation;
	customInstructions?: string;
}

/** model_select event payload */
export interface ModelSelectEvent {
	models?: Array<{ id: string; contextWindow?: number }>;
}

/** Pi extension registration helpers */
export interface PiExtensionAPI {
	on: (event: string, handler: (...args: unknown[]) => unknown) => void;
	commands?: {
		register: (name: string, handler: (...args: unknown[]) => unknown) => void;
	};
}
