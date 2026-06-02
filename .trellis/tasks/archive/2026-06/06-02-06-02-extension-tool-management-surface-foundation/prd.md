# Extension Tool Management Surface Foundation PRD

## Goal

Make the existing tools/extension foundation visible and manageable through
slash commands, doctor diagnostics, gateway manifest discovery, and deterministic
smoke.

## Requirements

1. `/tools` lists builtin and contributed tools from the combined manifest.
2. Tool rows include source, toolset, risk, availability, and approval policy.
3. `/toolsets` lists toolset grouping, enabled state, sources, conflicts, and
   tools.
4. Slash command completion and help include `/toolsets`.
5. Doctor reports a read-only manifest/runtime consistency check.
6. Node TUI gateway `extension.manifest` returns live runtime contributed
   tools when available.
7. Deterministic smoke verifies machine manifest output and human slash output.
8. Update parity docs.

## Non-Goals

- Runtime toolset enable/disable enforcement.
- MCP remote/auth/SSE management.
- Full plugin marketplace or ACP publishing.
- Copying Hermes-agent code.
- Merging into `main`.

## Acceptance

- `uv run ruff check src tests evaluation`
- `uv run mypy src/mycli`
- `uv run pytest tests/unit tests/integration -q`
- `uv run python evaluation/tool_smoke.py`
- `uv run python evaluation/mcp_smoke.py`
- `uv run python evaluation/skill_smoke.py`
- `uv run python evaluation/subagent_smoke.py`
- deterministic management smoke passes.
