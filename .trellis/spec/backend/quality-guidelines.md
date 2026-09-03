# Quality Guidelines

> Code quality standards for backend development.

---

## Overview

<!--
Document your project's quality standards here.

Questions to answer:
- What patterns are forbidden?
- What linting rules do you enforce?
- What are your testing requirements?
- What code review standards apply?
-->

(To be filled by the team)

---

## Forbidden Patterns

<!-- Patterns that should never be used and why -->

(To be filled by the team)

---

## Required Patterns

<!-- Patterns that must always be used -->

(To be filled by the team)

---

## Testing Requirements

### Scenario: Repository Test Suite Taxonomy

#### 1. Scope / Trigger

- Trigger: adding, moving, renaming, or changing a Node test, root test command, smoke script, or
  CI/release test gate.
- `scripts/test-suite-catalog.mjs` is the canonical repository test classifier;
  `scripts/run-test-suite.mjs` is the canonical root Node test orchestrator.

#### 2. Signatures

- Deterministic repository gate: `npm test` or `npm run test:ci`.
- Focused suites: `test:unit`, `test:contract`, `test:integration`, `test:platform`, and
  `test:release`.
- Provider-free executable gate: `npm run test:smoke`.
- Credential-gated provider probe: `npm run test:smoke:live`.
- Catalog inspection: `npm run test:list [-- --json]`.

#### 3. Contracts

- Every discovered `*.test.*` file belongs to exactly one suite. CI expands to unit, contract,
  integration, platform, and release in stable order and selects every catalog row once.
- Ordinary workspace tests default to unit. The contracts workspace and repository test directory
  default to contract. Whole-file `.integration.test.*`, `.platform.test.*`, and
  `.contract.test.*` suffixes select the matching boundary.
- A small explicit override map may classify legacy mixed filenames. Catalog discovery fails when
  an override points to a missing file.
- Unit tests are deterministic and in-process. Integration tests may own loopback servers, Workers,
  subprocesses, SQLite concurrency, or extension hosts. Platform tests exercise real PTY, shell,
  process transport, sandbox, or native behavior. Each test owns cleanup for every resource it
  starts.
- Smoke journeys are executable scripts, not ordinary test modules. Real provider traffic is never
  part of `npm test` and remains explicit, credential-gated, bounded, and redacted.
- Root tests resolve current TypeScript through `mycli-source`. Tests that intentionally inspect
  compiled or packed output run after the root build boundary.
- Package-local test scripts remain valid focused entry points. CI uses only the root catalog and
  must not rerun milestone tests already selected by it.
- Historical `test:m2` through `test:m8` scripts may remain as investigation shortcuts, but they are
  not separate quality gates.

#### 4. Validation & Error Matrix

- Unknown suite selector -> `unknown_test_suite`; execute nothing.
- Missing suite argument -> `test_suite_value_required`; execute nothing.
- Duplicate discovered path -> `duplicate_test_catalog_path`; execute nothing.
- Override points to a removed or renamed test -> `stale_test_suite_override`; execute nothing.
- Test path escapes the repository -> `test_path_outside_repository`; execute nothing.
- A smoke-named `node:test` file -> `smoke_test_must_be_an_explicit_script`; move the journey to an
  explicit smoke script or classify the deterministic assertions correctly.
- A target process fails or is interrupted -> stop later suites and preserve the failing exit code.

#### 5. Good / Base / Bad Cases

- Good: add `queue-coordinator.test.ts`; it is discovered as a runtime unit test without editing a
  second file list.
- Good: add `mcp-process.integration.test.ts`; the suffix places it in integration automatically.
- Good: keep native PTY coverage in platform and run it on every supported CI host.
- Base: use an override while a large legacy file contains more than one execution boundary, then
  remove the override when the file is split or renamed.
- Bad: add a real-provider request to a package `test` command or silently skip it when credentials
  are absent.
- Bad: run `npm test` and then `test:m8` in the same CI job even though the catalog already includes
  the M8 audit.
- Bad: make the complete app suite serial to hide leaked ports, global environment changes, or
  incomplete Worker/process cleanup.

#### 6. Tests Required

- Catalog tests prove unique paths, non-empty suites, complete CI selection, representative
  classification, stale-override rejection, selector expansion, and argument forwarding.
- Repository script tests keep root command names and suite mappings stable.
- Workflow drift tests require `test:ci` and reject a second `test:m8` step.
- Run each changed focused suite, then `npm test`, lint, type-check, contract drift, config drift, and
  `git diff --check` before completion.
- Changes to native/platform behavior also run provider-free packed smoke on every supported host.

#### 7. Wrong vs Correct

Wrong:

```json
{
  "test": "npm run test --workspaces && npm run test:m8"
}
```

Correct:

```json
{
  "test": "node scripts/run-test-suite.mjs --suite ci",
  "test:platform": "node scripts/run-test-suite.mjs --suite platform"
}
```

### Scenario: Doctor Diagnostics And Explicit Recovery

#### 1. Scope / Trigger
- Trigger: Any change to `mycli doctor`, local runtime diagnostics, or health
  checks for config, storage, logs, FileHistory, TUI, or MCP setup.
- The command crosses CLI, services, config, storage layout, and integration
  boundaries, but must stay outside model/runtime execution.

#### 2. Signatures
- CLI command: `mycli doctor [--fix [--confirm <plan-id>] | --support-bundle]`
- Service API: `runDoctor(options, signal) -> Promise<DoctorReport>`.
- Management API: `DoctorManagementService.execute(command, signal)`.
- Rendering API: `doctorResponseFromReport(report, options?) -> DoctorManagementResponse`.
- Result fields: `DoctorCheck.name`, `DoctorCheck.status`,
  `DoctorCheck.message`, optional `DoctorCheck.detail`; status values are
  `ok`, `warning`, and `failed`.

#### 3. Contracts
- Plain Doctor and an unconfirmed `--fix` preview are read-only. They must not
  create config files, sessions DBs, log files, file-history indexes, or MCP
  server processes. A confirmed repair may mutate only the actions shown in
  the matching plan through the owning service. `--support-bundle` may write
  only the private allowlisted support artifact.
- Default doctor must not perform a real provider/model request.
- Output is human-readable text headed by `mycli doctor` and ending with a
  summary count.
- API keys, bearer tokens, and secret-like values must never be printed; report
  presence only, for example `api_key: present`.
- Warnings return exit code `0`; one or more failed checks return exit code `1`.
- Repair and support errors add one bounded operation issue. They do not become
  runtime-turn failures or duplicate the primary TUI diagnostic.

#### 4. Validation & Error Matrix
- `doctor --fix` without confirmation -> value-free preview and no mutation.
- Missing or truncated repair changes -> `repair_preview_failed`; expose no
  plan that could mutate undisclosed state.
