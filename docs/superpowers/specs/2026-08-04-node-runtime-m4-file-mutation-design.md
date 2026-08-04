# Node Runtime M4 File Mutation Design

## Status

Approved in conversation on 2026-08-04. The user selected workspace-local auto-approval with
fail-closed workspace boundaries and the shared filesystem-kernel architecture.

## Goal

Allow the Node backend to complete and persist provider turns that create or modify workspace text
files through the built-in `Write`, `Edit`, and `Patch` tools without starting Python. M4 must
preserve the active Python tools' conflict detection, content safety, result shape, and recovery
semantics while reusing the M3 provider loop, router, transcript, and TUI event boundaries.

## Scope

M4 includes:

- Node-native `Write`, `Edit`, and `Patch` adapters;
- provider-visible manifests and JSON schemas compatible with Python;
- one shared workspace mutation runtime for path policy, snapshots, validation, diff generation,
  and filesystem commits;
- a snapshot store shared by `Read`, `Edit`, and `Patch` for read-before-write enforcement;
- optional `expected_sha256` conflict detection for `Write`;
- workspace traversal and symbolic-link escape protection for existing and new targets;
- binary, directory, encoding, size, no-op, repeated-match, and secret-like-content guards;
- bounded mutation receipts and unified-diff metadata;
- ordered SQLite mutation transcript persistence and TUI lifecycle projection;
- Python/Node parity fixtures, Node end-to-end tests, and one sanitized live Responses smoke.

M4 is accepted only when a provider can read and mutate a disposable workspace, receive the tool
result, continue to a final answer, persist the complete transcript, and never start Python.

## Permission Decision

M4 matches the Python runtime's default `auto_approve_medium=true` behavior:

- `Write`, `Edit`, and `Patch` are medium-risk tools;
- a target confined to the real workspace root is auto-allowed;
- traversal, absolute-path escape, and symbolic-link escape are denied before mutation;
- no `approval.request` event is emitted for an allowed workspace-local mutation;
- a denied boundary is returned as a failed tool result with `workspace_escape`.

Interactive approval pause/resume, remembered allow rules, external writable roots, and unrestricted
filesystem mode are deferred. This is an explicit scope boundary, not a permanent removal of the
gateway approval contract.

## Non-Goals

M4 does not implement:

- `approval.request` / `approval.respond` or waiting-approval turn resumption;
- file-history rollback or retained pre-mutation backup snapshots;
- external writable roots or unrestricted filesystem access;
- delete, move, rename, append, directory, Git, shell, PTY, MCP, plugin, hook, skill, or subagent
  tools;
- parallel mutation execution;
- binary-file editing or document-format mutation;
- Node promotion to the default backend;
- silent fallback to Python after a Node turn begins.

## Considered Approaches

### Selected: shared filesystem mutation kernel

Add a focused mutation runtime inside `packages/tools`. `Read`, `Write`, `Edit`, and `Patch` share
one snapshot store and one path/safety policy. Tool adapters remain responsible for their schemas
and model-facing results; the shared kernel owns filesystem decisions and effects.

This mirrors the useful Python boundary, prevents safety checks from drifting across tools, and
keeps `packages/runtime` independent of filesystem implementation details.

### Rejected: independent self-contained adapters

Implementing each adapter separately would initially touch fewer files, but it would duplicate
path resolution, binary detection, size limits, secret checks, diff bounds, and error mapping.
Behavior would inevitably diverge between `Write`, `Edit`, and `Patch`.

### Rejected: mutation logic in the agent runtime

Putting file IO in `packages/runtime` would simplify direct persistence orchestration, but it would
break the M3 tool boundary and couple the provider loop to local filesystem behavior. It would also
make future tools harder to isolate and test.

## Architecture

```text
apps/mycli
  -> packages/runtime
       -> ToolRouter contract
       -> packages/storage
  -> packages/tools
       -> manifest and schemas
       -> Read / Write / Edit / Patch adapters
       -> WorkspacePathPolicy
       -> FileSnapshotStore
       -> FileMutationRuntime
```

