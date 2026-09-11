# File Mutation Tool Contract

## Overview

Built-in file mutation tools must be safe to execute, easy to diagnose, and
recoverable after failures. The local mutation set is `Edit`, `Patch`, and
`Write`.

## Scope / Trigger

Apply this contract when changing:

- `backend/packages/tools/src/files/edit-tool.ts`
- `backend/packages/tools/src/files/patch-tool.ts`
- `backend/packages/tools/src/files/write-tool.ts`
- shared mutation safety helpers
- file history integration
- mutation tool formatter output
- registry/manifest metadata for file mutation tools
- Node mutation code under `backend/packages/tools`
- Node tool-result persistence or gateway projection

## Contracts

- `Write` creates or replaces one complete UTF-8 file. `Edit` performs one
  exact replacement against the file content present when it executes. Neither
  tool requires a prior `Read`.
- `Patch` is a first-class built-in local tool with stable manifest id
  `builtin:Patch`. It accepts one to 64 ordered structured operations:
  `add`, `update`, `delete`, and `move`. Patch reads and validates the current
  filesystem state during preparation; it does not require a prior `Read`.
- `Patch` `move` uses independent `from_path` and `to_path` fields. Moving and
  then updating the destination is expressed as two ordered operations and is
  folded into the final prepared changeset.
- The model-visible `Write` schema contains `file_path`, `content`, and the
  optional sandbox escalation fields. It must not expose `expected_sha256`:
  models cannot reliably distinguish a real Read digest from a fabricated but
  well-formed value, especially when creating a new file.
- Direct `WriteTool` calls may still contain legacy `expected_sha256` arguments,
  but the adapter ignores them. Caller-owned hashes never authorize or block a
  file mutation.
- `Write`, `Edit`, and `Patch` accept optional
  `sandbox_permissions="workspace-write"|"danger-full-access"` and
  `justification`. The default remains the frozen turn policy.
- `danger-full-access` requires a bounded non-empty justification and is valid
  only as a one-time retry of the same operation after workspace confinement
  denied it in the current turn when the active policy is restricted. An
  already-unrestricted turn needs no additional override; the model argument
  alone never grants access.
- A `justification` sent without `danger-full-access` is inert and ignored. It
  must not turn an otherwise valid default-policy mutation into a denial.
- Mutation tools return bounded `diff` output for changed text files.
- Every validated mutation may be prepared before policy resolution. Preparation resolves paths,
  reads current content, computes bounded `fileChanges`, and returns a `PreparedMutationGuard`. It
  must not write targets, create history, consume a Read snapshot, or otherwise perform mutation
  side effects.
- `Write` compares submitted content with the real current file and classifies the change as `add`
  or `update`. `Edit` applies its exact replacement in memory. `Patch` applies all ordered
  operations to a virtual file map and projects the folded final `add`, `update`, `delete`, or
  `move` changes; a move includes `previousPath` internally and `previous_path` on the gateway.
- The guard is bounded preview/effect identity derived from canonical intent, path hashes,
  existence, and requested final-content hashes. It contains no file body, diff, or absolute path
  and is never exposed in a provider schema, provider replay, ordinary transcript metadata,
  gateway event, or TUI state. Legacy persisted guard fields remain readable for session recovery
  but are not filesystem preconditions.
- Auto-allowed, unrestricted, and approved mutations execute the canonical semantic request against
  the current filesystem. A pending approval may persist the guard once under
  `pending_decision.metadata.prepared_mutation_guard` for effect identity; the canonical tool call
  remains the sole durable source of requested content.
- Execution rebuilds the mutation instead of committing previewed bytes. `Write` replaces current
  content. `Edit` and Patch update preserve unrelated current changes when `old_string` still
  exists, and fail as `string_not_found` when it no longer exists. A changed content hash, size,
  mtime, or prior Read snapshot is never a rejection reason.
- Commit revalidates canonical path identity before creating a sibling temporary file and again
  immediately before rename. A path escape fails as `workspace_escape`; content changes alone do
  not prevent the mutation.
