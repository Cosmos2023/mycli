# Runtime V2 Cache-First Architecture Design

Date: 2026-04-29

## Summary

Runtime v2 redesigns the agent runtime around stable request shape, provider-neutral replay, retrieval-based memory, and deterministic tool schema assembly. The immediate pressure is DeepSeek cache cost: real logs showed complex and controlled multi-turn sessions at roughly 30-40% cache hit rate, while an AgentScope spike against `deepseek-v4-flash` showed stable-prefix requests can reach roughly 96% prompt cache hit after warmup.

The problem is architectural, not a single DeepSeek provider bug. The current runtime lets dynamic context, tool exposure state, memory summaries, and provider replay details drift into early request positions. Runtime v2 makes cache stability a first-class invariant for all providers, including DeepSeek, Qwen, OpenAI, and Anthropic.

## Evidence

DeepSeek log analysis found these cache killers:

- `messages[1]` is a large dynamic contextual user message and is usually the first changed message between adjacent requests.
- `messages[0]` changes when `Direct tools` and `Deferred tools` change, which breaks the cache from the system prompt.
- Tool schema order changes when direct/deferred membership changes, even when the tool set is the same.
- Session memory injects recent assistant summaries that duplicate conversation context.
- Tool evidence appears both in contextual summaries and transcript replay.
- Provider reasoning/thinking replay is mixed too closely with general context and memory concerns.

AgentScope spike:

- Stable prefix second call: prompt `2939`, cache hit `2816`, miss `123`, ratio `0.9581`.
- Dynamic context before stable content second call: prompt `3190`, cache hit `1152`, miss `2038`, ratio `0.3611`.
- Reversing tool schema order on the same messages dropped ratio from about `0.9598` to `0.3926`.

This confirms that SDK choice is less important than request shape. AgentScope's useful lesson is boundary design: model, formatter, and message blocks are separated. Runtime v2 should adopt the boundary idea without requiring a wholesale SDK replacement.

## Goals

- Keep stable system content unchanged within a session.
- Keep tool schema order and tool schema hash stable unless the actual tool catalog changes.
- Move volatile runtime context after stable request prefix.
- Make memory retrieval-based, budgeted, and deduplicated.
- Keep tool evidence in a single authoritative channel.
- Keep provider reasoning/thinking replay out of memory and contextual summaries.
- Make provider adapters protocol translators, not prompt designers.
- Add diagnostics that explain which request fragment breaks cache reuse.
- Preserve tool correctness, approval behavior, and provider replay requirements across DeepSeek, Qwen, OpenAI, and Anthropic.

## Non-Goals

- Do not replace all runtime code with AgentScope.
- Do not make DeepSeek-only hacks the default architecture.
- Do not rely on prompt text alone for safety or tool permission enforcement.
- Do not promise 99% hit rate for every task. The goal is stable prefix behavior and measurable improvement; user requests, tool results, and new evidence still create legitimate cache misses.

## Architecture

Runtime v2 splits the current runtime into explicit layers:

1. `TurnRuntime`
   - Owns the turn loop, tool execution, approvals, suspension/resume, and activity events.
   - Does not construct provider payloads directly.

2. `RequestShapeBuilder`
   - Converts runtime state into provider-neutral request shape.
   - Applies cache policy, context ordering, memory selection, and tool catalog references.

3. `ToolCatalog` and `ToolPolicy`
   - `ToolCatalog` is the stable model-visible schema set.
   - `ToolPolicy` is the current runtime permission, approval, deny, and recommendation layer.
   - Direct/deferred status must not reorder model-visible schemas.

4. `MemoryRetriever`
   - Selects relevant memory records by current intent.
   - Deduplicates against transcript and summaries.
   - Enforces budget and excludes reasoning/thinking.

5. `ProviderFormatter`
   - Converts `RequestShape` to provider payloads.
   - Handles provider-specific replay metadata such as DeepSeek `reasoning_content`, Anthropic thinking, and Responses API items.

6. `CacheShapeDiagnostics`
   - Records shape hashes, fragment sizes, first-diff index, and provider usage cache hit/miss data.

## Request Shape

Runtime v2 uses a provider-neutral request shape:

```text
Stable System
Stable Tool Schema
Provider Replay Transcript
Current User Intent
Volatile Runtime Context
```

### Stable System

Stable system contains long-lived operating rules only:

- role and safety baseline
- tool-use contract at a stable abstraction level
- provider-neutral behavior rules
- workspace instructions only when they are stable baseline fragments

It must not include:

- direct/deferred tool lists
- runtime policy state
- current user request
- session id
- model name
- protocol
- recent conversation
- memory records
- tool evidence

### Stable Tool Schema

Tool schema is serialized from `ToolCatalog` in a deterministic order. Recommended order is static registry order with a persisted catalog version hash. If registry order is not stable enough, sort by route key.

Dynamic tools are appended after static tools using a stable route key. A dynamic tool lifecycle change may legitimately change tool schema hash, but volatile direct/deferred changes must not.

### Provider Replay Transcript

Replay transcript is the authoritative history channel for provider-required state:

- user messages
- assistant text that must be replayed
- assistant tool calls
- tool results paired by call id
- provider reasoning metadata required for valid replay

Replay transcript should not carry extra contextual summaries that duplicate later volatile context.

### Current User Intent

The current user request is represented once. Runtime v2 must avoid duplicating it in both contextual fragments and the actual user message.

### Volatile Runtime Context

Volatile context comes last and stays short. It can include:

- compact runtime reminders
- active plan status
- selected memory snippets
- evidence index summaries
- tool policy notes

It must not include full tool evidence already present in transcript.

## Typed Fragments

`RequestShapeBuilder` works with typed fragments rather than raw concatenated strings:

- `StableFragment`: stable system or baseline content.
- `ReplayFragment`: provider-required transcript and metadata.
- `IntentFragment`: current request.
- `VolatileFragment`: short runtime policy, plan, or reminder content.
- `RetrievedMemoryFragment`: selected memory only.
- `EvidenceIndexFragment`: compact tool result index.
- `ToolPolicyFragment`: current allowed/denied/recommended tool policy, rendered late.

Each fragment carries:

- `id`
- `kind`
- `content`
- `stability`: `stable`, `replay`, or `volatile`
- `dedupe_key`
- `budget_weight`
- `provider_visibility`
- diagnostic hash

## Memory V2

Memory changes from default injection to retrieval-based injection.

Rules:

- Session summaries are stored but not automatically injected.
- Recent assistant responses are not copied back into prompt as memory by default.
- Memory must be selected by relevance to current user intent.
- Memory is deduplicated against replay transcript, conversation summary, and selected volatile fragments.
- Memory has a strict budget.
- Reasoning/thinking blocks are never stored in memory.
- Tool evidence is not stored as memory unless explicitly distilled into a stable fact.

Memory output should be short facts, not long previous answers.

## Tool System V2

Runtime v2 separates catalog, policy, and execution.

### ToolCatalog

ToolCatalog owns stable tool definitions:

- name
- description
- parameter schema
- route key
- source
- catalog version hash

It produces model-visible schema in deterministic order.

### ToolPolicy

ToolPolicy owns current decision state:

- allowed tools
- denied tools
- tools requiring approval
- recommended tools
- user-forbidden tools
- risk-derived constraints

Policy is enforced at execution time. It may be summarized in volatile context, but it must not reorder schema.

Negated instructions must be parsed conservatively. For example, "do not call git_diff or run_shell" must mark those tools denied or discouraged, not promote them because the words `git` or `shell` appeared.

### ToolExecutor

ToolExecutor validates every model tool call against `ToolPolicy` before execution. Prompt guidance is advisory; execution policy is authoritative.

## Reasoning and Thinking Replay

Provider thinking belongs to replay metadata only.

Rules:

- DeepSeek `reasoning_content` is preserved on assistant replay messages when required.
- Anthropic thinking blocks are preserved through provider formatter replay.
- OpenAI/Qwen Responses items are normalized into replay blocks.
- Thinking content is not written to memory.
- Thinking content is not rendered into volatile context.
- Thinking content is not summarized into conversation summaries.

Provider adapters declare their replay requirements so the runtime does not guess.

## Provider Formatter Boundary

Provider formatters accept `RequestShape` and return provider payloads:

