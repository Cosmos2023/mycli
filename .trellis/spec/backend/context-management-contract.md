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

---

## Scenario: Skill Catalog And Explicit Context Injection

### 1. Scope / Trigger

- Trigger: changes to skill discovery, skill catalog rendering, `Skill` tool
  execution, skill activation diagnostics, or provider-visible tool exposure.
- The flow crosses skill registry, runtime context assembly, tool execution,
  turn ledger/history, trace diagnostics, and provider-facing request shape.

### 2. Signatures

- Stable activation tool: `SkillTool.spec.name == "Skill"`.
- Catalog renderer: `render_skill_catalog(skill_registry: SkillRegistry) -> str`.
- Activation trace: `RuntimeTraceEvent(kind="skill_activation", ...)`.
- Persistent activation snapshot:
  `SessionService.record_invoked_skill_snapshot(session_id, InvokedSkillSnapshot)`.
- Legacy explicit provider: `SkillToolContributionProvider(registry)`.

### 3. Contracts

- Default runtime registers one stable `Skill` tool. Adding/removing unactivated
  skills must not create provider-visible `skill_*` tool schemas.
- `SkillToolContributionProvider` is compatibility-only and must be injected
  explicitly by tests or callers that need legacy per-skill tool exposure.
- `skill_catalog` is static catalog context: it may list skill names and
  descriptions, but must not include full skill bodies.
- Skill bodies enter model-visible context only after an explicit successful
  `Skill` tool call.
- Successful skill activation appends a replayable `skill_instructions` user
  message and a `SKILL_INSTRUCTIONS` turn item with:
  - `cache_class="dynamic"`
  - `durability="persistent"`
  - `scope="transcript"`
  - `model_visible=True`
  - `replayable=True`
- Successful skill activation persists an `InvokedSkillSnapshot` so later
  continuity can survive source-file deletion. This contract records the
  snapshot; it does not modify compact/rehydration implementation.
- `skill_activation` trace rows may contain only bounded metadata:
  `skill_name`, `tool_name`, `tool_call_id`, `description_present`,
  `source_path_present`, `content_chars`, `body_digest`, `replayable`,
  `cache_class`, `durability`, and optional `source_kind`.
- `skill_activation` trace rows must not include raw skill bodies, raw user
  prompts, raw tool output, headers, secrets, or provider payload bodies.

### 4. Validation & Error Matrix

- No skills -> empty catalog and no `skill_catalog` section.
- New unactivated skill -> catalog may change, provider-visible tool schema
  remains stable.
- Explicit `SkillToolContributionProvider` injection -> legacy per-skill
  provider-safe route names continue to work.
- Successful `Skill` call -> dynamic replayable skill instruction and bounded
  `skill_activation` trace.
- Unknown/missing skill -> failed tool result without skill instruction replay
  or activation snapshot.
- Deleted source after activation -> existing persisted skill instruction and
  invoked skill snapshot remain available through existing history/snapshot
  paths.

### 5. Good/Base/Bad Cases

- Good: catalog says `- code-review: Review code`; the body appears only after
  `Skill({"skill_name": "code-review"})` succeeds.
- Base: adding `repo-analysis` changes catalog text but not the provider tool
  list, which still includes `Skill` instead of `skill_repo_analysis`.
- Bad: registering `SkillToolContributionProvider` by default in bootstrap.
- Bad: writing raw skill body into `skill_activation` trace or doctor output.

### 6. Tests Required

- Unit test normal runtime exposes `Skill`, not one provider-visible tool per
  skill.
- Unit test adding an unactivated skill does not change provider-visible skill
  tool schema.
- Unit test explicit legacy `SkillToolContributionProvider` still routes
  provider-safe and dotted legacy names.
- Unit test successful skill activation records replayable transcript,
  `SKILL_INSTRUCTIONS` turn item, invoked skill snapshot, and bounded
  `skill_activation` trace.
- Unit test deleted source still leaves existing cached invoked-skill snapshot
  and history available without editing compact/rehydration implementation.

### 7. Wrong vs Correct

#### Wrong

Expose every discovered skill as a provider-visible tool during normal runtime
startup.

#### Correct

Expose one stable `Skill` tool, render a catalog of names/descriptions, and
inject detailed skill instructions only after explicit activation.
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

## Scenario: Canonical Timeline Persistence Contract

### 1. Scope / Trigger

