# Subagent Task Tool Lifecycle Foundation PRD

## Goal

Make Task/subagent match the local lifecycle foundation already used for MCP
and skills: discoverable, diagnosable, present in the combined manifest,
callable through runtime routing, and covered by deterministic smoke.

## Non-Goals

- Full multi-agent productization.
- Remote worker lifecycle.
- Cross-agent file locking.
- Copying Hermes-agent code.
- Merging into `main`.

## Requirements

1. Expose configured subagent profiles as contributed tools with route names
   `subagent.<profile>`.
2. Combined manifest entries must render subagent-origin tools with
   `source=subagent`, `toolset=external`, and profile metadata.
3. Doctor must report subagent profile diagnostics without leaking task
   descriptions, prompts beyond bounded metadata, or local secrets.
4. Runtime routing must invoke a fake/local subagent through
   `ToolOrchestrator`/`ToolRouter` and record lifecycle states.
5. Add deterministic `evaluation/subagent_smoke.py`.
6. Update `docs/tools-parity-report.md`.

## Acceptance

- `uv run ruff check src tests evaluation/subagent_smoke.py`
- `uv run mypy src/mycli`
- `uv run pytest tests/unit tests/integration -q`
- `uv run python evaluation/tool_smoke.py`
- `uv run python evaluation/mcp_smoke.py`
- `uv run python evaluation/skill_smoke.py`
- `uv run python evaluation/subagent_smoke.py`
