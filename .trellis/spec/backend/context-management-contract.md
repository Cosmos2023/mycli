# Context Management Contract

## Scenario: Provider-Free Context Assembly And Diagnostics

### 1. Scope / Trigger

- Trigger: changes to project context file loading, `TurnContextSection`
  metadata, memory/session summary rendering, compaction summary persistence, or
  context diagnostics.
- The flow crosses services, application runtime, request-shape diagnostics,
  trace, doctor, and provider-facing prompt assembly.

### 2. Signatures

- Loader:
  `ContextFileLoader.load(workspace_root: Path, cwd: Path | None = None) -> LoadedContextFile`
- Result:
  `LoadedContextFile(content: str, diagnostics: ContextFileDiagnostics)`
- Section:
  `TurnContextSection(..., cache_class: TurnContextCacheClass)`
- Runtime context:
  `ExecutionContext.context_file_content: str`
  `ExecutionContext.context_file_diagnostics: dict[str, object]`
- Trace kinds:
  `context_diagnostics`
  `context_summary_persistence`
  `request_shape`
  `cache_shape_diagnostic`
- Smoke:
  `uv run python evaluation/context_smoke.py`

### 3. Contracts

- Context file priority:
  1. `.mycli.md` or `MYCLI.md`, searched upward from cwd to git/workspace root.
  2. `AGENTS.md` or `agents.md`, cwd first, then workspace root.
  3. `CLAUDE.md` or `claude.md`, cwd first, then workspace root.
  4. `.cursorrules`, cwd first, then workspace root.
- Loader is read-only and provider-free. It must not create config, memory,
  trace, session, or context files.
- Loader diagnostics include selected source, selected path presence, search
  roots, truncation, original/rendered lengths, blocked status, and issue codes.
- Blocked context file content is replaced with a bounded diagnostic placeholder;
  raw blocked content must not be injected.
- Cache classes are:
  - `static`: stable prefix-like guidance and tool/skill catalogs.
  - `dynamic`: conversation, memory, plan, environment, and compaction context.
  - `ephemeral`: current user request and runtime reminders.
- Workspace context, memory, session summaries, and compaction rehydration must be
  rendered inside explicit reference fences that say the content is not the
  current user request/new user input.
- Request fragments must preserve cache class/source metadata so cache and trace
  policy does not infer behavior from section names.
- Provider-visible request shape order is stable prefix first, dynamic replay
  second, ephemeral runtime/hook/plugin context third, and current user input
  last. Dynamic replay fragments should use `replay:*` identifiers; ephemeral
  context fragments should use `volatile:*` identifiers; the newest user input
  should remain `intent:current` and be the final model-visible user intent when
  it is not already present in replay.
- `RequestShape.summary()` must include:
  - `section_boundaries`
  - `cacheable_prefix_fragment_ids`
  - `cacheable_prefix_hash`
  - `estimated_cacheable_prefix_chars`
  - `provider_projection`
  - `compact_policy`
- Provider projection diagnostics must distinguish the protocol lane without
  mutating canonical timeline content:
  - Responses: `lane=responses`, optional future `prompt_cache_key` as
    wire-only hint.
  - Chat Completions: `lane=chat_completions`, stable transcript prefix.
  - Anthropic Messages: `lane=anthropic_messages`, optional future
    `cache_control` as wire-only hint.
- Compact policy diagnostics must state that all providers use the canonical
  compact engine by default. Cheap pruning may only target dynamic replay and
  must not alter the stable prefix hash.
- Cache-shape diagnostics must include `first_changed_cache_class`,
  section-boundary metadata, provider projection metadata, compact policy
  metadata, and bounded provider cache usage when available.
- Doctor context diagnostics must report bounded row counts for request-shape
  and cache-shape traces in addition to context trace rows.
- Doctor must warn on anomalous stable prefix changes, using bounded counts such
  as `stable_prefix_changes=<n>` rather than raw fragment text or hashes.
- Context diagnostics trace payloads are bounded counts, hashes, lengths, and
  status flags only. They must not include raw context file content, raw memory,
  user text, tool output, headers, or secrets.