`packages/tools` owns all filesystem reads used for mutation validation and all filesystem writes.
It does not import providers, SQLite, the gateway, or TUI code.

`packages/runtime` remains provider-neutral. It persists calls before execution, executes calls in
provider order, emits lifecycle events, persists bounded results, and continues the provider turn.
It does not special-case a mutation tool by name.

`packages/storage` keeps the existing additive JSON payload shapes. M4 requires no breaking table
or column migration.

## Components

### FileSnapshotStore

The current `ReadTool` range-dedup map is separated from the mutation snapshot store. The shared
store records the latest complete-file snapshot by normalized workspace-relative path:

```ts
interface FileSnapshot {
	readonly path: string;
	readonly sha256: string;
	readonly mtimeNs: string;
	readonly size: number;
	readonly capturedAt: string;
}
```

Every successful text, CSV, or TSV `Read` records a snapshot after the entire file has been
consumed and validated. Duplicate reads still refresh the mutation snapshot. Failed, interrupted,
binary, and unsupported reads do not record one.

The store is in memory and scoped to one Node backend instance and workspace. It is deliberately
not rehydrated from SQLite: a process restart requires a fresh `Read` before `Edit` or `Patch`,
which avoids trusting stale persisted metadata.

A successful mutation does not refresh or remove the stored `Read` snapshot. Consequently, a
second `Edit` or `Patch` without another `Read` observes the old snapshot and fails with
`stale_read_snapshot`, matching Python. A later successful `Read` replaces it.

### WorkspacePathPolicy

The existing read path policy evolves into read and mutation resolution functions that share one
real workspace-root check.

For an existing target, resolution follows symbolic links and verifies the real target remains
inside the real workspace. For a new target, resolution finds the nearest existing ancestor,
resolves that ancestor, verifies it remains inside the workspace, and appends only the missing
path segments. Empty paths, the workspace root itself, and directory targets fail.

The resolved target and its parent are revalidated immediately before the filesystem commit.
Internal symbolic links may resolve to another file inside the workspace; symbolic links that
resolve outside are rejected. Error messages expose only a bounded display path, never an escaped
absolute target.

### FileMutationRuntime

The shared runtime owns:

- UTF-8 text loading with fatal decoding;
- binary sampling compatible with Python's first-1,024-byte heuristic;
- file and content byte limits;
- secret-like-content checks compatible with the active Python patterns;
- current snapshot capture and comparison;
- exact replacement and match counting;
- normalized unified diff creation and bounding;
- parent-directory creation for `Write` only;
- interruption checks before validation, before commit, and after commit.

Validation completes before any file is changed. The commit writes a temporary sibling file with
exclusive creation and then renames it over the resolved target. Temporary files are removed on
failure. Before rename, the runtime recaptures an existing target and rechecks the snapshot used
for the operation. This narrows the compare/write race and prevents validation failures from
leaving partial content. When replacing an existing file, the temporary file receives the original
permission mode before rename.

An interruption observed before rename leaves the target unchanged. An interruption observed
after rename returns a successful mutation result so the runtime can persist the completed side
effect before marking a later boundary interrupted. M4 never reports a completed write as if no
side effect occurred.

## Tool Schemas And Behavior

All schemas use ordinary function-schema mode because each tool has optional properties. They do
not set provider `strict: true`.

### Write

```json
{
  "type": "object",
  "properties": {
    "file_path": {"type": "string", "minLength": 1},
    "content": {"type": "string"},
    "expected_sha256": {"type": "string", "minLength": 1}
  },
  "required": ["file_path", "content"],
  "additionalProperties": false
}
```

`Write` creates missing parent directories and writes complete content. Existing identical content
returns `status=unchanged` and performs no rename. If `expected_sha256` is supplied, a missing or
changed target returns `stale_write_snapshot`. Without it, `Write` intentionally retains Python's
explicit full-overwrite behavior.

Successful statuses are `created`, `overwritten`, or `unchanged`.

### Edit

```json
{
  "type": "object",
  "properties": {
    "file_path": {"type": "string", "minLength": 1},
    "old_string": {"type": "string"},
    "new_string": {"type": "string"},
    "replace_all": {"type": "boolean"}
  },
  "required": ["file_path", "old_string", "new_string"],
  "additionalProperties": false
}
```