- Matching `--confirm <plan-id>` -> rebuild the plan, then delegate only its
  listed deterministic actions to their owners.
- Stale plan -> `version_conflict`, with no newly discovered action applied.
- Repair exception -> bounded failed result; never serialize the exception.
- Support export -> one allowlisted JSON DTO at the fixed private location;
  never copy raw logs or upload it.
- Support config/sandbox probes fail -> export bounded fallback metadata.
- Support write fails -> one `support_bundle_write_failed` issue.
- Config resolves -> report provider, protocol, model, and base URL.
- Config parse/validation fails -> `config=failed`; keep checking other areas.
- API key missing -> `api_key=warning`.
- `~/.mycli/sessions.db` missing -> `sessions_db=warning`.
- Sessions DB exists but is not openable or lacks required tables -> failed.
- Sessions DB `schema_version` table is missing, empty, invalid, or does not
  match the current `SQLiteSessionStore.SCHEMA_VERSION` -> `sessions_db=failed`
  with expected/current version detail.
- Sessions DB local search FTS table/triggers for `conversation_messages` are
  missing -> `sessions_db=failed` with bounded object names. Doctor must not
  open the write-path store or repair the objects while checking.
- Sessions DB critical recovery rows in `session_state` for `pending_decision`,
  `suspended_turn`, `turn_record`, or `responses_continuation_state` contain
  invalid JSON, non-object JSON, or malformed nested approval/clarification
  objects -> `sessions_db=failed` with bounded `session_id:state_key`
  references. Doctor must not print raw `payload_json`.
- Doctor recovery validators must follow the generated runtime-state nullability
  contract. An optional nested recovery object declared as `T | null` treats
  explicit `null` the same as an absent field; only a non-null, non-object value
  is malformed. This keeps read-only diagnostics aligned with payloads accepted
  and persisted by the runtime.
- Sessions DB contains a `pending_decision` but no valid `suspended_turn`,
  waiting-approval `turn_record` with user message, or waiting-approval
  rollout plus matching user history item -> `sessions_db=failed` with bounded
  session ids. Doctor must not repair or clear the pending decision.
- Sessions DB contains a `suspended_turn.pending_clarification` but no non-blank
  suspended `user_message`, waiting-clarification `turn_record` with user
  message, or waiting-clarification rollout plus matching user history item ->
  `sessions_db=failed` with bounded session ids. Doctor must not repair or
  clear the suspended turn.
- Session maintenance diagnostics must not classify runtime-only sessions as
  empty. `history_items`, `turn_rollouts`, and `session_state` rows count as
  durable session content even when legacy `conversation_messages` is empty.
- `/session-maintenance` is read-only by default. Empty-session cleanup requires
  the explicit `/session-maintenance --apply-empty` form, must recompute
  candidates at apply time, and must only delete workspace-scoped sessions that
  still have no conversation messages, summaries, history items, turn rollouts,
  or session state.
- Empty-session cleanup must preserve sessions that participate in conversation
  lineage as forked children or as parents of other sessions. Lineage pruning
  requires a separate explicit policy.
- Orphan child-row cleanup requires the explicit
  `/session-maintenance --apply-orphans` form. It may delete only known child
  table rows whose `session_id` is absent from `sessions`; it must not delete
  sessions, repair lineage parent references, or run `VACUUM`.
- SQLite vacuum requires the explicit `/session-maintenance --apply-vacuum`
  form. It must report bounded before/after storage metrics, preserve sessions
  and child rows, and must not run from doctor, the default dry-run report,
  empty-session cleanup, or orphan cleanup.
- Logs or FileHistory missing -> warning, not failure.
- Reserved trace/artifact directories missing -> `storage_layout=ok`; doctor
  must not create them because runtime writers create parents lazily.
- Reserved trace/artifact path exists as a non-directory -> `storage_layout=failed`.
- Reserved trace/artifact directory exists without write bits ->
  `storage_layout=failed`.
- Trace diagnostics check:
  - Missing `~/.mycli/traces/` -> `traces=ok`; doctor must not create it.
  - Existing empty `traces/` -> `traces=ok`.
  - Existing readable `*.jsonl` trace files with valid runtime trace rows ->
    `traces=ok` with bounded file/row counts.
  - Existing trace files with invalid JSONL rows, non-object rows, or rows that
    cannot decode as runtime trace events -> `traces=warning`; runtime loading
    skips bad rows, but doctor must surface degraded diagnostics.
  - Existing trace files that cannot be opened/read -> `traces=failed`.
  - Trace doctor output must report counts and bounded file/line references, not
    raw trace payload content.
- Stream diagnostics check:
  - Missing `~/.mycli/traces/` or no `model_stream_diagnostics` trace rows ->
    `stream_diagnostics=ok` with `no stream diagnostics found`; doctor must not
    create the trace directory.
  - Successful stream diagnostics rows -> `stream_diagnostics=ok` with bounded
    stream count, failure count, max TTFB, max elapsed time, and total text
    bytes.
  - Failed stream diagnostics rows -> `stream_diagnostics=warning` with bounded
    failure-kind counts. Doctor must not print raw trace payloads or
    `failure_message` values.
- Approval diagnostics check:
  - Missing `~/.mycli/traces/` or no approval diagnostic trace rows ->
    `approval_diagnostics=ok` with `no approval diagnostics found`; doctor must
    not create the trace directory.
  - Approval diagnostic rows include `approval_resolution`,
    `approval_recovery`, `approval_allowance`, and `approval_auto_allowed`.
  - Successful approval diagnostics -> `approval_diagnostics=ok` with bounded
    total, per-kind counts, `approval_resolution` result counts, and
    `approval_recovery` result counts.
  - Problem approval-resolution results such as `no_pending_decision`,
    `invalid_choice`, `allow_session_unavailable`, `missing_suspended_turn`, or
    unknown non-empty results -> `approval_diagnostics=warning` with bounded
    result counts. Doctor must not print raw trace payloads, command patterns,
    reasons, user text, headers, or secret-like values.
  - Approval recovery rows may expose only bounded result/status counts and
    state booleans. Doctor must not print raw tool arguments, raw command text,
    raw user prompt, raw tool output, headers, or secret-like values.
- Clarification diagnostics check:
  - Missing `~/.mycli/traces/` or no `clarification_resolution` trace rows ->
    `clarification_diagnostics=ok` with `no clarification diagnostics found`;
    doctor must not create the trace directory.
  - Successful answered rows -> `clarification_diagnostics=ok` with bounded
    total and result counts.
  - Problem clarification-resolution results such as `blank_response`,
    `no_pending_clarification`, `request_id_mismatch`, or unknown non-empty
    results -> `clarification_diagnostics=warning` with bounded result counts.
    Doctor must not print raw response text, user text, request payloads,
    provider transcript content, headers, or secret-like values.