- Trigger: changes to `CanonicalTimelineItem`, `TurnContextSection`
  durability/scope metadata, instruction contract assembly, request-shape
  fragment metadata, session context baseline persistence, or session resume
  context rehydration.
- The flow crosses domain runtime contracts, context assembly, instruction
  fragments, request shape summaries, runtime ledger persistence, session store,
  and resume-time `ExecutionContext` reconstruction.

### 2. Signatures

- Canonical item:
  `CanonicalTimelineItem(role, kind, content, source, durability, scope,
  cache_class, metadata, provider_state)`
- Section:
  `TurnContextSection(..., cache_class, durability, scope)`
- Fragment metadata fields:
  `durability`, `scope`, `model_visible`, `replayable`,
  `provider_state_keys`
- Baseline persistence:
  `RuntimeEventLedger.context_baseline_from_contract(contract) -> ContextBaseline | None`
- Resume input:
  `ExecutionContext.context_baseline: ContextBaseline | None`

### 3. Contracts

- `CanonicalTimelineDurability` values are:
  - `persistent`: model-visible state that may participate in later request
    assembly or resume reconstruction.
  - `api_only`: transport/cache/debug-only data that must not be projected into
    model-visible instruction fragments.
- `CanonicalTimelineScope` values are:
  - `request`: one provider request only.
  - `turn`: visible only during the current user turn or continuation.
  - `session`: durable session state that may be selected again by runtime
    assembly.
  - `transcript`: durable model-visible replay across later user turns.
- `InstructionContractAssembler` must skip sections with
  `durability=api_only` before creating contextual or developer fragments.
- Fragment metadata must preserve bounded persistence fields:
  `durability`, `scope`, `model_visible`, and `replayable`.
- `RequestShape.fragment_metadata_summary()` may expose bounded persistence
  metadata but must not expose raw model-visible content, full provider wire
  payloads, full `prompt_cache_key`, or raw `provider_state`.
- If an instruction fragment includes `provider_state`, request-shape metadata
  may include only sorted `provider_state_keys`.
- `RuntimeEventLedger.context_baseline_from_contract()` stores only
  model-visible persistent fragments that can be reconstructed later. It must
  not store `conversation_context` or `user_request`, because those are handled
  by structured history items.
- The context baseline must remove wire-only metadata keys before persistence:
  `provider_state`, `prompt_cache_key`, and `cache_control`.
- Resume-time `TurnContextAssembler` may use baseline fragments for sparse
  workspace, environment, memory, and plan context. Baseline memory/plan
  fragments are fallback selected context when no live memory/plan provider data
  is present.
- Current user input remains the final model-visible user intent after
  persistence metadata is added.

### 4. Validation & Error Matrix

- `durability=api_only` section -> no instruction fragment, no request-shape
  fragment, no context baseline fragment.
- `model_visible=false` metadata -> no context baseline fragment.
- `replayable=true` memory or plan fragment -> persisted as a baseline fragment
  and available to resume-time context assembly.
- `conversation_context` or `user_request` fragment marked replayable ->
  excluded from baseline; structured history remains the source of transcript
  replay.
- Baseline metadata contains `provider_state`, `prompt_cache_key`, or
  `cache_control` -> invalid; these keys must be stripped before session state
  persistence.
- Sparse resume with baseline memory/plan and no live memory/plan provider ->
  memory/plan sections are enabled and include the baseline content.
- Empty plan with no baseline -> plan section remains disabled even though the
  renderer fallback text is `Current plan: none`.
- Provider-private state present in fragment metadata -> request-shape summary
  shows `provider_state_keys` only.

### 5. Good/Base/Bad Cases

- Good: selected memory is emitted with
  `durability=persistent`, `scope=transcript`, `replayable=true`, enters the
  context baseline, and rehydrates after session resume.
- Good: a retry notice is represented as `durability=api_only`,
  `scope=request`, and never reaches the model-visible instruction contract.
- Base: a session with no context baseline still assembles normal workspace,
  environment, conversation, memory, plan, and current user sections.
- Bad: persisting a full `prompt_cache_key` in baseline metadata.
- Bad: flattening encrypted reasoning state into fragment content instead of
  keeping provider-private state behind `provider_state`.

### 6. Tests Required

- Unit test `CanonicalTimelineItem` serialization, `is_model_visible`, and
  `is_replayable`.
- Unit test `InstructionContractAssembler` excludes `api_only` sections.
- Unit test request-shape fragments preserve durability/scope/replayable
  metadata and redact raw `provider_state`.
