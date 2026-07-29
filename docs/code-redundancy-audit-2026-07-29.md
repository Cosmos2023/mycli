# mycli Python / TypeScript redundancy audit

Date: 2026-07-29

## Scope

This audit covers production Python under `src/mycli` and TypeScript under
`tui/mycli-shell/src`. Tests and evaluation programs were inspected as callers,
but their line counts are not included in the production baseline.

The worktree already contains unrelated uncommitted changes. Line references in
this document describe the audited worktree and may move as those changes are
integrated.

## Baseline

| Area | Files | Lines |
| --- | ---: | ---: |
| Python (`src/mycli`) | 331 | 84,282 |
| TypeScript (`tui/mycli-shell/src`) | 80 | 25,533 |
| Total | 411 | 109,815 |

Largest ownership areas:

| Area | Lines |
| --- | ---: |
| `src/mycli/services` | 21,321 |
| `src/mycli/application/runtime` | 19,234 |
| `tui/mycli-shell/src/tui-core` | 11,777 |
| `src/mycli/tools` | 11,420 |
| `src/mycli/cli` | 7,998 |
| `src/mycli/llms` | 6,231 |
| `src/mycli/domain` | 6,054 |

Largest individual files:

| File | Lines |
| --- | ---: |
| `services/diagnostics/doctor.py` | 4,498 |
| `tui/mycli-shell/src/adapters/runtime-state.ts` | 3,414 |
| `cli/node_tui/gateway.py` | 3,251 |
| `application/runtime/turn_executor.py` | 2,970 |
| `application/runtime/agent_runtime.py` | 2,641 |
| `tui/mycli-shell/src/tui-core/components/editor.ts` | 2,360 |
| `tui/mycli-shell/src/shell-runtime.ts` | 2,140 |
| `application/runtime/tools/tool_execution_service.py` | 2,125 |
| `application/turn_service.py` | 1,937 |
| `tui/mycli-shell/src/tui-core/tui.ts` | 1,726 |

File size alone is not evidence of dead code. The findings below require either
zero callers, an inactive dependency chain, an exact duplicate, or a compatibility
path with a concrete canonical replacement.

## Implementation progress

Current production snapshot after the completed cleanup below:

| Area | Files | Lines |
| --- | ---: | ---: |
| Python (`src/mycli`) | 317 | 78,433 |
| TypeScript (`tui/mycli-shell/src`) | 80 | 24,591 |
| Total | 397 | 103,024 |

Completed cleanup items:

- R1: removed the inactive terminal bitmap rendering pipeline while preserving
  image attachments, capability detection, hyperlinks, and Kitty row cleanup.
- R2: removed `isPunctuationChar()`.
- R3: removed the obsolete `EditorComponent`, dead key parsing/helper APIs, and
  unused barrel exports; `knip` now reports only the dynamic `setup.ts` entry and
  two declaration-merging/dynamic-entry type false positives.
- R4: migrated the summarizer adapter to `RequestMessageProjector`, deleted
  `message_builder.py`, and moved tool-call, metadata, and image-path assertions
  to projector tests.
- R5: removed the private forwarding layer around request projection, tool
  routing/execution, assistant conversation recording, model requests, event
  persistence, planning effects, and approval decisions. Turn execution and
  collaborator construction now call the existing owners directly.
- R9: made clarification tool execution reuse `_record_tool_start()`.
- R10: unified normal-turn and approval-resume completion event emission while
  retaining each worker's distinct suppression and cleanup behavior.
- R14: removed the uncalled `TurnService._format_allowed_choices()` duplicate;
  runtime formatting remains owned by `RuntimeApprovalDecisions`.
- R12: made `default_tools()` the single built-in tool inventory and parameterized
  its filesystem roots, unrestricted mode, and pre-runtime `Task` inclusion.
- R13: made `RuntimePolicyGate.default_policy()` the single sandbox policy owner;
  runtime context now reads that policy through an injected provider.
- R15: generalized the existing queue record filter so legacy user migration,
  task notification drain, and capacity eviction share one implementation.
- R16: centralized tolerant trace-event line parsing across Doctor diagnostics.
- R18: extracted the duplicated provider filtering, movement, visible-window,
  status, and empty-state rendering shared by login and setup selectors while
  retaining their distinct row details.
- R19: centralized cache/durability/scope metadata projection for contextual
  instruction fragments.
- R20: centralized gateway runtime identity projection across bootstrap, welcome,
  and status payloads.
- R21: removed dead legacy slash display construction and centralized repeated
  Markdown styling, ANSI string parsing, and bracketed-paste completion paths.
- R22: centralized compact diff styling, provider-local connection/validation
  error mapping, OpenAI tool parameter schema projection, and Editor change and
  post-delete autocomplete notifications.
- Second Python sweep: removed definition-only runtime helpers, the obsolete
  Windows shell parser, stale forwarding APIs, and test-only compatibility
  surfaces across request construction, session state, tools, planning, and
  context handling.
- Removed the production-unreachable Rich/Structlog rendering and logging chains,
  plus the unused `langchain`, `rich`, `pygments`, and `structlog` dependencies.
