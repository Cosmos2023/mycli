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
  `loadWorkspaceInstructions(input) -> LoadedWorkspaceInstructions`
- Result:
  `LoadedWorkspaceInstructions { content, diagnostics }`
- Section:
  `TurnContextSection(..., cache_class: TurnContextCacheClass)`
- Runtime context fields: `workspaceInstructions` and `workspaceInstructionDiagnostics`.
- Trace kinds:
  `context_diagnostics`
  `context_summary_persistence`
  `request_shape`
  `cache_shape_diagnostic`
- Smoke:
  `npm run smoke:m8`

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
- Runtime environment context is a bounded model-visible contract, not an
  enforcement mechanism. It may include workspace root, filesystem policy,
  network policy, shell policy, approval policy, command/file/tool policy, and
  execpolicy status/count/source summary.
- The model-visible `shell` name and `shell_kind` must be derived from the same frozen
  `ShellProfile` instance used by the approval policy and Shell adapter. Known names are bounded to
  `zsh`, `bash`, `sh`, `powershell`, and `cmd`; an unrecognized POSIX executable is rendered as
  `posix`. Do not expose the executable path or the raw environment variable used to resolve it.
- Runtime environment context remains `dynamic` and turn-scoped. It must not be
  part of the stable prefix, must not alter the cacheable prefix hash, and must
  be rendered before ephemeral runtime reminders and the current user request.
- Runtime environment metadata and rendered content must not include raw
  environment variables, secret values, raw command text, raw execpolicy rule
  pattern tokens, stdout/stderr, local file payloads, headers, or provider wire
  payload bodies.
- Shell runtime enforcement is the execution-side counterpart to the
  model-visible runtime environment contract. It may enforce workspace cwd,
  sanitized env policy, timeout caps, and output limits, but these enforcement
  options remain runtime-only and must not become provider-visible tool schema
  fields or stable prompt text.
- Shell runtime enforcement diagnostics may report argument key/count metadata,
  env key names, timeout/output limits, cwd, and output character/truncation
  counters. They must not report shell argument values, command text,
  stdout/stderr previews, stdout/stderr bodies, inherited env values, headers,
  secrets, or provider payload bodies.
- Sandbox policy enforcement is the execution-side gate for declared tool
  effects. `ToolExecutionService` must resolve a `ToolEffectProfile` before the
  runtime policy decision and pass the bounded effect summary into
  `RuntimePolicyGate.decide(...)`.
- Sandbox denial must happen before ExecPolicy prefix rules, contributed-tool
  exposure allow rules, approval service evaluation, hooks, or actual tool
  execution. In `filesystem=read_only`, filesystem `write` and `unknown`
  effects are denied. In `shell=disabled`, `Bash` / `run_shell` are denied even
  if an ExecPolicy rule would otherwise allow them. In `network=disabled`,
  network-effect tools are denied.
- Sandbox enforcement diagnostics may include only bounded effect summary fields
  `filesystem`, `network`, and `process`, alongside existing sandbox and
  argument key/count metadata. They must not include raw tool argument values,
  raw shell command text, raw URLs, stdout/stderr bodies or previews, local file
  payloads, headers, secrets, or provider payload bodies.
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
- Provider projection diagnostics may distinguish the Responses, Chat Completions, and Anthropic
  protocol lanes without mutating canonical timeline content. Role selection and cache wire fields
  are pi-ai model/compat behavior and must not be predicted by context diagnostics.
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
- Pre-turn compaction summary input must exclude both the fresh current-turn
  suffix and every completed turn retained verbatim as the exact tail. Its
  replacement is summary + exact tail + fresh suffix, with each source item
  represented once.
- Mid-turn and context-overflow compaction run only after completed tool results
  are durable. Their summary input includes the active user/tool phase, while
  replacement history retains recent real user messages plus the new summary
  and removes completed tool-call, tool-result, and provider-reasoning replay.
  The append-only readable transcript remains unchanged. Active-turn compaction
  must not rehydrate file contents into the provider-only replacement.
- Pre-turn and user-requested compaction may rehydrate bounded workspace files.
  Their reported `afterTokens` and savings ratio must include that provider-only
  rehydration instead of measuring only the persisted replacement history.
- Provider replay state may persist a non-negative `tokenEstimate` derived from
  the successful provider step's `reasoning_tokens`. Compaction uses that value
  for opaque reasoning replay instead of tokenizing ciphertext. For legacy replay
  state without an estimate, token accounting recursively excludes opaque
  `encrypted_content` and signature fields while retaining readable summaries
  and metadata.
- Once `compaction_started` is emitted, summary-generation failure or interruption
  must emit a terminal `compaction_completed(status=failed)` event with unchanged
  before/after token counts. A failed summary must not replace canonical history.
- Doctor with no traces -> context check still reports loader and session summary
  state without creating traces.