- Unit test current user input remains the final request fragment after
  persistence metadata changes.
- Unit test `RuntimeEventLedger.context_baseline_from_contract()` persists
  replayable memory/plan and skips `api_only`, turn-scoped, conversation, and
  current-user fragments.
- Unit test baseline metadata strips provider-private and wire-only keys.
- Unit test `TurnContextAssembler` rehydrates baseline memory/plan when live
  runtime stores are sparse.
- Provider-free context and cache-policy smokes must continue to pass.

### 7. Wrong vs Correct

#### Wrong

```python
fragment.metadata["provider_state"] = {"codex_reasoning_items": encrypted}
baseline.fragments.append(fragment)
```

#### Correct

```python
request_metadata["provider_state_keys"] = tuple(sorted(provider_state))
baseline_metadata = {
    key: value
    for key, value in fragment.metadata.items()
    if key not in {"provider_state", "prompt_cache_key", "cache_control"}
}
```

## Scenario: Recovery Diagnostics And Provider Replay Recovery

### 1. Scope / Trigger

- Trigger: changes to provider/runtime model error handling, Responses
  continuation replay, recovery retry policy, provider-free dry-run output,
  cache-shape diagnostics, runtime trace rows, or doctor context diagnostics.
- The flow crosses runtime recovery, model adapter continuation state, trace,
  doctor, dry-run rendering, provider-cache smoke, and request-shape redaction.

### 2. Signatures

- Classifier:
  `ErrorClassifier.classify(exc: ModelResponseError) -> ErrorClassification`
- Policy:
  `RecoveryPolicy.decide(classification, deterministic_repair_available=False) -> RecoveryDecision`
- Recovery classes:
  `invalid_encrypted_content`, `context_overflow`, `schema_rejected`,
  `unsupported_payload`, `image_too_large`, `unknown`
- Recovery actions:
  `strip_encrypted_reasoning_retry`, `compact_or_shrink_retry`,
  `sanitize_repair_retry`, `surface_only`
- Trace kind:
  `recovery_diagnostic`
- Dry-run renderer fields:
  `recovery_counts`, `latest_recovery`
- Doctor context detail fields:
  `recovery_rows`, `recovery_retries`, `recovery_error_classes`,
  `recovery_actions`, `latest_recovery`

### 3. Contracts

- Error classification must be centralized in `recovery.py`; runtime tests
  should not assert on scattered string matching in `TurnExecutor`.
- `invalid_encrypted_content` recovery clears Responses continuation state from
  the session and active adapter, retries once, and records a bounded
  `recovery_diagnostic` trace row. It must not flatten encrypted reasoning or
  provider-private state into ordinary prompt text.
- `context_overflow` maps to the existing compact/shrink path. It may retry
  through drain and reactive compact, but retry count remains bounded by the
  runtime loop state.
- `schema_rejected` retries only when deterministic adapter sanitize/repair is
  explicitly available; otherwise it surfaces a bounded diagnostic.
- `unsupported_payload` and `image_too_large` surface diagnostics only. The
  text/multimodal envelope is not implemented by this contract.
- `recovery_diagnostic` trace payloads may include only bounded taxonomy fields:
  `error_class`, `recovery_error_class`, `failure_kind`, `stop_reason`,
  `action`, `will_retry`, `attempt`, `max_attempts`, and `recovery_kind`.
- Doctor and dry-run may summarize recovery counts and the latest bounded
  recovery tuple. They must not print raw provider messages, raw request
  payloads, raw tool output, full provider wire bodies, full `prompt_cache_key`,
  provider-private encrypted state, or secret-like values.
- Recovery diagnostics are local observability only. They must not be replayed
  into canonical timeline content, provider messages, tool schemas, or stable
  request-shape fragments.

### 4. Validation & Error Matrix

- Provider returns `invalid_encrypted_content` -> clear Responses continuation
  state, call adapter `set_continuation_state(None)` when available, retry
  once, record `recovery_diagnostic`, and do not persist encrypted content in
  trace/doctor/dry-run output.
- Provider returns another `invalid_encrypted_content` after the retry ->
  surface the model error without another retry.
- Provider returns context-window stop reason or equivalent failure kind ->
  reuse drain/compact recovery; no raw provider error text is required for the
  policy decision.
- Provider returns schema rejection with no deterministic repair -> no retry;
  doctor can report `schema_rejected` and `surface_only`.
- Provider returns schema rejection with deterministic repair -> retry once
  with sanitized adapter output.
