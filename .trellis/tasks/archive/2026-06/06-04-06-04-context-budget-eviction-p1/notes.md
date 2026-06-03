# Research Notes

## Current Evidence

- `ContextBudget` exists in `services/context/compaction/budget.py` and tracks
  max tokens, total tokens, usage ratio, and remaining tokens.
- `ContextWindowAnalyzer` and `ToolResultBudget` compact conversation/tool
  results, but they do not trim `TurnContextSection` content.
- `TurnContextAssembler` builds typed sections with `TurnContextCacheClass` and
  section sources. This is the right point to apply section budget policy.
- `RuntimeContextBuilder.assemble_turn_context()` already logs turn-context
  summary but does not trace section-level budget decisions.
- `RequestPipeline._trace_context_diagnostics()` emits bounded context
  diagnostics from enabled sections, and doctor summarizes `context_diagnostics`
  and `cache_shape_diagnostic` rows.
- `evaluation/context_smoke.py` is provider-free and already constructs
  `TurnContext` plus doctor context diagnostics.

## Implementation Direction

- Add a service under `services/context/` for section-level budgeting.
- Keep it pure/provider-free and based on the existing `TokenCounter`.
- Inject it into `RuntimeContextBuilder` with default config derived from
  `AgentConfig.max_prompt_tokens`.
- Emit `context_budget_diagnostic` trace rows in the runtime builder boundary.
- Extend doctor to summarize `context_budget_diagnostic` rows.
- Add unit tests around the budgeter and runtime-builder/doctor behavior.
