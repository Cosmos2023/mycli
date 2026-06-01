# Write/Edit/Patch Safety Hardening

## Problem

`Edit` already has exact replacement and a read snapshot guard, but the write
side is still uneven:

- `Write` lacks diff output, content safety checks, and stale overwrite
  diagnostics.
- There is no dedicated `Patch` tool in the built-in local tool registry.
- Edit failure payloads do not consistently expose actionable `error_kind`
  values for no-match, repeated-match, no-op, binary, or unsafe content cases.
- Formatter output for write mutations is mostly a raw diff preview, without
  stable status/path/match diagnostics.

## Scope

This slice covers built-in file mutation tools only:

- `Write`
- `Edit`
- new `Patch`
- shared write safety helpers
- tool registry/manifest metadata
- formatter output and unit/integration tests

## Non-goals

- No MCP, ACP, skills, subagents, browser, or computer-use productization.
- No shell execution changes.
- No full fuzzy patch engine. This slice adds exact patch/replace semantics and
  actionable failure diagnostics; fuzzy matching can follow later.

## Requirements

1. Add a built-in `Patch` tool for exact replacement using `file_path`,
   `old_string`, `new_string`, and optional `replace_all`.
2. `Patch` uses the same read snapshot/stale guard as `Edit`.
3. `Patch` returns stable diff, match count, status, path, and error_kind.
4. `Edit` failures return stable `error_kind` values for no match, repeated
   match, no-op, missing snapshot, stale snapshot, oversized file, binary or
   unsafe content.
5. `Write` returns diff for overwrites and stable status/path diagnostics.
6. `Write` refuses binary-looking existing files, directory targets, oversized
   content, and secret-like content.
7. `Write` supports an optional expected snapshot hash so callers can prevent
   stale overwrites when they have read metadata.
8. Registry/manifest include `Patch` as a medium-risk file mutation tool.
9. Formatter output for Edit/Write/Patch includes path, status, match count,
   error kind, and bounded diff preview.
10. Tests cover success, failure recovery hints, repeated matches, stale guard,
    no-op, secret-like content, binary guard, manifest registration, and file
    history mutation target integration.

## Acceptance

- Unit tests for Edit/Write/Patch pass.
- Registry manifest tests include Patch.
- Existing tools/integration tests pass.
- Full Python unit/integration tests run before commit.