`Edit` requires a snapshot recorded by `Read`. The current hash, modification time, and size must
all match. `old_string` must occur exactly once unless `replace_all=true`. Python-compatible
line-number prefixes are removed from `old_string`, and trailing horizontal whitespace handling
follows the active Python behavior for Markdown versus other text files.

An empty `old_string` may populate an existing empty file that was successfully read. Because the
provider-visible tool always enforces the read snapshot first, it cannot create a missing file;
that operation uses `Write`. It may not overwrite a non-empty existing file. A successful edit
returns `status=edited` plus `matches`.

### Patch

`Patch` uses the same schema and replacement kernel as `Edit`, requires the same current `Read`
snapshot, and returns `status=patched` plus `matches`. It remains a first-class manifest entry with
stable id `builtin:Patch`; it is not an alias hidden from providers.

`Patch` and `Edit` deliberately share execution mechanics while retaining distinct tool names,
summaries, statuses, manifest ids, and transcript identities.

## Limits And Safety

M4 preserves the active Python limits and classifications:

- maximum replacement target size: 1,000,000 bytes;
- maximum new content size: 1,000,000 UTF-8 bytes;
- binary sample: first 1,024 bytes, including NUL and suspicious-control detection;
- secret patterns: OpenAI-style `sk-...` values and quoted assignment values for API key,
  secret, token, or password names;
- model-visible result: at most 8,000 characters;
- persisted/display diff: at most 200,000 characters and 5,000 lines, retaining bounded head and
  tail context with truncation metadata.

Secrets are checked only in newly supplied content. Failure results never echo the submitted
content, old string, expected hash, or resolved absolute path.

## Result Contract

A successful mutation returns bounded metadata:

```ts
{
	path: string,
	status: "created" | "overwritten" | "unchanged" | "edited" | "patched",
	matches?: number,
	diff: string,
	addedLines: number,
	removedLines: number,
	diffTruncated: boolean,
	omittedChars?: number
}
```

The model receives a compact receipt compatible with Python:

```text
Success. Updated the following files:
A path/to/new-file.ts
```

or `M` for an update. `unchanged` returns `No changes to <path>`. The full bounded diff is metadata
for persistence and TUI projection, not repeated in provider continuation text.

Failures include `path` and `errorKind` metadata plus a bounded corrective message. They do not
include partial diff metadata.

## Error Matrix

Expected tool-level errors are returned to the model and do not terminate the turn:

- `missing_read_snapshot`;
- `stale_read_snapshot`;
- `stale_write_snapshot`;
- `multiple_matches`;
- `string_not_found`;
- `no_op`;
- `edit_existing_content`;
- `not_found`;
- `binary_file`;
- `is_directory`;
- `content_too_large`;
- `file_too_large`;
- `secret_like_content`;
- `invalid_encoding`;
- `permission_denied`;
- `workspace_escape`;
- bounded `write_failed`, `edit_failed`, or `patch_failed` fallback kinds.

Malformed JSON or schema-invalid arguments remain `invalid_arguments`. Interruption is propagated
to the runtime rather than converted into an ordinary tool failure. Persistence failure, provider
protocol corruption, and an unhandled filesystem invariant failure are terminal turn failures.

## Runtime, Persistence, And Recovery

The M3 sequential loop remains unchanged in shape:

```text
persist assistant tool calls
  -> emit tool.start
  -> validate and execute mutation
  -> emit tool.complete or tool.failed
  -> persist bounded tool result
  -> reload canonical history
  -> continue provider turn
```

Calls from one provider step execute sequentially in provider order. This is mandatory for
mutation tools even if a future read-only scheduler supports parallel calls. A later call observes
the filesystem effects and snapshots produced by earlier calls.

The existing SQLite assistant-call and tool-result records remain the canonical transcript.
Mutation result metadata adds bounded file-change fields inside existing JSON payloads; no schema
column is required. Python must read Node-written mutation records and Node must read Python-written
records without losing call IDs, tool names, success state, summary, error kind, or file-change
projection.

