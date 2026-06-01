# Read/List/Search Notes

## Current behavior

- `Read` now records file snapshot metadata, exposes CSV/TSV content, numeric
  summaries, and repeated-read hints.
- `LS` returns names plus raw `dirs/files/hidden/total`, but the formatter only
  renders a flat `entries` preview.
- `Glob` returns raw `files/dirs/count/truncated`, but the formatter has no
  dedicated renderer for it.
- `Grep` returns string rows. For `content` mode they can be parsed into
  evidence, but for `files_with_matches` they are not locatable line evidence.
- `ToolResultFormatter._render_search_result` expects dict rows, so current
  string-shaped grep rows are not rendered as intended.

## Target

Do not introduce a new search engine. Make current read-only discovery output
more grounded and continuation-friendly:

- preserve raw payload compatibility
- add structured fields where useful
- keep formatter output bounded and easy to scan
- include actionable hints for next steps
