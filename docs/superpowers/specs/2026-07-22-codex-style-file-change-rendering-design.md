# Codex-Style File Change Rendering Design

## Summary

mycli currently presents `Write`, `Edit`, and patch-style tools through the generic
tool card. The backend already returns a diff for completed mutations, but the TUI
adapter assumes every completed `Write` detail is file content. As a result, Write
diffs can appear as uncolored content, line counts can describe a different body
than the one on screen, and live execution can differ from `/resume`.

This design gives file mutations a typed display contract and a dedicated
Codex-style transcript cell. Successful changes render as `Added`, `Edited`, or
`Deleted` with line counts and an unfolded diff. Added and removed lines receive
theme-aware full-line backgrounds while retaining syntax foreground colors. The
model receives a compact success summary instead of a repeated diff. Live events
and resumed history project the same durable tool call/result pair into the same
file-change cell.

## Goals

- Render successful file mutations as semantic file changes rather than generic
  tool cards.
- Distinguish added, edited, deleted, renamed, unchanged, and failed outcomes.
- Use full-line green and red diff highlighting in dark and light themes.
- Preserve line numbers, `+`/`-` markers, context, wrapping, and syntax colors.
- Keep the display understandable with `NO_COLOR=1` and limited color terminals.
- Give the model a compact, stable mutation result without repeating the diff.
- Produce identical file-change cells during live execution and `/resume`.
- Bound pathological payloads explicitly without folding normal diffs by default.

## Non-Goals

- Replacing the file mutation tools or changing their input schemas.
- Changing approval policy or the existing approval preview.
- Reconstructing diffs for legacy records that contain neither a diff nor both
  before/after contents.
- Building an interactive diff editor, staging interface, or side-by-side view.
- Persisting a second file-change history record beside the existing tool result.
- Applying the new visual treatment to shell, read, search, or diagnostic tools.

## Current Problems

The current path mixes data semantics with generic presentation:

1. `ToolDisplayProjector` places the proposed file content in `display.detail`
   while a Write is running.
2. After success it places `raw_payload.diff` in the same `display.detail` field.
3. The TypeScript adapter always maps Write detail to `contentPreview`, while Edit
   detail maps to `diffPreview`.
4. `ToolExecutionComponent` only applies diff coloring to `diffPreview`.

This overloaded field causes the completed Write bug. It also makes summary and
hidden-line counts depend on the tool name rather than the displayed data kind.
Legacy metadata fallback paths introduce another source of live/resume drift.

The mutation model output has a separate problem. `mutation_model_output` returns
the result summary, path, and full diff. The provider already saw the requested
content or patch in the tool call, so repeating the diff consumes context without
adding useful evidence. Its default 1,600-character budget can also cut the diff
at an arbitrary point.

## Design Principles

### One durable source

The durable source remains the paired `TOOL_CALL` and `TOOL_RESULT`, joined by
`call_id`. A file-change transcript item is a projection of that pair, not another
append-only history item. This avoids duplicate persistence and keeps chronology
aligned with the tool execution.

### Separate consumers

One tool result serves three consumers through separate projections:

- runtime correctness uses the complete structured result;
- model context receives a compact mutation receipt;
- TUI transcript receives a structured `FileChangeDisplay`.

No consumer infers its representation by parsing another consumer's text.

### Semantics before styling

Operation kind, paths, counts, hunks, truncation, and status are explicit data.
Color, indentation, symbols, and wrapping remain TUI concerns.

## File Change Contract

Add a structured file-change payload to the mutation display envelope. The
generic `detail` field is no longer authoritative for successful mutation tools.

```python
class FileChangeKind(StrEnum):
    ADD = "add"
    UPDATE = "update"
    DELETE = "delete"
    RENAME = "rename"


@dataclass(frozen=True, slots=True)
class FileChangeDisplay:
    version: int
    kind: FileChangeKind
    path: str
    previous_path: str | None = None
    diff: str = ""
    added_lines: int = 0
    removed_lines: int = 0
    truncated: bool = False
    omitted_chars: int = 0
    language: str | None = None
```

`ToolDisplayEnvelope` gains `file_changes: tuple[FileChangeDisplay, ...]`. The
field is emitted only for mutation results with enough structured evidence. It is
included in both live lifecycle payloads and transcript snapshots.

Each entry follows these rules:

- `version` is `1`; unsupported versions use the compatibility fallback;
- `kind` describes the filesystem outcome, not the invoked tool name;
- `path` is the resulting path for add, update, and rename, and the former path
  for delete;
