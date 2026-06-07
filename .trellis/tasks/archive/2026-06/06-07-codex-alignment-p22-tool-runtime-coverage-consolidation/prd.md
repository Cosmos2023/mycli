# P22 PRD: ToolRuntime Coverage Consolidation

## Goal

Consolidate the current ToolRuntime hardening work into a provider-free coverage contract and Doctor surface that shows which tool-like action lanes are covered by lifecycle, effect, sandbox, approval, hooks, background, cancellation, and bounded diagnostics.

## Scope

- Add a bounded ToolRuntime coverage profile model and registry.
- Cover built-in tools, shell foreground/background, MCP tools, plugin tools, hook execution, subagent jobs, skill activation, and background job control lanes.
- Add Doctor `tool_runtime_coverage` diagnostics.
- Add tests proving coverage rows are bounded and highlight known partial lanes.
- Update backend spec with the ToolRuntime coverage contract and redaction boundary.

## Non-goals

- Do not rewrite all tool execution paths into a new runtime in this phase.
- Do not add new third-party dependencies.
- Do not implement Docker/SSH/remote/cloud sandbox.
- Do not productize ACP, remote agent, gateway, swarm, or background maintenance.
- Do not touch compact/rehydration implementation.

## Acceptance

- Unit tests cover the ToolRuntime coverage registry rows for all named lanes.
- Doctor reports `tool_runtime_coverage` with bounded metadata and no raw command/args/env/prompt/output/secret.
- Known partial coverage lanes are represented as warnings/gaps, not hidden.
- `uv run ruff check src tests evaluation` passes.
- `uv run mypy src/mycli` passes.
- `uv run pytest -q` passes.
- Compact/rehydration diff audit remains empty.