- Chat Completions payload for DeepSeek and compatible providers.
- Responses payload for OpenAI/Qwen-compatible Responses providers.
- Anthropic Messages payload for Anthropic.

Formatters may adapt roles, merge system messages when required by provider protocol, and encode replay metadata. They must not decide memory selection, tool policy, or context ordering.

## Cache Policy

All providers use a cache-first default policy. Providers can override details:

- DeepSeek: strict stable system, strict stable tools, reasoning replay metadata, aggressive volatile compaction.
- Qwen Responses: stable instructions and tools, Responses item replay, no DeepSeek-specific reasoning fields.
- OpenAI Responses: stable instructions and tools, Responses item replay, provider-native tool item handling.
- Anthropic: stable system/messages split, thinking replay according to Anthropic protocol.

Policy knobs:

- `stable_system_required`
- `stable_tool_schema_required`
- `volatile_context_position`
- `memory_injection_mode`
- `tool_policy_render_mode`
- `reasoning_replay_mode`
- `max_volatile_chars`
- `diagnostics_enabled`

## Diagnostics

Every model request should emit a shape diagnostic event:

- provider
- protocol
- model
- system hash
- tool schema hash
- tool order hash
- replay hash
- intent hash
- volatile hash
- per-fragment character lengths
- per-message character lengths
- first changed fragment compared with previous request
- first changed provider message index compared with previous request
- prompt tokens
- cache hit tokens
- cache miss tokens
- cache hit ratio

Diagnostics must redact secrets and must not log API keys.

## Migration Plan

1. Add request shape domain types and diagnostics without changing behavior.
2. Recreate current prompt output through `RequestShapeBuilder` and lock it with snapshot-style unit tests.
3. Introduce `ToolCatalog`, `ToolPolicy`, and stable schema serialization.
4. Move provider payload construction behind formatter boundaries.
5. Replace automatic memory injection with retrieval, budget, and dedupe.
6. Move tool evidence duplication into single-channel replay plus compact evidence index.
7. Enable cache-first ordering for all providers.
8. Run provider-specific regression tests and real DeepSeek smoke tests.

## Testing

Unit tests:

- system content stays stable across turns when only tool policy changes.
- tool schema order stays stable when direct/deferred changes.
- negated tool instructions do not promote forbidden tools.
- memory retrieval excludes duplicated recent assistant content.
- reasoning/thinking does not enter memory or volatile context.
- evidence index excludes full duplicated evidence when transcript already contains it.
- provider formatters preserve required replay metadata.

Integration tests:

- DeepSeek chat-completions tool call and reasoning replay.
- Qwen Responses multi-turn tool call.
- OpenAI Responses replay and tool result continuation.
- Anthropic thinking/tool replay.
- approval and denied tool execution still work.

Manual smoke:

- DeepSeek complex repository task with follow-up no-tool questions.
- Compare cache hit ratio against current 30-40% baseline.
- Confirm system hash and tool schema hash remain stable after warmup.

## Risks

- Aggressive memory reduction may make some follow-up answers less context-rich. Mitigation: retrieval by current intent and explicit transcript replay.
- Provider replay requirements differ and can regress if hidden in formatter details. Mitigation: provider-specific replay tests.
- Stable tool schema may expose tools that current policy will deny at execution. Mitigation: clear execution error and late volatile policy note.
- Cache hit rate remains workload-dependent. New evidence and tool results will still create misses; diagnostics will identify legitimate misses.

## Acceptance Criteria

- Runtime v2 design boundaries are implemented without provider-specific prompt hacks in `agent_runtime`.
- DeepSeek multi-turn requests keep stable system hash across a session.
- Tool schema order hash remains stable unless the actual catalog changes.
- Direct/deferred policy changes do not change model-visible tool schema order.
- Dynamic tool lifecycle changes are deterministic and diagnosable.
- Memory injection is retrieval-based and deduplicated.
- Tool evidence is not duplicated between contextual user blocks and transcript replay.
- Provider reasoning/thinking replay remains correct and excluded from memory/context summaries.
- Cache diagnostics identify the first fragment responsible for request drift.
- DeepSeek real smoke shows a substantial cache hit improvement from the current 30-40% complex-task baseline.