- Doctor with context traces -> report counts and token maxima only.
- Changing only the current user request or runtime reminders must leave
  `cacheable_prefix_hash` unchanged and report the first changed cache class as
  `ephemeral`.
- Changing workspace instructions or deterministic tool schema should change the
  stable prefix hash.
- Changing only runtime environment fields should remain a dynamic-context
  change, not a stable-prefix change.
- Sandbox-denied tool calls -> append a bounded `runtime_policy_decision` trace
  row and do not execute the tool.
- Sandbox-denied `Bash` / `run_shell` with a matching ExecPolicy allow rule ->
  deny with `policy=sandbox_shell_policy` and do not emit raw command text.
- Sandbox-denied network tool with a URL argument -> deny with
  `policy=sandbox_network_policy` and do not emit the raw URL.
- Sandbox-denied unknown filesystem-effect tool under `read_only` -> deny with
  `reason_code=filesystem_unknown_blocked_by_read_only`.
- A cache-shape diagnostic with `first_changed_cache_class=static` -> doctor
  context warning with a bounded stable-prefix-change count.
- Compaction rehydration must be dynamic and placed before ephemeral runtime
  context and current user intent.
- Runtime reminders, hook context, and plugin context should be placed before
  the current user input so the newest user request remains the final
  model-visible instruction.
- Provider cache keys, cache-control blocks, retention wire fields, and affinity headers must not be
  persisted into canonical messages or request fragments; pi-ai owns them at serialization time.
### 5. Good/Base/Bad Cases

- Good: `.mycli.md` at workspace root is fenced as `workspace-context` with
  `cache_class=static`, and request fragment metadata preserves the same class.
- Good: runtime environment renders `filesystem=workspace_write`,
  `network=enabled`, `shell=restricted`, and `execpolicy_rule_count=2` without
  raw rule patterns.
- Good: active-turn compaction returns `rehydration=[]` and sends only retained
  user intent plus the compact summary to the next provider step.
- Good: pre-turn compaction reports `afterTokens` from its rehydrated
  `providerConversation`, even though persisted replacement items omit file bodies.
- Base: a fresh workspace without context files has no workspace context section
  and no failure.
- Bad: injecting `Ignore previous instructions...` raw from a project file.
- Bad: rendering session summaries as ordinary current user text.
- Bad: measuring compaction savings from persisted replacement items before
  provider-only file rehydration is injected.
- Bad: doctor printing project context text, memory values, or trace payloads.

### 6. Tests Required

- Loader tests for priority, upward/root fallback, truncation, and blocking.
- Assembler tests for cache classes and reference fences.
- Assembler/runtime tests for bounded runtime environment contract rendering
  and redaction.
- Instruction contract/request-shape tests for metadata preservation.
- Request-shape tests for provider projection lanes and canonical compact policy
  summary.
- Cache-shape diagnostic tests for first changed cache class, section
  boundaries, provider projection metadata, and compact policy metadata.
- Runtime/trace tests for context diagnostics and summary persistence when
  compaction summaries are produced.
- Runtime tests proving mid-turn compaction happens after tool-result
  persistence and before the next provider request, including a context-overflow
  fallback when the proactive threshold check does not compact.
- Coordinator tests proving both active-turn sources omit rehydration, pre-turn
  `afterTokens` equals the actual provider conversation estimate, and
  `minSavingsRatio` uses that same estimate.
- Runtime policy tests for sandbox enforcement denial ordering and bounded
  effect summaries.

### 7. Wrong vs Correct

#### Wrong

```typescript
const afterTokens = countItems(storedConversation);
const providerConversation = injectRehydration(storedConversation, rehydration);
```

#### Correct

```typescript
const rehydration = isActiveTurnCompaction(source) ? [] : await rehydrate();
const providerConversation = injectRehydration(storedConversation, rehydration);
const afterTokens = countItems(providerConversation);
```

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
- Doctor skill runtime diagnostics may summarize `skill_activation` trace rows
  with bounded counts for total activations, replayable activations, missing
  replay metadata, missing body digest, and missing content length. It must not
  print raw skill body, raw source path, raw user prompt, raw tool output,
  headers, secrets, or provider payload bodies.

### 4. Validation & Error Matrix

- No skills -> empty catalog and no `skill_catalog` section.
- New unactivated skill -> catalog may change, provider-visible tool schema
  remains stable.
- Explicit `SkillToolContributionProvider` injection -> legacy per-skill
  provider-safe route names continue to work.
- Successful `Skill` call -> dynamic replayable skill instruction and bounded
  `skill_activation` trace.
- Malformed `skill_activation` trace missing replay metadata, body digest, or
  content length -> doctor warning with bounded counts only.
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
- Unit test doctor skill runtime diagnostics summarize activation rows without
  leaking skill body or source path.
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
- Provider-free context/cache tests, including stable prefix hash stability when only
  ephemeral/current intent changes.