- A structured preview change has `version=1`, `kind`, safe display `path`, bounded unified `diff`,
  complete `addedLines` / `removedLines` counts, `truncated`, and `omittedChars`. If policy or file
  state prevents a real-content preview, the adapter may return a bounded argument-level fallback;
  it must not widen sandbox access merely to improve the preview.
- Mutation tool payloads include stable `path`, `status`, and `error_kind`
  fields where applicable.
- Mutation tools reject binary-looking existing files, directory targets,
  oversized content, and secret-like new content before writing.
- Patch accepts at most 128 distinct resolved targets. Its loaded source bytes and final retained
  content are each bounded to 8 MB; each individual existing or resulting file remains bounded to
  1 MB.
- Patch validates the complete virtual changeset before committing. Each target commit is atomic,
  but the tool does not promise an all-or-nothing filesystem transaction across multiple files.
  It writes move destinations before deleting move sources so a later failure cannot lose the
  source file.
- Empty or no-op writes/edits should not create retained file-history
  snapshots.
- File history captures each changed path before commit and marks that snapshot complete only
  after the corresponding file commit succeeds. The existing `/undo` format remains compatible.

## Error Kinds

Use stable error kinds for model recovery and diagnostics:

- `string_not_found`
- `no_op`
- `edit_existing_content`
- `already_exists`
- `not_found`
- `binary_file`
- `is_directory`
- `content_too_large`
- `file_too_large`
- `secret_like_content`
- `invalid_encoding`
- `permission_denied`
- `workspace_escape`
- `invalid_sandbox_permissions`
- `invalid_justification`
- `sandbox_override_not_approved`
- `invalid_path`
- `write_failed`
- `edit_failed`
- `patch_failed`

## Validation

Required tests for mutation tool changes:

- Edit success without a prior Read, consecutive updates, first-match default, and `replace_all`.
- Patch ordered add/update/delete/move success without a prior `Read`, first/all-match behavior,
  target and aggregate limits, and move-plus-update folding.
- Write, Edit, and Patch tests for content changes after preview: Write overwrites current content,
  while Edit/Patch reapply to current content or return `string_not_found`.
- Write overwrite diff output.
- Write secret-like and binary failures, plus ignored legacy direct-adapter `expected_sha256`.
- Registry manifest includes `Patch` as a medium-risk file tool.
- Registry mutation targets include Patch paths for file-history integration.

## Scenario: Node M4 Workspace Mutation Runtime

### 1. Scope / Trigger

- Trigger: changing Node `Read`, `Edit`, `Patch`, `Write`, mutation path policy, provider tool
  continuation, SQLite tool-result metadata, or gateway mutation events.
- M4 behavior is owned entirely by the Node runtime. A failed mutation turn must report its actual
  terminal state and must never retry through another implementation.

### 2. Signatures

- Read-only snapshot store: `FileSnapshotStore.record(snapshot)` and `latest(path)`.
- Mutation kernel: `FileMutationRuntime({workspaceRoot, sessionId?, history?})`.
- Prepared route: `ToolRouter.prepare(call, options) -> PreparedToolCall` with bounded
  `fileChanges` and optional host-only `mutationGuard`.
- Adapters: `ReadTool({workspaceRoot, snapshots})`, `EditTool(runtime)`, `PatchTool(runtime)`, and
  `WriteTool({runtime})`.
- Provider `Write` input:
  `{ file_path: string; content: string; sandbox_permissions?: "workspace-write" | "danger-full-access"; justification?: string }`.
- Legacy direct-adapter calls may contain `expected_sha256`, which `WriteTool` ignores.
- Provider permission:
  `sandbox_permissions?: "workspace-write" | "danger-full-access"` and
  `justification?: string` on `Edit`, `Patch`, and `Write`.
- Provider `Patch` input:
  `{ operations: Array<Add | Update | Delete | Move>; sandbox_permissions?; justification? }`,
  where `Add={type:"add",file_path,content}`,
  `Update={type:"update",file_path,old_string,new_string,replace_all?}`,
  `Delete={type:"delete",file_path}`, and
  `Move={type:"move",from_path,to_path}`.
- Host-only execution inputs: `ToolExecutionOptions.sandboxOverrideApproved?: boolean`,
  `ToolExecutionOptions.sandboxOverridePolicy?: ExecutionPolicy`, and
  `ToolExecutionOptions.preparedMutationGuard?: PreparedMutationGuard`.
