# Codex-Style Compact Slimming Design

## Summary

Replace mycli's layered L1-L4 compaction path with one explicit history-replacement
boundary modeled on Codex. Compaction produces a small canonical window instead of
carrying rewritten copies of old messages, tool outputs, files, skills, and runtime
context forward.

The replacement window contains a compact summary of older history plus the two most
recent completed user/assistant turns. Canonical instructions and current environment
state are rebuilt from their authoritative sources for the next request.

## Goals

- Make compaction a deterministic replacement operation with a traceable reason.
- Keep model-visible history small after every compaction.
- Preserve recent conversational continuity without retaining tool execution noise.
- Use provider token usage as the primary trigger signal and estimates as fallback.
- Keep tool call/result pairs and interrupted turns out of malformed partial history.
- Support Chat Completions, Responses, Anthropic, and future native compact endpoints.

## Non-Goals

- Rewriting the full durable transcript shown by `/resume`.
- Persisting file contents or complete skill bodies inside compact summaries.
- Preserving old reasoning, approval prompts, tool progress, or tool outputs.
- Making provider-specific summaries produce different canonical history semantics.

## Trigger Model

Every compaction records a reason and phase.

Reasons:

- `context_limit`: the active window reaches the model's configured compact limit.
- `model_downshift`: the selected model has a smaller context window than the previous model.
- `compatibility_changed`: the provider, protocol, or compact compatibility hash changes.
- `mid_turn_limit`: completed tool output makes the next model request exceed the limit.
- `user_requested`: `/compact` explicitly requests replacement.

Phases:

- `pre_turn`: before sampling a new user turn.
- `mid_turn`: between completed tool execution and the next model request.
- `standalone`: a manual compact operation.

The primary measurement is the latest provider-reported input-token usage for the active
window. A complete request estimate is used when provider usage is unavailable or when new
tool output has not yet been sampled. Limits are model-specific absolute token counts with
a reserved output buffer; ratio configuration remains a compatibility input during migration.

Compaction never runs while an approval, clarification, unresolved tool call, or interrupted
turn is pending. Mid-turn compaction occurs only after all tool results in the current batch
are complete.

## Replacement History

The canonical replacement is ordered as follows:

1. One user-role compact summary covering history older than the exact tail.
2. The two most recent completed user/assistant turns in chronological order.

The exact tail includes the real user message and only the final assistant reply for each
turn. It excludes reasoning, tool-preface text, tool calls, tool results, approvals,
clarifications, warnings, partial streamed output, and interrupted replies. A dedicated tail
token budget removes the oldest retained turn first if two turns do not fit.

The compact summary is generated from only the history being removed. It must not receive
the current initial-context fragments, the exact tail, tool schemas, runtime reminders,
memory injection, or rehydrated files and skills. This prevents duplicated context and keeps
the summary scope equal to the replacement scope.

After installation, base instructions, workspace instructions, permissions, environment,
current model settings, tool exposure, and invoked-skill state are regenerated normally from
authoritative runtime state. They are not copied from pre-compaction provider messages.

## Provider Paths

Providers with a native compact endpoint may produce replacement history directly. mycli
normalizes that result into the same canonical shape and drops stale developer/context
messages returned by the provider.

Providers without native compaction use a local compact turn with tools disabled, thinking
disabled, a bounded output budget, and the configured summarizer model. The result is treated
as untrusted text: it receives a compact marker and provenance metadata but cannot introduce
tool calls or mutate runtime state.

If summarization fails, the existing history remains active. Context overflow retry may then
drop the oldest complete turn pair and retry compaction; it never installs a partial summary.

## Persistence And Replay

Durable transcript and rollout events remain append-only. Installing compaction writes a
checkpoint containing the input-history hash, replacement history, reason, phase, window
number, and window ID. Runtime replay installs the latest valid checkpoint and then applies
subsequent events.

The summary is stored once as part of replacement history. It is not copied into a separate
memory lane and is not injected again as `conversation_context`. `/resume` continues to show
the original transcript, while provider replay uses the compacted active window.

## Removal Of Legacy Weight

The active path removes or bypasses:

- the outer L4 gate around tool-output pruning;
- the second full-request snapshot summarization path;
- the assistant-role continuation marker;
- persisted duplicate `session_summaries` injection;
- automatic file-content and full skill-body rehydration after compact;
- the unused `ContextManager.build()` recent-message summary path.

Small bounded tool-output truncation remains an ingestion concern, not a compaction level.

## Observability

Each attempt records reason, phase, trigger tokens, limit tokens, input-history hash,
replacement-history hash, removed item count, retained tail turns, before/after tokens,
summary tokens, provider path, status, and failure kind.

The TUI presents one compact lifecycle item. It does not render the summary as a new assistant
answer or expand removed tool output.

## Testing

- Trigger tests cover every reason and distinguish pre-turn from mid-turn behavior.
- Replacement tests verify summary scope, two-turn exact tail, token-bound tail eviction, and
  exclusion of tool/reasoning/interrupted content.
- Replay tests verify checkpoint installation, resume, fork, rollback, and post-compact append.
- Provider tests verify local and native compact results normalize to one history shape.
- Regression tests verify static context, files, skills, and summaries are not duplicated.
- Failure tests verify no partial replacement is installed after timeout, interruption, malformed
  provider output, or context overflow.

