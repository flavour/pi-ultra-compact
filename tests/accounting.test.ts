/**
 * Tests for corrected context accounting (extensions/accounting.ts).
 */

import { describe, expect, it } from "vitest";
import { ContextAccountant, contextTokensFromUsage } from "../extensions/accounting";

describe("contextTokensFromUsage", () => {
	it("prefers totalTokens", () => {
		expect(
			contextTokensFromUsage({ input: 10, output: 5, cacheRead: 3, totalTokens: 99 }),
		).toBe(99);
	});

	it("falls back to summing the parts", () => {
		expect(contextTokensFromUsage({ input: 10, output: 5, cacheRead: 3, cacheWrite: 2 })).toBe(
			20,
		);
	});

	it("ignores aborted and errored responses", () => {
		expect(contextTokensFromUsage({ totalTokens: 500 }, "aborted")).toBeNull();
		expect(contextTokensFromUsage({ totalTokens: 500 }, "error")).toBeNull();
	});

	it("ignores missing and all-zero usage", () => {
		expect(contextTokensFromUsage(undefined)).toBeNull();
		expect(contextTokensFromUsage({ input: 0, output: 0 })).toBeNull();
	});
});

describe("ContextAccountant calibration", () => {
	it("learns the estimator's error from a single sample", () => {
		const a = new ContextAccountant();
		// Pi estimated 130k where the provider counted 190k.
		a.observeTurn({
			usage: { totalTokens: 190000 },
			projectedEstimate: 130000,
			trailingEstimate: 0,
		});

		expect(a.getRatio()).toBeCloseTo(190 / 130, 3);
		expect(a.getDiagnostics().calibrated).toBe(true);
	});

	it("clamps the ratio into a plausible band", () => {
		const a = new ContextAccountant();
		a.observeTurn({
			usage: { totalTokens: 1000 },
			projectedEstimate: 1000,
			trailingEstimate: 0,
		});
		expect(a.getRatio()).toBe(1);

		a.observeTurn({
			usage: { totalTokens: 100000 },
			projectedEstimate: 1000,
			trailingEstimate: 0,
		});
		expect(a.getRatio()).toBeLessThanOrEqual(3);
	});

	it("smooths repeated samples instead of jumping", () => {
		const a = new ContextAccountant();
		a.observeTurn({
			usage: { totalTokens: 100000 },
			projectedEstimate: 100000,
			trailingEstimate: 0,
		});
		const first = a.getRatio();
		a.observeTurn({
			usage: { totalTokens: 200000 },
			projectedEstimate: 100000,
			trailingEstimate: 0,
		});

		expect(a.getRatio()).toBeGreaterThan(first);
		expect(a.getRatio()).toBeLessThan(2);
	});

	it("leaves the ratio alone when the turn carries no usable usage", () => {
		const a = new ContextAccountant();
		a.observeTurn({
			usage: { totalTokens: 190000 },
			projectedEstimate: 130000,
			trailingEstimate: 0,
		});
		const ratio = a.getRatio();
		a.observeTurn({ usage: undefined, projectedEstimate: 400000, trailingEstimate: 1000 });

		expect(a.getRatio()).toBe(ratio);
	});
});

describe("ContextAccountant corrected count", () => {
	it("starts unknown until a usage sample arrives", () => {
		expect(new ContextAccountant().getCorrected()).toBeNull();
	});

	it("equals the provider's number when nothing has changed since", () => {
		const a = new ContextAccountant();
		a.observeTurn({
			usage: { totalTokens: 150000 },
			projectedEstimate: 150000,
			trailingEstimate: 0,
		});

		expect(a.getCorrected()).toBe(150000);
	});

	it("adds trailing content scaled by the calibrated ratio", () => {
		const a = new ContextAccountant();
		a.observeTurn({
			usage: { totalTokens: 190000 },
			projectedEstimate: 130000, // 130k at request time, nothing trailing yet
			trailingEstimate: 0,
		});
		// A new turn: same request-time estimate, plus 10k estimated tokens of
		// assistant reply and tool results.
		a.observeTurn({
			usage: { totalTokens: 190000 },
			projectedEstimate: 140000,
			trailingEstimate: 10000,
		});

		const expected = Math.round(190000 + (190 / 130) * 10000);
		expect(a.getCorrected()).toBe(expected);
	});

	it("subtracts content pruning applied since the baseline", () => {
		const a = new ContextAccountant();
		a.observeTurn({
			usage: { totalTokens: 190000 },
			projectedEstimate: 130000,
			trailingEstimate: 0,
		});
		const ratio = a.getRatio();

		a.notePrunedChars(35000); // 10k estimated tokens

		expect(a.getCorrected()).toBe(Math.round(190000 - ratio * 10000));
		expect(a.getDiagnostics().prunedRealTokens).toBe(Math.round(ratio * 10000));
	});

	it("never goes below zero", () => {
		const a = new ContextAccountant();
		a.observeTurn({
			usage: { totalTokens: 1000 },
			projectedEstimate: 1000,
			trailingEstimate: 0,
		});
		a.notePrunedChars(10_000_000);
		expect(a.getCorrected()).toBe(0);
	});

	it("keeps accumulating trailing content when a turn has no usage", () => {
		const a = new ContextAccountant();
		a.observeTurn({
			usage: { totalTokens: 100000 },
			projectedEstimate: 100000,
			trailingEstimate: 0,
		});
		a.observeTurn({ usage: undefined, projectedEstimate: 108000, trailingEstimate: 8000 });

		expect(a.getCorrected()).toBe(108000);
	});

	it("resets after a compaction rewrites the context", () => {
		const a = new ContextAccountant();
		a.observeTurn({
			usage: { totalTokens: 190000 },
			projectedEstimate: 130000,
			trailingEstimate: 0,
		});
		a.notePrunedChars(1000);
		a.reset();

		expect(a.getCorrected()).toBeNull();
		expect(a.getDiagnostics().baselineReal).toBeNull();
		// Calibration survives: it is a property of the tokenizer, not the context.
		expect(a.getRatio()).toBeCloseTo(190 / 130, 3);
	});
});
