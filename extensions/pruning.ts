/**
 * Non-LLM pruning pass.
 *
 * Rewrites older entries' model-visible content through Pi `context_edit`
 * entries. The transcript keeps the originals; only the projection changes, so
 * the pass costs no LLM call and stays reversible.
 *
 * Two invariants drive every decision here:
 *
 * 1. Tool-call pairing is inviolable. An assistant message that carries
 *    `toolCall` blocks must keep them, and its tool results must keep their
 *    `toolCallId`. Pruning replaces *content*, never whole entries, so the
 *    pairing survives by construction.
 * 2. Prefix caching. A local server such as llama.cpp re-prefills everything
 *    from the first changed entry onwards. Pruning the newest eligible entry
 *    first keeps the longest unchanged prefix, which is why `order` defaults to
 *    "newest" and why each entry is edited at most once.
 */

import { EvictionLevel } from "./types";
import type {
	PiContentBlock,
	PiContextEditDraft,
	PiContextMessage,
	PiProjectedEntry,
	PiThinkingContent,
	PiToolCall,
	PruningPlan,
	PruningPolicy,
} from "./types";

/** Matches Pi's own estimator so savings are directly comparable to its count. */
export const CHARS_PER_TOKEN = 3.5;

export const DEFAULT_PRUNING_POLICY = {
	enabled: true,
	atRatio: 0.35,
	targetRatio: 0.28,
	maxLevel: EvictionLevel.STRIP_ARTIFACTS,
	keepRecentTurns: 4,
	minEntryChars: 400,
	bulkMinChars: 4000,
	bulkExcerptChars: 1200,
	order: "newest" as const,
	skipAlreadyEdited: true,
};

export interface ResolvedPruningPolicy {
	enabled: boolean;
	atRatio: number;
	atTokens?: number;
	targetRatio: number;
	maxLevel: EvictionLevel;
	keepRecentTurns: number;
	minEntryChars: number;
	bulkMinChars: number;
	bulkExcerptChars: number;
	order: "newest" | "oldest";
	skipAlreadyEdited: boolean;
}

export function resolvePruningPolicy(policy: PruningPolicy | undefined): ResolvedPruningPolicy {
	return { ...DEFAULT_PRUNING_POLICY, ...(policy ?? {}) };
}

/** Flatten model-visible content to text for sizing and excerpting. */
export function blocksToText(content: string | PiContentBlock[]): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";

	const parts: string[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		switch (block.type) {
			case "text":
				parts.push((block as { text?: string }).text ?? "");
				break;
			case "thinking":
				parts.push((block as PiThinkingContent).thinking ?? "");
				break;
			case "toolCall": {
				const call = block as PiToolCall;
				parts.push(`${call.name ?? "tool"}(${safeJson(call.arguments)})`);
				break;
			}
			case "image":
				parts.push("[image]");
				break;
			default:
				parts.push("");
		}
	}
	return parts.join("\n");
}

function safeJson(value: unknown): string {
	if (value === undefined || value === null) return "";
	try {
		return JSON.stringify(value) ?? "";
	} catch {
		return "";
	}
}

export function messageChars(message: PiContextMessage | undefined): number {
	if (!message) return 0;
	return blocksToText(message.content).length;
}

export function estimateCharsAsTokens(chars: number): number {
	return Math.floor(Math.max(0, chars) / CHARS_PER_TOKEN);
}

/** Estimate the model-visible tokens contributed by a set of messages. */
export function estimateMessagesTokens(messages: readonly PiContextMessage[]): number {
	let chars = 0;
	for (const message of messages) chars += messageChars(message) + 8;
	return estimateCharsAsTokens(chars);
}

/** Estimate the model-visible tokens of a session projection. */
export function estimateProjectionTokens(entries: readonly PiProjectedEntry[]): number {
	const messages: PiContextMessage[] = [];
	for (const entry of entries) messages.push(...(entry.messages ?? []));
	return estimateMessagesTokens(messages);
}

function isToolResult(message: PiContextMessage | undefined): boolean {
	return message?.role === "toolResult";
}

function isAssistant(message: PiContextMessage | undefined): boolean {
	return message?.role === "assistant";
}

/**
 * Redacted thinking is an opaque payload the provider needs back. Dropping it
 * would break multi-turn continuity, so those entries are left alone.
 */
function hasRedactedThinking(message: PiContextMessage | undefined): boolean {
	if (!message || !Array.isArray(message.content)) return false;
	return message.content.some(
		(block) =>
			block &&
			(block as PiThinkingContent).type === "thinking" &&
			(block as PiThinkingContent).redacted === true,
	);
}

/**
 * Entries eligible for a single edit: exactly one model-visible message, backed
 * by a persisted message entry. Multi-message entries would have that one
 * replacement applied to every message in the entry, which is not something this
 * pass can reason about safely.
 */
function editableMessage(entry: PiProjectedEntry): PiContextMessage | undefined {
	const messages = entry?.messages;
	if (!Array.isArray(messages) || messages.length !== 1) return undefined;
	if (entry.sourceEntry?.type !== "message") return undefined;
	return messages[0];
}

/**
 * Indices from which pruning must stop. Everything from the first protected
 * assistant turn onwards stays untouched: the model is still working with it, and
 * editing there would also invalidate the cached prefix that covers the whole
 * recent tail.
 */
function protectionStart(entries: readonly PiProjectedEntry[], keepRecentTurns: number): number {
	if (keepRecentTurns <= 0) return entries.length;

	let seen = 0;
	for (let i = entries.length - 1; i >= 0; i--) {
		if (entries[i].sourceEntry?.type !== "message") continue;
		if (!entries[i].messages.some(isAssistant)) continue;
		seen++;
		if (seen >= keepRecentTurns) return i;
	}
	return 0;
}

