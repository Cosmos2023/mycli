# File Mutation Tool Contract

## Overview

Built-in file mutation tools must be safe to execute, easy to diagnose, and
recoverable after failures. The local mutation set is `Edit`, `Patch`, and
`Write`.

## Scope / Trigger

Apply this contract when changing:

- `src/mycli/tools/edit.py`
- `src/mycli/tools/patch.py`
- `src/mycli/tools/write.py`
- shared mutation safety helpers
- file history integration
- mutation tool formatter output
- registry/manifest metadata for file mutation tools
- Node mutation code under `packages/tools`
- Node tool-result persistence or gateway projection

## Contracts

- `Edit` and `Patch` are exact replacement tools. They require a recent `Read`
  snapshot before modifying an existing file.
- `Patch` is a first-class built-in local tool with a stable manifest id
  `builtin:Patch`.
- `Write` writes complete file content and may accept `expected_sha256` to
  reject stale overwrites when a caller has read snapshot metadata.
- Mutation tools return bounded `diff` output for changed text files.
- Mutation tool payloads include stable `path`, `status`, and `error_kind`
  fields where applicable.
- Mutation tools reject binary-looking existing files, directory targets,
  oversized content, and secret-like new content before writing.
- Empty or no-op writes/edits should not create retained file-history
  snapshots.
- `mutation_targets()` must identify changed paths so runtime file history can
  snapshot before mutation.

## Error Kinds

Use stable error kinds for model recovery and diagnostics:

- `missing_read_snapshot`
- `stale_read_snapshot`
- `stale_write_snapshot`
- `multiple_matches`
- `string_not_found`
- `no_op`
- `binary_file`
- `is_directory`
- `content_too_large`
- `file_too_large`
- `secret_like_content`
- `invalid_encoding`
- `workspace_escape`

## Validation

Required tests for mutation tool changes:

- Edit/Patch success after `Read` snapshot.
- Patch repeated-match and stale-read failures.
- Write overwrite diff output.
- Write secret-like, binary, and stale expected-hash failures.
- Registry manifest includes `Patch` as a medium-risk file tool.
- Registry mutation targets include Patch paths for file-history integration.

## Scenario: Node M4 Workspace Mutation Runtime

### 1. Scope / Trigger

- Trigger: changing Node `Read`, `Edit`, `Patch`, `Write`, mutation path policy, provider tool
  continuation, SQLite tool-result metadata, or gateway mutation events.
- M4 is a preview-backend slice. Python remains the default backend and is an explicit rollback
  selection only; a failed Node turn must never fall back to Python.

### 2. Signatures

- Shared snapshot store: `FileSnapshotStore.record(snapshot)` and `latest(path)`.
- Mutation kernel: `FileMutationRuntime({workspaceRoot, snapshots})`.
- Adapters: `ReadTool({workspaceRoot, snapshots})`, `EditTool(runtime)`, `PatchTool(runtime)`, and
  `WriteTool({runtime})`.
- Durable input: `AppendToolResultInput.metadata?: Readonly<Record<string, unknown>>`.
- Stable provider order: `Read`, `Edit`, `Patch`, `Write`.

### 3. Contracts

- One process-local snapshot store is shared by all four adapters for the lifetime of a Node
  backend instance. Restarting the process clears snapshots; persisted hashes do not silently
  become current Read authorization.
- `Edit` and `Patch` require a current full-file Read snapshot. Missing and changed snapshots fail
  as `missing_read_snapshot` and `stale_read_snapshot` without writing.
- `Write` may omit `expected_sha256`; when supplied it must match the current existing file or fail
  as `stale_write_snapshot` without writing.
- Writable targets are resolved against the real workspace root. Traversal, absolute outside
  paths, and existing or parent symlink escapes fail as `workspace_escape` before mutation.
- Workspace-local mutations auto-allow in M4. Interactive approval request/resume and external
  writable roots are deferred; an escape is denied rather than paused for approval.
