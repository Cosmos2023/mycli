# File Mutation Architecture Research

## Compared Patterns

### Current mycli

- Separate `Write`, `Edit`, and `Patch` JSON tools.
- `Edit` and `Patch` use a process-local Read snapshot; `Write` captures a baseline at execution.
- Preview and execution are separate calls into `FileMutationRuntime`.
- Approval persists the canonical model call, not a host-owned prepared mutation.
- Per-file commit uses a synced sibling temp file, path revalidation, baseline comparison, and rename.
- Undo stores host-derived before/after hashes and refuses to replace a later manual change.

### Codex apply_patch

- One grammar-constrained freeform tool expresses Add, Update, Delete, and Move operations.
- Update context is verified against actual file content before execution.
- The host derives paths, file changes, approval keys, and committed deltas.
- No model-supplied digest or host authorization field is part of the patch language.
- Multi-file operations can report committed deltas; they are not equivalent to a portable
  cross-filesystem database transaction.

### Compare-and-Swap APIs

- CAS is useful only when the version token comes from a trusted read and remains bound to the same
  resource identity.
- A format-valid hash is not proof that a model observed the file.
- Host-owned opaque preparation IDs can safely represent a baseline, but exposing them to the model
  adds retry and persistence complexity without improving semantic expressiveness.

## Constraints From This Repository

- Node 22.19+ and the standard library are preferred.
- `ToolDefinition` currently represents only JSON function tools. Responses, Chat Completions, and
  Anthropic all project the same `inputSchema`; there is no canonical freeform/custom-tool variant.
- Provider schemas and tool manifests have one canonical projection path.
- Pending approvals survive restart, while large preview content intentionally does not duplicate
  into durable TUI state.
- Mutating effects already have durable attempt/outcome fencing.
- The worktree contains an established `/undo` format that should remain backward compatible.

## Feasible Approaches

### A. Prepared Mutation Behind Existing Tools (Recommended First Stage)

- Keep the model-facing `Write`, `Edit`, and `Patch` names.
- Add a host-owned `prepare -> approve -> commit` object with baseline and intent hashes.
- Persist only bounded identity/baseline metadata; reuse the canonical tool-call content blob.
- Re-prepare after conflict; never silently widen or rewrite the requested operation.

Pros: smallest migration, preserves provider behavior and UI, directly closes the preview/approval
race. Cons: three overlapping model tools remain and multi-file changes stay verbose.

### B. Codex-Style apply_patch Replacement

- Replace the three tools with one grammar-constrained Add/Update/Delete/Move patch tool.
- Verify patch context and produce prepared changes before approval.
- Retain the same commit, effect-ledger, and history kernel beneath it.

Pros: semantic API, fewer malformed argument combinations, strong Codex parity, efficient multi-file
changes. Cons: larger provider/TUI migration, streaming parser work, compatibility and recovery
translation for pending old calls.

### C. Stable Tools With Structured Patch Operations

- Build the prepared-mutation kernel first.
- Keep `Write` for full-file creation/replacement and `Edit` for one exact replacement.
- Change `Patch` to a bounded JSON `operations` array for multi-file Add, Update, Delete, and Move.

Pros: preserves all public tool names, works identically across every current provider, and avoids a
new parser-level provider abstraction. Cons: the nested JSON schema is more verbose than Codex's
freeform patch language.

## Recommendation

Choose C, implemented on top of A's prepared-mutation kernel. Do not add a provider-specific
freeform route until the canonical provider contract can represent it across Responses, Chat, and
Anthropic. Do not start by only changing prompts, accepting sentinel hashes, or weakening
missing-file conflict checks.
