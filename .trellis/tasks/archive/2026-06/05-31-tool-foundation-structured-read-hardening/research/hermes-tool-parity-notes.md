# Hermes Tool Parity Notes

## Evidence

- Hermes `tools/file_tools.py` registers `read_file`, `write_file`, `patch`, and `search_files` through a central registry/toolset model.
- Hermes `read_file` returns model-visible content with line numbers, pagination, size guards, secret redaction, and per-task duplicate-read tracking.
- Hermes file operations include lint/LSP diagnostics, diff output, write-path guards, and patch retry guidance.
- mycli already has core local tools (`Read`, `Grep`, `Glob`, `LS`, `Bash`, `Edit`, `Write`, `Lint`) plus early contributed tool/MCP foundations.

## Gap Observed In Real Eval

Scenario `03-weekly-data-summary` repeatedly called `Read` for the same CSV files because CSV `Read` returned structured raw payload (`headers`, `preview`, `rows`) but no `content`. `ToolResultFormatter` only makes `content` or `evidence` model-visible for `Read`, so the model saw only `Read weekly_sales.csv` and kept searching for the actual data.

## Slice Decision

This task focuses on the highest-value local core tool foundation gaps:

- Make structured `Read` payloads visible to the model.
- Add CSV/TSV `offset`/`limit` parity with text reads.
- Add duplicate-read hints for unchanged repeated reads.
- Improve shell reroute guidance for `cat`/`head`/`tail`.
- Preserve existing edit/write snapshot safeguards and diagnostics.
- Keep the current mycli layering instead of copying Hermes' registry implementation.

Out of scope for this slice:

- Browser/computer-use/image/video tools.
- Full Hermes toolset registry parity.
- MCP/skills/subagent/ACP productization.
