/**
 * Tests for the non-LLM pruning pass (extensions/pruning.ts).
 */

import { describe, expect, it } from "vitest";
import {
	DEFAULT_PRUNING_POLICY,
	estimateProjectionTokens,
	planPruning,
	resolvePruningPolicy,
} from "../extensions/pruning";
import { EvictionLevel } from "../extensions/types";
import type { PiProjectedEntry } from "../extensions/types";
import {
	filler,
	makeAssistantEntry,
	makeToolResultEntry,
	makeProjectedEntry,
	makeUserEntry,
} from "./helpers";

/** Policy with no protection window, so tests control eligibility exactly. */
function policy(overrides: Record<string, unknown> = {}) {
	return resolvePruningPolicy({ keepRecentTurns: 0, ...overrides });
}

function textOf(draft: { replacement: { content: unknown } } | undefined): string {
	if (!draft) return "";
	const content = draft.replacement.content;
	if (typeof content === "string") return content;
	return (content as Array<{ type: string; text?: string }>)
		.map((b) => (b.type === "text" ? (b.text ?? "") : `[${b.type}]`))
		.join("\n");
}

describe("pruning policy defaults", () => {
	it("is enabled by default", () => {
		expect(DEFAULT_PRUNING_POLICY.enabled).toBe(true);
	});

	it("defaults to the lowest cache cost: newest-first pruning", () => {
		expect(DEFAULT_PRUNING_POLICY.order).toBe("newest");
	});

	it("caps pruning below whole-message removal", () => {
		expect(DEFAULT_PRUNING_POLICY.maxLevel).toBe(EvictionLevel.STRIP_ARTIFACTS);
	});

	it("fills unspecified fields from defaults", () => {
		const resolved = resolvePruningPolicy({ minEntryChars: 99 });
		expect(resolved.minEntryChars).toBe(99);
		expect(resolved.bulkMinChars).toBe(DEFAULT_PRUNING_POLICY.bulkMinChars);
		expect(resolved.keepRecentTurns).toBe(DEFAULT_PRUNING_POLICY.keepRecentTurns);
	});
});

describe("tool result pruning", () => {
	it("replaces a large tool result with a marker plus head excerpt", () => {
		const body = `${"line of output\n".repeat(50)}${filler(6000)}`;
		const entries = [makeToolResultEntry("t1", { text: body })];

		const plan = planPruning(entries, policy(), {});

		expect(plan.drafts).toHaveLength(1);
		const text = textOf(plan.drafts[0]);
		expect(text).toContain("[tool output pruned:");
		expect(text).toContain(body.slice(0, 100));
		expect(text.length).toBeLessThan(body.length);
	});

	it("collapses mid-sized tool results to a one-line marker", () => {
		const body = filler(1200);
		const entries = [makeToolResultEntry("t1", { text: body, toolName: "grep" })];

		const plan = planPruning(entries, policy(), {});

		expect(plan.drafts).toHaveLength(1);
		const text = textOf(plan.drafts[0]);
		expect(text).toContain("[tool result pruned: grep,");
		expect(text).toContain("1200 chars");
	});

	it("leaves tool results below minEntryChars alone", () => {
		const entries = [makeToolResultEntry("t1", { text: filler(300) })];
		const plan = planPruning(entries, policy({ minEntryChars: 400 }), {});
		expect(plan.drafts).toHaveLength(0);
	});

	it("never prunes error tool results, however large", () => {
		const entries = [makeToolResultEntry("t1", { text: filler(9000), isError: true })];
		const plan = planPruning(entries, policy(), {});
		expect(plan.drafts).toHaveLength(0);
	});

	it("never prunes user messages", () => {
		const entries = [makeUserEntry("u1", filler(9000))];
		const plan = planPruning(entries, policy(), {});
		expect(plan.drafts).toHaveLength(0);
	});

	it("never prunes custom entries", () => {
		const entry = makeProjectedEntry(
			"c1",
			{ role: "custom", content: filler(9000) },
			{ type: "custom_message" },
		);
		const plan = planPruning([entry], policy(), {});
		expect(plan.drafts).toHaveLength(0);
	});
});

