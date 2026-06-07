# P20 PRD: Skill Runtime Finalization

## Goal

Finalize the skill runtime migration by adding bounded doctor diagnostics for skill activation replayability while preserving the stable default `Skill` tool surface.

## Scope

- Add `skill_runtime_diagnostics` doctor check over `skill_activation` trace rows.
- Warn on activation rows missing replay metadata, body digest, or content length.
- Add tests proving doctor summarizes activation runtime without leaking skill body/source path.
- Keep existing default stable `Skill` tool behavior and compatibility-only `SkillToolContributionProvider`.

## Non-goals

- No marketplace/package manager productization.
- No per-skill provider-visible default tool schemas.
- No compact/rehydration implementation change.

## Acceptance

- Doctor skill runtime diagnostics has unit tests and redaction coverage.
- Existing skill schema stability, activation snapshot, and skill catalog tests remain green.
- `uv run ruff check src tests evaluation`, `uv run mypy src/mycli`, and `uv run pytest -q` pass.
- Compact/rehydration diff audit remains empty.
