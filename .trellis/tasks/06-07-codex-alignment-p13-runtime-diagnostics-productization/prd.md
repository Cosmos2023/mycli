# Codex Alignment P13 Runtime Diagnostics Productization

## Objective

Implement P13 from `docs/parity/codex-alignment-phases-p9-p13.md`: turn the runtime-kernel primitives from P9-P12 into a reusable local diagnostics surface for doctor, trace, dry-run, and provider-free smoke.

## Problem

P9-P12 already introduced the core primitives:

- `runtime_policy_decision` trace rows;
- `tool_runtime_lifecycle` trace rows;
- `session_continuity` trace rows;
- doctor checks for runtime policy, tool lifecycle, session continuity, approval, clarification, interrupt, and failure diagnostics;
- provider-free request-shape dry-run diagnostics.

P13 should productize these into a coherent runtime diagnostics layer, not introduce another runtime or mutate provider request assembly.

## Requirements

1. Add reusable dry-run runtime diagnostics:
   - exposed tools summary;
   - policy decision summary;
   - sandbox lane summary;
   - approval lane summary;
   - provider request shape summary passthrough;
   - bounded trace/diagnostic event counts when available.
2. Keep doctor runtime diagnostics bounded and explicit:
   - distinguish allowed / denied / needs_approval;
   - expose sandbox profile counts from existing runtime policy rows;
   - keep tool lifecycle integrity warnings;
   - include session continuity as part of runtime diagnostics.
3. Improve trace inspection/export redaction if needed:
   - bounded runtime policy fields may be shown;
   - raw arguments, raw command text, raw user prompt, raw tool output, provider payload bodies, provider keys, and full `prompt_cache_key` must not be rendered.
4. Add provider-free smoke coverage for runtime policy diagnostics.
5. Update specs with the runtime diagnostics productization contract.

## Non-goals

- Do not build UI/TUI product surfaces.
- Do not make real provider diagnostics calls.
- Do not add a telemetry backend.
- Do not modify provider request shape layering.
- Do not edit compact/rehydration implementation.
- Do not introduce third-party dependencies.

## Acceptance Criteria

- Runtime dry-run diagnostics have unit tests.
- Doctor runtime diagnostics have unit tests for sandbox/policy bounded fields.
- Trace bounded runtime fields have unit tests.
- Provider-free cache/runtime smoke includes P13 runtime diagnostics fields.
- Quality gates pass:
  - `uv run ruff check src tests evaluation`
  - `uv run mypy src/mycli`
  - `uv run pytest -q`
- Relevant smokes pass:
  - `uv run python evaluation/context_smoke.py`
  - `uv run python evaluation/subagent_smoke.py`
  - `uv run python evaluation/mcp_smoke.py`
  - `uv run python evaluation/plugin_runtime_smoke.py`
  - `uv run python evaluation/hook_smoke.py`
  - `uv run python evaluation/provider_cache_policy_smoke.py`
- Compact boundary diff audit remains empty:
  - `src/mycli/domain/runtime/compaction_rehydration.py`
  - `src/mycli/services/context/compaction.py`
  - `src/mycli/services/context/compaction/rehydration.py`
  - `src/mycli/services/context/compaction/pipeline.py`
