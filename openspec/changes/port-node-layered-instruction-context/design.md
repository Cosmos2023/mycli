## Context

The Python runtime already separates stable base instructions, developer policy, contextual user fragments, canonical conversation, and current user intent. The Node runtime has provider adapters that accept base and developer instructions, but `NodeTurnRuntime` still passes a fixed string and transient history directly to request projection. Memory is inserted only in memory, hook-provided context is discarded, collaboration mode remains in the gateway, the skill catalog is not injected, and no workspace instruction loader or instruction snapshot exists.

The Node session store has append-only `conversation_messages`, `history_items`, and `turn_rollouts`, plus mutable `session_state` projections. Its current canonical context item is specialized to loaded skill instructions and cannot represent all prompt layers or the exact ordering of a provider request. The migration must preserve two invariants:

1. Model-visible source-of-truth records are append-only.
2. No content may enter a provider context window before the complete logical model input has been durably committed.

## Goals / Non-Goals

**Goals:**

- Port the Python layered instruction semantics to the Node runtime without coupling provider adapters to raw runtime fields.
- Persist the full content and exact order of every model-visible input before provider dispatch.
- Keep transcript presentation separate from internal model context while making both reconstructable.
- Preserve authority roles across Responses, Chat Completions, and Anthropic Messages.
- Apply one instruction pipeline to main agents and subagents.
- Retain compatibility for existing Node sessions.

**Non-Goals:**

- Removing or modifying the Python runtime.
- Displaying internal developer or contextual scaffolding as ordinary TUI transcript messages.
- Persisting credentials, transport headers, or other values that are not model-visible.
- Reintroducing named agent profiles or task-specific prompt branches.
- Implementing a new plan-state subsystem; the migration consumes plan state when one exists.

## Decisions

### 1. Separate transcript, model-context events, and provider request manifests

The transcript remains the canonical user-facing sequence of user, assistant, tool-call, and tool-result records. A new append-only model-context ledger stores versioned developer and contextual-user events without forcing internal scaffolding into the TUI transcript. Each provider step appends an immutable request manifest that references the exact instruction snapshot, tool-set snapshot, context events, conversation records, provider-native replay records, and their projected order.

This separation avoids reordering a user message that was already reserved before hooks and runtime context were assembled. Physical append order and provider-visible order are both preserved: the former by ledgers and the latter by the manifest.

Alternatives considered:

- Store every context fragment in `conversation_messages`. Rejected because it conflates transcript and model scaffolding and cannot express provider-specific ordering cleanly.
- Store only request hashes. Rejected because an old request cannot be reconstructed after templates or tool schemas change.

### 2. Make append-only records the source of truth and mutable state a projection

Instruction snapshots, tool-set snapshots, model-context events, request manifests, compaction boundaries, and continuation resets are insert-only. A changed section appends a superseding event containing the complete new value. Removal appends a tombstone. No prior model-visible item is updated or deleted.

Existing mutable `session_state`, current turn status, and cached context baselines may remain as rebuildable indexes. They must not be the sole source of any provider-visible content or ordering.

### 3. Enforce assemble, budget, persist, project, send

Each provider step follows this sequence:

1. Collect the current runtime sources.
2. Assemble `TurnContext` and `InstructionContract`.
3. Apply the model-input budget and deterministic ordering.
4. In one SQLite transaction, insert missing immutable snapshots and blobs, append changed context events, and append the request manifest.
5. Commit the transaction.
6. Build the provider request from the committed manifest and immutable content.
7. Dispatch the network request and append response/tool events.

Persistence failure aborts the provider step. Provider code cannot receive an uncommitted request shape. The persisted manifest excludes API keys and transport headers.

### 4. Use typed instruction layers with independent authority and lifetime

Core contracts define section kind, semantic role, cache class, durability, scope, source, content hash, and memory inclusion. Base instructions use the top-level system/instructions channel. Collaboration mode, permission/sandbox/approval policy, skill catalog, tool policy, trusted policy hooks, and runtime policy use developer authority. Workspace rules, environment facts, memory, summaries, loaded skill bodies, compaction rehydration, ordinary hooks, and factual reminders use contextual-user authority.

