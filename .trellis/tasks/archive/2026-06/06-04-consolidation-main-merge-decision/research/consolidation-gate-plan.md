# Consolidation / Main Merge Decision Research

## Current Roadmap State

`docs/hermes-parity-roadmap.md` marks the first five slices as complete:

1. Provider / Cache Policy P1
2. Context Budget / Eviction P1
3. Subagent Context Sharing / Fork P1
4. MCP Usability P1
5. Real Task Evaluation P1

The remaining slice is Consolidation / Main Merge Decision.

## Existing Evidence Sources

- `docs/hermes-parity-roadmap.md`: live roadmap and per-slice completion log.
- `docs/hermes-agent-gap-analysis.md`: broad Hermes-vs-mycli gap analysis.
- `docs/tools-parity-report.md`: local tools parity and remaining gaps.
- `evaluation/README.md`: evaluation commands and report shape.
- `evaluation/real_task_smoke.py`: provider-free real workflow smoke.

## Gate Commands

Python:

- `uv run pytest tests/unit tests/integration -q`
- `uv run ruff check src tests evaluation`
- `uv run mypy src/mycli`

Node TUI:

- `npm test` from `tui/node`
- `npm run typecheck` from `tui/node`

Provider-free foundation smokes:

- `uv run python evaluation/tool_smoke.py`
- `uv run python evaluation/context_smoke.py`
- `uv run python evaluation/real_task_smoke.py`
- `uv run python evaluation/mcp_smoke.py`
- `uv run python evaluation/subagent_smoke.py`
- `uv run python evaluation/hook_smoke.py`

## Reporting Requirements

- Update the roadmap so all six slices are Done.
- Add a final completion log for the consolidation slice.
- Add or update a final parity/merge decision report with:
  - branch name
  - commits covered
  - completed modules
  - gate results
  - remaining Hermes gaps
  - main merge risk
  - next phase recommendation

## Non-Goals

- Do not merge to main.
- Do not start a new foundation module.
- Do not productize ACP, remote agents, browser/computer-use, cron, packaging,
  or enterprise policy.
