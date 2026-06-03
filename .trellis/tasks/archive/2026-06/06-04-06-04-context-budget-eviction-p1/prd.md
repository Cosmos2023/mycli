# Context Budget / Eviction P1

## Goal

Manage whole-turn context size before provider request construction. When
workspace instructions, memory/session summaries, project context, conversation
rehydration, or tool evidence would push a turn over the configured context
budget, mycli should degrade lower-priority sections first while preserving the
current user request and required runtime safety instructions.

## Background

mycli already has conversation/tool-result compaction and request-window
metrics, but those operate mostly on conversation history and request estimates.
The `TurnContext` assembled for a turn can still contain oversized project
context, memory, plan, and rehydration sections. This slice adds a provider-free
budget policy at the turn-context section layer so oversized sections are
trimmed deterministically before the instruction contract and request shape are
built.

## Scope

- Add a section-level context budget policy for `TurnContext`.
- Assign priorities and preserve rules for every section type.
- Trim in this broad order:
  1. memory/session summary details
  2. project/workspace context
  3. conversation and compaction rehydration
  4. low-value runtime/context evidence
- Always preserve base instructions, tool exposure, current user request, and a
  bounded runtime reminder section.
- Emit bounded trace diagnostics with target budget, before/after estimates,
  trimmed section counts, reasons, and remaining budget.
- Extend doctor context diagnostics to report trimming counts and max estimated
  savings without raw content.
- Add a provider-free oversized-context smoke.

## Non-Goals

- Do not implement LLM summarization in this slice.
- Do not add provider-specific tokenizer dependencies.
- Do not change conversation compaction strategy internals.
- Do not productize ACP, remote agents, browser/computer-use, cron, or
  packaging.

## Acceptance Criteria

- Oversized `TurnContext` is reduced under the configured budget when possible.
- Current user request, base instructions, and tool exposure are preserved.
- Trimmed sections include metadata explaining `trimmed`, `original_chars`,
  `trimmed_chars`, and `budget_reason`.
- `context_budget_diagnostic` trace rows are emitted during runtime context
  assembly.
- Doctor reports context budget trim diagnostics without raw context content.
- Provider-free smoke creates oversized context and verifies trimming.
- Relevant Python tests pass.