- Approval detail projector:
  `fileMutationApprovalPreview(call: CanonicalToolCall) -> ApprovalPreviewDetails`.
- Durable input: `AppendToolResultInput.metadata?: Readonly<Record<string, unknown>>`.
- Stable provider order: `Read`, `Edit`, `Patch`, `Write`.

### 3. Contracts

- `ReadTool` may record process-local snapshots for read deduplication and diagnostics. Mutation
  tools neither consume those snapshots nor treat them as authorization.
- `Edit` and Patch update operations read the file content present when they execute. With
  `replace_all=false`, they replace the first exact match even when more matches exist; with
  `replace_all=true`, they replace every exact match.
- Provider calls to `Write` cannot supply `expected_sha256`. Direct adapter calls that still contain
  the legacy field are accepted and ignore it.
- Restricted writable targets are resolved against the real workspace root. Traversal, absolute
  outside paths, and existing or parent symlink escapes fail as `workspace_escape` before mutation.
- A frozen unrestricted execution policy permits canonical Read and mutation targets outside the
  workspace. Atomic-write, path, encoding, size, binary, and secret checks still apply. Outside
  mutations do not create workspace file-history snapshots.
- Workspace-local mutations auto-allow in M4. A restricted outside attempt fails as
  `workspace_escape`; only a matching retry with `danger-full-access` and a bounded justification
  may suspend for one-time user approval.
- Retry eligibility is turn-scoped, consumed when the approval request is created, and fingerprinted
  from the exact tool name and operation arguments other than `sandbox_permissions` and
  `justification`. Changed paths, content, replacement text, or flags do not match.
- Runtime forwards `sandboxOverrideApproved=true` only for the unchanged canonical call authorized
  by policy. Approval recovery derives the bit from the persisted call; model arguments alone and
  pre-tool hook modifications never inherit it.
- Approved execution resolves access from the runtime-owned override policy when present. Managed
  writable roots still cap the mutation; the approval bit by itself does not imply unrestricted
  filesystem access.
- The bounded justification is the user-visible approval reason. It is not copied into mutation
  receipts, result metadata, file-history rows, or diff output.
- A live approved mutation includes the prepared guard mutation id in its effect fingerprint. Only
  the bounded guard is persisted, and only in pending-decision metadata; no second copy is stored
  in the suspended turn.
- Waiting approval recovery executes the persisted canonical call against current filesystem state.
  A guard does not impose a content baseline. An orphaned already-executing effect still fails as
  `effect_outcome_unknown` and is never replayed.
- Compatibility approval details are bounded independently from the path-only policy preview:
  `Write` content is capped at 12,000 characters and carries `content_line_count`, `content_chars`,
  and `content_truncated`; `Edit` retains at most five initial lines per side within a
  12,000-character combined diff and carries `diff_chars` plus `diff_truncated`. Structured Patch
  uses its prepared `fileChanges` instead of reconstructing a flat replacement diff from arguments.
- Structured `fileChanges` and compatibility mutation preview fields are derived for the initial
  live request after the canonical tool-call batch is durably persisted and are sent only through
  the local file-change and approval presentation paths. Do not
  duplicate them in SQLite or expose them in model-visible mutation receipts, provider replay,
  traces, or ordinary diagnostics. Restart/session recovery intentionally does not reconstruct
  `content_*` or `diff*`; it re-emits only approval identity, path preview, reason, and choices so
  recovered TUI transcript metadata stays compact.
- Existing binary-looking files, directories, invalid UTF-8, files or submitted UTF-8 content over
  1,000,000 bytes, and secret-like submitted content fail closed with stable error kinds. Patch is
  additionally bounded to 64 operations, 128 resolved targets, 8 MB loaded source content, and
  8 MB final retained content.
- Writes use a temporary sibling, flush it, preserve an existing target mode, revalidate the path,
  then rename. Failure or interruption removes the temporary sibling.
- Patch prepares every operation before writing and then performs per-file atomic commits. It does
  not guarantee cross-file rollback. Destination writes precede source deletions for moves.