M3 startup recovery continues to synthesize results for unmatched persisted calls and never
re-executes a mutation. If the process exits after a filesystem commit but before the corresponding
result is durable, recovery reports the unmatched call as interrupted and does not guess or replay
the side effect. The next provider turn must inspect the file before deciding what to do. M4's
atomic target replacement prevents partial file bytes but cannot make filesystem and SQLite commits
one transaction; this residual boundary is documented and tested.

Duplicate `client_turn_id` submissions return the stored turn and never repeat filesystem work.
A failed Node mutation is never retried through Python.

## Gateway And TUI Projection

M4 reuses `tool.start`, `tool.complete`, and `tool.failed`. Successful completion metadata includes
only bounded path, status, counts, and file-change diff fields. Failed events include bounded path
and error kind. Raw arguments, content, hashes, and escaped absolute paths are never emitted.

The existing TUI file-change renderer consumes the normalized metadata and does not branch on
backend language. M4 adds no layout, key binding, modal, or approval UI.

## Testing

Offline acceptance requires:

1. manifest tests for the stable `Read`, `Edit`, `Patch`, `Write` order, ids, schemas, risk, approval
   policy, effects, tags, and optional-schema projection;
2. path-policy tests for existing and new relative targets, allowed internal symlinks, traversal,
   absolute escape, symlink escape, missing parents, workspace-root targets, directories, and
   permission errors;
3. snapshot-store tests for recording, replacement, normalized keys, duplicate reads, process-local
   lifetime, missing snapshots, and hash/mtime/size conflicts;
4. mutation-kernel tests for UTF-8, binary detection, content/file limits, secret patterns, parent
   creation, no-op writes, temporary-file cleanup, interruption, and bounded unified diffs;
5. `Write` tests for create, overwrite, unchanged, expected hash success, stale hash, missing target
   with expected hash, and validation failures preserving original bytes;
6. `Edit` and `Patch` tests for read-before-write success, missing/stale snapshots, unique and
   repeated matches, `replace_all`, missing strings, identical strings, empty old strings, Markdown
   whitespace behavior, and stable distinct statuses;
7. router and runtime tests for failed-tool recovery, sequential multi-mutation order, interruption,
   event ordering, persistence ordering, and provider continuation;
8. Responses and Chat adapter fixtures proving all four tools are projected without strict mode;
9. SQLite Python-to-Node and Node-to-Python mutation transcript parity fixtures;
10. gateway/TUI parity fixtures for bounded mutation file-change metadata;
11. an end-to-end Node turn that reads, mutates, continues, completes, reloads, and proves
    `python_started=false`;
12. full Node and targeted Python suites, ESLint, TypeScript typecheck, contracts, build, pack smoke,
    and M3 regression gates.

After offline gates pass, one authorized `gpt-5.5` Responses smoke may run against the configured
non-official compatible endpoint. It uses zero retries, a short timeout, bounded tokens, a unique
temporary workspace and database, and a prompt that requests one `Read` followed by one bounded
`Edit` or `Write`. The script prints only protocol, terminal status, mutation lifecycle counts,
persisted state, final file invariant, and `python_started=false`. It never prints credentials,
endpoint details, prompts, arguments, file contents, diffs, hashes, or model text.

## Exit Gate

M4 is complete when:

- the Node backend advertises `Read`, `Edit`, `Patch`, and `Write` in that stable manifest order;
- both provider protocols can execute mutation calls, receive their results, and finish;
- workspace-local writes follow the selected auto-allow policy and every escape fails closed;
- conflict, content-safety, exact-replacement, output-bound, and error-kind parity tests pass;
- mutation transcripts and file-change metadata survive reload and remain Python-readable;
- interruption and unmatched-call recovery never replay a mutation;
- the full offline quality gate passes;
- the sanitized live smoke succeeds when the authorized endpoint is available;
- the complete M4 turn starts no Python process;
- a failed Node turn never falls back to Python.

Python remains the default backend after M4. Interactive approval, external writable roots,
file-history rollback, and additional tool families require separately approved milestones.