- Tool execution diagnostics check:
  - Missing `~/.mycli/traces/` or no `tool_execution` trace rows ->
    `tool_execution_diagnostics=ok` with
    `no tool execution diagnostics found`; doctor must not create the trace
    directory.
  - Successful-only tool execution rows -> `tool_execution_diagnostics=ok`
    with bounded total/failure/interruption/denial/truncation/write-diagnostic
    counts.
  - Failed tool execution rows -> `tool_execution_diagnostics=warning` with
    bounded counts and allowlisted `error_kind` counts. Doctor must not print
    raw tool arguments, stdout, stderr, summaries, file contents, local paths,
    user text, headers, or secret-like values.
- Tool runtime lifecycle diagnostics check:
  - Missing `~/.mycli/traces/` or no `tool_runtime_lifecycle` trace rows ->
    `tool_lifecycle_diagnostics=ok` with
    `no tool lifecycle diagnostics found`; doctor must not create the trace
    directory.
  - Runtime lifecycle rows are emitted by `ToolExecutionService` as
    `RuntimeTraceEvent(kind="tool_runtime_lifecycle", ...)`.
  - Allowed phases are `planned`, `policy_checked`, `started`, `progress`,
    `completed`, `failed`, `denied`, `needs_approval`, and `interrupted`.
  - Allowed statuses are `running`, `completed`, `failed`, `denied`,
    `needs_approval`, and `interrupted`.
  - Lifecycle payloads may contain only bounded metadata: `tool_name`,
    `tool_id`, `tool_call_id`, `phase`, `status`, `argument_count`,
    `argument_keys`, optional `policy_decision`, optional `duration_ms`, and
    optional `error_kind`.
  - Lifecycle payloads must not contain raw arguments, raw command text, raw
    prompt text, raw tool output, stdout/stderr bodies, local file contents,
    headers, secrets, or provider payload bodies.
  - Complete lifecycle rows -> `tool_lifecycle_diagnostics=ok` with bounded
    row/call/terminal counts and phase counts.
  - Planned/started calls without a terminal phase -> warning.
  - Terminal phases without planned/started rows -> warning.
  - Duplicate terminal phases for the same turn/call id -> warning.
  - Unknown phase/status values -> warning.
  - Doctor output must not print raw trace payload content, argument values,
    command text, stdout/stderr bodies, file contents, headers, or secret-like
    values even if those fields appear in a malformed trace row.
- Tool runtime coverage diagnostics check:
  - `ToolRuntimeCoverageProfile` is a metadata-only contract that names
    tool-like runtime lanes and whether lifecycle, effect profile, sandbox,
    execpolicy, approval, hooks, background, cancellation, and diagnostics are
    `full`, `partial`, or `external`.
  - Default coverage rows must include built-in tools, shell foreground,
    shell background, MCP tools, plugin tools, hook execution, subagent jobs,
    skill activation, and background job control.
  - `tool_runtime_coverage` is a Doctor contract summary, not a tool executor.
    It must not execute tools, read provider payloads, or create trace files.
  - Partial lanes and known gaps must be visible as bounded metadata instead of
    hidden, but they are roadmap gaps rather than runtime health failures, so
    they should not make an otherwise healthy doctor report warn by default.
  - Coverage payloads may include lane id, owner label, coverage labels, and
    short known-gap labels only. They must not include raw commands, raw
    arguments, raw env values, stdout/stderr, hook stdin/stdout/stderr, raw
    prompts, raw tool outputs, file contents, provider payload bodies, headers,
    secrets, or full prompt-cache keys.
- Turn failure diagnostics check:
  - Missing `~/.mycli/traces/` or no `turn_failed` trace rows ->
    `turn_failure_diagnostics=ok` with `no turn failure diagnostics found`;
    doctor must not create the trace directory.
  - Any `turn_failed` rows -> `turn_failure_diagnostics=warning` with bounded
    total, `stop_reason`, and `phase` counts. Doctor must not print raw
    exception messages, tracebacks, provider payloads, request payloads, user
    text, tool output, headers, or secret-like values.
- Redaction diagnostics check:
  - `logs_redaction` scans `agent.log`, `errors.log`, `model-events.jsonl`,
    `model-raw/<session>/*.json`, and bounded `traces/*.jsonl` files for
    obvious unredacted secret shapes.
  - Secret findings in traces must report bounded references such as
    `traces/demo-trace.jsonl:1:$.payload.headers.Authorization`, not raw trace
    payloads or secret values.
- `errors.log` missing by itself -> OK when `agent.log`, `model-events.jsonl`,
  and `model-raw/` exist; `errors.log` is created on first warning/error.
- FileHistory `index.json` exists but cannot parse -> failed.
- MCP config load fails -> failed; do not start servers.
- Node/npm or TUI unavailable -> warning unless a stricter command is
  explicitly introduced later.
- Node TUI source exists but `tui/mycli-shell/node_modules/.bin/tsx` is missing ->
  `node_tui_dependencies=warning` with remediation text
  `npm --prefix tui/mycli-shell install`; do not create `node_modules` or run npm.
- Node-side TUI verification should run a dependency-free preflight before
  commands that import `tsx`, and should print missing markers plus the
  remediation `npm --prefix tui/mycli-shell ci`.
- Node TUI source is missing -> report the existing `node_tui` warning and skip
  dependency-marker checks, because missing source is the actionable root cause.
- Invalid canonical `gatewayContractCatalog` protocol version, duplicate method names, or missing
  required RPC/event names -> `runtime_contract=failed`. Doctor must not run a turn or call a model
  to validate this contract.
- Runtime event payload schemas count as declared object schemas when they use either direct
  `type: object` or a non-empty top-level `allOf` composition. A missing/non-object payload schema,
  an empty `allOf`, or a missing schema `name` remains absent from the discovered set and must make
  a required event fail `runtime_contract` validation.
- Contract mismatch between canonical JSON Schema and generated TypeScript declarations ->
  `contracts:check` or protocol tests fail; keep drift checking out of the runtime hot path.
- Hook config diagnostics:
  - Missing repo/user hook config -> `hooks=ok` when built-in hooks are present.
  - Malformed repo/user `.mycli/hooks.json` -> `hooks=failed` with bounded
    config issue text.
  - Missing absolute script/command path in configured hooks ->
    `hooks=failed`.
  - Configured hook uses `env_policy=inherit_safe`, is disabled, lacks an
    allowlist entry, has a digest mismatch, or has a malformed
    `~/.mycli/hook-allowlist.json` -> `hooks=warning`.
  - Hook diagnostics must not print raw tool args, hook stdin payloads, full
    command output, inherited environment values, or secrets.

