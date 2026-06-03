# Real Task Evaluation P1 Research

## Current State

- `src/mycli/evaluation/runner.py` already discovers scenario directories,
  runs turn scripts through `service.handle_user_turn`, extracts per-turn
  timeline/tool events from `TurnRecord`, writes JSON reports, and performs
  deterministic checks from `checks/expected.json`.
- `evaluation/tool_smoke.py` provides provider-free coverage for data summary,
  document lookup, and small code modification by exercising real local tools.
- Foundation-specific provider-free smokes already exist for context, MCP,
  subagents, hooks, skills, plugins, and tool management.
- `evaluation/README.md` documents the scenario suite and existing smoke entry
  points.

## Gaps Against Roadmap

- JSON reports contain per-turn data but do not expose top-level `final_answer`.
- Tool calls are captured as raw events, but there is no compact
  `tool_timeline` for reading a run quickly.
- Approval events are not summarized at the report level.
- Context/cache/budget diagnostics are not summarized at the report level.
- Failures require manually scanning failed checks, tool events, and stop
  reasons; there is no normalized `failures` list.
- There is no report-level score for comparing run quality between scenarios.
- Provider-free smoke reports do not use the same readable fields as real
  scenario reports.

## Implementation Direction

- Extend the existing runner instead of adding a parallel evaluator.
- Keep evaluation code under `src/mycli/evaluation` and provider-free smoke
  scripts under `evaluation/`.
- Add report-level summaries that are derived from existing turn/check data:
  final answer, tool timeline, approvals, context diagnostics, failures, and
  score.
- Add a provider-free `evaluation/real_task_smoke.py` that composes realistic
  workflow evidence across local tools, context, subagent, MCP, and resume-like
  report generation without requiring a real provider key.
- Keep output deterministic and CI-friendly.
