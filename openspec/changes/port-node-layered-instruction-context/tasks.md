## 1. Core Model-Input Contracts

- [x] 1.1 Add typed instruction snapshot, tool-set snapshot, turn-context section, instruction fragment, instruction contract, and request-manifest domain contracts to `@mycli/core`.
- [x] 1.2 Generalize canonical model-context roles and metadata without changing legacy skill-context restoration behavior.
- [x] 1.3 Add deterministic hashing, ordering, supersession, tombstone, and request-shape helpers with focused core tests.

## 2. Append-Only Storage

- [x] 2.1 Add a backward-compatible SQLite migration for immutable model-input blobs, instruction/tool snapshots, context events, request manifests, and provider-step lifecycle events.
- [x] 2.2 Add storage interfaces and transactional writes that commit a complete provider-step manifest before returning a dispatchable request shape.
- [x] 2.3 Add strict payload validation, collision checks, immutable insert semantics, and compatibility bootstrap records for legacy Node sessions.
- [x] 2.4 Add reconstruction APIs that rebuild exact logical provider input from durable records while treating mutable session state as a cache only.
- [x] 2.5 Add storage tests for append-only supersession, tombstones, failed transactions, exact reconstruction, legacy bootstrap, and prohibited updates/deletes.

## 3. Base And Workspace Instructions

- [x] 3.1 Package the complete Node system template with version/hash metadata and add Python/Node template parity tests.
- [x] 3.2 Implement load-or-create per-session instruction snapshots and replace the one-line Node default prompt.
- [x] 3.3 Implement Python-compatible workspace instruction discovery, UTF-8 handling, bounds, fencing, diagnostics, and safety scanning.
- [x] 3.4 Add tests for precedence, truncation, blocked content, new-session template updates, and resumed-session snapshot stability.

## 4. Layered Context Assembly

- [x] 4.1 Implement Node runtime context collection and deterministic `TurnContext` section assembly with explicit cache class, role, scope, durability, and source.
- [x] 4.2 Implement `InstructionContractAssembler` mappings for collaboration mode, permissions, tool exposure, skill catalog, workspace, environment, memory, compaction, hooks, reminders, conversation, and current intent.
- [x] 4.3 Preserve hook-provided contexts across user-prompt, pre-tool, and post-tool provider steps with trust-aware role classification.
- [x] 4.4 Implement complete-request token budgeting that preserves base instructions, required permission policy, tool schemas, and current user intent.
- [x] 4.5 Add assembly and budget tests covering stable/dynamic/ephemeral behavior, untrusted-role protection, deduplication, and deterministic trimming.

## 5. Persist-Before-Send Runtime Pipeline

- [x] 5.1 Add request-shape construction from the layered contract and durable timeline, including stable prefix, replay, dynamic/ephemeral updates, and current intent ordering.
- [x] 5.2 Integrate assemble-budget-persist-project-send into every `NodeTurnRuntime` provider step and fail closed before transport on persistence errors.
- [x] 5.3 Extend request signatures and continuation selection to include durable instruction, tool-set, context-prefix, and provider-semantic hashes.
- [x] 5.4 Append continuation-reset and provider-step lifecycle events, and recover committed-but-unconfirmed requests without claiming completion.
- [x] 5.5 Add runtime tests proving no provider call occurs before commit and every provider-visible value is reconstructable after completion, interruption, or restart.

## 6. Provider And Compaction Projection

- [x] 6.1 Project one durable logical request shape to Responses, Chat Completions, and Anthropic Messages while preserving authority roles and tool protocol ordering.
- [x] 6.2 Make continuation/delta transport conditional on strict extension of the complete persisted logical input, with full replay fallback.
- [x] 6.3 Represent compaction as append-only boundaries with summary, retained-tail, and rehydration references while retaining original records.
- [x] 6.4 Add cross-provider golden tests and compaction/reconstruction tests for equivalent logical context.

## 7. Skills, Modes, Permissions, And Subagents

- [x] 7.1 Expose and inject the bounded skill catalog without loading every skill body, while retaining durable loaded-skill context items.
- [x] 7.2 Pass collaboration mode and current execution-policy/sandbox state from Gateway into each runtime context snapshot.
- [x] 7.3 Move child sessions onto the same instruction snapshots, workspace context, model-input ledger, and request pipeline with appended agent path/task/tool/policy developer context.
- [x] 7.4 Add main-agent/subagent parity tests and verify no agent-profile or child-specific one-line prompt path remains.

## 8. Compatibility, Documentation, And Verification

- [x] 8.1 Keep legacy sessions readable, document the compatibility boundary, and add doctor diagnostics for incomplete or corrupt model-input ledgers.
- [x] 8.2 Update Node runtime/context documentation with append-only, persist-before-send, reconstruction, authority-role, and sensitive-content invariants.
- [x] 8.3 Run focused package tests, full Node typecheck/build/test gates, and Python regression tests affected by template parity.
- [x] 8.4 Run real-provider smoke tests for a main-agent tool turn, a context-changing follow-up, resume, compaction, and a subagent turn without persisting credentials.