### 7. Wrong vs Correct

#### Wrong

```typescript
const workspaceInstructions = readFileSync(join(workspace, "AGENTS.md"), "utf8");
const section = { ...baseSection, content: workspaceInstructions };
```

#### Correct

```typescript
const loaded = loadWorkspaceInstructions({ workspaceRoot: workspace, cwd });
const section = {
  ...baseSection,
  content: fenceWorkspaceInstructions(loaded.content),
  metadata: { contextFile: loaded.diagnostics },
  cacheClass: "static",
};
```

## Scenario: Resume/Fork Runtime Continuity And Compact Boundary Guard

### 1. Scope / Trigger

- Trigger: changes to `/resume`, `/fork`, conversation lineage composition,
  pending approval/clarification recovery, compact rehydration classification,
  or session continuity diagnostics.
- The flow crosses `TurnService`, `SessionService`, SQLite lineage storage,
  runtime trace, doctor diagnostics, request-shape cache boundaries, and
  compact/rehydration read paths.

### 2. Signatures

- Resume: `SessionCoordinator.resume(sessionId) -> Promise<ActiveSessionSnapshot>`.
- Fork persistence: `SQLiteSessionStore.forkSession(input) -> ForkSessionResult`.
- Session continuity trace:
  `RuntimeTraceEvent(kind="session_continuity", ...)`
- Doctor check:
  `DoctorCheck.name == "session_continuity"`
- Protected compact boundary modules:
  `backend/packages/runtime/src/compaction-coordinator.ts`
  `backend/packages/runtime/src/model-input-pipeline.ts`
  `backend/packages/runtime/src/memory-context-service.ts`

### 3. Contracts

- Resuming an ancestor session resolves to the current branch tip before
  resolving pending approval or pending clarification state.
- Pending approval recovery must use a consistent state order:
  1. `pending_decision` plus `suspended_turn.pending_approval` when both exist.
  2. `suspended_turn.pending_approval` as the structured fallback when the
     `pending_decision` row is missing.
  3. `SessionService.reconstruct_suspended_turn(...)` when the
     `pending_decision` row exists but the suspended turn row is missing.
- Approval fallback recovery may emit `RuntimeTraceEvent(kind="approval_recovery", ...)`
  with bounded state booleans, tool name, call id, option count, and command
  pattern presence. It must not emit raw tool arguments, raw command text, raw
  user prompt, raw tool output, headers, provider payload bodies, or secrets.
- Forking creates a child transcript at the requested fork point. Later child
  appends must not mutate the parent transcript/history.
- `session_continuity` trace payloads may contain only bounded metadata:
  `action`, `result`, `requested_session_id`, `resolved_session_id`,
  `lineage_switched`, `message_count`, `fork_point`, `pending_decision`, and
  `pending_clarification`.
- `session_continuity` trace payloads must not contain raw user prompts, raw
  tool output, provider payload bodies, provider-private reasoning content,
  headers, or secrets.
- Doctor summarizes session continuity from trace rows using bounded counts
  only. It must not print raw trace payloads or session transcript content.
- Compact/rehydration implementation is a protected boundary for Codex
  alignment runtime-kernel phases. Runtime continuity work may add read-only
  regression tests, but must not rewrite compact rehydration behavior.
- Compaction rehydration remains dynamic context in request-shape fragments. Changing only
  compaction rehydration text must not change the stable prefix hash or the configured
  `cacheRetention` intent.
- Provider-private reasoning state must remain filtered before compacted or
  rehydrated context becomes model-visible.

### 4. Validation & Error Matrix

- Resume `root` with newest child `branch` -> active runtime session becomes
  `branch`; pending approval/clarification resolution happens on `branch`.
- Suspended turn contains `pending_approval` but `pending_decision` row is
  missing -> approval response recovers a bounded pending decision, executes
  the approved tool once, clears both pending stores, and emits
  `approval_recovery.result=recovered_from_suspended_turn`.
- `pending_decision` row exists but suspended turn row is missing and runtime
  snapshot contains a waiting-approval rollout -> reconstruct suspended turn and
  resume as before.
- Approval state cannot be recovered -> return a pending-decision response and
  emit bounded recovery/resolution diagnostics without raw command or prompt
  content.
- Resume missing session -> bounded `session_continuity` trace with
  `result=not_found`; no raw request text.
- Fork `root` at message index `N` -> child contains the prefix through `N`;
  parent remains unchanged after child-only appends.
- Trace directory missing or without continuity rows -> doctor reports OK with
  `no session continuity diagnostics found`.
- Valid continuity rows -> doctor reports event/action/lineage/pending counts
  and bounded result counts.
- Continuity trace rows with extra raw fields -> doctor ignores those fields and
  must not render their values.
