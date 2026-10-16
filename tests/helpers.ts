/**
 * Shared test helpers for pi-ultra-compact tests.
 */

import type { Message, PiContextMessage, PiProjectedEntry } from "../extensions/types";

/**
 * Create a test message with positional args (id, role, content).
 */
export function makeMsg(
	id: string,
	role: string,
	content: string,
): Message {
	return { id, role: role as any, content, timestamp: Date.now() };
}

/**
 * Create a test message with structured content blocks.
 */
export function makeStructuredMsg(
	id: string,
	role: string,
	blocks: { type: string; text?: string }[],
): Message {
	return {
		id,
		role: role as any,
		content: blocks as any,
		timestamp: Date.now(),
	};
}

/**
 * Create a test message from partial overrides (defaults to user role).
 */
export function makeMsgFrom(
	overrides: Partial<Message> & { content: string },
): Message {
	return {
		id: `msg-${Math.random().toString(36).slice(2, 8)}`,
		role: "user",
		timestamp: Date.now(),
		...overrides,
	};
}

// ─── Pi projection helpers ──────────────────────────────────────────────

/** Wrap a model message as one projected session entry, as `turn_end` exposes it. */
export function makeProjectedEntry(
	id: string,
	message: PiContextMessage,
	overrides: Partial<PiProjectedEntry["sourceEntry"]> = {},
): PiProjectedEntry {
	return { sourceEntry: { id, type: "message", message, ...overrides }, messages: [message] };
}

export function makeUserEntry(id: string, text: string): PiProjectedEntry {
	return makeProjectedEntry(id, { role: "user", content: text });
}

export function makeAssistantEntry(
	id: string,
	parts: { text?: string; thinking?: string; toolCalls?: string[]; redactedThinking?: boolean },
): PiProjectedEntry {
	const content: PiContextMessage["content"] = [];
	if (parts.thinking) content.push({ type: "thinking", thinking: parts.thinking });
	if (parts.redactedThinking)
		content.push({ type: "thinking", thinking: "", redacted: true, thinkingSignature: "sig" });
	if (parts.text) content.push({ type: "text", text: parts.text });
	for (const callId of parts.toolCalls ?? []) {
		content.push({ type: "toolCall", id: callId, name: "read", arguments: { path: "a.ts" } });
	}
	return makeProjectedEntry(id, { role: "assistant", content });
}

export function makeToolResultEntry(
	id: string,
	options: { text: string; toolName?: string; isError?: boolean; toolCallId?: string },
): PiProjectedEntry {
	return makeProjectedEntry(id, {
		role: "toolResult",
		content: [{ type: "text", text: options.text }],
		toolName: options.toolName ?? "bash",
		isError: options.isError,
		toolCallId: options.toolCallId ?? "call-1",
	});
}

/** Deterministic filler of the requested length. */
export function filler(chars: number, unit = "x"): string {
	return unit.repeat(Math.max(0, chars));
}
