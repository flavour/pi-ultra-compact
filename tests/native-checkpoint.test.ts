/**
 * Tests for native-checkpoint awareness: which projected entries the pruning
 * pass has to leave alone when a provider checkpoints its own context.
 */

import { describe, expect, it } from "vitest";
import { NATIVE_COMPACTION_KIND, resolveNativeProtectedIds } from "../extensions/native-checkpoint";
import type { PiProjectedEntry } from "../extensions/types";
import {
	filler,
	makeAssistantEntry,
	makeCompactionEntry,
	makeNativeCheckpointDetails,
	makeToolResultEntry,
} from "./helpers";

const CODEX_MODEL = {
	provider: "openai-codex",
	api: "openai-codex-responses",
	id: "gpt-5.3-codex",
	contextWindow: 272000,
};

const CODEX_KEY = "openai-codex:openai-codex-responses:gpt-5.3-codex";

/**
 * A checkpointed Codex session as Pi projects it: the checkpoint entry, the
 * pre-checkpoint entries it kept verbatim, then the work done since, each
 * descending from the checkpoint.
 */
function checkpointedProjection(): PiProjectedEntry[] {
	const retained = [
		makeAssistantEntry("a4", { text: filler(6000), toolCalls: ["c4"] }),
		makeToolResultEntry("t4", { text: filler(20000), toolCallId: "c4" }),
	];
	const post = [
		makeAssistantEntry("a5", { text: filler(6000), toolCalls: ["c5"] }),
		makeToolResultEntry("t5", { text: filler(20000), toolCallId: "c5" }),
		makeAssistantEntry("a6", { text: filler(6000), toolCalls: ["c6"] }),
		makeToolResultEntry("t6", { text: filler(20000), toolCallId: "c6" }),
	];
	const checkpoint = makeCompactionEntry("compact1", {
		summary: "OpenAI Codex native compaction checkpoint (uuid).",
		firstKeptEntryId: "a4",
		parentId: "t3",
		details: makeNativeCheckpointDetails(CODEX_KEY),
	});
	post[0].sourceEntry.parentId = checkpoint.sourceEntry.id;
	for (let i = 1; i < post.length; i++) {
		post[i].sourceEntry.parentId = post[i - 1].sourceEntry.id;
	}
	return [checkpoint, ...retained, ...post];
}

describe("resolveNativeProtectedIds", () => {
	it("protects nothing when no compaction entry stands", () => {
		const entries = [
			makeAssistantEntry("a1", { text: "one" }),
			makeToolResultEntry("t1", { text: filler(9000) }),
		];
		expect(resolveNativeProtectedIds(entries, CODEX_MODEL)).toEqual(new Set());
	});

	it("protects nothing for a text summary, which the provider can re-read", () => {
		const entries = [
			makeCompactionEntry("compact1", {
				firstKeptEntryId: "a4",
				details: { ultracompact: true },
			}),
			makeAssistantEntry("a4", { text: filler(6000) }),
			makeToolResultEntry("t4", { text: filler(20000) }),
		];
		expect(resolveNativeProtectedIds(entries, CODEX_MODEL)).toEqual(new Set());
	});

	it("protects the checkpoint and the history it retains, but not later work", () => {
		const protectedIds = resolveNativeProtectedIds(checkpointedProjection(), CODEX_MODEL);

		expect([...protectedIds].sort()).toEqual(["a4", "compact1", "t4"]);
	});

	it("leaves entries appended after the checkpoint prunable", () => {
		const protectedIds = resolveNativeProtectedIds(checkpointedProjection(), CODEX_MODEL);

		expect(protectedIds.has("a5")).toBe(false);
		expect(protectedIds.has("t5")).toBe(false);
		expect(protectedIds.has("a6")).toBe(false);
	});

	it("protects nothing when the checkpoint belongs to another model", () => {
		const entries = checkpointedProjection();
		const stale = { provider: "llama.cpp", api: "openai-completions", id: "qwen3" };

		expect(resolveNativeProtectedIds(entries, stale)).toEqual(new Set());
	});

	it("protects everything when the projection holds only checkpointed history", () => {
		const entries = [
			makeCompactionEntry("compact1", {
				firstKeptEntryId: "a4",
				parentId: "t3",
				details: makeNativeCheckpointDetails(CODEX_KEY),
			}),
			makeAssistantEntry("a4", { text: filler(6000) }),
			makeToolResultEntry("t4", { text: filler(20000) }),
		];

		expect([...resolveNativeProtectedIds(entries, CODEX_MODEL)].sort()).toEqual([
			"a4",
			"compact1",
			"t4",
		]);
	});

	it("protects nothing when the checkpoint details are unreadable", () => {
		const entries = checkpointedProjection();
		(entries[0].sourceEntry as { details: unknown }).details = {
			kind: NATIVE_COMPACTION_KIND,
		};

		expect(resolveNativeProtectedIds(entries, CODEX_MODEL)).toEqual(new Set());
	});

	it("protects nothing when the model is unknown", () => {
		expect(resolveNativeProtectedIds(checkpointedProjection(), undefined)).toEqual(new Set());
	});
});
