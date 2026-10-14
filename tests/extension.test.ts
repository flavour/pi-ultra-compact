import { beforeEach, describe, expect, it, vi } from "vitest";
import piUltraCompact, { __resetModuleState } from "../extensions/index";
import { isOpenAICodexNativeModel } from "../extensions/utils";
import type { UltraCompactConfig } from "../extensions/types";

function makeMessage() {
	return {
		id: "message-1",
		role: "user",
		content: "Keep this conversation intact.",
		timestamp: Date.now(),
	};
}

describe("piUltraCompact extension", () => {
	it("uses ctx.model.contextWindow instead of the generic fallback", async () => {
		const handlers = new Map<string, Function>();
		const fakePi = {
			registerCommand: vi.fn(),
			on(event: string, handler: Function) {
				handlers.set(event, handler);
			},
		};

		piUltraCompact(fakePi);

		await handlers.get("session_start")?.(
			{ reason: "startup" },
			{
				model: {
					id: "gpt-5.5",
					contextWindow: 272000,
				},
			},
		);

		const result = await handlers.get("session_before_compact")?.(
			{
				preparation: {
					tokensBefore: 100000,
					messagesToSummarize: [makeMessage()],
					firstKeptEntryId: "entry-1",
				},
			},
			{
				model: {
					id: "gpt-5.5",
					contextWindow: 272000,
				},
				ui: { notify: vi.fn() },
			},
		);

		expect(result).toBeUndefined();
	});

	it("does not write normal startup messages to stdout", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const handlers = new Map<string, Function>();
		const fakePi = {
			registerCommand: vi.fn(),
			on(event: string, handler: Function) {
				handlers.set(event, handler);
			},
		};

		try {
			piUltraCompact(fakePi);
			await handlers.get("session_start")?.(
				{ reason: "startup" },
				{
					model: {
						id: "gpt-5.5",
						contextWindow: 272000,
					},
				},
			);

			expect(log).not.toHaveBeenCalled();
			expect(warn).not.toHaveBeenCalled();
			expect(error).not.toHaveBeenCalled();
		} finally {
			log.mockRestore();
			warn.mockRestore();
			error.mockRestore();
		}
	});
});

const NATIVE_CODEX_MODEL = {
	provider: "openai-codex",
	api: "openai-codex-responses",
	id: "gpt-5.3-codex",
	contextWindow: 1000,
};

const PLAIN_MODEL = {
	provider: "llama.cpp",
	api: "openai-completions",
	id: "qwen3-local",
	contextWindow: 1000,
};

/**
 * Three prose messages estimate to ~800 tokens against the 1000-token test
 * window: past both shouldCompact gates, inside the MICRO tier.
 */
function makeBulkMessages() {
	const prose = "Keep this conversation intact. ".repeat(30);
	return [1, 2, 3].map((n) => ({
		id: `message-${n}`,
		role: "user",
		content: prose,
		timestamp: Date.now(),
	}));
}

function makeCompactionEvent() {
	return {
		reason: "threshold",
		willRetry: false,
		preparation: {
			tokensBefore: 900,
			messagesToSummarize: makeBulkMessages(),
			firstKeptEntryId: "entry-1",
		},
	};
}

function registerExtension(config: UltraCompactConfig = {}) {
	const handlers = new Map<string, Function>();
	const commands = new Map<string, { description: string; handler: Function }>();
	const fakePi = {
		registerCommand(name: string, definition: { description: string; handler: Function }) {
			commands.set(name, definition);
		},
		on(event: string, handler: Function) {
			handlers.set(event, handler);
		},
	};
	piUltraCompact(fakePi, config);
	return { handlers, commands };
}

describe("native compaction handoff", () => {
	beforeEach(() => {
		__resetModuleState();
	});

	it("defers automatic compaction to the checkpoint owner for Codex models", async () => {
		const { handlers } = registerExtension();
		const notify = vi.fn();

		const result = await handlers.get("session_before_compact")?.(
			makeCompactionEvent(),
			{ model: NATIVE_CODEX_MODEL, ui: { notify } },
		);

		expect(result).toBeUndefined();
		expect(notify).not.toHaveBeenCalled();
	});

	it("still compacts other models at the same token pressure", async () => {
		const { handlers } = registerExtension();

		const result = await handlers.get("session_before_compact")?.(
			makeCompactionEvent(),
			{ model: PLAIN_MODEL, ui: { notify: vi.fn() } },
		);

		expect(result?.compaction?.details?.ultracompact).toBe(true);
	});

	it("does not defer when only the provider matches", async () => {
		const { handlers } = registerExtension();

		const result = await handlers.get("session_before_compact")?.(
			makeCompactionEvent(),
			{
				model: { ...NATIVE_CODEX_MODEL, api: "openai-responses" },
				ui: { notify: vi.fn() },
			},
		);

		expect(result?.compaction?.details?.ultracompact).toBe(true);
	});

	it("compacts Codex models when deferToNativeCompaction is disabled", async () => {
		const { handlers } = registerExtension({ deferToNativeCompaction: false });

		const result = await handlers.get("session_before_compact")?.(
			makeCompactionEvent(),
			{ model: NATIVE_CODEX_MODEL, ui: { notify: vi.fn() } },
		);

		expect(result?.compaction?.details?.ultracompact).toBe(true);
	});

	it("leaves the checkpoint entry standing in either load order", async () => {
		// Pi runs every session_before_compact handler and keeps the last result, so
		// the checkpoint owner must win whichever order the extensions load in.
		const { handlers } = registerExtension();
		const ours = handlers.get("session_before_compact")!;

		const emit = async (ordered: Function[]) => {
			let result: Record<string, any> | undefined;
			for (const handler of ordered) {
				const next = await handler(makeCompactionEvent(), {
					model: NATIVE_CODEX_MODEL,
					ui: { notify: vi.fn() },
				});
				if (next) result = next;
			}
			return result;
		};
		const nativeHandler = async (_event: any, ctx: any) =>
			isOpenAICodexNativeModel(ctx.model)
				? {
						compaction: {
							summary: "native checkpoint marker",
							firstKeptEntryId: "entry-1",
							tokensBefore: 900,
							details: { kind: "openai-codex-native-compaction" },
						},
					}
					: undefined;

		expect((await emit([ours, nativeHandler]))?.compaction?.details?.kind).toBe(
			"openai-codex-native-compaction",
		);
		expect((await emit([nativeHandler, ours]))?.compaction?.details?.kind).toBe(
			"openai-codex-native-compaction",
		);
	});

	it("routes /ultracompact through native compaction for Codex models", () => {
		const { commands } = registerExtension();
		const notify = vi.fn();
		const compact = vi.fn();

		commands.get("ultracompact")?.handler([], {
			model: NATIVE_CODEX_MODEL,
			compact,
			ui: { notify },
		});

		expect(compact).toHaveBeenCalledWith(
			expect.objectContaining({ customInstructions: "ultracompact" }),
		);
		expect(notify).toHaveBeenCalledWith(
			expect.stringContaining("natively"),
			"info",
		);
		expect(notify).not.toHaveBeenCalledWith(
			"Starting Ultra-compact compaction...",
			"info",
		);
	});

	it("keeps the usual /ultracompact notice for other models", () => {
		const { commands } = registerExtension();
		const notify = vi.fn();

		commands.get("ultracompact")?.handler([], {
			model: PLAIN_MODEL,
			compact: vi.fn(),
			ui: { notify },
		});

		expect(notify).toHaveBeenCalledWith(
			"Starting Ultra-compact compaction...",
			"info",
		);
	});
});