- Compact rehydration text changes -> request-shape stable prefix hash remains
  unchanged and rehydration fragment metadata keeps `cache_class=dynamic`.

### 5. Good/Base/Bad Cases

- Good: `/resume default` reports `resumed branch`, writes a
  `session_continuity` row to the branch trace, and pending approval resolves
  against branch state.
- Good: doctor says
  `continuity_events=2 resume=1 fork=1 lineage_switched=2 pending=1`.
- Base: no resume/fork activity leaves doctor at OK/no diagnostics.
- Bad: rebuilding provider transcript from trace payloads.
- Bad: printing raw user text from a malformed `session_continuity` row.
- Bad: modifying compact rehydration implementation to satisfy runtime
  continuity tests.

### 6. Tests Required

- Integration test root-to-tip pending approval resume.
- Integration test root-to-tip pending clarification resume.
- Integration test approval response recovers from
  `suspended_turn.pending_approval` when `pending_decision` is missing.
- Integration test existing pending-decision-only suspended-turn reconstruction
  remains valid.
- Unit test approval recovery doctor summary redacts raw command, raw args,
  raw prompt, and secret-like values.
- Unit test fork child updates do not pollute parent transcript/history.
- Unit test `session_continuity` doctor summary redacts raw payload fields.
- Cache stability regression proving compaction rehydration stays dynamic and does not affect the
  stable prefix hash or configured cache-retention intent.
- Compact boundary diff audit before completion:
  `git diff -- backend/packages/runtime/src/compaction-coordinator.ts backend/packages/runtime/src/model-input-pipeline.ts backend/packages/runtime/src/memory-context-service.ts`
  must be empty for runtime-continuity-only work.

### 7. Wrong vs Correct

#### Wrong

```typescript
event.payload.userMessage = suspended.userMessage;
const traceSummary = JSON.stringify(event.payload);
```

#### Correct

```typescript
const event = {
  kind: "session_continuity",
  turnId: "session_resume",
  payload: {
    action: "resume",
    result: "resolved",
    lineageSwitched: true,
    messageCount: conversation.messages.length,
    pendingDecision: pendingDecision !== undefined,
    pendingClarification: pendingClarification !== undefined,
  },
};
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

```typescript
fragment.metadata.providerState = { codexReasoningItems: encrypted };
baseline.fragments.push(fragment);
```

#### Correct

```typescript
requestMetadata.providerStateKeys = Object.keys(providerState).sort();
const baselineMetadata = Object.fromEntries(Object.entries(fragment.metadata).filter(
  ([key]) => !["provider_state", "prompt_cache_key", "cache_control"].includes(key),
));
```

## Scenario: Node Provider-Input Timeline Windows

### 1. Scope / Trigger

- Trigger: changes to Node instruction/context assembly, provider-input persistence, logical request
  projection, provider wire serialization, compaction, resume, or provider cache diagnostics.
- The flow crosses `@mycli/core`, `@mycli/storage`, `@mycli/runtime`, `@mycli/providers`, and the
  read-only storage doctor.

### 2. Signatures

- Timeline projector:
  `projectProviderInputTimeline(input) -> ProviderInputTimelineProjection`
- Durable events:
  `ProviderInputTimelineEvent(kind=window_boundary|conversation_item|context_update|context_tombstone)`
- Manifest:
  `ProviderRequestManifestV2(timelineWindowId, timelineEventIds, requestConfigurationSha256,
  bootstrapPrefixSha256, timelineSha256, commonPrefixItemCount)`
- Storage reader:
  `ModelInputLedgerStore.loadProviderInputTimelineEvents(sessionId)`
- Provider projection:
  `ModelProvider.stream(request: ProviderRequest, options: ProviderStreamOptions) -> AsyncIterable<ProviderEvent>`

### 3. Contracts

- Within one window, each logical request retains the complete prior logical input as an exact
  prefix and appends only the normalized unsynchronized conversation tail.
- Changed context appends a complete superseding context item immediately before the new user item.
  Removed context appends a bounded model-visible tombstone. Prior context events and items remain
  immutable.
- Tool call/result normalization runs before prefix comparison. Context cannot split an open batch;
  every sibling result precedes generated tool context.
- The first new session window uses `bootstrap`. A readable v1 session uses `legacy_bootstrap`.
  Compaction uses `compaction`, and any other incompatible source replacement uses `source_reset`.
  A boundary starts a new window without rewriting earlier windows.
- Instruction snapshots, tool-set snapshots, context events, timeline events, the exact request,
  manifest v2, and `prepared` lifecycle event commit in one transaction before provider dispatch.
- Request configuration and request signature exclude hashes that change only because timeline items
  were appended. Timeline growth changes `timelineSha256`, while adjacent-request diagnostics record
  the exact `commonPrefixItemCount`.
- Provider projection keeps the canonical timeline provider-neutral. Stable instructions,
  configured developer instructions, and every developer-role context item are joined in
  deterministic order into pi-ai `Context.systemPrompt`; those context items are not also emitted
  as messages. Pi-ai then chooses the system/developer wire role from model metadata and compat.
- Cache retention does not depend on `previous_response_id`. Continuation is a separate validated
  optimization; incompatible or transport-unbound replay falls back to canonical input.
- Diagnostics persist only window ids, event ids, hashes, counts, and bounded boundary labels. They
  must not contain raw prompt text, tool output, provider payloads, credentials, or full cache keys.

### 4. Validation & Error Matrix

- Previous conversation is an exact prefix -> append only the tail; no boundary.
- Context hash changes -> append one update before current user; preserve the old request prefix.
- Context becomes inactive -> append one tombstone referencing the superseded context.
- Source is replaced by a compaction summary -> append a `compaction` boundary and bootstrap a new
  window.
- Source changes incompatibly without compaction -> append a `source_reset` boundary.
- Existing request manifest has no timeline -> append `legacy_bootstrap` and leave the v1 request
  reconstructable.
- Any timeline/manifest/request/prepared write fails -> roll back the complete provider step and do
  not call the provider.
- Reopen or resume -> load immutable events, select the latest window, and continue its exact prefix.
- Developer context changes -> preserve the append-only canonical timeline and rebuild the ordered
  pi-ai `systemPrompt`; do not invent a lower-authority user/assistant marker.

### 5. Good/Base/Bad Cases

- Good: a permission change appends one canonical developer context item; provider projection folds
  it into `Context.systemPrompt` and pi-ai selects the wire authority.
- Base: ordinary user context stays at its chronological message position.
- Bad: converting developer context to a user or assistant marker to preserve a guessed provider
  prefix.

### 6. Tests Required

- Projector tests for strict extension, context update, tombstone, all window boundaries, and
  contiguous tool results.
- SQLite tests for schema migration, immutable triggers, exact reconstruction, reopen/resume, and
  transactional rollback.
- Runtime tests for ordinary turns, changed context, compaction, v1 adoption, and provider dispatch
  only after persistence.
- Wire tests for deterministic `Context.systemPrompt` assembly and pi-ai-owned role selection across
  Responses, Chat/DeepSeek, and Anthropic.
- Continuation tests proving transport-identity validation and cache-retention independence from
  `previous_response_id`.

### 7. Wrong vs Correct

#### Wrong

```typescript
messages.push({ role: "assistant", content: developerContextMarker });
```

Marker messages lower or misstate instruction authority and retain a second wire serializer.

#### Correct

```typescript
const systemPrompt = [stableInstructions, ...developerInstructions, ...developerContext]
  .filter(Boolean)
  .join("\n\n");
