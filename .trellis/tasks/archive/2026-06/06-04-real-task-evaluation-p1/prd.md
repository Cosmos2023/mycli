# Real Task Evaluation P1 PRD

## Objective

Make mycli's evaluation output useful for judging real local-agent work. The
slice should refresh the evaluation reporting layer so a run shows the final
answer, tool timeline, approval activity, context diagnostics, failures, and a
score without manually reading raw streamed events.

## Scope

- Enhance `src/mycli/evaluation/runner.py` report model and rendering.
- Preserve existing scenario discovery, deterministic checks, and CLI behavior.
- Add or update provider-free smoke coverage under `evaluation/`.
- Update evaluation documentation.
- Update `docs/hermes-parity-roadmap.md` completion log when the slice finishes.

## Functional Requirements

1. `EvaluationRunReport.to_dict()` must include top-level:
   - `final_answer`
   - `tool_timeline`
   - `approvals`
   - `context_diagnostics`
   - `failures`
   - `score`
2. `render_evaluation_report()` must print a compact human-readable summary
   that includes score, final answer preview, tool timeline count, approval
   count, context diagnostic count, and failure count.
3. Tool timeline must be derived from existing per-turn tool events.
4. Approval summary must be derived from runtime timeline events when present
   and default to an empty list when no approval events occurred.
5. Context diagnostics must be derived from runtime timeline events when
   present and default to an empty list when no context diagnostics occurred.
6. Failures must include failed deterministic checks, failed/unconverged turns,
   and failed tool events where evidence is available.
7. Score must be deterministic and provider-free. Use check pass ratio when
   checks exist, with penalties for runtime/tool failures.
8. A provider-free real-task smoke must produce a JSON report with the same
   top-level readability fields and cover:
   - repo onboarding/doc lookup
   - small code edit/tool-heavy workflow
   - data summary
   - subagent delegated analysis signal
   - MCP-backed lookup signal
   - resume/long-task style continuity signal

## Non-Goals

- Do not implement new model/provider behavior.
- Do not require real API keys for the smoke.
- Do not productize ACP, remote agents, browser/computer-use, cron, packaging,
  or enterprise policy.
- Do not replace the existing evaluation runner.

## Acceptance Criteria

- Unit tests cover report serialization, rendering, score/failure extraction,
  approval extraction, and context diagnostic extraction.
- Provider-free smoke writes a readable report under `evaluation/runs/`.
- `evaluation/README.md` documents the new report shape and smoke command.
- Focused test commands pass:
  - `uv run pytest tests/unit/evaluation/test_runner.py tests/unit/cli/test_eval_cli.py -q`
  - `uv run python evaluation/real_task_smoke.py`
  - `uv run python evaluation/tool_smoke.py`
  - `uv run python evaluation/mcp_smoke.py`
  - `uv run python evaluation/subagent_smoke.py`
  - `uv run ruff check src/mycli/evaluation evaluation tests/unit/evaluation tests/unit/cli/test_eval_cli.py`