#### 5. Good/Base/Bad Cases
- Good: `npm run mycli -- doctor` reports local health, redacts API keys, and exits
  `0` with only warnings.
- Good: A fresh machine without `~/.mycli/traces` or `~/.mycli/artifacts`
  reports `storage_layout=ok` without creating those directories.
- Good: preview config migration, confirm the exact plan id, and let the
  config transaction own locking, backup, validation, and atomic replacement.
- Good: export a deterministic support bundle containing relative log
  references but no log bodies, session ids, local paths, or credentials.
- Base: A fresh machine with no prior sessions gets missing-storage warnings but
  no model request.
- Base: no repair action exists, so `doctor --fix` reports `not_needed` without
  creating any file.
- Bad: Creating `traces/` or `artifacts/` just to check doctor health.
- Bad: Calling `build_turn_service()` for doctor, because that can require an
  API key and initialize runtime dependencies unrelated to diagnostics.
- Bad: Printing `sk-...` or MCP environment secret values in remediation text.
- Bad: applying a replacement plan after a conflict or using a generic archive
  of `.mycli` as a support bundle.

#### 6. Tests Required
- Unit test service success with config/storage/logs/history/MCP fixtures.
- Unit test warning-only conditions such as missing sessions DB and history.
- Unit test malformed critical `session_state` recovery payloads, including
  invalid JSON, non-object JSON, and nested suspended-turn approval or
  clarification payloads that cannot be recovered.
- Unit test nullable nested recovery fields with object, explicit `null`, and
  invalid scalar cases; object and `null` must pass while the scalar fails.
- Unit test failed MCP or storage parse/open behavior.
- Unit test storage layout reserved directories missing, present, path-conflict,
  and non-writable cases.
- Unit test trace doctor cases for missing directory, valid trace files, invalid
  rows, and bounded scan reporting.
- Unit test stream diagnostics doctor cases for missing directory, no stream
  rows, successful summary, and failed-summary redaction.
- Unit test approval diagnostics doctor cases for missing directory, no approval
  rows, successful summary, and warning-summary redaction.
- Unit test clarification diagnostics doctor cases for missing directory, no
  clarification rows, successful summary, and warning-summary redaction.
- Unit test tool execution diagnostics doctor cases for missing directory, no
  tool rows, successful summary, failed/interrupted/denied/truncated/write
    diagnostic summary, and warning-summary redaction.
- Unit test tool runtime lifecycle diagnostics for missing directory/no rows,
  complete lifecycle summary, missing terminal, terminal without start,
  duplicate terminal, malformed phase/status, and warning-summary redaction.
- Unit test tool runtime coverage registry rows for all named tool-like lanes,
  bounded payload shape, Doctor warning status for partial lanes, and redaction
  of raw command/argument/output/secret-like fields.
- Runtime policy diagnostics check:
  - Missing `~/.mycli/traces/` or no `runtime_policy_decision` trace rows ->
    `runtime_policy_diagnostics=ok` with
    `no runtime policy diagnostics found`; doctor must not create the trace
    directory.
  - Runtime policy rows must summarize only bounded fields such as decision
    kind, policy name, risk level, argument key/count, and sandbox policy
    shape.
  - Runtime policy rows for sandbox enforcement may include only bounded effect
    fields: `filesystem`, `network`, and `process`.
  - ExecPolicy prefix-rule matches may add bounded fields only:
    `execpolicy_decision`, `execpolicy_rule_source`,
    `execpolicy_rule_index`, `execpolicy_rule_pattern_hash`,
    `execpolicy_rule_pattern_length`, and
    `execpolicy_rule_argument_count`.
  - ExecPolicy diagnostics must never render the raw command, raw rule pattern
    tokens, raw argument values, or secret-like values. The pattern hash is the
    stable join point across trace, doctor, and dry-run.
  - Shell runtime enforcement metadata may expose only bounded fields:
    filesystem, network, shell, env policy, env key names, timeout seconds,
    timeout capped flag, output char limit, and cwd. It must never expose env
    values, raw command text, raw arguments, stdout/stderr bodies, or secret-like
    values.
  - Shell `tool_execution` trace payloads must keep `arguments` value-redacted
    and may expose only argument keys/count plus stdout/stderr character and
    truncation counters. Shell stdout/stderr previews must be empty.
  - Allowed-only runtime policy rows -> `runtime_policy_diagnostics=ok`.
  - `needs_approval` or `denied` runtime policy rows ->
    `runtime_policy_diagnostics=warning` with bounded decision/risk/policy
    counts.
  - Doctor must not print raw prompt, raw tool output, command text, raw
    arguments, local file payloads, headers, or secret-like values.
- Unit test turn failure diagnostics doctor cases for missing directory, no
  failed-turn rows, warning summary, and raw message/traceback/request/secret
  redaction.
- Unit test Node TUI dependency marker OK and missing-warning cases without
  creating `node_modules`.
- Unit test hook config diagnostics for missing/malformed config, allowlist
  missing/mismatch/malformed, and configured command path checks.
- Unit test session maintenance cleanup for workspace-scoped empty sessions,
  runtime-state protection, lineage protection, bounded apply limits, and CLI
  routing through `/session-maintenance --apply-empty`.
- Unit test explicit orphan child-row cleanup for multi-table orphan deletion,
  valid-row preservation, empty-session separation, and CLI/gateway routing
  through `/session-maintenance --apply-orphans`.
- Unit test explicit vacuum maintenance for before/after storage metrics,
  session preservation, cleanup-path separation, and CLI/gateway routing through
  `/session-maintenance --apply-vacuum`.
- Node protocol tests cover event methods plus required fields, property names, and enum values
  against canonical schemas.
- Unit test runtime-contract discovery against both direct object payload schemas and generated
  non-empty `allOf` payload schemas; malformed, unnamed, and empty-composition schemas stay absent.
- CLI test for `mycli doctor` command parsing and no secret leakage.
- Repair tests cover preview, exact confirmation, stale confirmation, no-op,
  per-action failure, aggregate partial failure, idempotency, and no provider IO.
- Support tests cover deterministic bytes/digest, private modes, structural
  allowlisting, fallback metadata, write containment, and fuzzed nested
  secrets, credential URLs, control characters, and cross-platform paths.
- Text/JSON tests assert the same plan id, action list, support location, byte
  count, and digest; existing gateway/TUI tests keep one root failure to one
  primary diagnostic.
- Full Node lint, type-check, tests, and contracts check must pass because doctor touches CLI
  startup paths.

#### 7. Wrong vs Correct

Wrong:
```typescript
const runtime = await startNodeBackend(options);
await runtime.submitTurn("diagnose my setup");
```