const context = { systemPrompt, messages: canonicalMessages };
```

Preserve canonical history and let pi-ai project its authoritative prompt to the selected API.

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

- Error classification must be centralized at the provider/runtime recovery boundary; runtime tests
  should not assert on scattered string matching in individual executors.
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

```typescript
if (String(error).includes("encrypted_content")) {
  trace.push({ rawMessage: String(error), encryptedContent: blob });
  retry();
}
```

#### Correct

```typescript
const classification = errorClassifier.classify(error);
const decision = recoveryPolicy.decide(classification);
trace.push({
  kind: "recovery_diagnostic",
  payload: {
    ...classification.toTracePayload(),
    ...decision.toTracePayload({ attempt: 1 }),
  },
});
```

## Scenario: Provider-neutral cache retention projection

### 1. Scope / Trigger

- Trigger: changes to cache configuration, provider request construction, durable request recovery,
  pi-ai stream options, usage normalization, or cache diagnostics.
- The flow crosses config, canonical request shape, runtime/Worker transport, storage readers,
  provider adapters, and provider usage telemetry.

### 2. Signatures

- Config: `NodeRuntimeConfig.cacheRetention: "none" | "short" | "long"`.
- Request: `ProviderRequestConfig { sessionId?: string; cacheRetention?: CacheRetention }`.
- Pi-ai options: `SimpleStreamOptions { sessionId?, cacheRetention?, maxRetries: 0 }`.
- Durable reader: `normalizeProviderRequest(value) -> ProviderRequest`.

### 3. Contracts

- Mycli exposes one provider-neutral preference: `request.cache_retention`, with closed values
  `none`, `short`, and `long`, and default `short`. The environment override is
  `MYCLI_CACHE_RETENTION`.
- Every new ordinary request carries the stable mycli session id and effective cache retention.
  Provider switching keeps this intent unchanged; no provider-specific cache capability guard runs
  before pi-ai.
- Pi-ai receives `sessionId` and `cacheRetention` through `SimpleStreamOptions`. Its selected model,
  automatic detection, and `Model.compat` decide prompt-cache keys, retention fields, cache-control
  placement, and session-affinity headers. Mycli must not recreate those fields in `onPayload`.
- A retention value is a preference, not evidence that a provider stored or hit a cache entry.
  Provider usage remains the only cache-hit/cache-write evidence and is normalized into canonical
  usage counts without treating absence as a transport error.
- Provider profiles contain no cache truth table. A private relay whose wire behavior differs from
  pi-ai detection uses validated route/model `compat`, with model values overriding route values.
- Removed `prompt_cache_key_enabled` and `cache_control_enabled` config keys emit bounded
  deprecation diagnostics pointing to `request.cache_retention`; their values never reach runtime.
- New canonical request, Worker RPC, continuation signatures, and storage projections emit only
  `sessionId` and `cacheRetention`. Legacy durable readers may accept `store`, `promptCacheKey`, and
  `cacheControlEnabled`, normalize them once, and never write them back.
- Cache wire fields must not be persisted in canonical conversation items, context fragments,
  readable transcripts, runtime history, or diagnostics. Diagnostics may expose only bounded cache
  usage counts and non-secret structural state.
- Payload snapshots used by tests may inspect pi-ai's mock wire request, but production traces,
  errors, and evidence must not contain provider payloads, cache keys, relay URLs, prompts,
  responses, response ids, credentials, or request headers.

### 4. Validation & Error Matrix

- Missing setting -> resolve `cacheRetention="short"`.
- `none`, `short`, or `long` -> carry the exact value with the stable session id to pi-ai.
- Any other retention value -> fail configuration validation before runtime construction.
- Removed cache boolean appears in user/project config -> ignore its value for request behavior and
  emit a deprecation diagnostic naming `request.cache_retention`.
- Session switches providers -> keep the same retention preference; do not fail because the new
  provider cannot represent a former wire hint.
- Provider cannot represent long retention -> pi-ai downgrades or omits the wire field; mycli does
  not convert this into `unsupported_capability`.
- Legacy durable request has `promptCacheKey` or `cacheControlEnabled` -> normalize to bounded
  `sessionId`/`cacheRetention`, verify original content addressing, and emit no legacy field later.
- Provider usage includes cache reads/writes -> normalize bounded numeric counts by protocol.
- Provider usage has no cache fields -> accept it; do not infer that caching is broken.
- Production diagnostic includes a full cache key, endpoint, prompt, response, response id, or key
  -> reject/redact it at the owning boundary.

### 5. Good/Base/Bad Cases

- Good: a request carries `{sessionId, cacheRetention: "short"}` and pi-ai emits the correct mock
  Responses or Anthropic cache representation.
- Good: a DeepSeek request receives the same neutral preference and proceeds without an OpenAI-only
  capability failure.
- Base: `cacheRetention="none"` leaves cache-field omission/disable behavior to pi-ai.
- Bad: persist `prompt_cache_key` or `cache_control` in canonical context metadata.
- Bad: infer provider cache support from URL strings or provider profile booleans.

### 6. Tests Required

- Config tests cover default/file/environment retention, invalid values, canonical writing, and
  deprecation diagnostics for both removed booleans.
- Runtime and Worker tests assert stable session identity and exact retention survive request
  projection and structured-clone validation, while old fields are rejected from new RPC payloads.
- Storage tests reconstruct legacy request-blob and timeline-manifest forms from real SQLite and
  preserve strict content-address verification.
- Provider payload tests use mock HTTP endpoints to assert pi-ai maps `none`, `short`, and `long` for
  Responses and Anthropic without mycli cache rewrites.
- Provider switching tests prove the neutral preference cannot trigger a stale provider-specific
  capability failure.
- Usage tests cover cache read/write normalization for Responses, Chat, and Anthropic.

### 7. Wrong vs Correct

#### Wrong

```typescript
request.promptCacheKey = makeProviderCacheKey(sessionId);
request.cacheControlEnabled = provider === "anthropic";
payload.cache_control = { type: "ephemeral" };
```

#### Correct

```typescript
const request = {
  ...canonicalRequest,
  sessionId,
  cacheRetention: config.cacheRetention,
};
const options = { sessionId, cacheRetention: config.cacheRetention, maxRetries: 0 };
```

Mycli expresses retention intent; pi-ai alone projects provider cache fields.

## Scenario: Provider Adapter Replay Hardening

### 1. Scope / Trigger

- Trigger: changes to canonical assistant/tool replay, pi-ai replay restoration, transport identity,
  provider-state validation, or deterministic fallback tool ids.
- The flow crosses canonical runtime items, provider transport snapshots, pi-ai context projection,
  provider-private replay state, and local provider tests.

### 2. Signatures

- Registry boundary:
  `ProviderRegistry.create(config: ProviderTransportConfig, route?: ProviderRouteDescriptor) -> ModelProvider`
- Canonical provider stream:
  `ModelProvider.stream(request: ProviderRequest, options: ProviderStreamOptions) -> AsyncIterable<ProviderEvent>`
- Replay restoration:
  `restorePiAiReplay(item, api, provider, model) -> PiAiReplayProjection`

### 3. Contracts

- New provider replay uses the bounded versioned `pi_ai_assistant` envelope. Legacy Responses replay
  accepts `responsesNativeItems` and `responsesReasoningItems` only through the compatibility reader.
- Responses encrypted reasoning replay must remain opaque. It must not be flattened into assistant
  text, Chat messages, Anthropic thinking blocks, summaries, trace payloads, or diagnostics.
- Responses replay items are same-issuer only. A replay item with
  `_issuer_kind` that is present and not equal to the supported Responses issuer
  must be filtered before request serialization.
- Pi-ai replay projections retain only supported provider state bound to the current route, API,
  model, and normalized endpoint hash.
- Replay items lacking provider ids receive deterministic fallback ids derived
  from their sanitized payload.
- Provider-specific reasoning/tool replay is restored through pi-ai message types; mycli does not
  rebuild raw Responses, Chat, DeepSeek, or Anthropic wire payloads.
- Foreign, transport-unbound, malformed, inconsistent, or oversized replay degrades to canonical
  assistant/tool content with a bounded diagnostic. It must never cause provider state from one
  route/model to cross into another.
- Stable/developer instructions and developer-role context are projected once into
  `Context.systemPrompt`. Pi-ai selects the wire role; replay code must not introduce marker messages
  or provider-specific role downgrades.
- Provider cache controls remain pi-ai wire state and must not mutate runtime items or canonical
  timeline state.

### 4. Validation & Error Matrix

- Responses legacy reasoning items -> restored as pi-ai thinking metadata only when provider and
  canonical content validation succeeds.
- Responses foreign-issuer encrypted reasoning -> omitted before request.
- Responses legacy hosted-search items -> omitted by the pi-ai replay reader while canonical content
  and supported reasoning are retained.
- Replay transport route, API, model, or endpoint differs -> omit private replay and retain canonical
  content with a bounded degradation diagnostic.
- DeepSeek receives developer authority -> pi-ai receives the same ordered `systemPrompt` as other
  APIs and selects its supported wire role from model compat.
- Anthropic receives only Responses-private state -> omit that state and retain canonical content.
- Anthropic tool call with missing/placeholder id -> deterministic `toolu_...`
  fallback id.

### 5. Good/Base/Bad Cases

- Good: Responses replays same-issuer encrypted reasoning as a `type=reasoning`
  item before normal assistant text.
- Good: Chat and Anthropic ignore foreign Responses replay while keeping canonical assistant text and
  tool calls.
- Base: Runtime items without provider-private state serialize exactly as before.
- Bad: Sending `reasoning.encrypted_content` to Chat Completions.
- Bad: sending cache controls or provider-specific role markers through a canonical runtime item.

### 6. Tests Required

- Unit test Responses same-issuer encrypted reasoning replay.
- Unit test Responses foreign issuer reasoning filtering.
- Unit test Responses same-shape message replay and deterministic fallback ids.
- Unit tests prove deterministic `Context.systemPrompt` assembly and pi-ai-owned role selection.
- Registry tests prove every supported route resolves to pi-ai and private replay is transport-bound.
- Mock Node agent smoke proves a DeepSeek Chat child completes its first provider turn and tool call
  through the worker runtime without provider-specific mycli serialization.
- Unit test provider cache fields remain outside canonical replay state.
- Unit test Anthropic ignores Responses-private reasoning while preserving
  Anthropic thinking metadata.
- Unit test deterministic Anthropic `tool_use` fallback ids.

### 7. Wrong vs Correct

#### Wrong

```typescript
payload.messages.push(deepSeekDeveloperMarker);
payload.cache_control = canonicalItem.metadata.cacheControl;
```

#### Correct

```typescript
const replay = restorePiAiReplay(item, api, transportProvider, transportIdentity);
const context = { systemPrompt: authoritativePrompt(request), messages: replay.messages };
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