- Removed the unintegrated provider payload snapshot/dry-run subsystem and
  migrated the provider cache smoke test to the active `CacheShapeDiagnostics`
  path.
- Removed duplicate function-style Edit, Write, and Bash safety APIs while
  preserving the active Tool classes, shell runtime, and centralized safety
  classifier.
- Removed the single-conversation `ConversationTree` wrapper and made
  `SessionService` call the canonical `Conversation.rewind()`/`fork()` methods
  directly with the existing duplicate-session guard.
- Removed the old `ContextManager` tool-result renderer; model-visible tool
  output remains owned by `ToolModelOutputProjector` and `ToolResultFormatter`.
- Retired the historical evaluation product surface: the package runner and
  probes, `--eval-*` CLI options, seven scenario suites, wrapper scripts, and
  tests that existed only for that subsystem. Independent focused smoke scripts
  remain under top-level `evaluation/`.
- Removed the obsolete `EnterPlanMode`/`ExitPlanMode` compatibility chain while
  preserving the canonical `Plan` tool, runtime plan state, and TUI
  collaboration modes.
- Retired the line-oriented `--plain` conversation mode, its REPL, dedicated
  renderer, readline installation, Node startup fallback, and plain-only tests.
  Interactive conversations now require a TTY and use the Node TUI; scriptable
  utility commands and the setup wizard's independent text fallback remain.
- Removed definition-only and test-only compatibility APIs for file backups,
  history replacement, runtime context/budget wrappers, provider history
  projection, Responses payload construction, token cache metrics, timeline
  metadata, runtime coverage aliases, MCP schema hydration, adapter capability
  probes, and shell output cursors. Tests now exercise the active owners and
  production paths directly.

R17 was implemented and regression-tested, then deliberately reverted: the
generic string-dispatched capability wrapper reduced production code by only one
line and made protocol behavior less explicit. The direct adapter-local checks
remain preferable unless a typed client boundary can remove substantially more
code without hiding protocol differences.

The current snapshot is 6,791 production lines below the audit baseline. This
number includes all completed cleanup already present in this worktree; it does
not claim that every line difference belongs to a single commit.

Verification for this pass:

- `uv run ruff check src/mycli tests evaluation`: passed.
- `uv run mypy src/mycli`: passed for 317 source files.
- Focused dead-interface cleanup regression suite: 236 passed.
- Focused request projection, request shape, compaction, AgentRuntime, tool
  execution, approval, and TurnService tests: passed.
- Combined cleanup regression suite: 428 passed.
- AgentRuntime/TurnExecutor/tool execution regression suite after R5: 307 passed.
- Node gateway unit and integration modules after R10: 136 passed.
- Full Python suite: 2,446 passed and 30 skipped after retiring plain-only tests
  and deleting tests that only exercised removed production-unreachable APIs.
- `npm run typecheck`: passed.
- `npm test`: 357 passed.
- `evaluation/hook_smoke.py` and `evaluation/tool_management_smoke.py`: passed
  through the active slash resolver and dispatcher after REPL removal.
- `uv run python evaluation/provider_cache_policy_smoke.py`: passed against the
  active Responses, Anthropic, and Chat cache-policy paths.
- `uvx vulture src/mycli --min-confidence 80`: only three protocol/context-manager
  callback parameters remain; no high-confidence removable implementation was
  reported.
- The former 38 gateway failures were stale test doubles. Their title-cache and
  permission-profile fixtures now implement the current service contract; both
  gateway modules and the full Python suite pass.
- `knip`: only the dynamic `setup.ts` entry, the test-only `rg` binary, and the
  required `SetupWizardState`/`Keybindings` exports remain reported.
- Current 12-line/100-token `jscpd` pass: 12 clone groups and 235 duplicated
  lines (0.22%), down from 24 groups and 510 lines at the start of this pass.

## Audit methods

The following checks were used:

1. Python AST import graph across production, tests, and evaluation programs.
2. `vulture src/mycli --min-confidence 80` through `uvx`.
3. `knip` for TypeScript files, exports, and exported types.
4. `jscpd` with a 10-line / 80-token threshold across Python and TypeScript.
5. Exact repository searches for legacy aliases, dynamic entry points, and all
   reported symbols.
6. Manual inspection of every high-value duplicate cluster.

Results:

- No ordinary Python module has zero inbound references.
- The only zero-inbound Python module is `services/plugins/worker.py`, which is a
  dynamic `python -m` process entry point and must remain.
- `vulture` reported only five unused interface parameters. They belong to
  Protocol/context-manager contracts and are false positives.
- `knip` reported one unused file, `src/setup.ts`. It is a false positive because
  Python launches it dynamically from `cli/node_tui/process.py` and
  `cli/setup_wizard.py`.
- `knip` reported 70 unused exports and 59 unused exported types. Most
  implementations are used inside their own module; the unnecessary part is the
  public `export`, not the implementation.
- `jscpd` found 70 clone groups: 985 duplicated Python lines and 239 duplicated
  TypeScript lines. Total clone density is 1.12%.

## Priority 0: directly removable

These findings have no current runtime caller and do not require preserving a
legacy session protocol.