Correct:
```typescript
const report = await runDoctor(options, signal);
const response = doctorResponseFromReport(report);
```

Explicit repair:

```typescript
// Wrong: confirmation is ignored and the newest migration is applied.
await config.applyMigration((await config.previewMigration(signal)).expectedVersion!, signal);

// Correct: the confirmed Doctor plan is rebuilt and matched first.
await doctorRepairService.execute(command.expectedPlanId, signal);
```

Nullable nested recovery validation:

```typescript
// Wrong: rejects a schema-valid explicit null.
if (value !== undefined && !isRecord(value)) invalid += 1;

// Correct: null and undefined both represent no pending nested recovery.
if (value !== undefined && value !== null && !isRecord(value)) invalid += 1;
```

### Scenario: Cache-aware Runtime Diagnostics

#### 1. Scope / Trigger
- Trigger: Any runtime safety, diagnostics, observability, checkpoint, rollback, or tool-effect feature that records metadata around tool execution.
- These features are cross-layer because data can move through tool execution, turn item metadata, trace payloads, provider transcript messages, and request-shape hashing.

#### 2. Signatures
- `ToolExecutionService(..., write_diagnostics_runner: Callable[[tuple[str, ...]], dict[str, object]] | None = None)`
- `WriteDiagnosticsService(workspace_root: Path).run(paths: tuple[str, ...]) -> dict[str, object]`
- Runtime dry-run:
  `RuntimeDryRunDiagnostics().render(diagnostics: dict[str, object]) -> dict[str, object]`
- Provider dry-run:
  `ProviderRequestDryRunRenderer.render(..., runtime_diagnostics: dict[str, object] | None = None) -> dict[str, object]`
- Runtime trace kinds:
  `runtime_policy_decision`, `tool_runtime_lifecycle`, `session_continuity`,
  and `tool_execution`.

#### 3. Contracts
- Allowed cache-volatile/local fields:
  - turn item metadata such as `write_diagnostics`
  - trace payload fields such as `write_diagnostics_count` and `write_diagnostics_error`
  - post-execution tool result `raw_payload` fields
  - dry-run runtime summaries such as exposed tool names/counts, policy
    decision counts, sandbox shape counts, approval lane state, lifecycle
    counts, and session continuity counts
- Forbidden stable-surface changes unless the actual user-visible contract changes:
  - stable system prompt text
  - model-visible `ToolSpec`
  - deterministic tool ordering
  - previous provider transcript messages
- Runtime policy trace rows may render only bounded fields: decision, policy,
  risk level, argument key/count, and sandbox filesystem/network/shell shape.
  Sandbox enforcement rows may additionally render the bounded effect summary
  fields `filesystem`, `network`, and `process`.
  If an ExecPolicy prefix rule matched, the row may additionally render bounded
  rule metadata: decision, source, pattern hash, pattern length, and command
  argument count. It must not render raw rule tokens or command text.
  They must not render raw argument values or command text.
- Runtime dry-run diagnostics must ignore unknown payload fields and must not
  render raw prompts, raw tool output, raw tool argument values, raw command
  text, provider payload bodies, secrets, provider keys, or full
  `prompt_cache_key` values.
- Doctor runtime policy diagnostics must include bounded sandbox profile counts
  alongside allowed / denied / needs_approval counts.
- Diagnostic failures are best-effort: they may record an error string but must not convert a successful write into a failed write.

#### 4. Validation & Error Matrix
- Successful structured file write -> run bounded diagnostics for changed paths.
- Failed validation or failed tool execution -> do not run diagnostics.
- No-op write -> do not run diagnostics.
- Diagnostic runner exception -> record diagnostic error; preserve original tool success.
- Missing diagnostic runner -> preserve existing behavior.
- Checkpoint/guardrail exit -> append a local `guardrail` trace event with bounded trigger diagnostics.
- Runtime policy row with `sandbox` -> doctor reports bounded filesystem,
  network, and shell counts.
- Runtime policy row with `effect` -> trace inspection, doctor, and dry-run may
  aggregate bounded filesystem/network/process effect state, but must not render
  raw argument values that produced the effect.
- Runtime policy row with `policy=sandbox_filesystem_policy`,
  `sandbox_shell_policy`, or `sandbox_network_policy` -> doctor reports bounded
  denial counts and remains warning-level when any denial exists.
- Runtime policy row with raw `arguments` or `command_pattern` -> trace
  inspection and doctor output omit those values.
- Runtime policy row with ExecPolicy fields -> doctor and dry-run report
  bounded decision/source counts and rule summary count without raw rule
  pattern tokens.
- Provider dry-run rendered with runtime diagnostics -> output includes
  `runtime_diagnostics` with exposed tool summary, policy decision summary,
  sandbox lane, approval lane, tool lifecycle counts, and session continuity
  counts.
- Provider dry-run runtime diagnostics containing extra raw fields -> renderer
  ignores them.

#### 5. Good/Base/Bad Cases
- Good: `Write` succeeds, `write_diagnostics` appears in turn metadata and trace count is available.
- Good: provider-free dry-run reports
  `approval_lane.state=needs_approval` and
  `sandbox_lane.shell.restricted=1` without command text.
- Good: `/trace` renders `decision=needs_approval args=1 keys=command
  sandbox=fs:workspace_write,net:enabled,shell:restricted`.
- Base: No diagnostic runner is configured and tool execution output is unchanged.
- Bad: A diagnostic warning is inserted into stable system instructions or model-visible tool schema.
- Bad: rendering `arguments.command`, raw user text, stdout/stderr bodies,
  provider payloads, or full provider cache keys in doctor, trace, or dry-run.

#### 6. Tests Required
- Unit test successful write diagnostics metadata and trace payload.
- Unit test failed validation and no-op write skip diagnostics.
- Unit test diagnostic exceptions do not fail the write.
- Unit test interrupted tool execution emits failed lifecycle/trace diagnostics,
  discards pending file-history snapshots, and re-raises the interrupt for
  turn-level recovery.
- Unit test guardrail trace payloads for checkpoint exits.
- Request-shape regression proving diagnostic metadata does not change stable system hash, tool schema hash, tool order hash, or replay hash when transcript content is unchanged.
- Unit test runtime dry-run diagnostics redaction and bounded summaries.
- Unit test runtime policy doctor sandbox counts and raw argument redaction.
- Unit test trace inspection renders bounded runtime policy fields without raw
  argument values.
- Unit test ExecPolicy parser/loader for user/project sources and project
  override precedence.
- Unit test RuntimePolicyGate and runtime execution for ExecPolicy
  `allow`/`deny`/`ask` decisions on `Bash` / `run_shell`.