## Scenario: Node Workspace Memory Projection And Mutation

### 1. Scope / Trigger

- Trigger: changes to Node workspace memory discovery, selection, context
  projection, explicit remember/forget actions, or memory-file mutation safety.
- The default flow crosses `MemoryStore`, `MemoryContextService`,
  `SessionStateStore`, `NodeTurnRuntime`, and provider request projection.
  `MemorySelector` remains an optional, explicitly composed extension.

### 2. Signatures

- Store:
  `MemoryStore({ homeDir, workspaceRoot, ...lockOptions })`
- Selection:
  `MemorySelector.select(query, memories, { limit, signal? })`
- Context:
  `MemoryContextService.collect({ userMessage, sessionId, enabled, signal? })`
- Explicit action:
  `MemoryContextService.applyExplicitActions({ userMessage, enabled })`
- Runtime injection:
  `NodeTurnRuntimeOptions.memoryContextService?: MemoryContextServiceContract`

### 3. Contracts

- Memory is disabled by default. It requires an
  explicit `[memory].enabled = true` or `MYCLI_MEMORY_ENABLED=true` opt-in.
- Memory is rooted at
  `~/.mycli/projects/<canonical-real-workspace-key>/memory`.
- `MEMORY.md` and topic reads use strict UTF-8 and realpath confinement. Model
  selected filenames are resolved only through the in-memory scan allowlist.
