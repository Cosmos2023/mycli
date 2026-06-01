# Tool Smoke Evaluation Harness

## Problem

The tools hardening goal requires real task smoke evidence across data summary,
document lookup, and code modification. Full model-driven evals are useful but
costly and provider-dependent, so the built-in tools need a deterministic smoke
harness that can run locally and preserve a report under `evaluation/runs/`.

## Scope

- Add a deterministic tool smoke runner.
- Cover CSV reading/duplicate-read hints.
- Cover document search and missing-answer behavior.
- Cover code copy/write/patch plus shell verification.
- Cover at least one failed tool diagnostic.

## Non-goals

- No model/provider calls.
- No MCP, ACP, skills, subagents, browser, or computer-use productization.
- No generated report files committed; `evaluation/runs/` remains ignored.

## Acceptance

- `uv run python evaluation/tool_smoke.py` exits 0.
- The generated report records all three scenario classes and tool call counts.
- The report records a failed tool diagnostic with stable `error_kind`.
- Python unit/integration tests remain green.
