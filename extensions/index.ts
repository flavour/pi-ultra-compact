/**
 * pi-ultra-compact
 *
 * Compaction extension for Pi with three escalating stages, each with its own
 * threshold:
 *
 * 1. Pruning (no LLM). Once usage crosses the pruning threshold, older tool
 *    results and reasoning blocks are rewritten out of the model-visible
 *    projection through Pi `context_edit` entries. The transcript keeps the
 *    originals, nothing is summarized, and no model call is made.
 * 2. Engine compaction (no LLM). At the lower compaction threshold the engine's
 *    structured summary is written as a Pi compaction entry at the turn
 *    boundary. No completion, no aborted run.
 * 3. Pi compaction (LLM). At the higher threshold Pi's native summarizer runs
 *    with the session model, updating the engine summary it finds there.
 *
 * A wrap-up/handoff nudge is available but disabled by default: it interrupts
 * the current task, which suits a human at the keyboard and not a long-running
 * agent.
 */

import { ContextAccountant } from "./accounting";
import {
	planEngineCompaction,
	resolveEngineAt,
	resolveEngineCompaction,
} from "./engine-compaction";
import type { EngineCompactionPlan } from "./engine-compaction";
import { UltraCompactEngine } from "./engine";
import { DEFAULT_HANDOFF_MESSAGE, resolveHandoffNudge, shouldFireNudge } from "./handoff";
import { resolveNativeProtectedIds } from "./native-checkpoint";
import {
	estimateMessagesTokens,
	estimateProjectionTokens,
	planPruning,
	resolvePruningPolicy,
} from "./pruning";
import type {
	PiCompactionDraft,
	PiContextEditDraft,
	PiContextMessage,
	PiProjectedEntry,
	UltraCompactConfig,
} from "./types";
import { isOpenAICodexNativeModel } from "./utils";

/** Track current model at runtime (updated by session_start and model_select events) */
let currentModel: { id?: string; contextWindow?: number } | undefined;
/** Circuit breaker state (module-level for __resetModuleState access) */
let compactionFailures = 0;
let breakerTrippedAtTurn: number | null = null;
let currentTurn = 0;

/** Pruning/escalation state (module-level for __resetModuleState access) */
let accountant = new ContextAccountant();
const editedEntryIds = new Set<string>();
let nudgeFired = false;
let lastPruneSummary = "";
let engineCompactions = 0;
let lastEngineCompaction = "";
let lastNativeProtected = 0;

/** Pi's default `compaction.reserveTokens`. */
const DEFAULT_RESERVE_TOKENS = 16384;

/** Pi's default `compaction.keepRecentTokens`. */
const DEFAULT_KEEP_RECENT_TOKENS = 20000;

/** Default configuration — thresholdTokens omitted so engine auto-detects from model context window */
const DEFAULT_CONFIG: UltraCompactConfig = {
	keepPercentage: 0.3,
	maxKeepTokens: 30000,
	autoCompact: true,
	deferToNativeCompaction: true,
	pruning: {},
	summarization: {},
	handoffNudge: {},
};

function captureModel(model: any): void {
	if (!model) return;

	const id =
		typeof model === "string" ? model : model.id || model.name || model.model || undefined;
	const contextWindow =
		typeof model === "object" && typeof model.contextWindow === "number"
			? model.contextWindow
			: undefined;

	if (id || contextWindow) {
		currentModel = { id, contextWindow };
	}
}

function notify(ctx: any, message: string, type: "info" | "warning" | "error" = "info"): void {
	if (typeof ctx?.ui?.notify === "function") {
		ctx.ui.notify(message, type);
		return;
	}
	// Headless runs have no UI. Problems still have to reach whoever is watching
	// the session; routine info does not.
	if (type === "error") console.error(message);
	else if (type === "warning") console.warn(message);
}

/**
 * Reconfigure the engine to match the current model before a compaction operation.
 * Ensures the threshold adapts even if the user changed models mid-session.
 */
function reconfigureEngineForCurrentModel(engine: UltraCompactEngine): void {
	engine.reconfigure(currentModel?.id, currentModel?.contextWindow);
}