- Provider returns unsupported payload or image-too-large -> no retry; bounded
  diagnostic/remediation only.
- Trace rows containing extra raw fields such as `raw_message`,
  `request_payload`, or `encrypted_content` -> doctor/dry-run ignore those
  fields and render only allowlisted bounded recovery fields.

### 5. Good/Base/Bad Cases

- Good: A Responses replay failure with invalid encrypted content causes one
  retry without continuation state and produces
  `error_class=invalid_encrypted_content action=strip_encrypted_reasoning_retry`.
- Good: Doctor reports `recovery_rows=2 recovery_retries=1` and class/action
  counts without exposing provider payload text.
- Base: No recovery trace rows -> doctor reports `recovery_rows=0` and
  `latest_recovery=none`.
- Bad: Retrying schema errors when no deterministic sanitizer produced a
  repaired payload.
- Bad: Adding raw provider exception strings or encrypted reasoning blobs to
  `recovery_diagnostic`, `turn_item` metadata, doctor detail, dry-run payloads,
  or canonical timeline fragments.
- Bad: Treating `image_too_large` as recovered by silently dropping image
  context in this text-only mainline.

### 6. Tests Required

- Unit tests for `ErrorClassifier` mapping explicit failure kinds and bounded
  message fallbacks to all P8 recovery classes.
- Unit tests for `RecoveryPolicy` decisions, retry limits, and deterministic
  repair gating.
- Runtime recovery tests proving invalid encrypted content clears continuation
  state, retries once, records bounded trace data, and does not leak secret or
  provider-private text.
- Doctor tests proving recovery diagnostic trace rows are summarized as bounded
  counts/latest status and raw payload fields are not rendered.
- Dry-run tests proving `recovery_counts` and `latest_recovery` are redacted and
  limited to allowlisted fields.
- Provider-free smoke must include P8 recovery fields without real provider API
  calls.

### 7. Wrong vs Correct

#### Wrong

```python
if "encrypted_content" in str(exc):
    trace.append({"raw_message": str(exc), "encrypted_content": blob})
    retry()
```

#### Correct

