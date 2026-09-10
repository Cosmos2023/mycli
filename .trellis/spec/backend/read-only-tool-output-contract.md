# Read-only Tool Output Contract

## Overview

Read-only local discovery tools must return bounded, model-visible, and
continuation-friendly output. The model should be able to decide whether to
read a file, list deeper, narrow a search, or answer from the current result
without repeating the same tool call.

## Scope / Trigger

Apply this contract when changing:

- `Read`
- `LS`
- `Glob`
- `Grep`
- `ToolResultFormatter`
- tool evidence or raw payload shapes for local read-only tools

## Contracts

- `Read` should expose grounded file excerpts and snapshot metadata.
- TUI summaries use validated `actualStartLine`, `actualEndLine`, `shownLines`, and `totalLines`
  to describe the returned read range. Empty, out-of-range, and unchanged reads have distinct
  summaries. CSV/TSV use row labels when row metadata is available. Preserve these bounded
  numeric fields and the `dedup` boolean through readable transcript projection and sanitization,
  without forwarding argument objects or file digests. Explicit display summaries retain priority.
- The main TUI groups Read, search, and list operations under `Exploring`/`Explored`, including
  single operations and recognized Shell searches. Consecutive reads merge deduplicated display
  filenames in one row, with hanging wrapping and no fixed target limit. Read aliases share this
  behavior. Failed/cancelled reads remain distinct so a successful retry cannot hide them.
  Expanded tools and the full transcript retain every call, full target, available output, and
  range/empty/unchanged summary; these details do not appear in the main exploration summary.
- Structured files such as CSV/TSV should expose model-visible content and
  useful summaries rather than only raw payload fields.
- Repeated unchanged reads should include a dedup hint.
- `LS` payloads include separated `dirs`, `files`, `hidden`, and corresponding
  counts. Formatter output keeps those categories separated.
- `Glob` payloads include matched files, dirs, counts, total matches, and a
  truncation flag. Formatter output should show a bounded preview.
- `Grep` preserves raw string `matches` for compatibility and also exposes
  `structured_matches` for model-visible rendering and evidence.
- `Grep` content-mode matches should expose relative path, line number, and
  line text when parseable.
- Empty search results are successful tool results with actionable next-step
  hints, not ambiguous failures.
- Error outputs should include bounded error kind/path context and should not
  include raw secrets, file contents beyond the requested excerpt, or unbounded
  command output.

## Validation

Required tests for read-only discovery changes:

- LS category counts and formatted output.
- Glob file/dir counts and formatted output.
- Grep `files_with_matches` formatting.
- Grep content-mode structured matches and evidence.
- Empty search result guidance.
- Existing read-only tool compatibility tests.
- Read range summary validation and storage-to-gateway-to-TUI preservation after resume.