- Existing binary-looking files, directories, invalid UTF-8, files or submitted UTF-8 content over
  1,000,000 bytes, and secret-like submitted content fail closed with stable error kinds.
- Writes use a temporary sibling, flush it, preserve an existing target mode, revalidate the path
  and baseline, then rename. Failure or interruption removes the temporary sibling.
- Model-visible mutation output is at most 8,000 characters and contains a compact receipt or a
  stable corrective error. It never contains submitted content, hashes, or an absolute path.
- Mutation metadata paths are relative and at most 240 characters. Unified diffs are at most
  200,000 characters and 5,000 lines; full added/removed counts may describe omitted lines.
- Storage derives at most one Python-compatible `file_changes` row from allowlisted flat metadata.
  Raw arrays, nested metadata, content, hashes, absolute/traversal paths, oversized diffs, and
  unknown statuses are ignored. Provider replay keeps the compact receipt, not the diff.
- Gateway `tool.complete`, `tool.failed`, and mirrored `turn.event` payloads expose only bounded
  lifecycle fields plus allowlisted `path`, `status`, `matches`, `file_changes`, and `error_kind`.

### 4. Validation & Error Matrix

- Current Read plus unique Edit/Patch match -> one atomic update and `edited`/`patched` status.
- Missing/stale Read, stale Write hash, repeated match without `replace_all`, missing string, or
  identical replacement -> stable failure and unchanged bytes.
- Traversal/symlink escape, binary, directory, invalid encoding, size, or secret failure -> stable
  failure and unchanged bytes.
- Successful create/overwrite -> `add`/`update` file-change kind, bounded diff, compact receipt,
  durable call/result order, and no Python process.

### 5. Good/Base/Bad Cases

- Good: One shared snapshot store records a successful Read, Edit consumes that snapshot, the
  atomic replacement succeeds, and storage/gateway expose the same bounded file-change row.
- Base: Write creates a workspace-local UTF-8 file without a prior Read and returns an add receipt.
- Bad: Each adapter owns a separate snapshot store; provider-visible Read succeeds but the next
  Edit always reports `missing_read_snapshot`.
- Bad: Persist raw mutation metadata directly; submitted content, hashes, nested objects, or an
  oversized diff can then leak through history or gateway events.

### 6. Tests Required

- Inventory and parameter order for all four tools; continued absence of `LS`, `Glob`, and `Grep`.
- Write create, overwrite, unchanged, stale hash, binary, directory, invalid UTF-8, oversized
  content, secret-like content, traversal, and symlink escape.
- Edit success, missing/stale Read, oversized file, missing string, identical strings, and Patch
  success/repeated match.
- Compact receipts, statuses, error kinds, match counts, file-change kinds/counts, final file
  contents, and preservation after every failure.
- Python reads Node mutation transcripts and Node reads Python mutation transcripts, including call
  id, tool name, receipt, success/error kind, and bounded `file_changes` metadata.
- Responses integration asserts Read/Edit continuation, same-turn recovery after a missing Read,
  durable item order, and `python_started=false`.
- Chat integration asserts Write execution and matching ordered `tool_call_id` replay.
- Storage and gateway tests inject content, hashes, nested fields, malformed file-change arrays,
  oversized paths, and oversized diffs, then assert those values are absent from safe projections.

### 7. Wrong vs Correct

Wrong:

```typescript
const read = new ReadTool({ workspaceRoot });
const edit = new EditTool(new FileMutationRuntime({
  workspaceRoot,
  snapshots: new FileSnapshotStore(),
}));
store.appendToolResult({ ...input, metadata: rawProviderOrToolMetadata });
```

Correct:

```typescript
const snapshots = new FileSnapshotStore();
const mutations = new FileMutationRuntime({ workspaceRoot, snapshots });
const adapters = [
  new ReadTool({ workspaceRoot, snapshots }),
  new EditTool(mutations),
  new PatchTool(mutations),
  new WriteTool({ runtime: mutations }),
];
const safe = projectMutationMetadata(result.metadata, result.success);
```
