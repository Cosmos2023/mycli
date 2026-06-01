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