- `previous_path` is present only for rename;
- `diff` is unified diff content normalized to LF for display;
- counts are computed from parsed diff lines, excluding `+++` and `---` headers;
- `language` is derived from the resulting path extension when known;
- truncation is explicit and preserves head and tail hunks with an omission row.

The projector prefers structured mutation metadata from the tool implementation.
During migration it may derive a single-file entry from `path`, `diff`, and the
tool call. It must not classify a file as added or deleted from the tool name
alone. If the result lacks enough evidence, it stays on the generic mutation
fallback.

Successful unchanged writes carry no `FileChangeDisplay`; they render as a compact
`No changes to <path>` notice. Failed mutations carry no successful file change and
use the error presentation described below.

## Model-Visible Output

Successful mutation output follows Codex's compact receipt shape:

```text
Success. Updated the following files:
A src/config.py
M src/app.py
D src/legacy.py
```

The status letters are `A`, `M`, `D`, and `R`. A rename uses
`R old/path.py -> new/path.py`. A no-op returns:

```text
No changes to src/app.py
```

The model output does not repeat the unified diff or full written content. Those
already exist in the tool call and durable result metadata. The output stays
paired with the original tool call through `call_id`.

Failures return only the actionable reason and affected path when known:

```text
Failed to update src/app.py: expected lines were not found
```

Provider-facing output retains the existing success flag. Mutation receipts use a
small dedicated output budget, but the normal success form is already short and
must not be head/tail truncated.

## TUI Transcript Model

Add a `MycliShellFileChange` model and a `file_change` transcript block. The block
contains status, summary counts, one or more file entries, an optional error, and
the originating `callId`. Generic `MycliShellTool` no longer carries successful
Write/Edit/Patch content or diff previews.

During execution, a mutation may temporarily use the existing running tool row:

```text
• Writing src/config.py…
```

On successful completion, the row is replaced in place by one file-change block
with the same identity. It is not appended a second time. On failure, it is
replaced by the compact failure block. Approval UI remains transient and separate.

The adapter uses structured `display.file_changes` first. Legacy sessions use the
existing `diff`, `path`, and mutation metadata when they can be classified safely;
otherwise they retain the current generic tool rendering. Legacy fallback never
guesses an add/delete operation without evidence.

## TUI Rendering

### Single file

```text
• Added src/config.py (+4 -0)
    1 + from pathlib import Path
    2 +
    3 + def load_config(path: Path) -> str:
    4 +     return path.read_text(encoding="utf-8")
```

```text
• Edited src/app.py (+2 -2)
   23   def run(config_path: Path):
   24 -     raw = config_path.read_text()
   24 +     raw = config_path.read_text(encoding="utf-8")
   25       start(config)
```

```text
• Deleted src/legacy.py (+0 -2)
    1 - def legacy_handler():
    2 -     return "deprecated"
```

`Added`, `Edited`, and `Deleted` use success, warning, and removal tones
respectively. The path uses the existing path/accent treatment. Added and removed
counts retain explicit `+` and `-` prefixes so color is never the only signal.

### Multiple files

```text
• Edited 3 files (+12 -5)
  └ src/config.py (+4 -0)
      ...

  └ src/app.py (+8 -3)
      ...

  └ src/legacy.py (+0 -2)
      ...
```

The top line aggregates counts. Each file receives its own path and counts. A
blank separator appears between file sections. A single-file block does not repeat
the path in a nested header.

### Failure and no-op

```text
× Failed to apply patch
  └ Expected lines were not found in src/app.py
```

```text
• No changes to src/app.py
```

Errors do not display a success diff. They use the existing error token, a compact
reason, and no decorative card.

### Expansion behavior

Normal file diffs are unfolded by default and are not controlled by the global
tool-detail `Ctrl+O` toggle. This matches Codex and prevents a successful edit from
looking like an opaque tool invocation.

The display contract applies a high safety limit of 200,000 characters or 5,000
logical diff lines per file, whichever comes first. A truncated diff preserves
head and tail hunks and inserts an explicit omission line. The omission is a
safety condition, not a collapsed state, so `Ctrl+O` does not claim that hidden
content is locally available.

## Diff Parsing And Layout

The TUI uses `parse-diff` to parse unified diff into file headers, hunk headers,
context lines, insertions, deletions, and no-newline markers. It does not style
lines solely with `startsWith("+")` and `startsWith("-")` because file headers and
content can share those prefixes.

The renderer follows these rules:

- line-number width is stable for the entire file section;
- old and new line counters advance independently;
- wrapped continuation rows align under code and omit duplicate line numbers;
- CJK and emoji width use the existing terminal cell-width utilities;
- paths and code are truncated or wrapped by cell width, never JavaScript length;
- hunk headers and no-newline markers use muted/accent treatment;
- narrow terminals keep a single-column diff and reduce indentation before
  removing line numbers;
- terminals below the practical minimum may hide line numbers but retain signs.

Syntax highlighting is progressive enhancement. A shared adapter uses
`cli-highlight` with a custom theme that maps parser token categories to the
existing `syntax*` theme tokens. It receives the language and raw code lines; it
does not use automatic language detection. Diff backgrounds are applied after
syntax foregrounds. Highlighting is skipped for unknown languages, `NO_COLOR`,
or diffs above 2,000 lines. The semantic diff remains fully visible when
highlighting is skipped.

## Color And Theme Contract

Reuse the existing foreground tokens:

- `toolDiffAdded`
- `toolDiffRemoved`
- `toolDiffContext`

Add theme background tokens:

- `toolDiffAddedBg`
- `toolDiffRemovedBg`

Dark themes use low-luminance green and red backgrounds. Light themes use pale
green and red backgrounds with dark foreground text. Background contrast remains
subordinate to the code foreground and must not resemble selection or focus.

The renderer applies the background to the complete visual row, including line
number, sign, code, and wrapped continuation cells. It separately colors line
numbers and signs with the added/removed foreground tokens. Context rows have no
diff background and use a muted foreground only where syntax highlighting is not
active.

With `NO_COLOR=1`, all foreground and background escapes are omitted. Operation
words, counts, line numbers, and `+`/`-` signs preserve the complete meaning. The
ASCII fallback replaces `•`, `└`, and `×` with `*`, `\`, and `x` when Unicode
decorations are unavailable.

## Live And Resume Projection

Live and resumed rendering share one conversion path:

1. The tool result stores structured file changes in result metadata.
2. The lifecycle event includes the same bounded display envelope.
3. Live state replaces the running mutation item by `call_id`.
4. Session snapshot projection merges the durable tool call and result by
   `call_id`.
5. Both paths invoke the same `fileChangeFromDisplay` adapter.
6. Both produce one `file_change` transcript block with the durable tool item ID.

The session does not persist rendered ANSI text, theme colors, wrapped rows, or a
second TUI-only file-change event. Theme changes and terminal resizing therefore
re-render existing history correctly.

## Error Handling And Compatibility

- Malformed structured entries are ignored individually and recorded through the
  existing diagnostics path.
- An unsupported display version falls back to generic mutation rendering.
- A missing diff with a valid success receipt renders a compact changed-file line,
  not fabricated content.
- A malformed unified diff renders as bounded preformatted text under the semantic
  header, without line-number claims.
- Old sessions remain readable; session files are not rewritten during resume.
- Unknown external mutation tools keep the generic tool presentation unless they
  emit the file-change contract.

## Testing

Backend tests cover:

- Write add, Write overwrite, Edit update, delete, rename, multi-file patch, no-op,
  and failure projection;
- exact added/removed counts and exclusion of diff headers;
- compact model receipts with no repeated diff;
- display bounds, omission metadata, malformed diffs, and legacy fallback;
- lifecycle and snapshot payload equivalence.

TUI tests cover:

- running mutation replacement rather than duplicate append;
- live and resumed state equality for the same history;
- single-file and multi-file headers and line counts;
- full-line dark and light theme backgrounds;
- readable ordinary code and strings in the light theme;
- syntax foreground layered over diff backgrounds;
- `NO_COLOR`, 16/256/truecolor, and ASCII fallbacks;
- wrapped lines, CJK paths/content, emoji, narrow widths, and terminal resize;
- large-diff highlighting cutoff and explicit truncation rows;
- successful Write diff classification, which directly guards the current bug;
- failed and unchanged mutations;
- no successful mutation diff rendered by the generic tool component.

## Acceptance Criteria

- A completed Write that modifies an existing file renders as `Edited`, not as a
  content preview or `Wrote N lines` card.
- Added rows have a theme-aware green full-line background; removed rows have a
  theme-aware red full-line background in dark and light themes.
- Light-theme ordinary code remains readable.
- The model receives only a compact file list for successful mutations.
- Live execution and `/resume` render one equivalent file-change block per tool
  call without duplicate history items.
- Normal diffs are visible by default and remain semantically readable with color
  disabled.
- Existing non-mutation tool rendering and approval behavior are unchanged.