### R1. Inactive terminal image rendering pipeline (completed)

File: `tui/mycli-shell/src/tui-core/terminal-image.ts`

The deleted `Image` component was the only consumer of the image encoding and
dimension pipeline. Current callers import only:

- `getCapabilities`
- `isImageLine`
- `deleteKittyImage`
- `setCellDimensions`
- `hyperlink`

The following chain now has no caller outside its own definitions and the barrel
file:

- `ImageDimensions` and `ImageRenderOptions`
- `getCellDimensions`
- `resetCapabilitiesCache` and `setCapabilities`
- `allocateImageId`
- `encodeKitty` and `encodeITerm2`
- `deleteAllKittyImages`
- `ImageCellSize`, `calculateImageCellSize`, and `calculateImageRows`
- PNG, JPEG, GIF, and WebP dimension parsers
- `getImageDimensions`
- `renderImage`
- `imageFallback`

The corresponding exports in `tui-core/index.ts` are also unused.

Estimated reduction: 330-355 TypeScript lines.

Risk: low. Keep capability detection, hyperlink handling, image-line detection,
Kitty cleanup for already-rendered rows, and cell-dimension updates.

This removal must not touch the image attachment pipeline:
`local-image-attachments.ts`, the editor placeholder/drop handling in
`shell-runtime.ts`, `local_images` gateway payloads, Python `image_paths`,
`domain/runtime/images.py`, or provider image serialization. Those paths are
active and are responsible for adding local images to model input. The removable
code only renders bitmap data directly inside the terminal through Kitty/iTerm2
escape sequences.

### R2. Unused punctuation helper (completed)

File: `tui/mycli-shell/src/tui-core/utils.ts:781`

`isPunctuationChar()` has exactly one repository occurrence: its definition.
`PUNCTUATION_REGEX` and `isWhitespaceChar()` are active and must remain.

Estimated reduction: 3-6 lines.

Risk: low.

### R3. TypeScript barrel/public surface (completed)

`knip` reports 70 unused exports and 59 unused exported types. Examples include
the helper exports in `gateway-client.ts`, `footer.ts`,
`session-selector-search.ts`, and many `tui-core/index.ts` re-exports.

Most have two or more occurrences inside their defining module, so deleting the
function would be incorrect. Remove only the `export` keyword or unused barrel
entry unless an exact search confirms that the symbol has one occurrence.

Estimated reduction: small (roughly 40-90 declaration/export lines), but it
materially reduces the accidental API surface and improves future `knip` signal.

Risk: low because `mycli-shell` is a private package. `setup.ts` remains a dynamic
entry point and is excluded.

## Priority 1: migrate callers, then delete

These are real redundant paths, but current callers or tests still depend on
them. They should be removed by moving callers to the canonical implementation,
not by retaining another forwarding wrapper.

### R4. Duplicate message projection implementation (completed)

Files:

- `application/runtime/message_builder.py` (133 lines)
- `application/runtime/request/message_projection.py`

Both implement conversion from `Message` to runtime blocks, tool calls, tool
results, metadata, and provider-visible content. The request pipeline already
uses `RequestMessageProjector`; the old module remains because the summarizer
adapter in `agent_runtime.py` and `test_runtime_message_builder.py` import it.

Action:

1. Make the summarizer adapter use `RequestMessageProjector`.
2. Move the remaining behavior assertions to projector tests.
3. Delete `message_builder.py` and its dedicated compatibility tests.

Estimated net reduction: 100-130 Python lines.

Risk: medium. Tool-call IDs, block metadata, images, and post-tool additional
contexts must remain byte-for-byte equivalent in provider payload tests.

### R5. AgentRuntime private forwarding layer (completed)

File: `application/runtime/agent_runtime.py`

AST inspection found 52 one-statement forwarding methods occupying 486 lines.
Of these, 32 private forwarding methods occupy 385 lines. High-cost examples:

- `_execute_tool_call`: 36 lines
- `_execute_tool_call_for_clarification`: 32 lines
- `_execute_tool_calls`: 34 lines
- `_consume_assistant_blocks`: 39 lines
- `_request_model_turn`: 18 lines
- `_persist_turn_record`: 18 lines
- `_append_tool_exposure_turn_item`: 14 lines
- `_record_assistant_tool_calls`: 14 lines
- `_assemble_instruction_contract`: 13 lines

These methods only forward to already extracted collaborators such as
`ToolExecutionService`, `AssistantBlockConsumer`, `ModelTurnRequester`,
`RuntimeEventLedger`, `RuntimeResponseFinalizer`, and `RequestPipeline`.

Action:

1. Give `TurnExecutor` an explicit dependency bundle containing these services.
2. Replace private wrapper calls with collaborator calls.
3. Pass collaborator methods directly where a callback is required.
4. Migrate tests away from `AgentRuntime._private_method` assertions.
5. Keep public queue/subagent methods that form the `TurnService` contract.

Estimated net reduction: 250-385 Python lines after accounting for explicit
dependency wiring.

Risk: medium-high. This touches the turn loop, approval resume, interruption,
stream lifecycle, and persistence ordering. It needs focused parity tests rather
than mechanical deletion.