function contextWindowFrom(ctx: any, engine: UltraCompactEngine): number | undefined {
	const fromCtx =
		typeof ctx?.model?.contextWindow === "number" ? ctx.model.contextWindow : undefined;
	return fromCtx ?? currentModel?.contextWindow ?? engine.getContextWindow();
}

/**
 * Resolve the higher (summarization) threshold.
 *
 * Defaults to Pi's own effective trigger — `contextWindow - reserveTokens`,
 * honouring Pi's per-model `compaction.modelOverrides` — so the extension's
 * escalation point and Pi's native one agree.
 */
/** Resolve Pi's effective compaction settings for the active model. */
function readPiCompactionSettings(
	pi: any,
	ctx: any,
): { reserveTokens: number; keepRecentTokens: number } {
	const settings =
		typeof ctx?.getSettings === "function"
			? ctx.getSettings()
			: typeof pi?.getSettings === "function"
				? pi.getSettings()
				: undefined;

	const compaction = settings?.compaction;
	const modelKey =
		ctx?.model?.provider && ctx?.model?.id
			? `${ctx.model.provider}/${ctx.model.id}`
			: undefined;
	const override = modelKey ? compaction?.modelOverrides?.[modelKey] : undefined;

	return {
		reserveTokens: override?.reserveTokens ?? compaction?.reserveTokens ?? DEFAULT_RESERVE_TOKENS,
		keepRecentTokens:
			override?.keepRecentTokens ?? compaction?.keepRecentTokens ?? DEFAULT_KEEP_RECENT_TOKENS,
	};
}

function resolveSummarizeAt(
	pi: any,
	ctx: any,
	contextWindow: number,
	config: UltraCompactConfig,
): number {
	const explicit = config.summarization?.atTokens;
	if (typeof explicit === "number" && explicit > 0) return explicit;

	const ratio = config.summarization?.atRatio;
	if (typeof ratio === "number" && ratio > 0) {
		return Math.floor(contextWindow * ratio);
	}

	const { reserveTokens } = readPiCompactionSettings(pi, ctx);
	return Math.max(0, contextWindow - reserveTokens);
}

/** Resolve the lower (pruning) threshold. */
function resolvePruneAt(contextWindow: number, config: UltraCompactConfig): number {
	const explicit = config.pruning?.atTokens;
	if (typeof explicit === "number" && explicit > 0) return explicit;
	const ratio = config.pruning?.atRatio ?? 0.35;
	return Math.floor(contextWindow * ratio);
}

/**
 * Handle /ultracompact command — manual compaction request.
 * Triggers Pi's native compaction flow via ctx.compact().
 * Our session_before_compact hook intercepts and applies ultra-compact logic.
 */
function handleUltracompactCommand(
	engine: UltraCompactEngine,
	deferToNativeCompaction: boolean,
): (_args: any, ctx: any) => void {
	return (_args: any, ctx: any) => {
		// Guard against missing ctx or ctx.compact
		if (typeof ctx?.compact !== "function") {
			console.warn("Ultra-compact warning: ctx.compact unavailable");
			return;
		}

		// Notify user that compaction is starting
		if (deferToNativeCompaction && isOpenAICodexNativeModel(ctx?.model)) {
			notify(
				ctx,
				"OpenAI Codex compacts this model natively; running Pi compaction without ultra-compact compression.",
				"info",
			);
		} else {
			notify(ctx, "Starting Ultra-compact compaction...", "info");
		}

		// Reconfigure engine to current model before compaction
		reconfigureEngineForCurrentModel(engine);

		// Use Pi's built-in compact() API with a marker so our
		// session_before_compact hook applies ultra-compact logic
		ctx.compact({
			customInstructions: "ultracompact",
			onComplete: () => {
				notify(ctx, "Ultra-compact compaction complete!", "info");
			},
			onError: (error: Error) => {
				if (typeof ctx?.ui?.notify === "function") {
					notify(ctx, `Ultra-compact failed: ${error.message}`, "error");
				} else {
					console.error("Ultra-compact failed:", error.message);
				}
			},
		});
	};
}

/**
 * Handle session_before_compact — the summarization stage.
 *
 * By default this returns undefined so Pi's native summarizer writes the summary
 * with the session model: it already handles iterative summary updates, keeps
 * `keepRecentTokens` of verbatim context, and accounts for the summary's own
 * usage. The extension's job is stage 1 (pruning), not re-implementing
 * summarization.
 *
 * Set `summarization.summaryMode: "engine"` to have the engine write *that*
 * summary too, whenever Pi triggers compaction.
 */
