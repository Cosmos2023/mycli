# Transactional File Mutation Architecture

## Goal

Redesign mycli file mutations so the model expresses semantic changes while the host owns path
resolution, approval, atomic replacement, crash recovery, and undo. File tools operate on the
filesystem state that exists when they execute and do not require a preceding Read or caller-owned
version metadata.

## What I Already Know

- The Node runtime exposes `Write`, `Edit`, and `Patch` and renders bounded diffs before execution.
- `FileMutationRuntime` already computes previews and writes through an atomic sibling-file rename.
- `FileHistoryStore` independently captures before/after state and refuses unsafe undo after a
  later manual change.
- The agent effect ledger records mutating attempts and unknown outcomes across crashes.
- The observed failure was not sandbox-related: a full-access session repeatedly supplied a
  fabricated but schema-valid `expected_sha256` for a missing file.
- Codex exposes semantic `Add File`, `Update File`, and `Delete File` patch operations and verifies
  them against the filesystem inside the host; it does not ask the model to supply a digest.

## Assumptions (Temporary)

- Existing `/undo`, TUI diff presentation, full-access behavior, and bounded transcript storage
  should remain.
- Direct adapter compatibility matters more than keeping every current model-facing field.
- Per-file atomicity is required; all-or-nothing atomicity across multiple files is a separate,
  materially larger guarantee.

## Open Questions

- None. The user approved retaining all three tools and starting the shared-kernel redesign.

## Research References

- [`research/file-mutation-architecture.md`](research/file-mutation-architecture.md) compares the
  current mycli pipeline, Codex `apply_patch`, host-owned CAS, and three migration strategies.

## Feasible Approaches

### A. Prepared Mutation Behind Existing Tools

Keep `Write`/`Edit`/`Patch`, but make all three compile into one host-owned prepared mutation before
approval and commit. This is the smallest safe architecture change but leaves overlapping tools.

### B. Direct Codex-Style Replacement

Replace all three tools with a grammar-constrained `apply_patch` supporting Add, Update, Delete, and
Move. This is the cleanest final API but has the highest migration and recovery risk.

### C. Shared Kernel With Stable Tool Names (Selected)

Keep `Write`, `Edit`, and `Patch` as the stable public tools and compile all three into the same
prepared-mutation kernel. Their schemas must express distinct semantic operations rather than
duplicating conflict or authorization metadata.

Recommended public roles:

- `Write`: create or replace one complete file.
- `Edit`: replace one exact text selection in one existing file without requiring a prior `Read`.
- `Patch`: apply a bounded JSON `operations` array across one or more files, with explicit Add,
  Update, Delete, and Move variants.
- `Move` remains an independent Patch operation with `from_path` and `to_path`. Moving and editing
  the same file is expressed as two ordered operations; the host collapses them into one prepared
  final changeset. Do not copy Codex's wire-level `Update File` plus `Move to` coupling.

## Requirements (Evolving)

- Retain the public model-facing tool names `Write`, `Edit`, and `Patch`.
- `Patch` accepts a bounded JSON `operations` array with independent `add`, `update`, `delete`, and
  `move` operations.
- Keep one canonical JSON-schema tool representation across Responses, Chat Completions, and
  Anthropic; do not introduce a provider-only freeform Patch contract.
- Model-visible inputs contain semantic intent only; no caller-generated hashes, mtimes, inode
  values, version tokens, or host authorization bits.
- `Write`, `Edit`, and `Patch` do not require a preceding `Read`, a process-local Read snapshot, an
  expected hash, or a persisted filesystem baseline.
- `Edit` and Patch update operations read the current file during execution. With
  `replace_all=false`, they replace the first exact match even when the same text appears elsewhere;
  `replace_all=true` replaces every exact match.
- A host-owned prepare phase resolves canonical paths, validates content and policy, and computes a
  bounded preview. Execution rebuilds the semantic operation against the then-current filesystem
  instead of rejecting it because the previewed baseline changed.
- Approval binds the canonical model call and permission decision. A prepared preview is display
  metadata, not a compare-and-swap requirement.
- Commit revalidates path containment but does not reject writes because content, size, mtime, or a
  prior Read snapshot changed.
- File history captures before commit and becomes recoverable only after successful commit.
- Crash recovery never blindly replays a mutation whose outcome is unknown.
- Internal callers may use host-derived preconditions, but those values remain outside provider
  schemas and model-visible transcripts.

## Acceptance Criteria (Evolving)

- [x] A model can create a missing file without supplying or inventing a version value.
- [x] A file changed between preview and approval is handled from its current execution-time state;
      Write replaces it, while Edit/Patch update still require their requested old text to exist.
- [x] A symlink/path swap between prepare and commit fails closed.
- [x] Approval resume executes only the exact prepared mutation once.
- [x] `/undo` restores an overwritten file and deletes a newly created file when still safe.
- [x] Manual changes after commit prevent `/undo` from overwriting newer content.
- [x] Provider schemas, tool-search projections, runtime routing, TUI previews, and persisted
      diagnostics agree on the same mutation contract.
- [x] Unit, integration, crash-recovery, lint, typecheck, contract, and build checks pass.

## Definition of Done

- Tests cover create/update/delete, execution against current file state, symlink/path boundaries,
  crash boundaries, direct-adapter compatibility, and undo.
- Lint, typecheck, contracts, build, and relevant integration suites pass.
- File mutation and tool manifest code-specs document the final public and host-only contracts.
- Rollout supports existing sessions without replaying stale pending mutations.

## Out of Scope (Until Confirmed)

- Replacing `Write`, `Edit`, and `Patch` with a single public `apply_patch` tool.
- Distributed transactions across remote machines.
- Guaranteed all-or-nothing commit across multiple filesystem targets.
- Replacing the existing file-history storage format solely for this redesign.

## Technical Notes

- Relevant mycli modules:
  `backend/packages/tools/src/file-mutation-runtime.ts`, `write-tool.ts`, `edit-tool.ts`,
  `manifest.ts`, `file-history-store.ts`, `approval-policy.ts`;
  `backend/packages/runtime/src/node-turn-runtime.ts` and approval continuation;
  `backend/packages/storage/src/agent-effect-ledger.ts`.
- Codex reference:
  `/Users/cosmos/Downloads/codex-main/codex-rs/core/src/tools/handlers/apply_patch_spec.rs`,
  `apply_patch.rs`, and `codex-rs/apply-patch/src/invocation.rs`.

## Decision (ADR-lite)

**Context**: A single Codex-style tool would simplify the model API but would remove established
mycli workflows the user wants to keep.

**Decision**: Preserve `Write`, `Edit`, and `Patch` as public tools. All three use the shared file
mutation runtime, but a prepared preview does not authorize or require a particular filesystem
baseline. Execution reapplies the canonical semantic request to the current filesystem state.

**Consequences**: Backward-compatible tool discovery and TUI naming are preserved. Edit and Patch
may still fail when requested text or paths do not exist, but no longer fail solely because the
model skipped Read, a match is repeated, or the file changed after preview.