- Model-visible mutation output is at most 8,000 characters and contains a compact receipt or a
  stable corrective error. It never contains submitted content, hashes, or an absolute path.
- Mutation metadata paths are relative or basename-only and at most 240 characters. Unified diffs are at most
  200,000 characters and 5,000 lines; full added/removed counts may describe omitted lines.
  Outside mutation receipts and diff headers must not expose absolute local paths.
- Storage derives at most 64 `file_changes` rows from allowlisted metadata. Rows support
  `add`, `update`, `delete`, and `move`; a move requires a safe `previous_path`. Raw operations,
  submitted content, guards, hashes, absolute/traversal paths, oversized aggregate diffs, and
  unknown statuses are ignored. Provider replay keeps the compact receipt, not the diff.
- Gateway `tool.complete`, `tool.failed`, and mirrored `turn.event` payloads expose only bounded
  lifecycle fields plus allowlisted `path`, `status`, `matches`, `file_changes`, and `error_kind`.

### 4. Validation & Error Matrix

- Edit without a prior Read plus an exact match -> one atomic update and `edited` status.
- Valid Patch operations without a prior Read -> prepare the complete virtual changeset and return
  a compact `patched` result with one bounded row per folded final change.
- Repeated matches with `replace_all=false` -> replace the first match and report `matches=1`.
- Repeated matches with `replace_all=true` -> replace every match and report the full match count.
- Missing string or identical replacement -> stable failure and unchanged bytes.
- Provider `Write` call containing `expected_sha256` -> schema rejection as `invalid_arguments`
  before adapter execution; a direct-adapter call ignores the legacy field.
- Traversal/symlink escape, binary, directory, invalid encoding, size, or secret failure -> stable
  failure and unchanged bytes.
- Outside path under a restricted policy -> `workspace_escape`; the same canonical target under
  full access -> execute with normal path and mutation validation.
- Restricted `danger-full-access` without a preceding matching `workspace_escape` -> deny before
  execution; a matching retry -> suspend for one-time approval.
- Approval requested for `Write`, `Edit`, or `Patch` -> emit the detailed proposed change before
  `approval.request`; `approve_once` executes the unchanged call and `reject` leaves the target
  bytes unchanged. Full access emits the same proposal before `tool.start` and executes without an
  approval request.
- Target content changed after preparation -> rebuild from current content. Write overwrites it;
  Edit/Patch update preserve unrelated changes if `old_string` remains, otherwise return
  `string_not_found` without writing.
- Parent replaced by an escaping symlink after preparation -> `workspace_escape` before temporary
  file creation, no outside write, and no reuse of the old approval.
- Missing/blank/oversized justification for escalation or an invalid permission enum -> policy
  denial before approval; direct adapters return `invalid_justification` or
  `invalid_sandbox_permissions`, with no write. A justification without escalation is ignored.
- Direct adapter escalation without the host authorization bit ->
  `sandbox_override_not_approved` with no write.
- Approved escalation outside the runtime override roots -> `workspace_escape` with no write.
- Successful create/overwrite -> `add`/`update` file-change kind, bounded diff, compact receipt,
  and durable call/result order.

### 5. Good/Base/Bad Cases

- Good: Edit executes without a preceding Read, applies its exact replacement to current content,
  and storage/gateway expose the same bounded file-change row.
- Good: Patch moves one file, updates the destination in a later operation, and presents one folded
  move row with `previous_path` while committing the destination before deleting the source.
- Good: A live strict mutation renders each prepared `Added/Edited/Deleted/Renamed` row plus a real
  numbered diff before the approval selector; full access renders the same proposal and proceeds
  without the selector. After restart the same pending decision is actionable with only its compact
  path-level preview, and approval execution rebuilds and validates the guard.
- Base: Write creates a workspace-local UTF-8 file without a prior Read and returns an add receipt.
- Base: A non-mutation approval has no file-mutation detail fields.
- Bad: Expose `expected_sha256` to the provider and rely on its format to prove authenticity; a
  model can fabricate a well-formed digest for a new file and permanently retry a stale write.
- Bad: Require a Read snapshot or caller-provided digest before Edit/Write; models can skip Read,
  fabricate digests, or waste turns recovering from host metadata they do not own.
