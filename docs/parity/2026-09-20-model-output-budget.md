# Central Model-Output Budget For Tool Results

Reference: `codex-rs/core/src/context_manager/history.rs` (`record_items_with_metadata`),
`codex-rs/core/src/tools/registry.rs` (`AnyToolResult::into_response`),
`codex-rs/utils/output-truncation/src/lib.rs` and `codex-rs/utils/string/src/truncate.rs`
(the last two fetched from `openai/codex` `main`, because the local snapshot only ships
`utils/pty`), inspected on 2026-09-20.

## Problem

mycli already bounded tool output, but not centrally: the storage layer *rejects* a canonical tool
result above `TOOL_RESULT_OUTPUT_MAX_CHARS` (8,000) with
`StorageFailure("tool result exceeds output limit")`. Every tool therefore has to police itself
(Read budgets 8,000 characters, Shell caps at 2,000 tokens, web_fetch subtracts its envelope,
MCP's adapter bounds text at 4,000). Any path that forgets — a plugin tool, an MCP resource, a
future tool — fails the whole turn instead of degrading.

## Codex behavior

- Every `FunctionCallOutput` / `CustomToolCallOutput` is truncated when it is recorded into history
  (`truncate_function_output_payload`) using `metadata.history_truncation_token_limit` or the
  `with_serialization_allowance(model truncation policy)` fallback.
- Text is middle-truncated (head and tail, UTF-8 safe) with an inline `…N tokens truncated…`
  marker; the exec path additionally prepends
  `Warning: truncated output (original token count: N)\nTotal output lines: M`.
- Structured content items are truncated item by item: text blocks consume the budget, images,
  audio (by estimator) and encrypted content are preserved, and omitted blocks are reported.
- Tools may override the budget through `ToolOutput::fallback_token_limit_override()`; currently
  only MCP does, using the server-configured `output_token_limit`.

## mycli implementation

`@mycli/runtime` gains `src/tools/model-output-budget.ts`:

- `boundModelOutput(text, maxChars = TOOL_RESULT_OUTPUT_MAX_CHARS)` keeps the head and tail, drops
  the middle, and reports `…N chars truncated…` behind a
  `Warning: truncated output (original token count: N)` / `Total output lines: M` header. The
  returned text never exceeds the budget and never splits a surrogate pair.
- `canonicalToolResult(result)` applies that bound to the single projection point where a tool
  execution becomes a canonical conversation item (`ToolBatchCoordinator.#persistToolResult`).
  Images and tool discoveries pass through untouched.
- The budget is configurable: `context.compression_threshold_tokens` (previously documented as
  "compressed before replay" but never read) now resolves to the character budget at four bytes per
  token, clamped to `[256, TOOL_RESULT_OUTPUT_MAX_CHARS]`. The 8,000-token default still resolves to
  the storage ceiling, so the shipped default behaviour is unchanged.
- The budget is the model-visible string itself, so Codex's 1.2 serialization allowance does not
  apply: the hard invariant is `output.length <= TOOL_RESULT_OUTPUT_MAX_CHARS`.

Oversized output now degrades to a truncated, self-describing result instead of failing the turn.
Existing tools are unaffected because they already produce less than the budget.

## Verification

- `backend/packages/runtime/test/tools/model-output-budget.test.ts` covers pass-through, head/tail
  retention with counters, surrogate-pair safety across budgets, a header-larger-than-budget case,
  both canonical projections (bounded with media kept, ordinary untouched), and the token-to-character
  budget mapping.
- `backend/packages/runtime/test/turns/node-turn-runtime.test.ts` runs a turn with
  `compression_threshold_tokens = 100` and asserts the recorded tool result stays within 400
  characters with the truncation header.
- Full unit suite: 375 files pass, i.e. no existing tool or transcript fixture changed.

## Deferred

- Per-tool budget overrides (a tool that needs a different ceiling than the session setting).
- Subagent reports, stderr separation, and spill files for omitted output.