Outcome: TurnExecutor and collaborator construction now use the established
request pipeline, tool orchestrator/execution service, assistant recorder/block
consumer, model requester, event ledger, planning effects, and approval decision
owner directly. Two zero-caller persistence wrappers were deleted as dead code.
Wrappers that synchronize config, mutate runtime state, preserve event ordering,
or combine multiple collaborators remain. Net reduction: 358 Python production
lines. Verification passed 307 focused runtime tests, Ruff, mypy, and the broad
Python suite with 2,450 passed and 30 skipped after excluding the two documented
gateway baseline modules.

### R6. Bash and BashOutput compatibility tool classes (evaluated, retained)

Files:

- `tools/bash.py:590` (`BashTool`)
- `tools/bash_output.py` (`BashOutputTool`)
- `tools/registry.py`
- `cli/bootstrap.py`

`BashTool` and `BashOutputTool` are compatibility aliases for `ShellTool` and
`ShellOutputTool`, yet all four classes are instantiated and registered. Bash
aliases are hidden from normal model exposure but remain executable registry
entries.

Action:

1. Normalize incoming legacy names `Bash` and `BashOutput` to canonical names in
   the router/replay boundary.
2. Preserve legacy argument aliases such as `bash_id` during normalization.
3. Remove the compatibility classes and duplicate registrations.
4. Retain explicit tests proving old transcript/tool-call names still route.

Estimated net production reduction: 25-45 Python lines, plus a substantial
reduction in alias-specific tests.

Risk: medium. Old sessions and third-party extensions may still emit legacy tool
names.

Outcome: retained. The aliases remain part of persisted sessions, subagent
profiles, extension-facing tool names, evaluation programs, and TUI history
projection. Removing two small classes would require a larger alias registry and
configuration migration, increasing code and compatibility risk for a projected
25-45 line reduction.

### R7. Legacy slash output parser (reduced to compatibility detector)

File: `services/legacy_slash_output.py` (137 lines)

This is not currently dead. `NodeTuiGateway._filter_transient_command_items()`
uses it while resuming historical transcript rows containing tagged command text.
New slash commands use structured `SlashCommandDisplay` results.

Removal condition:

1. Migrate tagged command rows to structured command-result envelopes when a
   session is loaded, or establish a supported-history cutoff.
2. Persist a migration marker so the parser is not needed on every resume.
3. Remove the parser and its nine dedicated test references only after migrated
   fixtures prove equivalent rendering.

Estimated reduction after migration: 110-137 Python lines.

Risk: high until historical sessions are migrated. Do not delete directly.

Outcome: runtime only used the conversion result as a boolean to hide old
transient slash rows; none of the generated display cards were consumed. The
137-line converter is now a 47-line strict detector that preserves supported
tags, malformed-quote rejection, mixed-tag rejection, SQLite replay filtering,
and snapshot fallback behavior. The detector must remain until old snapshots
are no longer supported.

### R8. Legacy queue migration bridge (evaluated, retained)

Files:

- `application/runtime/session_queue.py:376`
- `cli/node_tui/gateway.py`
- `tui/mycli-shell/src/adapters/runtime-state.ts`

The backend publishes `legacy_user_queue_migration`, the TUI imports it, and the
backend waits for an acknowledgement token. This is an active bridge from an
older queue ownership model, not dead code.

Removal condition:

1. Normalize all persisted queue snapshots in Python before bootstrap.
2. Add a durable schema version to queue state.
3. Verify resume across sessions created before and after the queue redesign.
4. Remove the gateway payload, TUI reducer branches, acknowledgement RPC, and
   compatibility tests together.

Estimated reduction after migration: 180-280 Python/TypeScript lines.

Risk: high. Incorrect removal can lose pending steering or duplicate user input.

Outcome: retained. This is still the active ownership handoff on resume: Python
publishes persisted queue records, Node imports them into its local pending
queues, and acknowledgement removes the backend copies. Removing any side before
introducing a versioned ownership migration can duplicate or lose steering and
follow-up input.

## Priority 2: exact duplicate flows

These implementations are active, but identical control flow is maintained in
multiple places. Extracting an existing behavior into one owner should reduce
code without changing compatibility.

### R9. Tool execution start recording is implemented twice (completed)

File: `application/runtime/tools/tool_execution_service.py`

Lines 483-511 manually build start metadata, activity, lifecycle trace, and the
`TOOL_CALL` item. Lines 989-1017 implement the same behavior in
`_record_tool_start()`.

Action: call `_record_tool_start()` from the clarification path as well.

Estimated reduction: 25-30 lines.

Risk: low-medium. Verify event ordering and display metadata.

### R10. Gateway turn completion finalization is duplicated (completed)

File: `cli/node_tui/gateway.py`

The normal turn worker around lines 1386-1426 and decision worker around lines
2083-2123 both emit approval, proposed plan, `turn.completed`, terminal status,
final message, and status update.

Action: extract one `_emit_turn_response_completion()` method. Keep the normal
worker's late-completion suppression and mailbox cleanup outside the helper.

Estimated reduction: 35-45 lines.

Risk: medium. Event order is part of the Node TUI protocol.