function handleBeforeCompact(
	engine: UltraCompactEngine,
	deferToNativeCompaction: boolean,
	summaryMode: "pi" | "engine" | "engine-then-pi",
): (event: any, ctx: any) => Promise<Record<string, any> | undefined> {
	return async (event: any, ctx: any) => {
		// ── Native compaction handoff ──────────────────────────────────
		// Pi runs every session_before_compact handler and keeps the last one that
		// returns a compaction. Returning undefined here means the checkpoint-owning
		// extension's entry stands, whichever order the two load in, and this turn
		// stays out of the circuit-breaker bookkeeping.
		if (deferToNativeCompaction && isOpenAICodexNativeModel(ctx?.model)) {
			return undefined;
		}

		currentTurn++;

		if (summaryMode !== "engine") {
			// Pi writes the summary. Nothing to intercept. "engine-then-pi" lands here
			// too: by the time Pi triggers, the cheap summary has already run, and Pi's
			// job is to improve on it with the model.
			return undefined;
		}

		// ── Circuit breaker check ───────────────────────────────────────
		if (breakerTrippedAtTurn !== null) {
			const COOLDOWN_TURNS = engine["config"]?.circuitBreakerCooldown ?? 5;
			if (currentTurn - breakerTrippedAtTurn < COOLDOWN_TURNS) {
				notify(
					ctx,
					"Ultra-compact circuit breaker open; using default compaction",
					"warning",
				);
				return undefined; // Fall back to Pi default
			}
			// Cool-down expired, reset breaker
			compactionFailures = 0;
			breakerTrippedAtTurn = null;
		}

		// Capture model from ctx at runtime
		if (ctx?.model) {
			captureModel(ctx.model);
		}
		reconfigureEngineForCurrentModel(engine);

		const preparation = event?.preparation;
		if (!preparation) {
			return undefined;
		}

		const currentTokens = preparation.tokensBefore;
		const messagesToCompact = preparation.messagesToSummarize;
		const isManual = event?.customInstructions === "ultracompact";

		if (!Array.isArray(messagesToCompact) || messagesToCompact.length === 0) {
			return undefined;
		}

		// ── Preemptive trigger ──────────────────────────────────────────
		// Project next turn's token usage (current + headroom for tool result + output)
		const outputHeadroom = engine["config"]?.outputHeadroom ?? 4096;
		const projectedTokens = currentTokens + outputHeadroom;
		const effectiveTokens = isManual ? currentTokens : projectedTokens;

		if (!isManual && !engine.shouldCompact(effectiveTokens)) {
			return undefined; // No compaction needed
		}

		// ── Snapshot ────────────────────────────────────────────────────
		const snapshot = JSON.parse(JSON.stringify(messagesToCompact));
		let snapshotPreviousSummary = preparation.previousSummary;

		try {
			// ── Cache-Aware: append instead of rewrite ──────────────────
			const isCacheAware = engine["config"]?.cacheAware ?? false;
			let cacheAwarePrefix = "";

			if (isCacheAware && snapshotPreviousSummary) {
				cacheAwarePrefix = snapshotPreviousSummary;
				snapshotPreviousSummary = undefined; // Don't re-summarize
			}

			const result = await engine.generateSummary(snapshot, snapshotPreviousSummary);
			if (isCacheAware && cacheAwarePrefix) {
				result.summary = cacheAwarePrefix + "\n\n" + result.summary;
			}

			if (!result.summary || result.summary.trim().length === 0) {
				throw new Error("Empty summary returned from compaction");
			}

			compactionFailures = 0;

			return {
				compaction: {
					summary: result.summary,
					firstKeptEntryId: preparation.firstKeptEntryId,
					tokensBefore: preparation.tokensBefore,
					details: {
						readFiles: result.readFiles,
						modifiedFiles: result.modifiedFiles,
						ultracompact: true,
						compressionRatio: result.compressionRatio,
					},
				},
			};
		} catch (error) {
			// ── Circuit breaker ─────────────────────────────────────────
			const reason = error instanceof Error ? error.message : String(error);
			compactionFailures++;
			notify(
				ctx,
				`Ultra-compact failed (${compactionFailures}/${engine["config"]?.circuitBreakerMaxFailures ?? 3}): ${reason}`,
				"warning",
			);

			if (compactionFailures >= (engine["config"]?.circuitBreakerMaxFailures ?? 3)) {
				breakerTrippedAtTurn = currentTurn;
				notify(
					ctx,
					"Ultra-compact circuit breaker tripped; emergency truncation applied",
					"error",
				);

				const tailKeep = 10;
				const system = snapshot.filter((m: any) => m.role === "system");
				const nonSystem = snapshot.filter((m: any) => m.role !== "system");
				const tail = nonSystem.slice(-tailKeep);

				const lossySummary = [
					...system.map(
						(m: any) => `[System]: ${typeof m.content === "string" ? m.content : ""}`,
					),
					"",
					"[earlier history truncated — circuit breaker engaged]",
					"",
					...tail.map(
						(m: any) =>
							`${typeof m.content === "string" ? `[${m.role}]: ${m.content.substring(0, 500)}` : ""}`,
					),
				]
					.filter(Boolean)
					.join("\n");

				return {
					compaction: {
						summary: lossySummary,
						firstKeptEntryId: preparation.firstKeptEntryId,
						tokensBefore: preparation.tokensBefore,
						details: {
							ultracompact: true,
							circuitBreakerEngaged: true,
						},
					},
				};
			}

			return undefined;
		}
	};
}

