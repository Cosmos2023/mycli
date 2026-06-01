# Read/List/Search Tool Output Hardening

## Problem

The first real smoke showed that weak model-visible tool output causes wasteful
local exploration. `Read` has started to improve, but `LS`, `Glob`, and `Grep`
still return thin summaries. `Grep` also returns strings in two different
formats, while the formatter currently expects dict-shaped search rows. This
makes results less grounded, harder to continue from, and easier for the model
to ignore or repeat.

## Scope

This slice hardens built-in read-only local discovery tools:

- `LS`
- `Glob`
- `Grep`
- `ToolResultFormatter` rendering for read-only discovery output

## Non-goals

- No MCP, ACP, skills, subagents, browser, or computer-use productization.
- No patch/edit/write changes in this slice.
- No shell execution policy changes in this slice.

## Requirements

1. `LS` output should expose directory, file, hidden, and total counts.
2. `LS` formatted output should keep directories/files/hidden entries visibly
   separated so the model can decide whether to list deeper or read a file.
3. `Glob` should expose matched files and dirs in a formatter-friendly shape,
   including total count and truncation.
4. `Grep` should expose model-visible, locatable results for both
   `files_with_matches` and `content` output modes.
5. `Grep` formatter must handle current string-shaped matches and structured
   dict-shaped matches.
6. Empty search results, invalid path, unsupported mode, missing `rg`, timeout,
   and truncation should produce actionable summaries/payload fields.
7. Tests should cover success, empty, structured formatting, and truncation
   behavior without requiring model/provider calls.

## Acceptance

- Unit tests cover `LS`, `Glob`, `Grep`, and formatter behavior.
- Existing read-only tool tests continue to pass.
- Full Python unit/integration tests are run before commit.
- Trellis task is archived and committed on the feature branch.
