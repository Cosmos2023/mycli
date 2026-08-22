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
- Provider projection diagnostics must distinguish the protocol lane without
  mutating canonical timeline content:
  - Responses: `lane=responses`, optional future `prompt_cache_key` as
    wire-only hint.
  - Chat Completions: `lane=chat_completions`, stable transcript prefix.
    DeepSeek keeps stable instructions in the initial `system` message and projects later
    developer-authority timeline updates as bounded user-context messages at their chronological
    suffix. Runtime policy remains authoritative; adding a dynamic update must not add another
    DeepSeek `system` message or rewrite the prior wire prefix.
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
- Anthropic `cache_control` and OpenAI `prompt_cache_key` must not be persisted
  into canonical messages or request fragments; they are provider wire/request
  hints only.
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
- Compaction rehydration remains dynamic context in request-shape fragments.
  Changing only compaction rehydration text must not change the stable prefix
  hash or `prompt_cache_key`.
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
- Cache stability regression proving compaction rehydration stays dynamic and
  does not affect stable prefix hash or `prompt_cache_key`.
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
- Chat provider projection:
  `ChatProvider.stream(request: ProviderRequest, options: ProviderStreamOptions) -> AsyncIterable<ProviderEvent>`

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
- Responses and native Chat keep dynamic developer context at its timeline position. DeepSeek maps
  such an item to fenced `user` context at that same position; only bootstrap developer
  instructions join the leading system prefix. Runtime policy remains authoritative. Anthropic has
  only top-level system authority, so it promotes developer context to `system`; that
  authority-preserving change may reset the system prefix, while ordinary contextual-user turns
  still preserve the message prefix.
- Prompt-cache prefix stability does not depend on `previous_response_id`. Continuation is a separate
  capability-gated optimization; HTTP-compatible Responses projection replays canonical input and
  omits `previous_response_id` unless the selected transport explicitly supports it.
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
- DeepSeek dynamic developer-context change -> preserve every prior wire message as an exact
  prefix, append the update with `role="user"`, and retain exactly one initial `system` message.

### 5. Good/Base/Bad Cases

- Good: a DeepSeek permission change appends a fenced `user` context message after the complete
  previous wire request and before the current user request.
- Base: native Chat continues to project dynamic developer context with `role="developer"` at its
  chronological timeline position.
- Bad: projecting a later DeepSeek permission update as another `system` message, which changes
  the provider's system-prefix cache identity.

### 6. Tests Required

- Projector tests for strict extension, context update, tombstone, all window boundaries, and
  contiguous tool results.
- SQLite tests for schema migration, immutable triggers, exact reconstruction, reopen/resume, and
  transactional rollback.
- Runtime tests for ordinary turns, changed context, compaction, v1 adoption, and provider dispatch
  only after persistence.
- Wire tests for Responses, native Chat, DeepSeek chronological role fallback, and ordinary
  Anthropic message-prefix stability.
- Continuation tests proving protocol/capability gating and prompt-cache compatibility without
  `previous_response_id`.
- DeepSeek Chat projection tests proving dynamic developer-context updates preserve the complete
  prior wire-message prefix and do not add a second `system` message.

### 7. Wrong vs Correct

#### Wrong

```text
system: stable instructions
user: U1
assistant: A1
system: <permissions>updated permission profile</permissions>
user: U2
```

Adding a changed permission update as a second DeepSeek `system` message invalidates the
provider's system-prefix cache identity.

#### Correct

```text
system: stable instructions
user: U1
assistant: A1
user: <permissions>updated permission profile</permissions>
user: U2
```

Keep one stable initial `system` message, preserve the complete previous wire request as an exact
prefix, and append the fenced permission context chronologically before the current user request.

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
  serialized payload content-block copies. The Node adapter marks the final system block, then the
  last cacheable content block of the earliest three non-system messages. Those fixed message
  breakpoints do not move when later timeline items are appended.
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
- Provider quirk profiles are provider-edge metadata, not timeline content.
  `resolve_provider_quirk_profile(...)` must resolve bounded labels from
  configured provider, protocol, and base URL inference. It may report provider
  family, protocol, cache strategy, hint support booleans, automatic prefix-cache
  status, reasoning replay label, cached-token usage-shape label, streaming
  shape label, and retry-error shape label. It must not include raw base URLs,
  API keys, headers, provider payload bodies, raw prompts, raw tool output, or
  full prompt-cache keys.
- Provider quirk resolution must recognize Anthropic protocol pointed at
  DeepSeek's Anthropic-compatible endpoint as `provider_family=deepseek` with
  `cache_strategy=automatic_prefix_cache` and wire hints disabled. This explains
  DeepSeek prefix-cache behavior without emitting Anthropic `cache_control`.