Outcome: `_emit_turn_response_completion()` now owns approval, proposed-plan,
completion, terminal-status, final-message, and status-update emission. Normal
turn late-completion suppression and worker-specific cleanup remain outside the
helper. The stale gateway test fixtures were updated to satisfy the current
title and permission-profile contracts. All 111 unit and 25 integration gateway
tests pass.

### R11. TurnExecutor early-response finalization is duplicated (evaluated, retained)

File: `application/runtime/turn_executor.py`

Approval resume around lines 679-707 and the main loop around lines 1498-1527
repeat interruption handling, leftover commit, runtime-state save, and response
finalization.

Action: extract a helper parameterized by context baseline and user message.

Estimated reduction: 20-30 lines.

Risk: medium-high because approval and interruption persistence are sensitive to
ordering.

Outcome: retained. A helper would need nine turn-state parameters plus an
optional context baseline and would not reduce production lines. Keeping the two
explicit sequences makes approval-resume and ordinary-turn persistence ordering
auditable.

### R12. Default tool inventory is assembled twice (completed)

Files:

- `cli/bootstrap.py:84`
- `tools/registry.py:627`

Both import and instantiate the built-in tool list. They already differ subtly:
bootstrap supplies allowed roots, unrestricted filesystem state, and a configured
`FileSystemRuntime`; the registry default does not.

Action: introduce one `build_builtin_tools(options)` factory and use it from both
bootstrap and `ToolRegistry.__post_init__`.

Estimated reduction: 35-60 lines and elimination of future inventory drift.

Risk: medium. Preserve allowed roots, unrestricted mode, Lint workspace root, and
the exact exposed/hidden tool inventory.

### R13. Runtime sandbox policy assembly is duplicated (completed)

Files:

- `application/runtime/context/runtime_context_builder.py:146`
- `application/runtime/tools/runtime_policy.py:79`

Both build an `ExecutionPolicy`, merge writable roots and denied read roots/globs,
and reconstruct an equivalent `SandboxProfile`.

Action: make `RuntimePolicyGate.default_policy()` the single owner and inject its
result into context assembly.

Estimated reduction: 25-35 lines.

Risk: medium. Full-access, read-only, and workspace-write modes need direct
equivalence tests.

### R14. Approval choice formatting is duplicated (completed)

Files:

- `application/runtime/approval_decisions.py:35`
- `application/turn_service.py:431`

Action: use `RuntimeApprovalDecisions.format_allowed_choices()` from
`TurnService`, or move the formatter to a domain-level function.

Estimated reduction: 12-16 lines.

Risk: low.

### R15. Queue record removal is duplicated (completed)

File: `application/runtime/session_queue.py`

`ack_legacy_user_queue_migration()` and `drain_legacy_task_notifications()` both
remove a set of IDs from pending, rejected, and follow-up tuples, persist, and
publish a new snapshot.

Action: extract `_remove_records_locked(record_ids)` while retaining separate
selection and validation behavior.

Estimated reduction: 12-20 lines.

Risk: medium because queue revision and notification ordering must remain exact.

### R16. Doctor trace scanners repeat the same file loop (completed)

File: `services/diagnostics/doctor.py`

At least six diagnostic summarizers repeat the same sequence: open JSONL, skip
blank lines, parse a trace event, ignore malformed rows, filter event kind, and
record unreadable files. `jscpd` reports the same 14-line block repeatedly around
lines 2478, 2613, 2662, 2776, 3113, 3153, and 3191.

Action: create one iterator returning parsed trace events plus read errors, then
keep aggregation logic in each summarizer.

Estimated reduction: 60-100 lines.

Risk: low-medium. Malformed-line tolerance and unreadable-file reporting must be
preserved.

### R17. Provider adapters repeat capability forwarding (evaluated, not retained)

Files:

- `llms/adapters/native_tool_adapter.py`
- `llms/adapters/anthropic_messages_adapter.py`
- `llms/adapters/responses_adapter.py`

The adapters repeat `getattr`/`callable` forwarding for log context, model,
thinking, tool choice, output tokens, continuation state, and interrupt-aware
stream selection. Some differences are protocol-specific and must remain.

Action: extract only a small typed client-capability helper. Do not introduce a
large inheritance hierarchy or merge payload serialization.

Estimated reduction: 50-90 lines across adapters.

Risk: medium. Capability fallback behavior differs between protocols.

Outcome: a 44-line generic helper replaced the repeated checks but produced only
one net production line of reduction and relied on string method names. It was
reverted after 66 focused tests, Ruff, and mypy passed because the abstraction
cost exceeded the cleanup benefit.

### R18. TUI provider selectors duplicate list mechanics (completed)

Files:

- `components/login-flow.ts`
- `components/setup-wizard.ts`

Both implement provider filtering, centered eight-row windows, selected-row
styling, empty state, and selection movement. Similar selector construction also
appears in resource/session/session-tree components.

Action: extract provider list projection/rendering, not an all-purpose selector
base class.

Estimated reduction: 25-50 TypeScript lines.

Risk: low-medium. Setup rows include model/protocol detail that login rows omit.