/**
 * Pruning + escalation pass, run at every turn boundary.
 *
 * Runs at `turn_end` because that is a boundary event: the handler can append
 * `context_edit` entries, and Pi commits them and rebuilds the projection before
 * the next provider request. Pruning therefore takes effect on the very next
 * request, mid-run, without aborting anything.
 */
function handleTurnEnd(
	pi: any,
	engine: UltraCompactEngine,
	config: UltraCompactConfig,
): (event: any, ctx: any) => Promise<Record<string, any> | undefined> {
	const policy = resolvePruningPolicy(config.pruning);
	const nudge = resolveHandoffNudge(config.handoffNudge);
	const escalation = config.summarization?.escalation ?? "native";

	return async (event: any, ctx: any) => {
		const entries: PiProjectedEntry[] = event?.context?.contextEntries ?? [];
		if (!Array.isArray(entries) || entries.length === 0) return undefined;

		const contextWindow = contextWindowFrom(ctx, engine);
		if (!contextWindow) return undefined;

		// ── Corrected accounting ────────────────────────────────────────
		const trailingMessages = [
			event?.message,
			...(Array.isArray(event?.toolResults) ? event.toolResults : []),
		].filter(Boolean) as PiContextMessage[];

		const projectedEstimate = estimateProjectionTokens(entries);
		const trailingEstimate = estimateMessagesTokens(trailingMessages);

		accountant.observeTurn({
			usage: event?.message?.usage,
			stopReason: event?.message?.stopReason,
			projectedEstimate,
			trailingEstimate,
		});

		const corrected = accountant.getCorrected() ?? projectedEstimate;
		const ratio = accountant.getRatio();

		// ── Optional wrap-up nudge (off by default) ─────────────────────
		const nudgeThreshold =
			typeof nudge.atTokens === "number" && nudge.atTokens > 0
				? nudge.atTokens
				: Math.floor(contextWindow * (nudge.atRatio ?? 0.4));

		if (
			shouldFireNudge(
				{ fired: nudgeFired },
				{
					enabled: nudge.enabled === true,
					mode: ctx?.mode,
					modes: nudge.modes,
					correctedTokens: corrected,
					threshold: nudgeThreshold,
					oncePerCompaction: nudge.oncePerCompaction !== false,
				},
			)
		) {
			if (typeof pi?.sendUserMessage === "function") {
				void pi.sendUserMessage(nudge.message ?? DEFAULT_HANDOFF_MESSAGE, {
					deliverAs: "steer",
				});
			}
			nudgeFired = true;
			notify(ctx, "Ultra-compact: wrap-up nudge sent", "info");
		}

		// ── Stage 1: prune below the lower threshold ────────────────────
		const drafts: PiContextEditDraft[] = [];
		let estimatedTokensSaved = 0;

		// A provider that checkpoints its own context replays that checkpoint instead
		// of the entries it replaced, and refuses the request once a context edit
		// touches history the checkpoint still retains. Pruning those entries would
		// save nothing and break the run, so they leave the candidate pool.
		const protectedIds = resolveNativeProtectedIds(entries, ctx?.model);
		lastNativeProtected = protectedIds.size;

		const pruneAt = resolvePruneAt(contextWindow, config);
		const targetRatio = policy.targetRatio ?? 0.28;
		const pruneTarget = Math.floor(contextWindow * targetRatio);

		if (policy.enabled && corrected >= pruneAt) {
			const realDeficit = corrected - pruneTarget;
			if (realDeficit > 0) {
				// The plan works in Pi's estimate units; the deficit is in real tokens.
				const plan = planPruning(entries, policy, {
					targetTokensSaved: Math.ceil(realDeficit / ratio),
					editedIds: editedEntryIds,
					protectedIds,
				});

				for (const draft of plan.drafts) editedEntryIds.add(draft.targetId);
				if (plan.charsRemoved > 0) accountant.notePrunedChars(plan.charsRemoved);

				drafts.push(...plan.drafts);
				estimatedTokensSaved = plan.estimatedTokensSaved;
				lastPruneSummary =
					plan.drafts.length > 0
						? `level ${plan.levelUsed}, ${plan.drafts.length} entries, ~${plan.estimatedTokensSaved} est. tokens`
						: "nothing prunable";
			}
		}

		// `estimatedTokensSaved` is in Pi's estimate units; the corrected count is in
		// real tokens, so the saving is scaled by the same ratio.
		const correctedAfterPruning = Math.max(
			0,
			Math.round(corrected - estimatedTokensSaved * ratio),
		);

		// ── Stage 2: engine compaction at the lower compaction threshold ──
		// A `compaction` draft returned from a boundary event is committed by Pi and
		// re-projected before the next provider request, so this costs no completion
		// and never aborts the run. Pi's summarizer later *updates* this summary.
		const mode = config.summarization?.summaryMode ?? "engine-then-pi";
		const engineResolved = resolveEngineCompaction(
			config.summarization,
			readPiCompactionSettings(pi, ctx).keepRecentTokens,
		);
		const engineAt = resolveEngineAt(contextWindow, config.summarization, engineResolved);
		// Providers that checkpoint their own context own the compaction entry; a second
		// one standing beside it would fight them for the projection.
		const defersToNative =
			config.deferToNativeCompaction !== false && isOpenAICodexNativeModel(ctx?.model);

		if (mode === "engine-then-pi" && !defersToNative && correctedAfterPruning >= engineAt) {
			const minSaving = Math.floor(contextWindow * engineResolved.minSavingRatio);
			let plan: EngineCompactionPlan | undefined;
			try {
				plan = await planEngineCompaction(entries, {
					keepRecentTokens: engineResolved.keepRecentTokens,
					summarize: (messages, previous) => engine.generateSummary(messages, previous),
				});
			} catch (error) {
				notify(
					ctx,
					`Ultra-compact engine summary failed: ${(error as Error)?.message ?? error}`,
					"error",
				);
			}

			// The plan estimates in Pi's units; scale by the calibration ratio to get
			// the real tokens the server counts.
			const realSaving = plan ? Math.round(plan.summarizedTokens * ratio) : 0;

			if (plan && realSaving >= minSaving) {
				const leaving = new Set(plan.summarizedIds);
				const surviving = drafts.filter((draft) => !leaving.has(draft.targetId));

				accountant.reset();
				editedEntryIds.clear();
				nudgeFired = false;
				for (const draft of surviving) editedEntryIds.add(draft.targetId);

				engineCompactions++;
				lastEngineCompaction = `~${realSaving} real tokens summarized, ~${plan.keptTokens} est. kept verbatim`;
				notify(ctx, `Ultra-compact: engine compaction (${realSaving} tokens)`, "info");

				const committed: (PiContextEditDraft | PiCompactionDraft)[] = [...surviving, plan.draft];
				return { entries: committed };
			}
			if (plan) {
				lastEngineCompaction = `skipped: only ~${realSaving} tokens to reclaim (min ${minSaving})`;
			}
		}

		// ── Stage 3: escalate when nothing cheaper can hold the line ──────
		const summarizeAt = resolveSummarizeAt(pi, ctx, contextWindow, config);

		if (correctedAfterPruning >= summarizeAt && escalation !== "native") {
			if (escalation === "compact" && typeof ctx?.compact === "function") {
				// Pi aborts the in-flight run before compacting. Only appropriate when
				// a human is driving; "native" is the default for long-running agents.
				ctx.compact({
					customInstructions: "ultracompact",
					onError: (error: Error) =>
						notify(ctx, `Ultra-compact escalation failed: ${error?.message}`, "error"),
				});
			} else if (escalation === "steer" && typeof pi?.sendUserMessage === "function") {
				void pi.sendUserMessage(
					"Context is at the compaction threshold and pruning can no longer recover it. " +
						"Wrap up the current step; compaction is about to run.",
					{ deliverAs: "steer" },
				);
			}
		}

		if (drafts.length === 0) return undefined;
		return { entries: drafts };
	};
}

