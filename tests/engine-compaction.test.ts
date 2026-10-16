/**
 * Tests for the engine compaction stage: where it cuts, what it hands the
 * engine, and the draft it produces.
 */

import { describe, expect, it, vi } from "vitest";
import {
	DEFAULT_ENGINE_COMPACTION,
	estimateEntryTokens,
	findEngineCutPoint,
	isCutPointMessage,
	planEngineCompaction,
	resolveEngineAt,
	resolveEngineCompaction,
} from "../extensions/engine-compaction";
import type { CompactionResult, PiProjectedEntry } from "../extensions/types";
import {
	filler,
	makeAssistantEntry,
	makeToolResultEntry,
	makeUserEntry,
} from "./helpers";

function compactionEntry(id: string, summary: string): PiProjectedEntry {
	return {
		sourceEntry: { id, type: "compaction", summary },
		messages: [{ role: "system", content: summary }],
	};
}

function turns(count: number, chars: number): PiProjectedEntry[] {
	const out: PiProjectedEntry[] = [];
	for (let i = 0; i < count; i++) {
		out.push(makeUserEntry(`u${i}`, `goal ${i}: build the thing`));
		out.push(makeAssistantEntry(`a${i}`, { text: `did step ${i}. ${filler(chars)}` }));
	}
	return out;
}

function result(overrides: Partial<CompactionResult> = {}): CompactionResult {
	return {
		summary: "#C\ncompressed history",
		tokensBefore: 1000,
		tokensAfter: 100,
		compressionRatio: 0.1,
		readFiles: ["a.ts"],
		modifiedFiles: [],
		timestamp: 0,
		...overrides,
	};
}

describe("resolveEngineCompaction", () => {
	it("falls back to Pi's keepRecentTokens when the policy omits it", () => {
		const resolved = resolveEngineCompaction(undefined, 40000);
		expect(resolved.keepRecentTokens).toBe(40000);
		expect(resolved.atRatio).toBe(DEFAULT_ENGINE_COMPACTION.atRatio);
		expect(resolved.minSavingRatio).toBe(DEFAULT_ENGINE_COMPACTION.minSavingRatio);
	});

	it("prefers the extension policy over Pi's setting", () => {
		const resolved = resolveEngineCompaction({ keepRecentTokens: 8000, engineAtRatio: 0.6 }, 40000);
		expect(resolved.keepRecentTokens).toBe(8000);
		expect(resolved.atRatio).toBe(0.6);
	});

	it("allows minSavingRatio: 0 to disable the guard", () => {
		expect(resolveEngineCompaction({ minSavingRatio: 0 }, undefined).minSavingRatio).toBe(0);
	});
});

describe("resolveEngineAt", () => {
	it("scales the ratio by the context window", () => {
		const resolved = resolveEngineCompaction({ engineAtRatio: 0.5 }, undefined);
		expect(resolveEngineAt(262144, undefined, resolved)).toBe(131072);
	});

	it("lets an explicit token count win over the ratio", () => {
		const resolved = resolveEngineCompaction({ engineAtRatio: 0.5 }, undefined);
		expect(resolveEngineAt(262144, { engineAtTokens: 90000 }, resolved)).toBe(90000);
	});
});

describe("isCutPointMessage", () => {
	it("accepts roles that may begin the kept tail", () => {
		for (const role of ["user", "assistant", "custom", "bashExecution"]) {
			expect(isCutPointMessage({ role, content: "x" })).toBe(true);
		}
	});

	it("rejects tool results, which must never be orphaned", () => {
		expect(isCutPointMessage({ role: "toolResult", content: "x", toolCallId: "c" })).toBe(false);
	});
});