- Unit test ExecPolicy trace, doctor, and dry-run redaction.
- Unit test shell runtime enforcement for workspace cwd, sanitized env, timeout
  cap, output limit metadata, and runtime-only argument filtering.
- Unit test sandbox enforcement for read-only filesystem write/unknown effects,
  shell disabled overriding ExecPolicy allow, and network disabled blocking
  network-effect tools before execution.
- Unit test sandbox-denied trace and doctor diagnostics include bounded effect
  metadata and exclude raw command text, raw args, raw URLs, stdout/stderr,
  headers, and secrets.
- Provider-free smoke must include runtime diagnostics fields.

#### 7. Wrong vs Correct

Wrong:
```typescript
contract.baseInstructions += `\nLatest diagnostics: ${diagnostics}`;
```

Correct:
```typescript
const rawPayload = { ...result.rawPayload, writeDiagnostics: diagnostics };
```

Keep runtime diagnostics appended after execution and outside stable request-shape inputs.

---

### Scenario: Cache-aware Session Storage Layout

#### 1. Scope / Trigger
- Trigger: Any runtime persistence, trace, log, artifact, or session lifecycle feature that writes under the user-level `.mycli` home.
- This is cache-sensitive because local persistence must not change stable prompt construction or provider transcript replay.

#### 2. Signatures
- `MycliStorageLayout.from_home_dir(home_dir: Path) -> MycliStorageLayout`
- `MycliStorageLayout.trace_path(session_id: str) -> Path`
- `MycliStorageLayout.legacy_trace_path(session_id: str) -> Path`
- `TraceService(home_dir: Path).append(session_id: str, event: RuntimeTraceEvent) -> None`
- `TraceService(home_dir: Path).load(session_id: str) -> tuple[RuntimeTraceEvent, ...]`

#### 3. Contracts
- Preferred user-home layout:
  - `~/.mycli/sessions.db` remains the session DB path.
  - `~/.mycli/traces/{session_id}-trace.jsonl` is the preferred trace path.
  - `~/.mycli/sessions/{session_id}-trace.jsonl` is legacy read-only fallback for traces.
  - `~/.mycli/artifacts/` is reserved for non-transcript payload artifacts.
  - `~/.mycli/logs/` is reserved for operational logs.
- Trace payloads are local diagnostics only. They must not be used to rebuild provider transcript messages.
- Trace payloads must store bounded previews for full-content fields such as nested `metadata.raw_payload.content` and `metadata.transcript_content`.

#### 4. Validation & Error Matrix
- Valid session ID -> append/read trace normally.
- Empty, placeholder-like, path-like, or traversal-like session ID -> raise `ValueError`; do not create a trace file.
- New trace file exists -> load from `traces/`.
- No new trace file and legacy trace exists -> load from `sessions/`.
- Corrupt JSONL row -> skip row and keep loading valid trace events.

#### 5. Good/Base/Bad Cases
- Good: `TraceService.append("demo", event)` writes `.mycli/traces/demo-trace.jsonl` and stores content previews/counts.
- Base: A user with old `.mycli/sessions/demo-trace.jsonl` can still inspect trace output.
- Bad: Creating `.mycli/sessions/<session>-trace.jsonl` or dumping full file content into a `turn_item` trace event.

#### 6. Tests Required
- Unit test new trace writes go to `traces/`, not `sessions/`.
- Unit test legacy trace fallback from `sessions/`.
- Unit test invalid session ID rejection.
- Unit test trace payload sanitization for `raw_payload.content` and `transcript_content`.
- Runtime/CLI trace rendering tests should continue to pass without provider-facing request-shape changes.

#### 7. Wrong vs Correct

Wrong:
```typescript
const path = join(homeDir, ".mycli", "sessions", `${sessionId}-trace.jsonl`);
await appendFile(path, JSON.stringify(event));
```

Correct:
```typescript
const path = storageLayout.tracePath(sessionId);
await appendFile(path, JSON.stringify(sanitizedTracePayload));
```

Keep storage layout centralized and treat trace files as bounded diagnostics, not as a second full transcript store.

---

### Scenario: Deterministic Process-Tree Timeout Tests

#### 1. Scope / Trigger
- Trigger: integration tests that start Node, MCP, plugin, hook, shell, or other child-process trees
  and assert timeout, interruption, or cleanup behavior.
- These tests run concurrently with other process-heavy files. A timeout that is safe for a warm
  single-file run is not evidence that the fixture reached the state the test intends to clean up.

#### 2. Signatures
- Readiness helper: `readFileEventually(path) -> Promise<string>` or an equivalent explicit
  child-process handshake.
- Cleanup helper: `assertProcessStops(pid) -> Promise<void>`.
- Operation timeout: a product-facing timeout passed to the runtime under test, separate from the
  test runner's outer deadline.

#### 3. Contracts
- A process-tree cleanup test must prove the descendant started before asserting that cleanup stopped
  it. Use a PID/readiness marker written by the descendant or a protocol-ready event.
- The product timeout must include realistic cold-start and scheduler margin for the slowest CI
  platform. Use a separate outer test deadline to detect hangs; do not encode scheduler performance
  into a 50-100ms product timeout merely to keep the test fast.
- Local executable handshakes, including the Windows sandbox helper protocol probe, must allow at
  least five seconds for cold-start and endpoint-security scheduling before failing closed.
- Polling for a readiness marker after the timed operation returns cannot repair an operation timeout
  that killed the parent before the marker was created.
- Keep assertions semantic: timeout result, known descendant PID, eventual process-tree absence, and
  bounded diagnostics. Do not assert exact elapsed milliseconds.

#### 4. Validation & Error Matrix
- Timed operation returns before readiness marker exists -> test setup failure, not cleanup evidence.
- Marker identifies a live descendant and timeout returns expected result -> poll for process exit.
- Descendant remains live past the cleanup deadline -> cleanup regression.
- Test passes alone but fails in the full package suite -> treat as an implicit scheduling assumption;
  reproduce in the full suite before modifying production cleanup.

#### 5. Good/Base/Bad Cases
- Good: allow one second for a Node hook tree to cold-start under concurrent load, confirm its PID
  marker, then assert the timeout result and eventual PID absence.
- Good: give the local Windows sandbox helper five seconds to return its bounded protocol handshake,
  then fail closed on timeout, malformed JSON, identity mismatch, or protocol mismatch.
- Base: a fake controller unit test uses a deterministic clock and does not start OS processes.
- Bad: use a 100ms timeout, wait for a marker only after the operation ends, and increase marker
  polling when the full suite fails.

#### 6. Tests Required
- Run the focused file to verify the semantic path.
- Run the complete owning package suite to reproduce scheduler/process contention.
- Run the repository-wide suite before completion because workspace concurrency can change startup
  timing again.