### 4. Validation & Error Matrix

- No context file -> loader returns empty content and diagnostics with
  `selected_source=None`.
- Long context file -> head/tail truncation with a clear marker and
  `truncated=True`.
- Obvious instruction-hijack phrase or invisible control character -> blocked
  placeholder, `blocked=True`, issue code populated.
- Context file read/decode issue -> bounded issue code, no raw file content.
- Memory/session summary value already present in replay -> omit from fenced
  memory section to avoid repeated provider-visible context.
- Repeated compaction summary persistence -> skip duplicates by content hash and
  report skipped count in `context_summary_persistence`.
- Doctor with no traces -> context check still reports loader and session summary
  state without creating traces.
- Doctor with context traces -> report counts and token maxima only.
- Changing only the current user request or runtime reminders must leave
  `cacheable_prefix_hash` unchanged and report the first changed cache class as
  `ephemeral`.
- Changing workspace instructions or deterministic tool schema should change the
  stable prefix hash.
- A cache-shape diagnostic with `first_changed_cache_class=static` -> doctor
  context warning with a bounded stable-prefix-change count.
- Compaction rehydration must be dynamic and placed before ephemeral runtime
  context and current user intent.
- Runtime reminders, hook context, and plugin context should be placed before
  the current user input so the newest user request remains the final
  model-visible instruction.
- Anthropic `cache_control` and OpenAI `prompt_cache_key` must not be persisted
  into canonical messages or request fragments; they are provider wire/request
  hints only.

### 5. Good/Base/Bad Cases

- Good: `.mycli.md` at workspace root is fenced as `workspace-context` with
  `cache_class=static`, and request fragment metadata preserves the same class.
- Base: a fresh workspace without context files has no workspace context section
  and no failure.
- Bad: injecting `Ignore previous instructions...` raw from a project file.
- Bad: rendering session summaries as ordinary current user text.
- Bad: doctor printing project context text, memory values, or trace payloads.

### 6. Tests Required

- Loader tests for priority, upward/root fallback, truncation, and blocking.
- Assembler tests for cache classes and reference fences.
- Instruction contract/request-shape tests for metadata preservation.
- Request-shape tests for provider projection lanes and canonical compact policy
  summary.
- Cache-shape diagnostic tests for first changed cache class, section
  boundaries, provider projection metadata, and compact policy metadata.
- Runtime/trace tests for context diagnostics and summary persistence when
  compaction summaries are produced.
- Doctor tests for bounded context diagnostics and raw-content redaction.
- Provider-free `evaluation/context_smoke.py`, including stable prefix hash
  stability when only ephemeral/current intent changes.

### 7. Wrong vs Correct

#### Wrong

```python
workspace_instructions = (workspace / "AGENTS.md").read_text()
section = TurnContextSection(..., content=workspace_instructions)
```

#### Correct

```python
loaded = ContextFileLoader().load(workspace_root=workspace, cwd=cwd)
section = TurnContextSection(
    ...,
    content=fence_reference_context(loaded.content),
    metadata={"context_file": loaded.diagnostics.to_dict()},
    cache_class=TurnContextCacheClass.STATIC,
)
```

## Scenario: Provider Wire Cache Policy Projection

### 1. Scope / Trigger

- Trigger: changes to request-shape provider policy, OpenAI Responses payload
  construction, OpenAI-compatible Chat Completions payload construction,
  Anthropic Messages serialization, cache-shape diagnostics, or doctor context
  diagnostics.
- The flow crosses canonical request shape, runtime item/message formatting,
  provider adapters, clients, trace, doctor, and smoke evaluations.

### 2. Signatures

- Domain policy:
  `ProviderRequestPolicyShape.for_request_shape(...) -> ProviderRequestPolicyShape`
- Request shape:
  `RequestShape.provider_request_policy: ProviderRequestPolicyShape | None`
- Runtime item:
  `RuntimeItem.metadata: dict[str, object]`
- Responses request builder:
  `ResponsesRequestBuilder.build(..., prompt_cache_key: str | None = None)`