/** Report corrected usage, calibration, and the thresholds. */
function handleStatusCommand(
	pi: any,
	engine: UltraCompactEngine,
	config: UltraCompactConfig,
): (_args: any, ctx: any) => void {
	return (_args: any, ctx: any) => {
		const contextWindow = contextWindowFrom(ctx, engine) ?? 0;
		const diagnostics = accountant.getDiagnostics();
		const pruneAt = resolvePruneAt(contextWindow, config);
		const summarizeAt = resolveSummarizeAt(pi, ctx, contextWindow, config);
		const mode = config.summarization?.summaryMode ?? "engine-then-pi";
		const engineResolved = resolveEngineCompaction(
			config.summarization,
			readPiCompactionSettings(pi, ctx).keepRecentTokens,
		);
		const engineAt = resolveEngineAt(contextWindow, config.summarization, engineResolved);

		const ratio = accountant.getRatio();
		// Pi compares its own projection estimate to `contextWindow - reserveTokens`.
		// To have that land on a real-token target, the estimate threshold must be
		// divided by the calibration ratio.
		const suggestedReserveTokens = Math.max(0, Math.round(contextWindow - summarizeAt / ratio));

		const lines = [
			`context window: ${contextWindow}`,
			`corrected tokens: ${diagnostics.correctedTokens ?? "unknown"} (Pi projection estimate would be ~${Math.round((diagnostics.correctedTokens ?? 0) / ratio)})`,
			`usage ratio: ${ratio.toFixed(2)} (${ratio > 1.05 ? "estimator under-counts; Pi's own trigger fires later than the token count suggests" : "estimator close to real tokens"})`,
			`prune at: ${pruneAt} (real tokens)`,
			`engine compaction at: ${mode === "engine-then-pi" ? `${engineAt} (real tokens)` : `disabled (summaryMode: ${mode})`}`,
			`summarize at: ${summarizeAt} (real tokens)`,
			`pruned entries: ${editedEntryIds.size}`,
			`last prune pass: ${lastPruneSummary || "none"}`,
			`native-protected entries: ${lastNativeProtected}`,
			`engine compactions: ${engineCompactions}`,
			`last engine compaction: ${lastEngineCompaction || "none"}`,
			`calibrated: ${diagnostics.calibrated}`,
		];

		if (ratio > 1.05) {
			lines.push(
				`Pi's native trigger is estimate-based; to make it fire near ${summarizeAt} real tokens, set compaction reserveTokens to ${suggestedReserveTokens} (and keep the model's maxTokens capped)`,
			);
		}
		console.log(lines.join("\n"));
	};
}

