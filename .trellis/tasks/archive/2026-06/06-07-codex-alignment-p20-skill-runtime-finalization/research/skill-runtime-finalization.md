# P20 Research: Skill Runtime Finalization

## Current state

- Default AgentRuntime registers one stable `Skill` tool.
- `SkillToolContributionProvider` still exists as explicit compatibility provider; bootstrap tests assert it is not registered by default.
- Skill catalog is rendered as static context with names/descriptions, not bodies.
- Successful `Skill` tool activation appends replayable skill instruction context, records `InvokedSkillSnapshot`, and writes bounded `skill_activation` trace.
- Tests already verify provider tool schema stability when skills are added.

## Remaining gap

Doctor has catalog diagnostics, but does not summarize skill activation runtime diagnostics or warn on malformed activation trace rows. P20 should add a bounded `skill_runtime_diagnostics` check rather than changing compact/rehydration or marketplace behavior.

## Direction

- Add doctor summary for `skill_activation` trace rows.
- Count activations, replayable rows, missing replay metadata, missing body digest, and missing content length.
- Keep output bounded: counts only, no raw skill body, no source path, no prompt/tool output.
- Preserve existing default stable `Skill` provider-visible surface.