function excerptReplacement(
	message: PiContextMessage,
	policy: ResolvedPruningPolicy,
): PiContentBlock[] {
	const text = blocksToText(message.content);
	const lines = text.split("\n").length;
	const head = text.slice(0, policy.bulkExcerptChars).trimEnd();
	const marker = `[tool output pruned: ${lines} lines, ${text.length} chars; head kept]`;
	return [{ type: "text", text: `${marker}\n${head}` }];
}

function markerReplacement(message: PiContextMessage): PiContentBlock[] {
	const text = blocksToText(message.content);
	const lines = text.split("\n").length;
	const firstLine = text.split("\n")[0]?.slice(0, 100) ?? "";
	const name = message.toolName ?? "tool";
	const suffix = firstLine ? ` | ${firstLine}` : "";
	return [
		{
			type: "text",
			text: `[tool result pruned: ${name}, ${lines} lines, ${text.length} chars${suffix}]`,
		},
	];
}

function reasoningReplacement(message: PiContextMessage): PiContentBlock[] | undefined {
	if (!Array.isArray(message.content)) return undefined;
	const kept = message.content.filter(
		(block) => block && (block as PiThinkingContent).type !== "thinking",
	);
	if (kept.length === message.content.length) return undefined;
	if (kept.length === 0) return [{ type: "text", text: "[reasoning pruned]" }];
	return kept;
}

/**
 * Build the set of context edits that would bring usage down to target.
 *
 * Levels run in ascending aggressiveness and stop as soon as
 * `targetTokensSaved` is met, so the pass never prunes harder than needed.
 * Within a level, entries are visited newest-first to preserve the cached
 * prefix.
 */
export function planPruning(
	entries: readonly PiProjectedEntry[],
	policy: ResolvedPruningPolicy,
	options: {
		targetTokensSaved?: number;
		editedIds?: ReadonlySet<string>;
		/** Entries whose provider-side context an edit would invalidate. */
		protectedIds?: ReadonlySet<string>;
	} = {},
): PruningPlan {
	const drafts: PiContextEditDraft[] = [];
	const handled = new Set<string>();
	let charsRemoved = 0;
	let levelUsed: EvictionLevel | 0 = 0;

	if (!Array.isArray(entries) || entries.length === 0) {
		return {
			drafts,
			charsRemoved,
			estimatedTokensSaved: 0,
			entriesConsidered: 0,
			levelUsed,
		};
	}

	const stop = protectionStart(entries, policy.keepRecentTurns);
	const candidates = entries
		.slice(0, Math.max(0, stop))
		.map((entry, index) => ({ entry, index }))
		.filter(({ entry }) => {
			const id = entry.sourceEntry?.id;
			if (!id) return false;
			if (policy.skipAlreadyEdited && options.editedIds?.has(id)) return false;
			// A native checkpoint replays its own history, and the provider refuses
			// the request once an edit touches entries it still retains.
			if (options.protectedIds?.has(id)) return false;
			return editableMessage(entry) !== undefined;
		});

	const ordered = policy.order === "oldest" ? candidates : [...candidates].reverse();
	const target = options.targetTokensSaved;

	const applyLevel = (
		level: EvictionLevel,
		shouldEdit: (message: PiContextMessage, chars: number) => boolean,
		replace: (message: PiContextMessage) => PiContentBlock[] | undefined,
	): boolean => {
		if (policy.maxLevel < level) return false;

		for (const { entry } of ordered) {
			if (target !== undefined && target > 0 && charsRemoved / CHARS_PER_TOKEN >= target) {
				return true;
			}
			const id = entry.sourceEntry.id;
			if (!id || handled.has(id)) continue;

			const message = editableMessage(entry);
			if (!message) continue;

			const chars = messageChars(message);
			if (!shouldEdit(message, chars)) continue;

			const replacement = replace(message);
			if (!replacement) continue;

			const replacementChars = blocksToText(replacement).length;
			const saved = chars - replacementChars;
			// Editing an entry that is barely larger than its replacement costs a
			// cache invalidation for nothing.
			if (saved < 200) continue;

			drafts.push({
				type: "context_edit",
				targetId: id,
				replacement: { content: replacement },
			});
			handled.add(id);
			charsRemoved += saved;
			levelUsed = level;
		}
		return false;
	};

	// Level 1: reasoning blocks. Tool calls and text stay untouched.
	applyLevel(
		EvictionLevel.STRIP_REASONING,
		(message) => !hasRedactedThinking(message),
		(message) => (isAssistant(message) ? reasoningReplacement(message) : undefined),
	);

	// Level 2: large tool results keep a head excerpt, so the model can still
	// recall what the output was without carrying all of it.
	applyLevel(
		EvictionLevel.STRIP_BULK_OUTPUT,
		(message, chars) =>
			isToolResult(message) && !message.isError && chars >= policy.bulkMinChars,
		(message) => (isToolResult(message) ? excerptReplacement(message, policy) : undefined),
	);

	// Level 3: remaining tool results collapse to a one-line marker. Errors are
	// never touched — they are the context the model most needs to keep.
	applyLevel(
		EvictionLevel.STRIP_ARTIFACTS,
		(message, chars) =>
			isToolResult(message) && !message.isError && chars >= policy.minEntryChars,
		(message) => (isToolResult(message) ? markerReplacement(message) : undefined),
	);

	return {
		drafts,
		charsRemoved,
		estimatedTokensSaved: estimateCharsAsTokens(charsRemoved),
		entriesConsidered: candidates.length,
		levelUsed,
	};
}