`static`, `dynamic`, and `ephemeral` describe cache behavior and activation, not persistence. Ephemeral content that reached a model is still durable. Untrusted or unclassified context cannot be promoted to developer authority.

### 5. Freeze base instructions and tool schemas by full snapshot

The Node application ships the complete system template as a build asset with a version and SHA-256. The first use of a session appends its instruction snapshot; resume reuses it. Tool definitions are deterministically ordered and persisted as a complete normalized schema snapshot, not only a hash. Content-addressed immutable blobs may deduplicate repeated large snapshots, but collision checks must verify identical content.

A repository test compares the Node template with the Python template until a shared canonical packaging location is introduced.

### 6. Load workspace instructions as bounded contextual data

The loader selects one source by Python-compatible precedence: `.mycli.md`/`MYCLI.md`, `AGENTS.md`/`agents.md`, `CLAUDE.md`/`claude.md`, then `.cursorrules`. It enforces UTF-8 handling, a 24,000-character bound, middle truncation, invisible-control checks, and obvious instruction-hijack diagnostics. Accepted content is fenced as workspace reference context and persisted before use.

### 7. Append context snapshots only when their effective value changes

The runtime compares current section hashes with the latest durable context baseline. Initial context appends a complete developer bundle followed by contextual-user sections. Later steps append only changed complete sections or tombstones. Request manifests may reference earlier unchanged events; they never depend on regenerating old content from the current filesystem or runtime configuration.

### 8. Preserve complete logical input before transport optimization

`RequestShapeBuilder` constructs the complete logical provider input from the instruction contract and durable timeline. Responses continuation or WebSocket delta optimization is permitted only after this full shape exists and the new manifest is a strict extension under an unchanged request signature. Otherwise the runtime records a continuation reset and sends full replay. Chat and Anthropic project the same semantic roles using their supported wire representations.

### 9. Treat compaction as an appended replacement boundary

Compaction does not rewrite or delete prior ledgers. It appends a boundary, replacement summary, retained-tail references, and rehydration items, then subsequent manifests reference the compacted logical window. Original records remain available for audit and reconstruction.

### 10. Main agents and subagents share the same pipeline

Child sessions inherit the product base snapshot and workspace context. A developer event adds agent path, assigned task, tool scope, inherited/narrowed execution policy, and reporting contract. The parent task prompt remains a user request. No `AgentProfile` abstraction is added.

## Risks / Trade-offs

- [Risk] Persisting full tool schemas and context increases storage use. -> Use immutable content-addressed blobs and manifest references while retaining complete reconstructable content.
- [Risk] Context updates can accumulate and reduce cache efficiency. -> Append only changed complete sections and use explicit compaction boundaries rather than mutation.
- [Risk] A crash after manifest commit but before provider acceptance leaves an uncertain prepared request. -> Persist provider-step lifecycle events and recover it as prepared/unknown without silently claiming completion.
- [Risk] Existing sessions lack instruction and tool snapshots. -> On first post-migration turn append a compatibility bootstrap boundary before any provider request.
- [Risk] Provider adapters may differ in developer-role support. -> Keep semantic roles in the contract and implement explicit adapter fallback without altering the durable role.
- [Risk] Workspace or hook content may contain sensitive values. -> Sanitize before assembly; content forbidden from durable storage is forbidden from model input.

## Migration Plan

1. Add compatible core contracts and append-only SQLite tables/readers without changing the active request path.
2. Add instruction/tool snapshot services and bootstrap existing sessions.
3. Add model-context events and immutable request manifests with reconstruction tests.
4. Switch Node provider steps to persist-before-send behind a runtime compatibility flag used only during rollout.
5. Add system template, workspace loader, skill catalog, collaboration, policy, hook, memory, and compaction sources.
6. Move subagents onto the same pipeline.
7. Remove the one-line prompt and transient request assembly after parity and real-provider smoke tests pass.

Rollback disables the new projector for sessions that have not emitted a new-format manifest. New-format sessions remain readable and exportable; append-only records are not deleted during rollback.

## Open Questions

- Whether immutable model-input blobs should live in dedicated tables or reuse a generalized history-item payload table will be decided during the storage task based on migration complexity.
- Plan-state injection remains dormant until Node owns a durable append-only plan event stream.
