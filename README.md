# pi-ultra-compact

Advanced compaction extension and skill for [Pi](https://pi.dev/) with automatic threshold-based compaction that follows Pi's active model metadata.

[![Pi Package](https://img.shields.io/badge/Pi-Package-blue)](https://pi.dev/packages)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![npm version](https://img.shields.io/npm/v/pi-ultra-compact.svg)](https://www.npmjs.com/package/pi-ultra-compact)

## Features

- **`/ultracompact` command** for manual compaction
- **Auto-adapts threshold** to Pi's active model context window
- **Works with any Pi model** that exposes context window metadata
- **Graduated Eviction (4 levels)** — strips reasoning, bulk outputs, artifacts, then messages
- **Generational Compaction** — micro (fast, no LLM) at 60-90%, full at 90%+
- **Preemptive Trigger** — fires before next turn, never pays latency during user turns
- **Cache-Aware Compaction** — immutable summary blocks keep prompt cache warm
- **Circuit Breaker** — 3 strikes → lossy truncation fallback, session never dies
- **Hierarchical summarization** with entropy-based information extraction
- **Critical context preservation** - goals, decisions, errors, file paths
- **Extension + Skill** - works as both a Pi extension and a skill
- **Smart model switching** - follows Pi model metadata and preserves custom settings
- **Conversation structure detection** - identifies turns, phases, and progress
- **Multi-pass summarization** — progressive compression with quality scoring
- **LLM-based summarization** — optional AI-powered compression (useLLM config)
- **Content-aware token counting** — dynamic ratios for code, prose, and whitespace
- **Token-Compressed Language (LLM Shorthand)** — high-density semantic style for extreme token efficiency
- **Lost-in-the-Middle Mitigations** — Entropy Scoring and Redundancy Penalties to fight context bloat in long histories
- **Native compaction handoff** — steps aside for providers that compact their own transcript (OpenAI Codex), so each model keeps exactly one compaction path
- **Three-stage compaction** — non-LLM pruning through Pi `context_edit` entries, then a non-LLM engine summary, then Pi's LLM summarizer only when the cheaper stages run out
- **Corrected token accounting** — calibrates Pi's projection estimate against real provider tokens, so thresholds mean the same thing on local models as on hosted ones

## Installation

## Installation

```bash
pi install npm:pi-ultra-compact
```

## Quick Start

After installation and restarting Pi, use:

```
/ultracompact
```

This triggers manual ultra-compact compaction.

Auto-compaction triggers automatically based on Pi's active model context window.

## Supported Models

The extension uses Pi's active model metadata as the source of truth for context window size. This avoids maintaining a separate model table in the extension and keeps thresholds aligned with Pi when new providers or models are added.

If Pi does not expose model metadata, the extension uses a conservative 128K-token fallback.

## How It Works

### Three-Stage Compaction (default)

Compaction is split into three independently thresholded stages, so the expensive stage runs as late and as rarely as possible. Each stage is measured against real tokens (see Corrected Token Accounting), and each runs at the turn boundary, so it takes effect on the very next request without aborting anything.

1. **Pruning** (default: 35% of the context window). Older tool results and assistant reasoning blocks are rewritten out of the model-visible projection through Pi `context_edit` entries. No LLM call, no summarization, and the transcript keeps the originals — only the projection changes.
2. **Engine compaction** (default: 50%). The engine's structured summary is written as a Pi `compaction` entry, cutting the oldest entries out of the projection and keeping roughly `keepRecentTokens` of the newest ones verbatim. Still no LLM call, and no aborted run — a compaction returned from a boundary event is committed by Pi and re-projected before the next request.
3. **Pi compaction** (default: Pi's own trigger, `contextWindow - reserveTokens`). Pi's native summarizer runs with the session model and writes a better summary. It finds the engine's summary in place and *updates* it — Pi reads the latest compaction entry and switches to its update prompt — so the two summarizers compose rather than compete.

Pruning rewrites *content*, never whole messages, so assistant tool calls stay paired with their tool results. Error outputs, user messages and the last four assistant turns are never touched. The engine stage never cuts between an assistant message and its tool results: the first kept entry is always a user, assistant, custom or summary message.

Set `summarization.summaryMode: "pi"` to skip stage 2, or `"engine"` to have the engine write the summary whenever *Pi* triggers compaction instead of at its own threshold.

### Corrected Token Accounting

Pi measures context exactly (`usage.totalTokens`) until a `context_edit` appears in the session, then switches to estimating the projection at 3.5 chars/token. On local models that estimate under-counts: measured against a llama.cpp server with a Qwen tokenizer, tool output lands nearer 2.4 chars/token, so a threshold configured at 128k would fire near 190k real tokens.

The extension keeps a real-token baseline from provider usage and calibrates the estimator's error from observed turns, so both thresholds are evaluated against tokens the server actually counts. `/ultra-compact-status` prints the learned ratio.

Pi's own auto-compaction trigger still compares its *estimate* to `contextWindow - reserveTokens`, so on a local model it fires later in real tokens than the number suggests. `/ultra-compact-status` prints the `reserveTokens` value that would put Pi's trigger at the extension's summarize threshold. Keep the model's `maxTokens` capped when you raise `reserveTokens` — Pi sizes the summary request as `min(0.8 × reserveTokens, model.maxTokens)`.

### What The Engine Summary Contains

The engine writes no model call: it classifies the entries leaving the projection and rebuilds them as a dense markdown summary. That is what stage 2 produces, and what stage 3 replaces when `summaryMode: "engine"` is set.

- Goals, key decisions, errors and fixes, and next steps, extracted by pattern and compressed to shorthand (`#G`, `#D`, `#E`, `#N`)
- Files read and modified, carried into Pi's next compaction so the list survives (`#F`)
- A compressed rendering of the remaining conversation (`#C`)
- The previous summary, prefixed as `#Prev` rather than discarded, so repeated compactions accumulate

It is fast, free and deterministic, and it is blind to anything that does not match a pattern — the reasoning that connected two decisions, for instance. That is exactly what Pi's summarizer is still needed for at the higher threshold.

### Eviction Levels

| Level | What it strips | When |
|-------|---------------|------|
| 1 | Assistant thinking/reasoning blocks | Always (harmless removal) |
| 2 | Bulk tool outputs (>100 lines, >5K chars) | Most sessions |
| 3 | All non-error tool results | Heavy sessions |
| 4 | Oldest non-protected messages | Only when necessary |

### Safety Systems

- **Snapshot-rollback**: Messages are deep-copied before compaction. If anything fails, the original is preserved.
- **Circuit breaker**: After 3 consecutive failures, falls back to lossy truncation (keep system + last 10 turns).
- **User messages inviolable**: Never stripped regardless of token pressure.
- **Cache-aware mode**: Previous summaries stay immutable — only new content pays prefill cost.

### Native Compaction Handoff

Some providers compact the transcript themselves and return an opaque checkpoint instead of text. OpenAI Codex (`openai-codex` provider with the `openai-codex-responses` api) does this, and extensions such as `pi-codex-compaction` store that checkpoint in Pi's compaction entry.

Pi runs every `session_before_compact` handler and keeps the last one that returns a compaction, so two extensions that both produce a summary fight over load order. For Codex models this extension returns no result: the checkpoint owner's entry stands regardless of which extension loads first, and a text summary can never orphan the provider-side checkpoint chain. `/ultracompact` still runs Pi's compaction on those models and says so in the notice. Set `deferToNativeCompaction: false` to force ultra-compact compression on Codex models.

## Configuration

Default settings work out of the box. The extension reads Pi's active model metadata and sets thresholds from `ctx.model.contextWindow` when available.

### Default Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `thresholdTokens` | Auto (80% of Pi context window, or 102,400 without metadata) | When to trigger compaction |
| `keepPercentage` | 30% | Percentage of context to keep |
| `maxKeepTokens` | 30,000 | Maximum tokens to keep |
| `autoCompact` | true | Enable automatic compaction |
| `deferToNativeCompaction` | true | Leave Codex models to native (checkpoint) compaction |
| `cacheAware` | false | Immutable summary blocks (saves API costs) |
| `maxEvictionLevel` | FULL_REMOVAL | Max eviction aggressiveness |
| `outputHeadroom` | 4,096 | Tokens reserved for LLM response |
| `circuitBreakerMaxFailures` | 3 | Failures before lossy truncation |
| `preemptiveWatermark` | 0.70 | Preemptive trigger level |
| `hardWatermark` | 0.95 | Reactive fallback level |

### Stage Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `pruning.enabled` | true | Enable the non-LLM pruning stage |
| `pruning.atRatio` | 0.35 | Fraction of the context window at which pruning starts |
| `pruning.atTokens` | unset | Absolute token threshold; overrides `atRatio` |
| `pruning.targetRatio` | 0.28 | Fraction of the window pruning works usage back down to |
| `pruning.maxLevel` | 3 (`STRIP_ARTIFACTS`) | Most aggressive pruning level allowed |
| `pruning.keepRecentTurns` | 4 | Assistant turns that are never pruned |
| `pruning.minEntryChars` | 400 | Smallest tool result eligible for level 3 |
| `pruning.bulkMinChars` | 4000 | Tool results at least this large get a head excerpt at level 2 |
| `pruning.bulkExcerptChars` | 1200 | Head excerpt kept at level 2 |
| `pruning.order` | `"newest"` | Visit order; `"newest"` preserves the longest cached prefix |
| `summarization.summaryMode` | `"engine-then-pi"` | `"engine-then-pi"` = engine at the lower threshold, Pi at the higher; `"pi"` = Pi only; `"engine"` = engine whenever Pi triggers |
| `summarization.engineAtRatio` | 0.5 | Lower compaction threshold, where the engine stage writes its summary |
| `summarization.engineAtTokens` | unset | Absolute lower compaction threshold; overrides `engineAtRatio` |
| `summarization.keepRecentTokens` | Pi's `keepRecentTokens` | Verbatim tail the engine stage keeps |
| `summarization.minSavingRatio` | 0.05 | Skip the engine stage unless it reclaims this fraction of the window |
| `summarization.atRatio` / `atTokens` | Pi's `reserveTokens` | Where Pi's summarization stage is allowed to start |
| `summarization.escalation` | `"native"` | `"native"` = let Pi compact, `"steer"` = send a wrap-up message, `"compact"` = call `ctx.compact()` (aborts the in-flight run) |
| `handoffNudge.enabled` | false | Send a wrap-up/handoff message ahead of compaction |
| `handoffNudge.atRatio` | 0.4 | Where the nudge fires |
| `handoffNudge.modes` | `["tui"]` | Run modes the nudge may interrupt |
| `handoffNudge.oncePerCompaction` | true | Fire at most once per compaction cycle |
| `handoffNudge.message` | built-in | Nudge text |

The nudge is off by default because it interrupts the current task. That is useful when a human is at the keyboard and can restart the agent context, and harmful for a long-running agent, which would just stop mid-step.

### Local Servers That Reject Oversized Requests

llama.cpp-style servers fail a request when `prompt tokens + max_tokens` exceeds `n_ctx` rather than truncating it. Pi sizes the compaction summary's `max_tokens` as `min(0.8 × reserveTokens, model.maxTokens)`, so raising a model's `compaction.modelOverrides.reserveTokens` to make compaction fire early also asks for an enormous completion, and the request 400s. Cap the model's `maxTokens` in Pi's model store as well; a `before_provider_request` handler can clamp it per request, but the durable fix is the model metadata.

## Commands

| Command | Description |
|---------|-------------|
| `/ultracompact` | Trigger manual ultra-compact compaction |
| `/ultra-compact-status` | Corrected context usage, the learned estimator ratio, all three stage thresholds, and pruning/compaction counters |

## Model Metadata

The extension does not ship its own model context-window table. Pi remains responsible for provider and model metadata; this extension uses the active model's `contextWindow` value for threshold calculation.

## Compatibility

- Works with any Pi-compatible model
- Compatible with gentle-engram (Engram memory backup)
- Compatible with gentle-pi (SDD/OpenSpec)
- Compatible with pi-codex-compaction (OpenAI Codex native checkpoints)
- No conflicts with Pi's default compaction

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for full version history.

### v0.9.2 - Test Suite Fixes & Automation
- Fixed 27 test failures from jest/vitest API mismatch
- Replaced jest.fn() with vi.fn() across all test files
- Automated senior-dev-agent pipeline deployed (review, fix, publish, label)

### v0.9.1 - CI/CD Pipeline Automation

### v0.8.0 - Generational Compaction + Safety Systems

- **Graduated Eviction** — 4-level content stripping (reasoning → bulk → artifacts → full)
- **Generational Compaction** — micro (60-90%, no LLM) + full (90%+) tiers
- **Preemptive Trigger** — fires at 70% watermark by projecting next turn
- **Cache-Aware Mode** — immutable summary blocks preserve prompt cache
- **Snapshot-Rollback + Circuit Breaker** — session never dies from bad compaction
- **Vitest suite passing** — zero regressions

### v0.7.0 - Compact Templates & LLM Summarization

- **Compact section templates** - shorter headers save 10-15% tokens across all conversations
- **LLM-based summarization** - optional LLM-powered semantic compression
- **Content-aware token estimation** - dynamic ratios for code/prose/whitespace
- **66 tests, 100% pass rate** - including 13 new effectiveness benchmarks
- **generateSummary is now async** - supports LLM callback integration

### v0.6.0 - Algorithm Enhancement Release

Major improvements to compaction quality and performance:

- **Smart model switching** - follows Pi model metadata and preserves custom settings
- **Conversation structure detection** - identifies turns, phases, progress
- **Enhanced critical extraction** - progress indicators, questions, user preferences
- **Multi-pass summarization** - 3-pass compression with quality scoring
- **Token estimation cache** - LRU cache for 3x faster performance
- **100% test pass rate** - 43 unit tests + 17 performance benchmarks

### v0.5.0 - Audit & Stability Release

This release fixes 18 issues found via comprehensive 5-agent audit:

- **3 Critical regex bugs fixed** - `\b` word boundaries on all patterns, no more false matches
- **Startup model detection fixed** - correct threshold from boot
- **Custom thresholds preserved** - across model switches
- **Null safety** - guards on all message-consuming methods
- **53-test Jest suite** - comprehensive coverage
- **Dead code removed** - 329-line `.disabled` file deleted, unused `typebox` dep removed

## Troubleshooting

### Extension not loading

- Restart Pi after installation
- Check `pi install npm:pi-ultra-compact` completed successfully

### Wrong threshold detected

- The extension reads Pi's active model metadata at session start and model switch time
- Ensure Pi reports a `contextWindow` for your selected model
- If Pi does not expose model metadata, the extension falls back to 128K tokens

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'feat: add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Acknowledgments

- [Pi](https://pi.dev/) - The AI coding agent