```python
classification = ErrorClassifier().classify(exc)
decision = RecoveryPolicy().decide(classification)
trace.append(
    RuntimeTraceEvent(
        kind="recovery_diagnostic",
        payload={
            **classification.to_trace_payload(),
            **decision.to_trace_payload(attempt=1),
        },
    )
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
  - Anthropic Messages transport pointed at a DeepSeek base URL:
    `cache_control` disabled by default because DeepSeek's Anthropic-compatible
    API ignores Anthropic `cache_control`; cache telemetry there reflects
    DeepSeek's automatic prefix cache rather than wire hints.
  - DeepSeek / unsupported compatible lanes: both disabled with
    `wire_hints_supported=false` unless a profile explicitly advertises support.
    DeepSeek profiles must still declare `provider_family=deepseek` and
    `cache_strategy=automatic_prefix_cache` so trace/doctor do not confuse
    missing wire hints with missing cache capability.
  - Compatible OpenAI-style endpoints may disable `prompt_cache_key` through
    config/profile when the upstream endpoint rejects the field.
- Normal `RequestPipeline` request assembly must pass the resolved capability to
  `RequestShapeBuilder`; the builder-level explicit argument remains available
  for focused tests and low-level call sites.
- OpenAI Responses and OpenAI-compatible Chat Completions use
  `prompt_cache_key` only as a request-level wire option.
- Anthropic Messages uses `cache_control: {"type": "ephemeral"}` only on
  serialized payload content-block copies. The default Anthropic policy is
  `system_and_3`: mark the final system block, then mark the last cacheable
  content block of the latest three non-system messages.
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
    hints without changing canonical fragments. It also carries the bounded
    diagnostic fields `provider_family` and `cache_strategy`; these are
    provider-policy labels, not raw provider payload.
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
- DeepSeek automatic prefix cache -> request policy reports
  `wire_hint_state=unsupported`, `provider_family=deepseek`, and
  `cache_strategy=automatic_prefix_cache`; doctor should count this separately
  from wire-hint failures.
- Policy says a hint should be emitted but provider metadata lacks a hint ->
  doctor reports `enabled_but_missing` with bounded remediation and no raw
  payload.
- Provider/lane is unsupported -> doctor reports `unsupported` as bounded
  policy state rather than printing raw request data.
- Anthropic system has no cache breakpoint -> keep legacy string system payload.
- Anthropic system has cache breakpoint -> serialize system as text blocks and
  put block-level `cache_control` on the final system block.
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
- Good: Anthropic payload has `cache_control` on the final system block and the
  latest three non-system cacheable content-block copies, while
  `RequestShape.summary()` has no `cache_control`.
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

## Scenario: Provider Adapter Replay Hardening

### 1. Scope / Trigger

- Trigger: changes to Responses input serialization, Chat Completions provider
  adapters, Anthropic Messages serialization, provider-private runtime
  metadata, or deterministic fallback provider ids.
- The flow crosses canonical runtime items, provider adapter wire projection,
  provider-private state replay, schema sanitization, and local provider-free
  tests.

### 2. Signatures

- Responses serialization:
  `ResponsesInputSerializer.serialize_items(items: list[RuntimeItem]) -> list[dict[str, object]]`
- Chat provider adapter:
  `ChatProviderAdapter.adapt_messages(messages: list[dict[str, object]]) -> list[dict[str, object]]`
- Anthropic serialization:
  `AnthropicMessagesModelAdapter._serialize_items(items) -> tuple[system, messages]`
- Provider-private helper:
  `responses_replay_items(provider_state: object) -> tuple[dict[str, object], ...]`
  `sanitize_provider_private(value: object) -> object`
  `deterministic_provider_id(prefix: str, payload: object) -> str`

### 3. Contracts

- Responses lane may replay provider-private state only from adapter-supported
  provider state keys:
  `codex_reasoning_items` and `codex_message_items`.
- Responses encrypted reasoning replay must remain opaque. It must not be
  flattened into `input_text`, assistant content, Chat messages, Anthropic
  thinking blocks, summaries, trace payloads, or diagnostics.
- Responses replay items are same-issuer only. A replay item with
  `_issuer_kind` that is present and not equal to the supported Responses issuer
  must be filtered before request serialization.
- Responses replay item wire copies may retain only supported wire fields. All
  underscore-prefixed keys and unsupported metadata keys must be removed.
- Replay items lacking provider ids receive deterministic fallback ids derived
  from their sanitized payload.
- Chat Completions providers must strip provider-private fields recursively
  before sending:
  `provider_state`, `codex_reasoning_items`, `codex_message_items`, `responses`,
  `cache_control`, `anthropic`, `thinking`, `signature`, `provider_request_policy`,
  `metadata`, and underscore-prefixed keys.
- Provider-specific Chat adapters may explicitly reintroduce supported metadata
  from their own namespace. Example: DeepSeek may use `metadata.deepseek` to
  replay `reasoning_content`, while default OpenAI-compatible adapters strip it.
- Anthropic Messages serialization must ignore Responses-private reasoning
  blocks. It may replay Anthropic raw thinking only when block metadata contains
  an Anthropic `thinking` block.
- Anthropic `cache_control` remains wire-only and must not mutate runtime items
  or canonical timeline state.

### 4. Validation & Error Matrix

- Responses same-issuer `codex_reasoning_items` -> serialized as opaque
  `reasoning` wire items.
- Responses foreign-issuer encrypted reasoning -> omitted before request.
- Responses same-shape `codex_message_items` -> serialized as sanitized
  `message` wire items.
- Responses replay item missing `id` -> deterministic fallback id with stable
  prefix (`rs_` or `msg_`).
- Chat message contains nested provider-private fields -> outgoing message has
  only supported Chat fields and recursively sanitized tool call objects.
- DeepSeek receives `developer` role -> adapter maps/merges it into `system`
  explicitly.
- Anthropic receives a reasoning block with only Responses provider_state ->
  no Anthropic thinking block is emitted.
- Anthropic receives raw `metadata.anthropic.type=thinking` -> thinking block is
  replayed with Anthropic fields intact except wire/private helper keys.
- Anthropic tool call with missing/placeholder id -> deterministic `toolu_...`
  fallback id.

### 5. Good/Base/Bad Cases

- Good: Responses replays same-issuer encrypted reasoning as a `type=reasoning`
  item before normal assistant text.
- Good: OpenAI Chat strips nested `_internal`, `cache_control`, and `responses`
  fields inside tool calls.
- Good: Anthropic ignores Codex encrypted reasoning but keeps Anthropic thinking
  signatures.
- Base: Runtime items without provider-private state serialize exactly as before.
- Bad: Sending `reasoning.encrypted_content` to Chat Completions.
- Bad: Sending Anthropic `cache_control` through a canonical runtime item or
  default Chat message.

### 6. Tests Required

- Unit test Responses same-issuer encrypted reasoning replay.
- Unit test Responses foreign issuer reasoning filtering.
- Unit test Responses same-shape message replay and deterministic fallback ids.
- Unit test default/OpenAI-compatible Chat recursive provider-private field
  stripping.
- Unit test DeepSeek developer-role downgrade remains explicit.
- Unit test Anthropic wire-only cache control remains non-mutating.
- Unit test Anthropic ignores Responses-private reasoning while preserving
  Anthropic thinking metadata.
- Unit test deterministic Anthropic `tool_use` fallback ids.

### 7. Wrong vs Correct

#### Wrong

```python
content.append({"type": "thinking", "thinking": block.text})
chat_message["reasoning"] = {"encrypted_content": encrypted}
```

#### Correct

```python
if block.metadata.get("anthropic", {}).get("type") == "thinking":
    content.append(anthropic_thinking_block)

