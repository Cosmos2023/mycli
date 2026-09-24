# Compaction Trigger Scope

Reference: `codex-rs/core/src/session/context_window.rs` (`ContextWindowTokenStatus`,
`AutoCompactTokenLimitScope::Total` / `BodyAfterPrefix`), the `model_auto_compact_token_limit_scope`
config key in `codex-rs/core/config.schema.json`, and `codex-rs/core/src/session/mod.rs`
(`auto_compact_window_snapshot` prefill baseline), inspected on 2026-09-21.

## Problem

mycli compared one token count against one ceiling: `usedTokens` (base context plus conversation)
against the compaction threshold. The base context - system prompt plus tool schemas, about 9.4k
tokens - can never be summarized away, because compaction only rewrites conversation history. A
window small enough to derive a threshold below that floor therefore compacted on every turn and
still stayed over budget, and each rewrite invalidated the whole prompt prefix cache.

The shipped math made that reachable rather than theoretical. Without an explicit
`context.compaction_token_limit`, the threshold is `min(max_prompt_tokens * 0.9,
max_prompt_tokens - 13000)`:

| `max_prompt_tokens` | derived threshold | base context share |
| --- | --- | --- |
| 272000 (this machine's config) | 244800 | 4% |
| 16000 | 3000 | 310% |
| 12000 (fallback when a model declares no window) | 9600 | 98% |

Any window below about 22.4k put the trigger underneath the base context.

## Codex behavior

- `model_auto_compact_token_limit_scope` selects what the auto-compact limit counts. `Total` uses
  the full active context; `BodyAfterPrefix` subtracts the compaction window's prefill baseline,
  which is exactly the base instructions plus tool schemas sent before the conversation.
- The model's full context window stays a hard cap under both scopes: `full_context_window_limit_reached`
  forces compaction once `active_context_tokens` reaches the window, independently of the
  auto-compact scope.
- Codex also adds a fallback prompt buffer to the scope limit when a fallback prompt exists.

## mycli implementation

- `core/src/policy/compaction-policy.ts` gains `CompactionLimitScope` (`total` |
  `body_after_prefix`) plus `baseContextTokens` and `hardLimitTokens` inputs. The scope chooses which
  token count faces the trigger; `hardLimitTokens` is an independent ceiling on the full context.
- `CompactionCoordinator` exposes `limitScope` and `hardLimitTokens`, validates them, and passes the
  carried prefix it already counts (`baseTokens`) into the decision.
- `node-backend.ts` passes the resolved scope and `maxPromptTokens` as the hard limit, so the model
  window still forces compaction even when the scope ignores the prefix.
- The new `context.compaction_limit_scope` setting defaults to `body_after_prefix` and accepts
  `total` for the previous accounting. It is writable through `mycli config`, appears in the
  configuration reference, and is parsed from `compaction_limit_scope` or
  `MYCLI_COMPACTION_LIMIT_SCOPE`.

## Verification

- `backend/packages/core/test/policy/compaction-policy.test.ts` covers the prefix scope, the hard
  limit, and rejection of an unknown scope or a prefix larger than the context.
- `backend/packages/runtime/test/context/compaction-coordinator.test.ts` drives one coordinator
  budget through three attempts: `total` compacts, `body_after_prefix` keeps, and the same prefix
  scope compacts once the hard limit is reached.
- `backend/packages/config/test/configuration/settings.test.ts` covers the default, the canonical
  `[context]` key, the environment override, and the rejection of an unsupported value.
- `npm run config:generate` refreshed the three generated reference files.
- The previous session's harness workarounds are reverted: the five scripted
  `node-backend.integration.test.ts` flows, `mcp-elicitation.integration.test.ts`, and the app-server
  service fixture no longer raise `MYCLI_MAX_PROMPT_TOKENS` / `MYCLI_COMPACTION_TOKEN_LIMIT`, and
  those suites pass with the shipped defaults (64/64, 1/1, and 3/3).

## Notes

Codex's own default for `model_auto_compact_token_limit_scope` could not be confirmed from the local
source snapshot, because the enum lives in the protocol crate that the snapshot does not vendor and
the network fetch failed. mycli defaults to `body_after_prefix` deliberately: the base context is
large and not compressible, and the hard limit plus the `context_overflow` path still protect the
request ceiling.

The M5 recovery test keeps its raised `MYCLI_MAX_PROMPT_TOKENS`. That budget is unrelated to the
trigger scope: at 16000 the summarizer request was squeezed below its 4096-token output floor.

## Deferred

`context.compaction_token_limit` remains an absolute ceiling rather than a window-relative one, and
the scope is global rather than per model. `context.compaction_l4_trigger_ratios_by_model` remains
the only per-model knob.