describe("findEngineCutPoint", () => {
	const entries = turns(6, 20000);

	it("keeps roughly keepRecentTokens of the newest entries", () => {
		const cut = findEngineCutPoint(entries, 0, 8000);
		expect(cut).toBeDefined();
		expect(cut!.keptTokens).toBeGreaterThanOrEqual(8000);
		expect(cut!.cutIndex).toBeGreaterThan(0);
		expect(cut!.cutIndex).toBeLessThan(entries.length);
	});

	it("never places the first kept entry on a tool result", () => {
		const withTools: PiProjectedEntry[] = [];
		for (let i = 0; i < 8; i++) {
			withTools.push(makeAssistantEntry(`a${i}`, { text: `s${i}`, toolCalls: [`c${i}`] }));
			withTools.push(makeToolResultEntry(`t${i}`, { text: filler(7000), toolCallId: `c${i}` }));
		}
		const cut = findEngineCutPoint(withTools, 0, 10000);
		expect(cut).toBeDefined();
		expect(cut!.cutIndex).toBeGreaterThan(0);
		expect(isCutPointMessage(withTools[cut!.cutIndex].messages[0])).toBe(true);
	});

	it("reports the tokens being summarized away", () => {
		const cut = findEngineCutPoint(entries, 0, 8000)!;
		const manual = entries
			.slice(0, cut.cutIndex)
			.reduce((sum, entry) => sum + estimateEntryTokens(entry), 0);
		expect(cut.summarizedTokens).toBe(manual);
	});

	it("returns undefined when nothing may be cut", () => {
		const onlyToolResults = [makeToolResultEntry("t1", { text: filler(100) })];
		expect(findEngineCutPoint(onlyToolResults, 0, 10)).toBeUndefined();
	});

	it("returns undefined when the whole range would be kept", () => {
		const cut = findEngineCutPoint(entries, 0, 10_000_000)!;
		// Everything is kept, so there is nothing to summarize.
		expect(cut).toBeUndefined();
	});

	it("returns undefined when the boundary leaves nothing behind it", () => {
		expect(findEngineCutPoint(entries, entries.length - 1, 1)).toBeUndefined();
	});
});

describe("planEngineCompaction", () => {
	it("summarizes everything before the cut and keeps the tail", async () => {
		const entries = turns(6, 20000);
		const summarize = vi.fn(async () => result());

		const plan = await planEngineCompaction(entries, {
			keepRecentTokens: 8000,
			summarize,
		});

		expect(plan).toBeDefined();
		const cut = findEngineCutPoint(entries, 0, 8000)!;
		expect(plan!.draft.firstKeptEntryId).toBe(entries[cut.cutIndex].sourceEntry.id);
		expect(plan!.summarizedIds).toHaveLength(cut.cutIndex);
		expect(plan!.draft.type).toBe("compaction");
		expect(plan!.draft.summary).toBe("#C\ncompressed history");
	});

	it("starts after an earlier compaction and passes its summary through", async () => {
		const earlier = compactionEntry("k1", "prior summary text");
		const entries = [earlier, ...turns(4, 20000)];
		const summarize = vi.fn(async () => result());

		const plan = await planEngineCompaction(entries, {
			keepRecentTokens: 6000,
			summarize,
		});

		expect(summarize).toHaveBeenCalledTimes(1);
		const [messages, previousSummary] = summarize.mock.calls[0];
		expect(previousSummary).toBe("prior summary text");
		expect(messages.some((m) => String(m.content).includes("prior summary text"))).toBe(false);
		expect(plan!.summarizedIds).not.toContain("k1");
	});

	it("hands the engine the projected (post-pruning) content, not the transcript", async () => {
		const edited: PiProjectedEntry = {
			sourceEntry: { id: "t1", type: "message" },
			messages: [{ role: "toolResult", content: "[pruned]", toolCallId: "c1" }],
		};
		const entries = [edited, ...turns(4, 20000)];
		const summarize = vi.fn(async () => result());

		await planEngineCompaction(entries, { keepRecentTokens: 4000, summarize });
		const [messages] = summarize.mock.calls[0];
		expect(messages.some((m) => String(m.content).includes("[pruned]"))).toBe(true);
	});

	it("declines when the engine produces no usable text", async () => {
		const plan = await planEngineCompaction(turns(4, 20000), {
			keepRecentTokens: 6000,
			summarize: async () => result({ summary: "   " }),
		});
		expect(plan).toBeUndefined();
	});

	it("declines when there is nothing to summarize", async () => {
		const plan = await planEngineCompaction(turns(1, 200), {
			keepRecentTokens: 10_000_000,
			summarize: async () => result(),
		});
		expect(plan).toBeUndefined();
	});

	it("records file operations and compression stats in details", async () => {
		const plan = await planEngineCompaction(turns(6, 20000), {
			keepRecentTokens: 8000,
			summarize: async () => result({ readFiles: ["x.ts"], compressionRatio: 0.2 }),
		});
		const details = plan!.draft.details as Record<string, unknown>;
		expect(details.ultracompact).toBe(true);
		expect(details.stage).toBe("engine");
		expect(details.readFiles).toEqual(["x.ts"]);
		expect(details.compressionRatio).toBe(0.2);
	});
});