- Cross-platform CI must cover the process-sensitive test on the minimum and current Node versions.

#### 7. Wrong vs Correct

Wrong:
```typescript
const result = await runTree({ timeoutMs: 100 });
const pid = await readFileEventually(marker); // The parent may have died before creating it.
```

Correct:
```typescript
const result = await runTree({ timeoutMs: 1_000 });
const pid = Number(await readFileEventually(marker));
assert.equal(result.kind, "timeout");
await assertProcessStops(pid);
```

---

### Scenario: Deterministic Agent Worker Integration Memory Tests

#### 1. Scope / Trigger
- Trigger: app integration tests that repeatedly construct real `AgentWorkerPool` instances in one
  Node test-file process.
- The production pool intentionally samples total process RSS. A long TypeScript integration file can
  retain enough allocator/code memory between otherwise closed backends to cross the production soft
  limit, even though the test is serial and every individual case passes.

#### 2. Signatures
- Direct-start test seam:
  `StartNodeBackendOptions.agentWorkerReadProcessRssBytes?: () => number`.
- Shared app-test composition:
  `startTestNodeBackend(options) -> ReturnType<typeof startNodeBackend>`.
- Production composition omits the seam and therefore keeps
  `AgentWorkerPoolOptions.readProcessRssBytes = () => process.memoryUsage.rss()`.

#### 3. Contracts
- Tests whose subject is backend behavior rather than memory pressure must use
  `test/support/offline-update-fetch.ts` so update I/O and process RSS are deterministic.
- The shared helper supplies a fixed non-negative RSS value. It must not change production defaults,
  exported memory limits, CLI environment behavior, or supervisor composition.
- Agent Worker memory-pressure behavior remains covered in `@mycli/runtime` with injected RSS values
  around the soft and hard boundaries.
- Serial test execution limits concurrent process load but is not a substitute for RSS injection:
  allocator-retained memory can still accumulate within one large test file.
- Do not solve this failure class by increasing product thresholds, lengthening child wait timeouts,
  or globally monkey-patching `process.memoryUsage`.

#### 4. Validation & Error Matrix
- Focused Worker test passes and the full app file passes -> accept the behavioral result.
- Focused Worker test passes, full app file stalls, and sampled RSS is above the production soft limit
  -> inspect shared test composition before changing runtime or timeout behavior.
- A memory-pressure unit test uses the shared low-RSS helper -> invalid coverage; construct the pool
  directly with explicit boundary RSS values.
- Production or supervisor startup supplies the test seam -> invalid composition; remove the override
  so real RSS protection remains active.
- Test seam returns a negative, fractional, or non-finite value -> pool validation fails closed.

#### 5. Good/Base/Bad Cases
- Good: app backend integration tests use `startTestNodeBackend`, while runtime pool tests inject
  soft/hard RSS values directly and assert queue/rejection outcomes.
- Base: a direct production `startNodeBackend` call omits the test seam and samples real process RSS.
- Bad: increase a 5-second child wait to 30 seconds when the child lease was deliberately held by
  soft pressure and never started.
- Bad: raise the production 1.5/2 GiB limits only to make one accumulated test process pass.

#### 6. Tests Required
- Run the affected Worker tests by exact name to prove their semantic path independently.
- Run the complete `node-backend.integration.test.ts` file to exercise accumulated test-process RSS.
- Run the complete `@mycli/app` suite and repository-wide `npm test` before completion.
- Keep `AgentWorkerPool` unit coverage for normal, soft, hard, queue-timeout, idle-retirement, and
  interactive-reuse behavior on the real production decision logic.

#### 7. Wrong vs Correct

Wrong:
```typescript
// Hides a test-process artifact by weakening the product for every user.
export const DEFAULT_AGENT_WORKER_RSS_SOFT_LIMIT_BYTES = 3 * 1024 ** 3;
```

Correct:
```typescript
return startNodeBackend({
	updateFetch: offlineUpdateFetch,
	agentWorkerReadProcessRssBytes: () => 0,
	...options,
});
```

Keep the deterministic override at the direct-start app-test boundary; production memory pressure
must continue to observe the actual process.

---

### Scenario: Configuration And UX Baseline Drift Gate

#### 1. Scope / Trigger
- Trigger: adding or changing a provider-free management command, slash command, shell setting,
  gateway contract, startup gate, or configuration/TUI journey covered by the UX baseline.
- The gate keeps parser, help, docs, TUI descriptors, generated gateway contracts, and distributed
  provider-free tests discoverable without adding another end-to-end framework.

#### 2. Signatures
- Manifest: `tests/fixtures/configuration_ux/baseline.json` with `schema_version: 1`.
- Canonical CLI metadata: `CLI_COMMAND_CATALOG`, `ROOT_CLI_OPTIONS`, and `COMPLETION_SHELLS` in
  `backend/apps/mycli/src/management/cli-command-catalog.ts`.
- Derived CLI surfaces: `CLI_COMMAND_NAMES`, `MANAGEMENT_COMMAND_NAMES`, and `renderRootHelp()` from
  the same catalog module.
- Completion command: `mycli completion <bash|zsh|fish|powershell>`.
- Completion renderer: `renderShellCompletion(shell: CompletionShell) -> string`.
- Keymap catalog: `TUI_KEYMAP_ACTIONS` and `tui.keymap.<context>.<config-key>` paths in
  `backend/packages/contracts/src/tui-keymap.ts`.
- Settings RPCs: `settings.load`, `settings.save`, and `settings.keymap.reset`.
- Settings snapshot fields: `settings`, `sources`, `keymap`, `terminal_capabilities`, and `catalog`.
- Focused command: `npm run test:ux-contracts`.
- Report: `docs/parity/configuration-ux-baseline.md`.

#### 3. Contracts
- The manifest keeps the required journey IDs in stable order and links each journey to at least one
  repository-relative file plus an exact `test("...")` declaration.
- Journey evidence is provider-free and covers `darwin`, `linux`, and `win32`; platform-specific
  behavior may use a narrower platform list.
- Checked-in measurements are deterministic structural values. Machine-dependent wall-clock
  startup profiling remains explicit opt-in through `MYCLI_STARTUP_PROFILE=1`.
- UX budgets explicitly cover first-paint network blocking, root-failure diagnostic count, selector
  response, minimum terminal width, destructive defaults, Esc cancellation, draft preservation,
  and PTY readiness.
- The manifest and report contain no captured credentials, prompts, provider output, tool content,
  secret-shaped values, or user-specific absolute paths.
- `CLI_COMMAND_CATALOG` is the only production registry for root command names, execution lanes,
  usage, descriptions, actions, options, and fixed candidate values. Parser membership, root help,
  and all four completion renderers derive from it; shell-specific code may format metadata but must
  not carry a second command list.
