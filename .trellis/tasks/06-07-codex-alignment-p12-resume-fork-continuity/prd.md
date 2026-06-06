# Codex Alignment P12 Resume/Fork Continuity And Compact Boundary Guard

## Objective

Implement P12 from `docs/parity/codex-alignment-phases-p9-p13.md`: harden resume/fork runtime continuity and add compact/rehydration boundary guard regressions without touching compact/rehydration implementation.

## Problem

`mycli` already has substantial resume/fork behavior:

- `SessionService.resume_conversation()` resolves an ancestor session to its current branch tip.
- `TurnService` has integration coverage for root-to-tip pending approval and clarification resume.
- `AgentRuntime` can persist pending approvals and interrupted turns.
- Existing compaction rehydration tests cover invoked skills/files and provider-private reasoning filtering.

P12 should make these contracts harder to regress and more diagnosable, not redesign them.

## Requirements

1. Add or extend tests proving resume/fork continuity:
   - pending approval resumes on branch tip when requested from root;
   - pending clarification resumes on branch tip when requested from root;
   - forked child turns do not mutate parent transcript/history.
2. Add compact/rehydration boundary guard tests:
   - compaction rehydration stays dynamic context;
   - stable prefix hash is not changed by compaction rehydration changes alone;
   - provider-private reasoning state is filtered from compacted/rehydrated context.
3. Add bounded trace/doctor explainability for resume/fork runtime continuity if missing:
   - no raw prompt;
   - no raw tool output;
   - no provider payload body;
   - no secrets.
4. Document compact/rehydration as a protected boundary for this phase.

## Non-goals

- Do not modify compact/rehydration implementation.
- Do not mimic Codex compact rehydration.
- Do not rewrite compact engine.
- Do not implement provider-specific compact engine.
- Do not change provider request shape layering.
- Do not make real provider API calls.

## Acceptance Criteria

- Resume/fork runtime continuity has unit or integration tests.
- Pending approval resume behavior has tests.
- Pending clarification resume behavior has tests.
- Fork does not pollute parent transcript/history.
- Compact boundary guard tests pass and do not require implementation changes in compact/rehydration files.
- Any added diagnostics are bounded and redacted.
- Quality gates pass:
  - `uv run ruff check src tests evaluation`
  - `uv run mypy src/mycli`
  - `uv run pytest -q`

## Compact Boundary

This phase must not edit:

- `src/mycli/domain/runtime/compaction_rehydration.py`
- `src/mycli/services/context/compaction.py`
- `src/mycli/services/context/compaction/rehydration.py`
- `src/mycli/services/context/compaction/pipeline.py`

Tests may exercise those modules read-only.
