/**
 * Tests for the extension's turn-boundary wiring: pruning entries, escalation,
 * the optional nudge, and state resets.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import piUltraCompact, { UltraCompactEngine, __resetModuleState } from "../extensions/index";
import {
	estimateMessagesTokens,
	estimateProjectionTokens,
	planPruning,
	resolvePruningPolicy,
} from "../extensions/pruning";
import type { PiProjectedEntry } from "../extensions/types";
import { filler, makeAssistantEntry, makeToolResultEntry, makeUserEntry } from "./helpers";

function makePi() {
	const handlers: Record<string, Function[]> = {};
	const commands: Record<string, any> = {};
	return {
		registerCommand: vi.fn((name: string, def: any) => {
			commands[name] = def;
		}),
		on: vi.fn((event: string, handler: Function) => {
			(handlers[event] ||= []).push(handler);
		}),
		sendUserMessage: vi.fn(),
		getSettings: vi.fn(() => ({})),
		_handlers: handlers,
		_commands: commands,
	};
}

function turn(n: number, chars = 6000): PiProjectedEntry[] {
	return [
		makeAssistantEntry(`a${n}`, { text: `step ${n}`, toolCalls: [`c${n}`] }),
		makeToolResultEntry(`t${n}`, { text: filler(chars), toolCallId: `c${n}` }),
	];
}

function makeEntries(turns = 6, chars = 6000): PiProjectedEntry[] {
	return [
		makeUserEntry("u1", "start"),
		...Array.from({ length: turns }, (_, i) => turn(i + 1, chars)).flat(),
	];
}

function makeTurnEndEvent(entries: PiProjectedEntry[]) {
	const projected = estimateProjectionTokens(entries);
	return {
		type: "turn_end",
		turnIndex: 0,
		message: {
			role: "assistant",
			content: [{ type: "text", text: "done" }],
			usage: {
				totalTokens: projected,
				input: projected,
				output: 4,
				cacheRead: 0,
				cacheWrite: 0,
			},
			stopReason: "stop",
		},
		toolResults: [],
		messageEntryId: "a-last",
		toolResultEntryIds: [],
		context: { messages: [], thinkingLevel: "off", model: {}, contextEntries: entries },
	};
}

function ctxFor(contextWindow: number, mode: string = "tui", extra: Record<string, any> = {}) {
	return {
		model: { id: "local-model", provider: "local", contextWindow },
		mode,
		ui: { notify: vi.fn() },
		...extra,
	};
}

async function turnEnd(pi: ReturnType<typeof makePi>, event: any, ctx: any) {
	return pi._handlers["turn_end"]?.[0]?.(event, ctx);
}

beforeEach(() => {
	__resetModuleState();
});

describe("turn_end pruning", () => {
	it("registers a turn_end handler", () => {
		const pi = makePi();
		piUltraCompact(pi);
		expect(pi._handlers["turn_end"]).toHaveLength(1);
	});

	it("returns context_edit entries once usage crosses the lower threshold", async () => {
		const pi = makePi();
		piUltraCompact(pi);
		const entries = makeEntries();

		const result = await turnEnd(pi, makeTurnEndEvent(entries), ctxFor(1000));

		expect(result?.entries.length).toBeGreaterThan(0);
		expect(result.entries[0].type).toBe("context_edit");
		expect(result.entries[0].replacement.content).toBeDefined();
	});

	it("returns nothing while usage is below the lower threshold", async () => {
		const pi = makePi();
		piUltraCompact(pi);
		const entries = makeEntries(2, 200);

		const result = await turnEnd(pi, makeTurnEndEvent(entries), ctxFor(100_000));

		expect(result).toBeUndefined();
	});

	it("returns nothing when pruning is disabled", async () => {
		const pi = makePi();
		piUltraCompact(pi, { pruning: { enabled: false } });

		const result = await turnEnd(pi, makeTurnEndEvent(makeEntries()), ctxFor(1000));

		expect(result).toBeUndefined();
		expect(pi.sendUserMessage).not.toHaveBeenCalled();
	});

	it("does not re-edit an entry it already pruned", async () => {
		const pi = makePi();
		piUltraCompact(pi);
		const entries = makeEntries();
		const ctx = ctxFor(1000);

		const first = await turnEnd(pi, makeTurnEndEvent(entries), ctx);
		const second = await turnEnd(pi, makeTurnEndEvent(entries), ctx);

		expect(first.entries.length).toBeGreaterThan(0);
		expect(second).toBeUndefined();
	});

	it("tolerates events without projected entries", async () => {
		const pi = makePi();
		piUltraCompact(pi);

		const result = await turnEnd(
			pi,
			{ message: { role: "assistant", content: [] } },
			ctxFor(1000),
		);

		expect(result).toBeUndefined();
	});
});

describe("wrap-up nudge", () => {
	it("does not interrupt the agent by default", async () => {
		const pi = makePi();
		piUltraCompact(pi);

		await turnEnd(pi, makeTurnEndEvent(makeEntries()), ctxFor(1000));

		expect(pi.sendUserMessage).not.toHaveBeenCalled();
	});

	it("sends a steering message when enabled in an interactive mode", async () => {
		const pi = makePi();
		piUltraCompact(pi, { handoffNudge: { enabled: true } });

		await turnEnd(pi, makeTurnEndEvent(makeEntries()), ctxFor(1000));

		expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
		expect(pi.sendUserMessage.mock.calls[0][1]).toEqual({ deliverAs: "steer" });
		expect(pi.sendUserMessage.mock.calls[0][0]).toContain("compaction threshold");
	});

	it("stays silent in non-interactive modes even when enabled", async () => {
		const pi = makePi();
		piUltraCompact(pi, { handoffNudge: { enabled: true } });

		await turnEnd(pi, makeTurnEndEvent(makeEntries()), ctxFor(1000, "print"));

		expect(pi.sendUserMessage).not.toHaveBeenCalled();
	});

	it("fires once, not on every turn", async () => {
		const pi = makePi();
		piUltraCompact(pi, { handoffNudge: { enabled: true } });
		const ctx = ctxFor(1000);

		await turnEnd(pi, makeTurnEndEvent(makeEntries()), ctx);
		await turnEnd(pi, makeTurnEndEvent(makeEntries()), ctx);

		expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
	});
});

describe("escalation to summarization", () => {
	it("leaves compaction to Pi by default", async () => {
		const pi = makePi();
		piUltraCompact(pi);
		const compact = vi.fn();

		await turnEnd(pi, makeTurnEndEvent(makeEntries()), ctxFor(1000, "tui", { compact }));

		expect(compact).not.toHaveBeenCalled();
		expect(pi.sendUserMessage).not.toHaveBeenCalled();
	});

	it("steers a wrap-up message when escalation is set to steer", async () => {
		const pi = makePi();
		piUltraCompact(pi, {
			pruning: { enabled: false },
			summarization: { atTokens: 3000, escalation: "steer" },
		});

		await turnEnd(pi, makeTurnEndEvent(makeEntries()), ctxFor(1000));

		expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
		expect(pi.sendUserMessage.mock.calls[0][1]).toEqual({ deliverAs: "steer" });
	});

	it("calls ctx.compact when escalation is set to compact", async () => {
		const pi = makePi();
		piUltraCompact(pi, {
			pruning: { enabled: false },
			summarization: { atTokens: 3000, escalation: "compact" },
		});
		const compact = vi.fn();

		await turnEnd(pi, makeTurnEndEvent(makeEntries()), ctxFor(1000, "tui", { compact }));

		expect(compact).toHaveBeenCalledTimes(1);
	});

	it("does not escalate while pruning is still recovering headroom", async () => {
		const pi = makePi();
		piUltraCompact(pi, { summarization: { atTokens: 9000, escalation: "steer" } });

		await turnEnd(pi, makeTurnEndEvent(makeEntries()), ctxFor(1000));

		// Pruning recovered enough headroom to drop the corrected count under the
		// summarize point, so the escalation path stays closed.
		expect(pi.sendUserMessage).not.toHaveBeenCalled();
	});

	it("escalates exactly when pruning runs out of content", async () => {
		// The boundary is the corrected count minus what pruning can still recover.
		// Asking for less than that must escalate; asking for exactly that must not.
		const entries = makeEntries();
		const policy = resolvePruningPolicy({});
		const saved = planPruning(entries, policy, {}).estimatedTokensSaved;
		const projected = estimateProjectionTokens(entries);
		const corrected =
			projected +
			estimateMessagesTokens([
				{ role: "assistant", content: [{ type: "text", text: "done" }] },
			]);

		// A few tokens of slack either side: the handler scales the saving by the
		// calibrated ratio, which is a hair over 1 in this fixture.
		const below = await runWithThreshold(corrected - saved - 5);
		expect(below).toBe(1);

		const at = await runWithThreshold(corrected - saved + 5);
		expect(at).toBe(0);
	});

	async function runWithThreshold(atTokens: number): Promise<number> {
		__resetModuleState();
		const pi = makePi();
		piUltraCompact(pi, { summarization: { atTokens, escalation: "steer" } });
		await turnEnd(pi, makeTurnEndEvent(makeEntries()), ctxFor(1000));
		return pi.sendUserMessage.mock.calls.length;
	}
});

describe("state resets and failure visibility", () => {
	it("re-prunes after a compaction clears the edited-entry set", async () => {
		const pi = makePi();
		piUltraCompact(pi);
		const entries = makeEntries();
		const ctx = ctxFor(1000);

		await turnEnd(pi, makeTurnEndEvent(entries), ctx);
		pi._handlers["session_compact"]?.[0]?.({}, ctx);
		const after = await turnEnd(pi, makeTurnEndEvent(entries), ctx);

		expect(after?.entries.length).toBeGreaterThan(0);
	});

	it("surfaces a failed compaction instead of swallowing it", async () => {
		const pi = makePi();
		piUltraCompact(pi);
		const ctx = ctxFor(1000);

		pi._handlers["session_compact_failed"]?.[0]?.(
			{ reason: "overflow", fromExtension: false, errorMessage: "context length exceeded" },
			ctx,
		);

		expect(ctx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("context length exceeded"),
			"error",
		);
	});

	it("falls back to console when there is no UI to notify", async () => {
		const pi = makePi();
		piUltraCompact(pi);
		const error = vi.spyOn(console, "error").mockImplementation(() => {});

		pi._handlers["session_compact_failed"]?.[0]?.(
			{ reason: "overflow", errorMessage: "boom" },
			{ model: { contextWindow: 1000 }, mode: "print" },
		);

		expect(error).toHaveBeenCalledWith(expect.stringContaining("boom"));
		error.mockRestore();
	});
});

describe("/ultra-compact-status", () => {
	it("reports thresholds and suggests a reserveTokens value when the estimator under-counts", async () => {
		const pi = makePi();
		piUltraCompact(pi);

		// A turn whose provider usage dwarfs the projection estimate forces the
		// calibration ratio to its ceiling, which is what the hint is for.
		const entries = makeEntries(2, 2000);
		const event = {
			message: {
				role: "assistant",
				content: [{ type: "text", text: "done" }],
				usage: { totalTokens: 100000 },
				stopReason: "stop",
			},
			toolResults: [],
			context: { contextEntries: entries },
		};
		await turnEnd(pi, event, ctxFor(262144));

		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		pi._commands["ultra-compact-status"].handler({}, ctxFor(262144));
		const output = log.mock.calls.map((c) => c.join(" ")).join("\n");
		log.mockRestore();

		expect(output).toContain("context window: 262144");
		expect(output).toContain("summarize at: 245760 (real tokens)");
		expect(output).toContain("estimate-based");
		expect(output).toContain("reserveTokens to 180224");
	});

	it("stays quiet about reserveTokens when the estimator is accurate", async () => {
		const pi = makePi();
		piUltraCompact(pi);
		const entries = makeEntries(2, 2000);

		await turnEnd(pi, makeTurnEndEvent(entries), ctxFor(262144));

		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		pi._commands["ultra-compact-status"].handler({}, ctxFor(262144));
		const output = log.mock.calls.map((c) => c.join(" ")).join("\n");
		log.mockRestore();

		expect(output).toContain("prune at: 91750 (real tokens)");
		expect(output).not.toContain("reserveTokens");
	});
});

describe("summarization stage defaults to Pi's own summarizer", () => {
	it("returns no compaction from session_before_compact", async () => {
		const pi = makePi();
		piUltraCompact(pi);

		const result = await pi._handlers["session_before_compact"]?.[0]?.(
			{
				preparation: {
					tokensBefore: 200000,
					firstKeptEntryId: "1",
					messagesToSummarize: [
						{ id: "1", role: "user", content: "GOAL: ship it", timestamp: Date.now() },
					],
				},
			},
			{
				model: { id: "local", provider: "local", contextWindow: 262144 },
				ui: { notify: vi.fn() },
			},
		);

		expect(result).toBeUndefined();
	});

	it("still writes its own summary when summaryMode is engine", async () => {
		const pi = makePi();
		piUltraCompact(pi, { summarization: { summaryMode: "engine" }, thresholdTokens: 100 });

		const result = await pi._handlers["session_before_compact"]?.[0]?.(
			{
				customInstructions: "ultracompact",
				preparation: {
					tokensBefore: 200000,
					firstKeptEntryId: "1",
					messagesToSummarize: [
						{ id: "1", role: "user", content: "GOAL: ship it", timestamp: Date.now() },
					],
				},
			},
			{
				model: { id: "local", provider: "local", contextWindow: 262144 },
				ui: { notify: vi.fn() },
			},
		);

		expect(result?.compaction?.details?.ultracompact).toBe(true);
	});
});

describe("engine compaction stage", () => {
	function textTurns(count: number, chars: number): PiProjectedEntry[] {
		const out: PiProjectedEntry[] = [];
		for (let i = 0; i < count; i++) {
			out.push(makeUserEntry(`u${i}`, `goal ${i}: build the thing`));
			out.push(makeAssistantEntry(`a${i}`, { text: `step ${i} done. ${filler(chars)}` }));
		}
		return out;
	}

	function toolTurns(count: number, chars: number): PiProjectedEntry[] {
		const out: PiProjectedEntry[] = [];
		for (let i = 0; i < count; i++) {
			out.push(makeUserEntry(`u${i}`, `goal ${i}`));
			out.push(makeAssistantEntry(`a${i}`, { text: `step ${i}`, toolCalls: [`c${i}`] }));
			out.push(makeToolResultEntry(`t${i}`, { text: filler(chars), toolCallId: `c${i}` }));
		}
		return out;
	}

	function pick(result: any, type: string) {
		return (result?.entries ?? []).filter((entry: any) => entry.type === type);
	}

	it("writes a compaction entry once the lower compaction threshold is crossed", async () => {
		const pi = makePi();
		piUltraCompact(pi);
		const entries = textTurns(12, 20000);

		const result = await turnEnd(pi, makeTurnEndEvent(entries), ctxFor(131072));

		const [compaction] = pick(result, "compaction");
		expect(compaction).toBeDefined();
		expect(compaction.summary.length).toBeGreaterThan(0);
		expect(entries.some((e) => e.sourceEntry.id === compaction.firstKeptEntryId)).toBe(true);
		expect(compaction.details.stage).toBe("engine");
	});

	it("leaves the context alone below the lower compaction threshold", async () => {
		const pi = makePi();
		piUltraCompact(pi);
		const entries = textTurns(4, 20000);

		const result = await turnEnd(pi, makeTurnEndEvent(entries), ctxFor(131072));

		expect(pick(result, "compaction")).toHaveLength(0);
	});

	it("does not compact at the boundary when summaryMode is pi", async () => {
		const pi = makePi();
		piUltraCompact(pi, { summarization: { summaryMode: "pi" } });
		const entries = textTurns(12, 20000);

		const result = await turnEnd(pi, makeTurnEndEvent(entries), ctxFor(131072));

		expect(pick(result, "compaction")).toHaveLength(0);
	});

	it("does not compact at the boundary when summaryMode is engine", async () => {
		const pi = makePi();
		piUltraCompact(pi, { summarization: { summaryMode: "engine" } });
		const entries = textTurns(12, 20000);

		const result = await turnEnd(pi, makeTurnEndEvent(entries), ctxFor(131072));

		expect(pick(result, "compaction")).toHaveLength(0);
	});

	it("skips the pass when the saving is below minSavingRatio", async () => {
		const pi = makePi();
		piUltraCompact(pi, { summarization: { minSavingRatio: 0.99 } });
		const entries = textTurns(12, 20000);

		const result = await turnEnd(pi, makeTurnEndEvent(entries), ctxFor(131072));

		expect(pick(result, "compaction")).toHaveLength(0);
	});

	it("drops pruning edits for entries the compaction removes, keeps the rest", async () => {
		const pi = makePi();
		piUltraCompact(pi, {
			pruning: { atTokens: 1000, targetRatio: 0.2, bulkExcerptChars: 18000 },
			summarization: { engineAtTokens: 20000, keepRecentTokens: 40000, minSavingRatio: 0.01 },
		});
		const entries = toolTurns(8, 20000);

		const result = await turnEnd(pi, makeTurnEndEvent(entries), ctxFor(100000));

		const [compaction] = pick(result, "compaction");
		const edits = pick(result, "context_edit");
		expect(compaction).toBeDefined();
		expect(edits.length).toBeGreaterThan(0);

		const keptFrom = entries.findIndex(
			(entry) => entry.sourceEntry.id === compaction.firstKeptEntryId,
		);
		expect(keptFrom).toBeGreaterThan(0);
		for (const edit of edits) {
			const index = entries.findIndex((entry) => entry.sourceEntry.id === edit.targetId);
			expect(index).toBeGreaterThanOrEqual(keptFrom);
		}
	});

	it("surfaces an engine failure and still commits the pruning pass", async () => {
		const failure = vi
			.spyOn(UltraCompactEngine.prototype, "generateSummary")
			.mockRejectedValue(new Error("boom"));
		try {
			const pi = makePi();
			piUltraCompact(pi, {
				pruning: { atTokens: 1000 },
				summarization: { engineAtTokens: 1 },
			});
			const entries = toolTurns(6, 20000);
			const ctx = ctxFor(100000);

			const result = await turnEnd(pi, makeTurnEndEvent(entries), ctx);

			expect(pick(result, "compaction")).toHaveLength(0);
			expect(pick(result, "context_edit").length).toBeGreaterThan(0);
			expect(
				ctx.ui.notify.mock.calls.some(
					([message, level]) => level === "error" && /engine summary failed/.test(message),
				),
			).toBe(true);
		} finally {
			failure.mockRestore();
		}
	});

	it("stands aside when the provider checkpoints its own context", async () => {
		const pi = makePi();
		piUltraCompact(pi);
		const entries = textTurns(12, 20000);
		const ctx = {
			...ctxFor(131072),
			model: {
				provider: "openai-codex",
				api: "openai-codex-responses",
				id: "gpt-5.3-codex",
				contextWindow: 131072,
			},
		};

		const result = await turnEnd(pi, makeTurnEndEvent(entries), ctx);

		expect(pick(result, "compaction")).toHaveLength(0);
	});

	it("writes its own compaction for a checkpointing model when deferral is disabled", async () => {
		const pi = makePi();
		piUltraCompact(pi, { deferToNativeCompaction: false });
		const entries = textTurns(12, 20000);
		const ctx = {
			...ctxFor(131072),
			model: {
				provider: "openai-codex",
				api: "openai-codex-responses",
				id: "gpt-5.3-codex",
				contextWindow: 131072,
			},
		};

		const result = await turnEnd(pi, makeTurnEndEvent(entries), ctx);

		expect(pick(result, "compaction")).toHaveLength(1);
	});

	it("counts engine compactions in the status report", async () => {
		const pi = makePi();
		piUltraCompact(pi);
		const entries = textTurns(12, 20000);

		await turnEnd(pi, makeTurnEndEvent(entries), ctxFor(131072));

		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		pi._commands["ultra-compact-status"].handler({}, ctxFor(131072));
		const output = log.mock.calls.map((c) => c.join(" ")).join("\n");
		log.mockRestore();

		expect(output).toContain("engine compaction at: 65536 (real tokens)");
		expect(output).toContain("engine compactions: 1");
	});
});