responses_items.extend(responses_replay_items(item.metadata.get("provider_state")))
chat_message = sanitize_provider_private(chat_message)
```

## Scenario: Compact Cheap Pruning / Tail Protection

### 1. Scope / Trigger

- Trigger: changes to `services/context/compaction`, cheap pruning strategies,
  tail protection, tool result shrinking, or tool-call argument pruning.
- The flow crosses conversation messages, cache zones, compaction budget
  recalculation, request-shape replay, and provider transcript validity tests.

### 2. Signatures

- Strategy:
  `CheapPruning.apply(conversation: Conversation, zones: CacheZones, budget: ContextBudget) -> Conversation`
- Pipeline:
  `CompactionPipeline.apply(conversation: Conversation, budget: ContextBudget) -> Conversation`
- Boundary:
  `CacheZones.from_conversation(conversation).frozen_fingerprint`

### 3. Contracts

- Cheap pruning may only target messages at or after `CacheZones.fresh_start`.
- Messages before the frozen boundary must remain byte-for-byte unchanged and
  must preserve `frozen_fingerprint`.
- Existing `append_only` or legacy `cache_frozen` messages are not rewritten.
- The protected tail remains byte-for-byte unchanged.
- Tail protection expands by semantic group:
  - a protected tool result protects its assistant tool-call message.
  - a protected assistant tool-call message protects matching tool results.
  - protected messages sharing the same `response_id` protect the whole group.
- Duplicate old tool results may be replaced by deterministic back-reference
  messages, preserving the original call id and bounded metadata.
- Large old tool results may be converted to structured summaries with bounded
  preview text and original-content hashes.
- Large tool-call arguments may be truncated recursively inside dict/list
  values, but the arguments object must remain structured and JSON-compatible.
- Cheap pruning runs before `ContextWindowAnalyzer` and `LLMSummarization` so
  budget and diagnostics reflect the pruned conversation.
- P7a must not perform canonical summary replacement, durable/turn
  rehydration, session lineage switching, or provider-specific compact.

### 4. Validation & Error Matrix

- Static prefix + large dynamic tool result -> dynamic tool result may shrink,
  static prefix fingerprint unchanged.
- Recent tail with large tool result -> tail content remains unchanged.
- Tail includes tool result whose assistant tool-call is just outside the tail
  count -> assistant tool-call is protected too.
- Duplicate old tool results -> older duplicate becomes a bounded
  back-reference to the newest unprotected duplicate.
- Tool call arguments contain long nested strings -> nested strings are
  truncated, dict/list structure remains intact.

### 5. Good/Base/Bad Cases

- Good: old repeated `Read` output becomes `[duplicate tool result omitted; see
  <call_id>]` with `cheap_pruning_kind=duplicate_tool_result`.
- Good: old oversized `Write` arguments keep a dict payload but long string
  values end with `...[truncated]`.
- Base: conversation below pressure or without prunable old dynamic content is
  returned unchanged.
- Bad: modifying `STATIC` messages, changing the newest user/tool tail, or
  producing orphan Chat tool results.

### 6. Tests Required

- Unit test static prefix invariant after cheap pruning.
- Unit test protected tail remains unchanged.
- Unit test tool-call/tool-result group protection.
- Unit test duplicate tool-result back-reference.
- Unit test old large tool-result structured summary.
- Unit test recursive tool-call argument truncation keeps dict/list structure.
- Existing compaction transcript validity and cache stability regression tests
  must pass.
