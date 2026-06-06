# Codex Alignment P11 Skill Context Injection Migration

## Objective

Implement P11 from `docs/parity/codex-alignment-phases-p9-p13.md`: make skills behave like a stable catalog plus explicit context injection, not like one provider-visible tool schema per skill.

P11 builds on P9/P10 runtime policy and lifecycle diagnostics. It must not rewrite context assembly, provider cache request shape, or compact/rehydration.

## Problem

`mycli` now has the right core direction:

- a stable `Skill` tool registered in `AgentRuntime`;
- a model-visible `skill_catalog` context section;
- successful `Skill` calls append replayable `skill_instructions` messages;
- invoked skill snapshots are persisted for later continuity.

However, a legacy compatibility surface still exists: `SkillToolContributionProvider` can expose every discovered skill as a separate provider-visible contributed tool. That path is useful for backward compatibility tests, but it must not become the default runtime shape because adding/removing unrelated skills would change provider tool schemas and reduce prefix-cache stability.

## Requirements

1. Keep the stable `Skill` tool as the default runtime activation path.
2. Keep `SkillToolContributionProvider` available as an explicit compatibility provider, but document and test that normal bootstrap does not register it by default.
3. Ensure adding a new unactivated skill changes the skill catalog text but does not add provider-visible skill-specific tool names.
4. Ensure activated skill instructions are durable:
   - appended as model-visible transcript context;
   - represented as `SKILL_INSTRUCTIONS` turn items;
   - persisted as invoked skill snapshots.
5. Emit bounded skill activation trace rows or extend existing bounded tool lifecycle diagnostics so activation can be found without reading raw skill body.
6. Doctor/diagnostics must distinguish catalog issues from activation history without printing raw skill bodies or secrets.
7. Preserve existing compatible provider/free smoke behavior.

## Non-goals

- Do not delete `SkillToolContributionProvider`.
- Do not implement marketplace/plugin registry productization.
- Do not change provider adapters.
- Do not change provider cache request shape.
- Do not touch compact/rehydration implementation.
- Do not mimic Codex compact rehydration.

## Acceptance Criteria

- Unit test proves normal runtime exposes `Skill`, not one provider-visible tool per skill.
- Unit test proves adding an unactivated skill does not change provider-visible skill tool schema.
- Unit test proves explicit legacy `SkillToolContributionProvider` still works when injected.
- Unit test proves successful skill activation emits bounded diagnostics and records replayable history.
- Unit test proves deleted skill source still leaves usable cached invoked-skill snapshot/history without changing compact/rehydration implementation.
- Skill smoke passes.
- Context / subagent / MCP / plugin / hook smokes do not regress.
- Quality gates pass:
  - `uv run ruff check src tests evaluation`
  - `uv run mypy src/mycli`
  - `uv run pytest -q`

## Compact Boundary

P11 may add regression tests around existing invoked-skill persistence, but it must not modify compact/rehydration implementation files.