Outcome: `ProviderList` now owns filtering, movement, the centered eight-row
window, row status, and empty state. Login retains its position indicator, while
setup retains model/protocol details. The migration removes 11 net production
lines and passed all 354 TUI tests, TypeScript type checking, and `knip`.

### R19. Context fragment metadata projection (completed)

File: `services/context/instruction_contract_assembler.py`

Three fragment builders repeated the same cache class, durability, scope,
model-visibility, and replayability defaults. `_section_metadata()` is now the
single projection owner. Net reduction: 22 Python lines. Instruction-contract,
turn-context, and request-shape tests pass (85 tests).

### R20. Gateway runtime identity projection (completed)

File: `cli/node_tui/gateway.py`

Bootstrap, welcome, and status payloads repeated session, model, collaboration
mode, reasoning, thinking, and provider projection. `_runtime_identity_payload()`
now owns those fields while view-specific workspace and context fields remain
local.

### R21. TUI and legacy compatibility duplicate cleanup (completed)

Files:

- `services/legacy_slash_output.py`
- `tui-core/components/markdown.ts`
- `tui-core/utils.ts`
- `tui-core/stdin-buffer.ts`

Removed unconsumed legacy slash display projection, reused Markdown's default
style application for ANSI prefix extraction, merged identical OSC/APC parsing,
and centralized bracketed-paste completion for inline and split chunks. New
tests directly cover OSC/APC width and both paste chunking forms.

### R22. Focused active-duplicate cleanup (completed)

Files:

- `tui/mycli-shell/src/components/diff-renderer.ts`
- `tui/mycli-shell/src/components/approval-selector.ts`
- `tui/mycli-shell/src/components/tool-execution.ts`
- `tui/mycli-shell/src/tui-core/components/editor.ts`
- `llms/clients/openai_chat.py`
- `llms/clients/openai_chat_payloads.py`
- `llms/clients/openai_responses.py`
- `llms/clients/anthropic_messages.py`

Compact approval and tool diffs now share one line classifier while retaining
their different context colors. Each provider client now owns one connection
and response-validation error mapper shared by its sync and streaming paths;
messages, log payloads, stop reasons, retry flags, and failure kinds remain
unchanged. OpenAI Chat and Responses share only the inner tool parameter JSON
Schema projection and continue to own their different outer wire formats.

The Editor now has one change notification path and one post-delete autocomplete
refresh path. Input state, cursor movement, kill-ring behavior, and autocomplete
trigger conditions are unchanged. This batch passed 56 provider error tests, 80
OpenAI payload tests, Ruff, focused mypy, TypeScript type checking, and all 357
TUI tests. It reduced the 12-line/100-token clone report from 17 groups and 372
duplicated lines to 12 groups and 235 duplicated lines.

## Lower-value clone groups

`jscpd` also identified smaller active duplicates in:

- streaming entry points across the Anthropic, native-tool, and Responses
  adapters;
- OpenAI multimodal block projection in the native adapter and Chat client;
- API-status detail parsing and request logging in the OpenAI and Anthropic
  clients;
- legacy/current shell runtime method signatures in `tools/bash.py`;
- explicit tool contracts for Edit/Patch and KillShell/ShellOutput;
- resource, session, and session-tree selector chrome;
- backward/forward kill-ring branches inside the Editor.

These should not be mass-refactored. Most represent parallel protocol branches or
state-machine cases where a shared abstraction could become harder to reason
about than the duplicated 10-30 lines. The multimodal projection also has
different accepted block types and protects active image attachment behavior.
Revisit these only when an existing typed owner can absorb the behavior without
changing compatibility or protocol boundaries.

## Confirmed false positives and code to retain

### Dynamic entry points

- `tui/mycli-shell/src/setup.ts`: launched by Python.
- `services/plugins/worker.py`: launched with `python -m`.
- Unix and Windows shell transports: selected dynamically by platform/factory.
- `tools/read/csv_handler.py`: selected by the Read tool's handler dispatch.

### Interface-required empty bodies

- Protocol methods using `...`.
- TUI `invalidate(): void {}` implementations required by `Component`.
- Context manager exception parameters reported by `vulture`.
- Windows ConPTY `dimensions` protocol parameter.

### Active behavior that only looks like a wrapper

- `services/session_service.py` adds conversation-tree metadata, lineage resume,
  rewind, and fork behavior to the state service. It is not a pure re-export.
- `state/session_service.py` persistence methods serialize different state
  contracts even when their final statement delegates to the SQLite store.
- `terminal-image.ts` capability detection, hyperlinks, image-line detection,
  Kitty cleanup, and cell-size updates are still used by Markdown/TUI rendering.
- `plan_mode.py` returns `legacy_noop`, but its tools are still registered as
  compatibility protocol endpoints. Remove only with a tool-name migration.
- `RETIRED_BUILTIN_TOOLS` for `Glob` and `Grep` preserves recognition of old tool
  names without registering their deleted implementations.
- Evaluation soak/probe modules are development entry points, not runtime dead
  code.

## Recommended execution batches

### Batch A: safe dead code and public surface

- Remove inactive terminal image rendering chain.
- Remove `isPunctuationChar()`.
- Remove unused TypeScript exports/barrel entries without deleting internally
  used implementations.