/**
 * Pi extension factory function
 */
export default function piUltraCompact(pi: any, config: UltraCompactConfig = {}): void {
	const mergedConfig: UltraCompactConfig = {
		...DEFAULT_CONFIG,
		...config,
		pruning: { ...DEFAULT_CONFIG.pruning, ...config.pruning },
		summarization: { ...DEFAULT_CONFIG.summarization, ...config.summarization },
		handoffNudge: { ...DEFAULT_CONFIG.handoffNudge, ...config.handoffNudge },
	};
	const { deferToNativeCompaction = true } = mergedConfig;
	const summarization = mergedConfig.summarization;
	// The engine predates these three stages and takes unknown keys literally, so
	// the stage config is kept out of its constructor bag.
	const engineConfig = { ...mergedConfig };
	delete engineConfig.pruning;
	delete engineConfig.summarization;
	delete engineConfig.handoffNudge;

	const summaryMode = summarization?.summaryMode ?? "engine-then-pi";
	const engine = new UltraCompactEngine(engineConfig);

	// Guard: ensure required Pi APIs are available
	if (typeof pi?.registerCommand !== "function") {
		console.error("pi.registerCommand is unavailable");
		return;
	}

	// Register /ultracompact command
	pi.registerCommand("ultracompact", {
		description:
			"Ultra-compact compaction with maximum compression while preserving critical context.",
		handler: handleUltracompactCommand(engine, deferToNativeCompaction),
	});

	pi.registerCommand("ultra-compact-status", {
		description:
			"Show corrected context usage, the estimator calibration ratio, and both compaction thresholds.",
		handler: handleStatusCommand(pi, engine, mergedConfig),
	});

	// Track model changes at runtime so compaction adapts when user switches models
	if (typeof pi.on === "function") {
		pi.on("session_start", (_event: any, ctx: any) => {
			captureModel(ctx?.model);
			reconfigureEngineForCurrentModel(engine);
		});

		pi.on("model_select", (event: any, _ctx: any) => {
			if (event?.model) {
				const id =
					typeof event.model === "string"
						? event.model
						: event.model.id || event.model.name || undefined;
				captureModel(event.model);
				reconfigureEngineForCurrentModel(engine);
				if (id) {
					console.log("Model updated: " + id);
				}
			}
		});

		// Stage 1: prune the projection at every turn boundary.
		pi.on("turn_end", handleTurnEnd(pi, engine, mergedConfig));

		// A compaction rewrites the context, so prior edits and the real-token
		// baseline no longer describe it.
		pi.on("session_compact", () => {
			accountant.reset();
			editedEntryIds.clear();
			nudgeFired = false;
			lastPruneSummary = "";
		});

		// Surface failures. Without this, a compaction that 400s at the provider is
		// invisible to whoever is watching the session.
		pi.on("session_compact_failed", (event: any, ctx: any) => {
			const reason = event?.errorMessage ?? (event?.aborted ? "aborted" : "unknown");
			notify(
				ctx,
				`Compaction failed (${event?.reason ?? "unknown"}${event?.fromExtension ? ", from extension" : ""}): ${reason}`,
				"error",
			);
		});
	}

	// Register automatic compaction hook (single handler)
	if (mergedConfig.autoCompact) {
		pi.on(
			"session_before_compact",
			handleBeforeCompact(engine, deferToNativeCompaction, summaryMode),
		);
	}
}

