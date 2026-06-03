# Hermes-like Foundation Final Report

## Summary

- Branch: `feature/mycli-context-management-p1`
- Baseline: `feature/mycli-hermes-parity-consolidated`
- Merge policy: `main` was not merged and this branch was not merged into
  `main`.
- Roadmap source: `docs/hermes-parity-roadmap.md`
- Current recommendation: suitable as a main-merge candidate after human review,
  with known product-parity gaps documented below.

## Covered Commits

Work commits since the consolidated baseline:

- `e065be2` Stabilize provider request shape for context caching
- `883bc5e` Trim oversized turn context before provider requests
- `4729589` Let subagents inherit bounded parent context
- `b6d71c4` Make local MCP tools diagnosable for agent use
- `380a0b5` Make real task evaluation runs readable

Trellis archive commits:

- `8a4ecb1` chore(task): archive 06-04-subagent-context-sharing-fork-p1
- `2ab85e7` chore(task): archive 06-04-mcp-usability-p1
- `7094927` chore(task): archive 06-04-real-task-evaluation-p1

## Completed Modules

1. Provider / Cache Policy P1
   - Provider-visible request shape now preserves a stable prefix and emits
     cache boundary diagnostics.
2. Context Budget / Eviction P1
   - Full turn context is budgeted and trimmed while preserving critical user
     request and runtime sections.
3. Subagent Context Sharing / Fork P1
   - Child agents inherit bounded parent context snapshots while keeping child
     transcript and trace isolated.
4. MCP Usability P1
   - Local MCP tools expose stable failure taxonomy, model-friendly summaries,
     manifest origin metadata, and local-tool-aligned failure semantics.
5. Real Task Evaluation P1
   - Evaluation reports expose final answer, tool timeline, approvals, context
     diagnostics, failures, and score.
   - Provider-free real-task smoke covers repo onboarding/doc lookup, data
     summary, code edit/tool-heavy flow, subagent analysis, MCP lookup, and
     resume/context continuity.
6. Consolidation / Main Merge Decision
   - Full gates were run and this final report records merge readiness and
     remaining gaps.

## Gate Results

Python:

- `uv run pytest tests/unit tests/integration -q`
  - Result: passed, `1355 passed in 25.74s`
- `uv run ruff check src tests evaluation`
  - Result: passed
- `uv run mypy src/mycli`
  - Result: passed, `Success: no issues found in 270 source files`

Node TUI:

- `npm --prefix tui/node ci`
  - Result: passed, installed local Node dependencies.
- `PATH="/Users/cosmos/Desktop/mycli/.worktrees/mycli-context-management-p1/.venv/bin:$PATH" npm test`
  from `tui/node`
  - Result: passed, `137 passed`
  - Note: `npm test` invokes `python3` for Python manifest parity tests. On this
    machine, plain `npm test` used a system Python missing project dependencies
    and failed with `ModuleNotFoundError: No module named 'anthropic'`. Prepending
    the project `.venv/bin` makes `python3` resolve to the uv-managed project
    environment.
- `npm run typecheck` from `tui/node`
  - Result: passed

Provider-free smokes:

- `uv run python evaluation/tool_smoke.py`
  - Result: passed
- `uv run python evaluation/context_smoke.py`
  - Result: passed, `ok=true`
- `uv run python evaluation/real_task_smoke.py`
  - Result: passed, `score=100/100`, `success=true`
- `uv run python evaluation/mcp_smoke.py`
  - Result: passed
- `uv run python evaluation/subagent_smoke.py`
  - Result: passed
- `uv run python evaluation/hook_smoke.py`
  - Result: passed

## Parity Estimate

Current mycli foundation parity with Hermes-agent:

- Core local-agent foundation: about 70-75%.
- Full product parity: about 40-50%.

The foundation estimate improved because context request shape, context budget,
subagent fork context, local MCP usability, and real-task evaluation are now
implemented and verified. The full-product estimate remains lower because
Hermes-agent includes broader product surfaces that are intentionally out of
scope for this phase.

## Remaining Hermes Gaps

- Browser/computer-use/vision/image-generation tools are still out of scope.
- Remote agent / ACP surfaces are not productized.
- Hosted MCP auth/OAuth/SSE/server lifecycle management is not productized.
- Skills are foundation-level, not marketplace/sync/productized management.
- Subagents support local fork/context foundation, not swarm/team productization.
- Shell remains local; no Docker/SSH/cloud sandbox backend matrix.
- No full packaging/release/GitHub workflow matrix comparable to Hermes-agent.
- Toolset enable/disable and contributed-tool policy are visible in manifests
  but not fully productized as user-facing runtime configuration.
- Real-task evaluation is provider-free and deterministic; live model quality
  should still be measured with API-backed runs before broad release.

## Main Merge Risk

Risk level: moderate.

Reasons:

- Test evidence is strong for Python, Node TUI, provider-free smokes, and
  architecture-level foundation behavior.
- The branch has accumulated multiple foundation slices and should receive a
  human diff review before merging.
- Node TUI tests require project Python dependencies to be visible to `python3`;
  document or fix the command wrapper before expecting plain `npm test` to pass
  on clean machines.
- Product parity is not complete; merging should be framed as a local foundation
  baseline, not a Hermes-equivalent product release.

## Recommendation

Use `feature/mycli-context-management-p1` as the next foundation candidate
branch. Merge to `main` only after explicit approval and human review. The next
phase should prioritize one of:

1. File/tool safety hardening beyond the current foundation.
2. Runtime-enforced toolset configuration and contributed-tool policy.
3. Live API real-task evaluation runs using the new readable report shape.
4. Productizing one surface at a time: MCP usability P2, skills P2, or subagent
   fork P2.