- Completion is a distinct `CliMode`, writes plain text directly to stdout, and returns before
  management composition, backend/provider construction, or TUI import. Missing, extra, or unknown
  shell arguments return the ordinary bounded argument error with exit code `2`.
- Interactive mode requires terminal stdin and stdout and returns one `tty_required` line otherwise.
  Provider-free management and completion commands remain valid under non-TTY streams and never
  emit TUI control sequences.
- Effective keymaps derive from `TUI_KEYMAP_ACTIONS` plus layered config. Key names are normalized,
  lists are bounded to eight unique entries, required actions cannot be unbound, and two actions in
  one input context cannot claim the same key. A validation or persistence failure leaves the prior
  effective keymap active.
- `settings.keymap.reset` clears only the user `[tui.keymap]` table, re-resolves every layer, and
  returns the same complete settings snapshot as load/save. The searchable settings catalog exposes
  each effective binding, its source, overridden layers, and the reset action without private values.
- Terminal capabilities are detected once per backend launch from bounded environment signals and
  combined with `tui.color_mode`, `tui.glyph_mode`, `tui.reduced_motion`,
  `tui.terminal_progress`, and `tui.high_contrast`. `NO_COLOR`, `MYCLI_TUI_COLOR=never`, and
  `TERM=dumb` force no-color output; `TERM=dumb` also forces ASCII glyphs. The gateway projects only
  the resolved enum/boolean state and at most two bounded guidance strings.
- TUI chrome consumes semantic color and glyph tokens. `none` emits no ANSI color sequences, ASCII
  mode removes product-owned non-ASCII chrome, and reduced motion uses a static progress indicator
  without changing transcript meaning or layout dimensions.
- Slash commands, aliases, and shell setting keys are generated or checked from their canonical
  registries rather than copied into another production registry.
- Gateway drift checks compare the generated contract catalog with the frozen M8 gateway evidence.

#### 4. Validation & Error Matrix
- Missing or reordered required journey -> focused gate fails with the manifest mismatch.
- Absolute evidence path, path traversal, missing file, or stale test name -> focused gate fails
  before accepting the baseline.
- Secret-shaped manifest/report value or common user-home absolute path -> privacy assertion fails.
- Root command/action/option added outside `CLI_COMMAND_CATALOG` -> help/completion/parser drift test
  fails; move the metadata into the catalog instead of copying it to the missing surfaces.
- Completion shell missing a catalog token, registration line, trailing newline, or plain-text
  output guarantee -> completion unit or CLI isolation test fails.
- Completion or management command starts the backend/provider/TUI under non-TTY streams -> CLI
  isolation test fails.
- Malformed key name, more than eight keys, an empty required action, or a same-context conflict ->
  typed `invalid_value`; do not apply a partial map.
- Keymap reset write/re-resolution failure -> retain the previous TUI state and show one bounded
  selector error.
- `NO_COLOR`, `MYCLI_TUI_COLOR=never`, or `TERM=dumb` paired with colored output -> capability/TUI
  regression fails.
- Slash command or alias omitted from docs -> canonical matrix comparison fails.
- `SHELL_SETTING_DESCRIPTORS` key omitted from docs -> descriptor comparison fails.
- Gateway method/event drift without updated frozen evidence -> count or required-surface assertion
  fails.
- Local startup timing varies while structural budgets remain unchanged -> no CI failure; investigate
  with the opt-in stage profile and update a numeric release budget only through an explicit change.

#### 5. Good/Base/Bad Cases
- Good: add one command descriptor to `CLI_COMMAND_CATALOG`; parser, help, Bash, Zsh, Fish, and
  PowerShell discover the same command through derived metadata.
- Good: add a keymap action to `TUI_KEYMAP_ACTIONS`, consume its normalized effective binding in the
  owning input context, and cover conflict/reset behavior.
- Good: add a shell setting descriptor, document its canonical `tui.*` key, and map it through a
  semantic TUI token rather than branching in every component.
- Base: improve one journey's existing provider-free test and update only its exact evidence name.
- Bad: add a second hand-maintained production command list solely for help, completion, or a drift
  test.
- Bad: inspect environment capability variables inside individual TUI components after the backend
  has already projected a resolved capability snapshot.
- Bad: check in a startup profile containing a local home path, session ID, prompt, or provider data.
- Bad: assert shared-runner wall-clock milliseconds without a documented performance budget.

#### 6. Tests Required
- Run `npm run test:ux-contracts` for manifest schema/order, evidence, privacy, and cross-surface drift.
- Run every added or renamed evidence test, not only the declaration-link check.
- Test catalog derivation, parser routing, every catalog token in all four completion outputs, one
  registration statement per shell, no ANSI, and a final newline. Parse Bash/Zsh output with the
  real shell when installed; keep deterministic token drift coverage for Fish/PowerShell where the
  host shell is unavailable.
- Test completion under non-TTY streams with zero management/backend/provider/TUI starts. Keep one
  concise `tty_required` assertion for interactive non-TTY invocation.
- Test layered keymap precedence, normalization, conflicts, required actions, reset success/failure,
  searchable catalog projection, custom action dispatch, and default restoration.
- Test capability detection/resolution plus TUI no-color, ASCII-only chrome, reduced-motion, and
  high-contrast projection. Keep CJK/IME paste and layout cases at widths `60`, `80`, `100`, and
  `140` with long Unix and Windows paths.
- Run `npm run lint`, `npm run typecheck`, and `npm run contracts:check`.
- Run the packed CLI smoke when root help, command composition, or a published entry changes. If a
  platform archive download is unavailable, record the external failure and still run the
  provider-independent `--app-only` packed smoke.
- Keep sixty-column CJK/IME, Esc/draft, one-root-failure/one-diagnostic, background-update, and native
  PTY readiness regressions represented by provider-free tests.

#### 7. Wrong vs Correct

Wrong:
```typescript
const managementCommands = ["setup", "doctor"];
const bashCommands = "setup doctor completion"; // A second registry can silently drift.
```

Correct:
```typescript
import {
	CLI_COMMAND_CATALOG,
	MANAGEMENT_COMMAND_NAMES,
	renderRootHelp,
} from "../src/management/cli-command-catalog.ts";
import { renderShellCompletion } from "../src/management/completion.ts";

for (const command of CLI_COMMAND_CATALOG) {
	assert.ok(renderRootHelp().includes(command.usage));
	assert.ok(renderShellCompletion("bash").includes(command.name));
}
assert.deepEqual(
	MANAGEMENT_COMMAND_NAMES,
	CLI_COMMAND_CATALOG.filter((command) => command.execution === "management")
		.map((command) => command.name),
);
```

---

## Code Review Checklist

<!-- What reviewers should check -->

(To be filled by the team)
