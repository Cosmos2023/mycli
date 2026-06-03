# Consolidation / Main Merge Decision PRD

## Objective

Finish the roadmap phase by proving the six-slice Hermes-like local agent
foundation is in a coherent, testable state and by producing a main-merge
decision report. Do not merge to `main`.

## Scope

- Run Python, Node TUI, and provider-free foundation gates.
- Update `docs/hermes-parity-roadmap.md` status and Completion Log.
- Add or update a final parity/merge decision report under `docs/`.
- Preserve the current architecture boundaries and avoid unrelated refactors.

## Functional Requirements

1. All six roadmap rows must be marked `Done`.
2. The final report must include:
   - branch name
   - commits covered
   - completed modules
   - test/gate results
   - remaining Hermes gaps
   - main merge risk
   - next phase recommendation
3. The final report must explicitly say that `main` was not merged.
4. If a gate is blocked by local environment, the report must record the exact
   command, failure, and reproduction/fix hint.
5. The Trellis task must be archived after the report and gates are complete.

## Acceptance Criteria

- Run and record:
  - `uv run pytest tests/unit tests/integration -q`
  - `uv run ruff check src tests evaluation`
  - `uv run mypy src/mycli`
  - `npm test` in `tui/node`
  - `npm run typecheck` in `tui/node`
  - provider-free smokes listed in research.
- `docs/hermes-parity-roadmap.md` marks Consolidation done and records this
  slice in the Completion Log.
- A final report exists under `docs/`.
- Worktree is clean after commits/archive.