describe("reasoning pruning", () => {
	it("strips thinking blocks and keeps text and tool calls", () => {
		const entry = makeAssistantEntry("a1", {
			thinking: filler(3000),
			text: "the conclusion",
			toolCalls: ["call-1"],
		});

		const plan = planPruning([entry], policy({ maxLevel: EvictionLevel.STRIP_REASONING }), {});

		expect(plan.drafts).toHaveLength(1);
		const blocks = plan.drafts[0].replacement.content as Array<{ type: string }>;
		expect(blocks.some((b) => b.type === "thinking")).toBe(false);
		expect(blocks.some((b) => b.type === "toolCall")).toBe(true);
		expect(blocks.some((b) => b.type === "text")).toBe(true);
	});

	it("keeps tool-call pairing intact so no orphan tool results appear", () => {
		const entries = [
			makeAssistantEntry("a1", { thinking: filler(3000), toolCalls: ["call-1"] }),
			makeToolResultEntry("t1", { text: filler(6000), toolCallId: "call-1" }),
		];

		const plan = planPruning(entries, policy({ maxLevel: EvictionLevel.STRIP_REASONING }), {});

		const assistantDraft = plan.drafts.find((d) => d.targetId === "a1");
		expect(assistantDraft).toBeDefined();
		const blocks = assistantDraft!.replacement.content as Array<{ type: string; id?: string }>;
		expect(blocks.filter((b) => b.type === "toolCall").map((b) => b.id)).toEqual(["call-1"]);
		// The tool result entry is untouched at this level, so the pair still matches.
		expect(plan.drafts.some((d) => d.targetId === "t1")).toBe(false);
	});

	it("leaves redacted thinking in place because the provider needs it back", () => {
		const entry = makeAssistantEntry("a1", {
			redactedThinking: true,
			text: filler(3000),
		});
		const plan = planPruning([entry], policy({ maxLevel: EvictionLevel.STRIP_REASONING }), {});
		expect(plan.drafts).toHaveLength(0);
	});

	it("replaces an all-thinking assistant message with a marker", () => {
		const entry = makeAssistantEntry("a1", { thinking: filler(3000) });
		const plan = planPruning([entry], policy({ maxLevel: EvictionLevel.STRIP_REASONING }), {});
		expect(textOf(plan.drafts[0])).toBe("[reasoning pruned]");
	});
});

describe("protection window", () => {
	it("leaves the most recent turns untouched", () => {
		const turn = (n: number): PiProjectedEntry[] => [
			makeAssistantEntry(`a${n}`, { toolCalls: [`c${n}`] }),
			makeToolResultEntry(`t${n}`, { text: filler(6000), toolCallId: `c${n}` }),
		];
		const entries = [...turn(1), ...turn(2), ...turn(3)];

		const plan = planPruning(entries, resolvePruningPolicy({ keepRecentTurns: 2 }), {});

		expect(plan.drafts.map((d) => d.targetId)).toEqual(["t1"]);
	});

	it("protects everything when keepRecentTurns covers the whole session", () => {
		const entries = [
			makeAssistantEntry("a1", { toolCalls: ["c1"] }),
			makeToolResultEntry("t1", { text: filler(6000) }),
		];
		const plan = planPruning(entries, resolvePruningPolicy({ keepRecentTurns: 4 }), {});
		expect(plan.drafts).toHaveLength(0);
	});
});