- Doctor `provider_quirk_diagnostics` and provider-free eval matrix rows may
  expose only the bounded quirk labels above. They must not mutate request
  fragments, canonical conversation messages, provider payload snapshots, or
  persisted session history.

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
- Dry-run `runtime_diagnostics` is local diagnostic metadata only. It may include
  exposed tool names/counts, policy decision summaries, sandbox lane counts,
  approval lane state, lifecycle counts, and session continuity counts, but must
  not alter request fragments, provider payload snapshots, cache boundary hashes,
  or provider wire payloads.
- DeepSeek Anthropic-compatible endpoint -> quirk diagnostics report
  `provider_family=deepseek`, `protocol=anthropic_messages`,
  `cache_strategy=automatic_prefix_cache`, and `wire_hints=false` without
  printing base URL, key, request, response, or prompt text.

### 5. Good/Base/Bad Cases

- Good: Responses payload has `prompt_cache_key` beside `model`, while input
  items contain no cache hint fields.
- Good: Anthropic payload has `cache_control` on the final system block and the
  earliest three non-system cacheable content-block copies, while
  `RequestShape.summary()` has no `cache_control`.
- Base: A legacy/fake Responses client without `prompt_cache_key` support still
  receives normal `input_items` and `tools`.
- Bad: Persisting `cache_control` in `RuntimeBlock.metadata`.
- Bad: Passing Anthropic `cache_control` or `thinking` blocks through Chat
  Completions messages.
- Bad: Inferring provider quirks by inspecting persisted transcript text or
  provider payload bodies.

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
- Unit test provider quirk resolution for OpenAI, compatible, Anthropic,
  DeepSeek Chat, and DeepSeek Anthropic-compatible endpoints.
- Unit test doctor provider quirk diagnostics are bounded and secret-safe.
- Unit test provider-free quirk eval matrix rows cover the supported fixture
  lanes without live provider calls.
- Unit test provider profile/config capability resolution and RequestPipeline
  automatic capability injection.
- Unit test redacted dry-run renderer output contract.
- Unit test redacted dry-run runtime diagnostics contract.
- Unit test provider cache usage telemetry normalization and doctor policy
  validation states.
- Provider package tests cover all three provider lanes plus capability resolution, dry-run
  comparison, snapshot counts, runtime diagnostics fields, and telemetry normalization fields.

### 7. Wrong vs Correct

#### Wrong

```typescript
block.metadata.cacheControl = { type: "ephemeral" };
tracePayload.providerRequestPolicy = { promptCacheKey: fullKey };
const quirk = inferFromPayloadBody(rawProviderPayload);
```

#### Correct

```typescript
const wireBlock = { type: "text", text: block.text, cache_control: { type: "ephemeral" } };
tracePayload.providerRequestPolicy = {
  promptCacheKeyHash: stableHash(fullKey),
  promptCacheKeyPreview: `${fullKey.slice(0, 48)}...`,
};
const quirk = resolveProviderQuirkProfile(config.provider, config.protocol);
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
- The provider registry must select provider-specific Chat wire policy from the
  resolved provider id, not from `chat_completions` alone. DeepSeek constructs
  `ChatProvider` with `developerInstructionMode=merge_into_system`; compatible,
  OpenAI, and Qwen Chat keep the default native developer-role projection.
- DeepSeek bootstrap developer instructions are merged with base instructions into one leading
  `system` message at the wire boundary. Dynamic developer-authority context is mapped to a later
  `system` message at its timeline position. Canonical instructions and request signatures retain
  their developer authority classification.
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
- DeepSeek receives a bootstrap `developer` instruction -> adapter merges it into the leading
  `system` message explicitly.
- DeepSeek receives a dynamic developer context after conversation -> adapter maps it to `system` at
  that chronological position.
- A DeepSeek child agent adds a role instruction -> its first Chat request has
  one leading `system` message and no `developer` wire message.
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
- Unit tests prove bootstrap developer-role downgrade remains explicit and dynamic developer context
  remains at its chronological position.
- Registry test proves only resolved `provider=deepseek` enables the downgrade.
- Real Node agent smoke proves a DeepSeek Chat child completes its first provider turn and tool call
  through the worker runtime.
- Unit test Anthropic wire-only cache control remains non-mutating.
- Unit test Anthropic ignores Responses-private reasoning while preserving
  Anthropic thinking metadata.
- Unit test deterministic Anthropic `tool_use` fallback ids.

### 7. Wrong vs Correct

#### Wrong

```typescript
content.push({ type: "thinking", thinking: block.text });
chatMessage.reasoning = { encrypted_content: encrypted };
```

#### Correct

```typescript
if (block.metadata.anthropic?.type === "thinking") content.push(anthropicThinkingBlock);
responsesItems.push(...responsesReplayItems(item.metadata.providerState));
const chatMessage = sanitizeProviderPrivate(inputChatMessage);
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
