/**
 * Tests for the optional wrap-up/handoff nudge (extensions/handoff.ts).
 */

import { describe, expect, it } from "vitest";
import {
	DEFAULT_HANDOFF_MESSAGE,
	DEFAULT_HANDOFF_NUDGE,
	resolveHandoffNudge,
	shouldFireNudge,
} from "../extensions/handoff";

describe("handoff nudge defaults", () => {
	it("is disabled by default", () => {
		expect(DEFAULT_HANDOFF_NUDGE.enabled).toBe(false);
		expect(resolveHandoffNudge(undefined).enabled).toBe(false);
		expect(resolveHandoffNudge({}).enabled).toBe(false);
	});

	it("is interactive-only by default, so long-running agents are not interrupted", () => {
		expect(resolveHandoffNudge(undefined).modes).toEqual(["tui"]);
	});

	it("fires at 40% of the window by default", () => {
		expect(resolveHandoffNudge(undefined).atRatio).toBe(0.4);
	});

	it("keeps a default message", () => {
		expect(DEFAULT_HANDOFF_MESSAGE).toContain("compaction threshold");
	});
});

describe("shouldFireNudge", () => {
	const base = {
		enabled: true,
		mode: "tui",
		modes: ["tui"],
		correctedTokens: 105000,
		threshold: 105000,
		oncePerCompaction: true,
	};

	it("stays silent when disabled", () => {
		expect(shouldFireNudge({ fired: false }, { ...base, enabled: false })).toBe(false);
	});

	it("stays silent below the threshold", () => {
		expect(shouldFireNudge({ fired: false }, { ...base, correctedTokens: 104999 })).toBe(false);
	});

	it("fires at the threshold", () => {
		expect(shouldFireNudge({ fired: false }, base)).toBe(true);
	});

	it("stays silent when the run mode is not interactive", () => {
		expect(shouldFireNudge({ fired: false }, { ...base, mode: "print" })).toBe(false);
		expect(shouldFireNudge({ fired: false }, { ...base, mode: undefined })).toBe(false);
	});

	it("allows modes the caller opts into", () => {
		expect(
			shouldFireNudge({ fired: false }, { ...base, mode: "rpc", modes: ["tui", "rpc"] }),
		).toBe(true);
	});

	it("fires at most once per compaction by default", () => {
		expect(shouldFireNudge({ fired: true }, base)).toBe(false);
	});

	it("can be configured to fire repeatedly", () => {
		expect(shouldFireNudge({ fired: true }, { ...base, oncePerCompaction: false })).toBe(true);
	});

	it("stays silent while usage is still unknown", () => {
		expect(shouldFireNudge({ fired: false }, { ...base, correctedTokens: null })).toBe(false);
	});
});