describe("ordering and stopping", () => {
	it("prunes the newest eligible entry first by default, to keep the cached prefix", () => {
		const entries = [
			makeToolResultEntry("old", { text: filler(6000) }),
			makeToolResultEntry("new", { text: filler(6000) }),
		];

		const plan = planPruning(entries, policy(), { targetTokensSaved: 100 });

		expect(plan.drafts.map((d) => d.targetId)).toEqual(["new"]);
	});

	it("prunes the oldest first when order is set to oldest", () => {
		const entries = [
			makeToolResultEntry("old", { text: filler(6000) }),
			makeToolResultEntry("new", { text: filler(6000) }),
		];

		const plan = planPruning(entries, policy({ order: "oldest" }), {
			targetTokensSaved: 100,
		});

		expect(plan.drafts.map((d) => d.targetId)).toEqual(["old"]);
	});

	it("stops as soon as the target saving is reached", () => {
		const entries = [1, 2, 3, 4, 5].map((n) =>
			makeToolResultEntry(`t${n}`, { text: filler(6000) }),
		);

		const plan = planPruning(entries, policy(), { targetTokensSaved: 1000 });

		expect(plan.drafts.length).toBeLessThan(entries.length);
		expect(plan.estimatedTokensSaved).toBeGreaterThanOrEqual(1000);
	});

	it("applies every entry when no target is given", () => {
		const entries = [1, 2, 3].map((n) => makeToolResultEntry(`t${n}`, { text: filler(6000) }));
		const plan = planPruning(entries, policy(), {});
		expect(plan.drafts).toHaveLength(3);
	});

	it("respects maxLevel", () => {
		const entries = [
			makeAssistantEntry("a1", { thinking: filler(3000), text: filler(3000) }),
			makeToolResultEntry("t1", { text: filler(6000) }),
		];

		const plan = planPruning(entries, policy({ maxLevel: EvictionLevel.STRIP_REASONING }), {});

		expect(plan.drafts.map((d) => d.targetId)).toEqual(["a1"]);
		expect(plan.levelUsed).toBe(EvictionLevel.STRIP_REASONING);
	});
});

describe("idempotence and safety guards", () => {
	it("skips entries that already carry a context edit", () => {
		const entries = [makeToolResultEntry("t1", { text: filler(6000) })];

		const plan = planPruning(entries, policy(), { editedIds: new Set(["t1"]) });

		expect(plan.drafts).toHaveLength(0);
	});

	it("re-editing an already pruned entry is skipped so the cache is not churned", () => {
		const entries = [makeToolResultEntry("t1", { text: filler(6000) })];
		const first = planPruning(entries, policy(), {});
		const ids = new Set(first.drafts.map((d) => d.targetId));
		const second = planPruning(entries, policy(), { editedIds: ids });
		expect(second.drafts).toHaveLength(0);
	});

	it("skips entries whose replacement would barely be smaller", () => {
		// Above minEntryChars, but the marker is ~90 chars, so the saving has to
		// clear the 200-char floor before an edit is worth a cache invalidation.
		const entries = [makeToolResultEntry("t1", { text: filler(250) })];
		const plan = planPruning(entries, policy({ minEntryChars: 200 }), {});
		expect(plan.drafts).toHaveLength(0);
	});

	it("skips entries that contribute more than one message", () => {
		const entry: PiProjectedEntry = {
			sourceEntry: {
				id: "multi",
				type: "message",
				message: { role: "toolResult", content: [{ type: "text", text: filler(6000) }] },
			},
			messages: [
				{ role: "toolResult", content: [{ type: "text", text: filler(6000) }] },
				{ role: "toolResult", content: [{ type: "text", text: filler(6000) }] },
			],
		};
		const plan = planPruning([entry], policy(), {});
		expect(plan.drafts).toHaveLength(0);
	});

	it("returns an empty plan for empty input", () => {
		const plan = planPruning([], policy(), {});
		expect(plan.drafts).toHaveLength(0);
		expect(plan.charsRemoved).toBe(0);
		expect(plan.levelUsed).toBe(0);
	});
});

describe("token estimation", () => {
	it("reports savings in the same units Pi uses (chars / 3.5)", () => {
		const body = filler(7000);
		const entries = [makeToolResultEntry("t1", { text: body })];

		const plan = planPruning(entries, policy(), {});
		const replacementChars = textOf(plan.drafts[0]).length;

		expect(plan.charsRemoved).toBe(body.length - replacementChars);
		expect(plan.estimatedTokensSaved).toBe(Math.floor((body.length - replacementChars) / 3.5));
	});

	it("estimates the projection in Pi's units", () => {
		const entries = [makeUserEntry("u1", filler(3500))];
		expect(estimateProjectionTokens(entries)).toBeCloseTo(1002, -1);
	});

	it("counts tool call arguments and images when sizing content", () => {
		const entry = makeAssistantEntry("a1", { toolCalls: ["c1"] });
		const plan = planPruning([entry], policy(), {});
		expect(plan.entriesConsidered).toBe(1);
	});
});