// Export engine for programmatic use
export { UltraCompactEngine } from "./engine";
export { ContextAccountant, contextTokensFromUsage } from "./accounting";
export {
	DEFAULT_PRUNING_POLICY,
	estimateProjectionTokens,
	planPruning,
	resolvePruningPolicy,
} from "./pruning";
export { resolveHandoffNudge, shouldFireNudge } from "./handoff";
export { NATIVE_COMPACTION_KIND, resolveNativeProtectedIds } from "./native-checkpoint";
export {
	findEngineCutPoint,
	planEngineCompaction,
	resolveEngineAt,
	resolveEngineCompaction,
} from "./engine-compaction";
export type {
	EngineCompactionPlan,
	EngineCutPoint,
	ResolvedEngineCompaction,
} from "./engine-compaction";
export type {
	CompactionResult,
	HandoffNudgeConfig,
	PruningPolicy,
	SummarizationPolicy,
	UltraCompactConfig,
} from "./types";

/**
 * @internal — Reset module-level state for testing isolation.
 * Vitest caches modules across test files, so shared state must be
 * explicitly reset between suites.
 */
export function __resetModuleState(): void {
	currentModel = undefined;
	compactionFailures = 0;
	breakerTrippedAtTurn = null;
	currentTurn = 0;
	accountant = new ContextAccountant();
	editedEntryIds.clear();
	nudgeFired = false;
	lastPruneSummary = "";
	engineCompactions = 0;
	lastEngineCompaction = "";
	lastNativeProtected = 0;
}