- Topic and index writes use synced sibling temporary files and atomic rename.
  A directory-scoped lock serializes remember/forget read-modify-write sequences
  across runtime instances and processes.
- Lock release, stale-lock recovery, and failed-write cleanup require matching
  ownership metadata and file identity. If ownership cannot be proved after a
  path swap, cleanup leaves the file in place rather than unlinking an unrelated
  path.
- Default selection is deterministic and local, using stable token
  weights, recency, and Unicode code-point filename ordering. It must not make
  a provider request. An explicitly composed provider selector has no tools, is
  capped at 512 output tokens, and receives the active turn abort signal.
- File memory is omitted when the current request says `ignore memory`,
  `do not use memory`, or `not use memory`; session summaries remain eligible.
- Provider-visible memory is token-bounded, fenced as reference content, placed
  after compaction rehydration and before fresh input, and never persisted into
  canonical history.
- Session-summary discovery uses the indexed recent-summary read and considers only the latest eight
  summaries before deduplication and token trimming. It must not materialize hundreds of historical
  compact summaries merely to enforce the 5,000-token aggregate memory budget.
- The runtime collects memory at most once per provider loop and reuses the
  resulting transient item for every tool-continuation request in that loop.
- Explicit remember/forget runs only after durable successful turn completion.

### 4. Validation & Error Matrix