- Bad: Persist raw mutation metadata directly; submitted content, hashes, nested objects, or an
  oversized diff can then leak through history or gateway events.
- Bad: Persist a second approval-preview copy; it can drift from the canonical pending call and
  defeats the slim session-state contract.
- Bad: Describe Patch as an all-or-nothing filesystem transaction; the host validates the whole
  preparation but guarantees atomicity only for each individual file commit.

### 6. Tests Required

- Inventory and parameter order for all four tools; continued absence of `LS`, `Glob`, and `Grep`.
- Provider-visible Write schema excludes `expected_sha256`; direct adapter tests assert that legacy
  digest and placeholder values are ignored. Write create, overwrite, unchanged, binary, directory,
  invalid UTF-8, oversized content, secret-like content, traversal, and symlink escape remain covered.
- Edit success without Read, consecutive updates, first/all-match replacement, oversized file,
  missing string, missing target, and identical strings.
- Patch add/update/delete/move, ordered move-plus-update folding, first/all-match replacement,
  missing/existing preconditions, and operation/target/aggregate limits.
- Guarded commit tests replace a prepared parent with an outside symlink and assert rejection before
  any temporary or target file appears outside the workspace.
- Full-access outside Read plus Edit/Patch, outside Write, path-safe receipts/diffs, and restricted
  outside-path rejection.
- Exact retry fingerprinting, one-time consumption, justification bounds, forged escalation
  rejection, exact-call authorization forwarding, and approval recovery after restart.
- Bounded mutation preview tests for side-effect-free Write add/overwrite, real-line-number Edit and
  multi-file Patch diffs, delete/move kinds, approval and full-access live gateway projection, and
  child-agent projection. Restart integration must assert all proposal and guard fields are absent
  from recovered TUI events while approval still executes the persisted call once against current
  filesystem state.
- Compact receipts, statuses, error kinds, match counts, file-change kinds/counts, final file
  contents, and preservation after every failure.
- Storage, provider replay, readable projection, and gateway tests agree on call id, tool name,
  receipt, success/error kind, and bounded `file_changes` metadata.
- Responses integration asserts both Read/Edit continuation and direct Edit without Read, durable
  item order, and no alternate runtime process.
- Chat integration asserts Write execution and matching ordered `tool_call_id` replay.
- Storage and gateway tests inject content, hashes, nested fields, malformed file-change arrays,
  oversized paths, and oversized diffs, then assert those values are absent from safe projections.

### 7. Wrong vs Correct

Wrong:

```typescript
const writeProviderParameters = [
  "file_path",
  "content",
  "expected_sha256",
];
```

Correct:

```typescript
const writeProviderParameters = ["file_path", "content"];

// Legacy direct calls may contain expected_sha256; WriteTool ignores it.
```

Wrong:

```typescript
await patch.execute({
  file_path: "src/a.ts",
  old_string: "before",
  new_string: "after",
});
```

Correct:

```typescript
await patch.execute({
  operations: [{
    type: "update",
    file_path: "src/a.ts",
    old_string: "before",
    new_string: "after",
  }],
});
```

Wrong:

```typescript
const read = new ReadTool({ workspaceRoot });
const edit = new EditTool(new FileMutationRuntime({
  workspaceRoot,
}));
store.appendToolResult({ ...input, metadata: rawProviderOrToolMetadata });
```

Correct:

```typescript
const snapshots = new FileSnapshotStore();
const mutations = new FileMutationRuntime({ workspaceRoot });
const adapters = [
  new ReadTool({ workspaceRoot, snapshots }),
  new EditTool(mutations),
  new PatchTool(mutations),
  new WriteTool({ runtime: mutations }),
];
const safe = projectMutationMetadata(result.metadata, result.success);
```

Wrong:

```typescript
const recovered = {
  ...approvalIdentity,
  ...fileMutationApprovalPreview(persistedCall),
};
```

Correct:

```typescript
const liveDetails = fileMutationApprovalPreview(livePending.call);
emit({ type: "approval_requested", ...approvalIdentity, ...liveDetails });

// Recovery keeps the durable call for later execution but emits compact UI state.
return { pendingApproval: approvalIdentity, suspendedTurn: true };
```