Expected net reduction: 370-450 source lines.

### Batch B: canonical request/runtime ownership

- Delete `message_builder.py` after projector migration.
- Remove private AgentRuntime forwarding methods after giving TurnExecutor direct
  collaborator access.

Expected net reduction: 350-515 source lines.

### Batch C: duplicate active flows

- Consolidate tool start recording, gateway response completion, turn early
  response finalization, tool inventory construction, policy assembly, approval
  formatting, queue removal, and doctor trace scanning.

Expected net reduction: 220-335 source lines.

### Batch D: explicit compatibility retirement

- Replace Bash/BashOutput classes with router aliases.
- Migrate structured slash history and remove `legacy_slash_output.py`.
- Version and migrate queue state, then remove the legacy queue bridge.
- Decide whether plan-mode compatibility tool names remain supported.

Expected net reduction: 315-520 source lines, depending on the supported session
history window.

Conservative total opportunity from the audited findings:

- Without dropping historical compatibility: approximately 940-1,300 source
  lines.
- After explicit compatibility migrations: approximately 1,250-1,820 source
  lines.

This will improve ownership and maintenance cost, but it will not make a
109,000-line system small by itself. Most remaining volume implements active
runtime, diagnostics, provider, sandbox, persistence, and TUI behavior rather
than unreachable code.

## Verification required for every batch

1. `uv run ruff check src/mycli tests`
2. `uv run mypy src/mycli`
3. Focused Python tests for every changed owner.
4. `npm run typecheck` in `tui/mycli-shell`.
5. `npm test` in `tui/mycli-shell`.
6. Full Python test collection to detect removed import paths.
7. Resume fixtures containing old slash, queue, Bash, approval, interrupted-turn,
   tool-call, and tool-output shapes for compatibility batches.
8. Re-run `uvx vulture`, `knip`, and `jscpd` and record the before/after counts.

## Recommended starting point

Start with Batch A. It has the clearest evidence, removes roughly 400 lines, and
does not alter model requests, turn persistence, session resume, queue ownership,
or shell execution. Batch B should follow as a separate change because its test
surface is much larger.

## Second Python-only sweep

This follow-up sweep started after R1-R22, against 330 Python files and 83,366
production lines. It used a lower 60% `vulture` threshold, an AST
import graph, production-vs-test symbol indexing, exact repository searches for
dynamic string dispatch, and feature-footprint counts.

### High-confidence removable code (pre-cleanup finding)

After excluding `HTMLParser` callbacks, dynamically selected CSV and shell
transport handlers, the CLI entry point, and the plugin worker process, the scan
found 34 definition-only functions, methods, and classes. The most substantial
groups were:

- obsolete Windows shell parsing in `tools/shell_safety_adapters.py`;
- old AgentRuntime queue and policy convenience methods;
- unused request-shape contextual projection helpers;
- unused MCP framed-response decoding;
- unused OpenAI Chat and Responses adapter forwarding helpers;
- unused state clearing helpers, planning aliases, filesystem helpers, and
  small inspection conveniences.

These account for roughly 250-300 Python lines before associated imports and
tests are removed.

The production package also contained 34 APIs used only by tests, with 509 raw
lines of definitions. They include `AgentRuntime.for_tests()`, old compaction
transition methods, provider dry-run comparison, legacy context rendering,
conversation-tree query conveniences, old session compaction, Rich rendering
helpers, and compatibility safety functions. Test fixtures should own genuine
test construction; tests that only validate an otherwise unreachable API should
be deleted with that API. A conservative removable subset is 300-450 lines.

The old Rich rendering chain is production-unreachable and tested only in
isolation: `StreamingRenderState`, streaming Rich output, tool status, Rich diff
view, and the standalone numbered diff renderer. Removing this chain also makes
the direct `rich` and `pygments` dependencies unnecessary. `langchain` has no
Python import anywhere in the repository and is independently removable.

`ObservabilityService` metrics are active, but its Structlog logging path and
`JsonLogFormatter` are test-only. Removing that unused path preserves `/usage`
and metrics while eliminating the direct `structlog` dependency.

The implemented sweep exceeded this estimate because it also found and removed
the isolated provider payload dry-run/snapshot subsystem. A subsequent explicit
feature-retirement pass removed the historical evaluation CLI and package. The
plan-mode compatibility and definition-only interface passes then reduced the
package to 319 Python files and 79,261 production lines. Retiring the plain
conversation mode then reduced it to 317 Python files and 78,433 production
lines.

### Retired evaluation package

The former package contained a 1,184-line scenario runner plus 732 lines of
provider probes and soak helpers. Its only product entry points were the
`--eval-list`, `--eval-scenario`, and `--eval-root` CLI options. Those options,
the package, seven scenario suites, dependent wrappers, and dedicated tests have
now been removed. Focused standalone smoke scripts that exercise current runtime
behavior remain under top-level `evaluation/` and are not installed as part of
`mycli`.

### Active feature footprint

The remaining size is mostly active behavior, not dead code:

| Feature area | Python lines | Status |
| --- | ---: | --- |
| Doctor diagnostics | 4,452 | active CLI feature |
| Subagents | 3,368 | active runtime and management feature |
| Hooks | 1,826 | active runtime extension feature |
| Plugins | 1,782 | active extension feature |
| MCP | 1,563 | active external-tool feature |
| Memory | 1,493 | active extraction/dream/file-memory feature |

These totals are footprints, not automatic deletion estimates. Reducing Python
from roughly 80k to 70k or below requires explicitly retiring or simplifying
features; dead-code cleanup alone cannot produce that reduction safely.

### Current cleanup inventory

The first two previously recommended batches are complete:

1. The obsolete `EnterPlanMode`/`ExitPlanMode` compatibility chain, including
   registration, exposure, safety policy, and dedicated tests, was removed.
2. Definition-only and test-only interfaces such as `backup_file()`, history
   replacement, AgentRuntime context/budget wrappers, provider history
   projection, execpolicy convenience decisions, Responses wire construction,
   MCP schema hydration, adapter capability probes, and shell cursor aliases
   were removed.

Together these batches reduced production Python from 79,621 to 79,261 lines,
a 360-line reduction. The canonical `Plan` tool, runtime/TUI plan state,
sessions, steering queues, shell protocols, provider protocols, and image
attachments remain intact.

The subsequent explicit retirement of `--plain` removed another 828 production
lines and two Python files. Conversation startup is now Node-TUI-only; utility
subcommands still dispatch before TTY validation, and setup retains its separate
text fallback.

#### Direct low-risk cleanup

These symbols currently have no production caller or no consumer at all:

- `services/context/token_counter.py`: `FragmentKind`, `Priority`,
  `CachePolicy`, and `Fragment` became definition-only after removal of the
  unused `count_fragment()` API. Estimated reduction: 30-35 lines.
- `services/turn_guard/checkpoint.py`: four `ExitReason` members are never
  produced: `TOKEN_BUDGET_EXCEEDED`, `TOOL_COUNT_EXCEEDED`, `LOOP_DETECTED`,
  and `REPEATED_TOOL_FAILURE`. Estimated reduction: 4 lines.
- `services/skills/registry.py`: `SkillRegistryDiagnostics.directory_count`
  and `discovered_count` are populated but never read. Estimated reduction:
  4 lines including construction arguments.
- `services/hooks/config.py`: `ConfiguredHookSpec.matches_tool()` is a
  test-only alias for the active `matches()` method. Estimated reduction:
  3 lines plus test adjustment.
- `services/diagnostics/doctor.py`: the `ImportChecker` alias,
  `import_checker` constructor argument, `_import_checker` field, and
  `_can_import()` helper are never consulted. Production reduction is roughly
  10-15 lines; many tests currently pass the inert constructor argument and
  require mechanical cleanup.

This direct batch is expected to remove roughly 55-70 production lines without
changing product behavior.

#### Cleanup after owner migration

- `HookAllowlist.write_allowed()` is used only by tests and focused smoke code.
  Test fixture construction can use `approve()` or a test-owned helper, removing
  roughly 15-20 production lines.
- `AgentRuntime.for_tests()` occupies about 39 production lines and has 180 test
  call sites. Moving it to `tests/support` reduces installed package code but
  produces broad test churn and little repository-wide reduction.
- `MetricsRegistry.context_window` has a test-only writer while inspection code
  still reads the stored payload. It should be consolidated with the active
  `TurnService.current_context_window_metrics()` owner rather than deleting one
  side. Estimated reduction after consolidation: 30-60 lines.
- `services/legacy_slash_output.py` remains a 47-line historical-session
  detector. It can be removed only after old tagged rows are migrated or a
  supported-history cutoff is established.
- The legacy steering/follow-up queue ownership bridge can remove an estimated
  180-280 Python/TypeScript lines only after persisted queue state gains a schema
  version and old snapshots are normalized in Python before bootstrap.

#### Retained compatibility and state APIs

- `BashTool` and `BashOutputTool` remain compatibility routes for persisted
  sessions, extensions, subagent profiles, evaluation programs, and TUI replay.
- `rewind_conversation()`, `clear_queue_snapshot()`, and
  `load_contributed_tool_state()` have few production callers but touch session,
  queue, and restore semantics; they are not direct dead-code candidates.
- Shell transport `resize()` methods and `HTMLParser` callbacks are protocol
  implementations and must not be removed based on static-analysis reports.
- Enum values and dataclass fields that participate in persisted or wire formats
  require protocol-level evidence before removal.

#### Explicit feature-retirement options

The following remaining areas are active product features, not redundant code:

- Memory: 1,493 lines before runtime wiring; includes `/memory`, extraction,
  dream jobs, and file memory.
- Hooks: 1,826 lines.
- Plugins: 1,782 lines.
- Subagents: approximately 3,368 lines.
- MCP: 1,563 lines.
- Doctor diagnostics: 4,452 lines.

Removing any of these requires an explicit product decision. File splitting or
renaming will not reduce total code. After the direct low-risk batch, further
large reductions should be classified as compatibility migration, architecture
simplification, or feature retirement rather than dead-code cleanup.