- Responses client/adapter:
  `create_response(..., prompt_cache_key: str | None = None)`
  and `stream_response(..., prompt_cache_key: str | None = None)`
- Anthropic adapter:
  `_serialize_items(...) -> tuple[str | list[dict[str, object]] | None, list[dict[str, object]]]`

### 3. Contracts

- Provider request policy is derived from provider, protocol, model,
  `system_hash`, `tool_schema_hash`, and `cacheable_prefix_hash`.
- Provider cache hint capability is resolved before request-shape construction
  in this order:
  1. explicit `AgentConfig.cache_policy_capability` override,
  2. `ProviderProfile.cache_policy_capability` default,
  3. conservative fallback with both hints disabled.
- Built-in provider defaults are safe by lane:
  - OpenAI Responses / OpenAI Chat: `prompt_cache_key` enabled,
    `cache_control` disabled.
  - Anthropic Messages: `cache_control` enabled, `prompt_cache_key` disabled.
  - DeepSeek / unsupported compatible lanes: both disabled with
    `wire_hints_supported=false` unless a profile explicitly advertises support.
  - Compatible OpenAI-style endpoints may disable `prompt_cache_key` through
    config/profile when the upstream endpoint rejects the field.
- Normal `RequestPipeline` request assembly must pass the resolved capability to
  `RequestShapeBuilder`; the builder-level explicit argument remains available
  for focused tests and low-level call sites.
- OpenAI Responses and OpenAI-compatible Chat Completions use
  `prompt_cache_key` only as a request-level wire option.
- Anthropic Messages uses `cache_control: {"type": "ephemeral"}` only on
  serialized payload content-block copies.
- Provider cache hints must not be written into canonical conversation messages,
  request fragments, persisted transcripts, or runtime history.
- `RequestShape.summary()` may expose bounded policy diagnostics, including
  key hash, preview, hint enabled state, and breakpoint counts. It must not
  expose the full `prompt_cache_key`.
- Full `prompt_cache_key` may exist only in runtime/provider metadata used by
  provider clients during request construction.
- Chat Completions message projection must strip provider-private fields such as
  `metadata`, `cache_control`, `anthropic`, `responses`, and underscore-prefixed
  keys before sending.
- Cache-shape diagnostics and doctor summaries must use bounded counts, hashes,
  and previews only.
- Cache-shape diagnostics must normalize fake/local usage payloads from
  Responses, Chat, and Anthropic-style providers into bounded fields:
  `provider_cached_tokens`, `provider_cache_usage.cached_tokens`,
  `provider_cache_usage.cache_write_tokens`, and
  `provider_cache_usage.telemetry_status`.
- Doctor cache policy validation must distinguish
  `enabled_and_emitted`, `disabled_by_policy`, `enabled_but_missing`, and
  `unsupported`. `disabled_by_policy` is informational; `enabled_but_missing`
  should produce bounded remediation.
- P3 cache observability adds a provider-free diagnostics loop:
  - `ProviderCachePolicyCapability` gates request-level `prompt_cache_key` and
    Anthropic `cache_control` independently. Default capability preserves safe
    P2 behavior; compatible or legacy provider paths may disable unsupported
    hints without changing canonical fragments.
  - `ProviderPayloadSnapshot` summarizes provider lane, message/runtime item
    counts, request-option hint presence, sanitized provider-private field
    counts, Anthropic cache-control block counts, and bounded prompt-cache-key
    hash/preview. It must not include raw user text, raw tool output, secrets, or
    the full `prompt_cache_key`.
  - `ProviderRequestDryRun` compares two request shapes without calling a model
    provider. It reports cache-boundary hash stability, prompt-cache-key hash
    stability, first changed cache class, and redacted per-turn snapshots.
  - `ProviderRequestDryRunRenderer` exposes a reusable provider-free local
    diagnostic surface with provider lane, boundary hash stability,
    prompt-cache-key hash stability, first changed cache class, wire hint state,
    and snapshot counts. It must not include raw prompts, raw tool output,
    provider wire payload bodies, secrets, or the full `prompt_cache_key`.
  - Doctor context diagnostics must summarize first-changed-cache-class
    distributions, stable/dynamic/ephemeral change counts, enabled/disabled/
    missing wire-hint counts, max/latest provider cached tokens, and bounded
    remediation text.