- Escaping topic or `MEMORY.md` symlink -> `memory_path_escape`; no body in the
  error or diagnostics.
- Invalid UTF-8 -> `memory_invalid_utf8` with bounded filename metadata only.
- Live directory lock past bounded wait -> `memory_write_failed` with
  `operation=memory_lock_timeout`; the other owner's lock remains unchanged.
- Old lock with a live PID -> do not steal; time out normally.
- Old lock with a dead PID and matching identity -> remove and retry.
- Root swap during write/cleanup -> fail closed and never unlink the new
  external same-name file.
- Selector provider/JSON/empty-selection failure -> deterministic local
  fallback; an empty query or memory set makes no selector provider request.
- Disabled memory -> no scan, summary load, selector request, injection, or
  explicit mutation.
- Hundreds of session summaries -> request only the latest eight in chronological order, then apply
  the normal per-record and aggregate token budgets.

### 5. Good/Base/Bad Cases

- Good: twelve runtime instances remember the same title concurrently and
  produce twelve unique topics plus twelve `MEMORY.md` entries.
- Good: context includes a fenced session summary but omits file memory after an
  explicit `ignore memory` request.
- Base: an empty memory directory produces no memory fragment and no failure.
- Bad: trusting a model-returned relative path, following an escaping entrypoint
  symlink, or unlinking a lexical cleanup path after its parent was swapped.

### 6. Tests Required

- Unit tests for workspace-key parity, 200-topic discovery, entrypoint
  line/byte bounds, frontmatter bounds, strict UTF-8, and valid kinds.
- Symlink tests for topics, `MEMORY.md`, root swaps before rename, and
  ownership-safe cleanup after rename.
- Concurrent same-instance and multi-instance remember tests asserting unique
  topics and complete index entries.
- Lock tests for dead stale recovery, live-owner timeout, and old live-owner
  preservation.
- Selector tests for JSON validation, allowlisting, five-file bounds, Unicode code-point ordering,
  deterministic fallback, and AbortSignal propagation.
- Runtime tests for placement after rehydration, absence from durable history,
  disabled/failed/interrupted behavior, post-success explicit actions, and
  single collection across a multi-step provider loop.
- Backend integration must prove default memory selection adds no provider
  request while still injecting a relevant memory into the main request.

### 7. Wrong vs Correct

#### Wrong

```ts
const selectedPath = join(memoryRoot, modelFilename);
await readFile(selectedPath);
await unlink(topicPath); // lexical path may now point outside the owned root
```

#### Correct

```ts
const selected = scannedByFilename.get(modelFilename);
await withDirectoryLock(async () => updateMemory(selected));
await unlinkOnlyWhenContainedAndIdentityMatches(ownedFile);
```