- Wire-only hints remain outside the canonical timeline. It is valid for
  summaries to name a wire-only hint such as `cache_control`, but raw canonical
  fragments, persisted messages, and runtime blocks must not contain provider
  wire payload fields such as `cache_control` or full prompt-cache keys.

### 4. Validation & Error Matrix

- Ephemeral/current intent changes only -> `prompt_cache_key` remains stable.
- Stable system, tool schema, or stable prefix changes -> `prompt_cache_key`
  changes.
- Client does not accept `prompt_cache_key` -> adapter must omit the argument
  instead of failing.
- Config/profile disables `prompt_cache_key` -> the request policy reports
  `wire_hint_state=disabled_by_policy`, runtime metadata has no full
  `prompt_cache_key`, and doctor does not fail.
- Policy says a hint should be emitted but provider metadata lacks a hint ->
  doctor reports `enabled_but_missing` with bounded remediation and no raw
  payload.
- Provider/lane is unsupported -> doctor reports `unsupported` as bounded
  policy state rather than printing raw request data.
- Anthropic system has no cache breakpoint -> keep legacy string system payload.
- Anthropic system has cache breakpoint -> serialize system as text blocks with
  block-level `cache_control`.
- Chat message contains provider-private fields -> outgoing provider messages
  exclude those fields.
- Trace payload includes full `prompt_cache_key` -> invalid; only hash/preview
  are allowed.
- Payload snapshot or dry-run summary includes raw user prompt, tool output,
  secret-like values, or full `prompt_cache_key` -> invalid.
- Compatible provider capability disables `prompt_cache_key` -> policy summary
  reports the hint disabled and provider wire metadata omits the full key.

### 5. Good/Base/Bad Cases

- Good: Responses payload has `prompt_cache_key` beside `model`, while input
  items contain no cache hint fields.
- Good: Anthropic payload has `cache_control` on system/static and dynamic
  boundary block copies, while `RequestShape.summary()` has no `cache_control`.
- Base: A legacy/fake Responses client without `prompt_cache_key` support still
  receives normal `input_items` and `tools`.
- Bad: Persisting `cache_control` in `RuntimeBlock.metadata`.
- Bad: Passing Anthropic `cache_control` or `thinking` blocks through Chat
  Completions messages.

### 6. Tests Required

- Unit test provider request policy generation and summary redaction.
- Unit test stable `prompt_cache_key` across ephemeral-only changes.
- Unit test `RuntimeItem.metadata` preservation through request-shape formatter.
- Unit test Responses request builder/client/adapter request-level
  `prompt_cache_key` propagation.
- Unit test Anthropic wire-only `cache_control` and canonical non-mutation.
- Unit test Chat Completions provider-private field stripping.
- Unit test cache-shape diagnostics and doctor bounded cache policy summary.
- Unit test cache stability regressions across static, dynamic, and ephemeral
  request changes.
- Unit test provider payload snapshots and dry-run comparisons are redacted.
- Unit test provider cache policy capability gates.
- Unit test provider profile/config capability resolution and RequestPipeline
  automatic capability injection.
- Unit test redacted dry-run renderer output contract.
- Unit test provider cache usage telemetry normalization and doctor policy
  validation states.
- Provider-free `evaluation/provider_cache_policy_smoke.py` covering all three
  provider lanes plus P4 capability resolution, dry-run comparison, snapshot
  counts, and telemetry normalization fields.

### 7. Wrong vs Correct

#### Wrong

```python
block.metadata["cache_control"] = {"type": "ephemeral"}
trace_payload["provider_request_policy"] = {"prompt_cache_key": full_key}
```

#### Correct

```python
wire_block = {"type": "text", "text": block.text}
wire_block["cache_control"] = {"type": "ephemeral"}
trace_payload["provider_request_policy"] = {
    "prompt_cache_key_hash": stable_hash(full_key),
    "prompt_cache_key_preview": full_key[:48] + "...",
}
```
