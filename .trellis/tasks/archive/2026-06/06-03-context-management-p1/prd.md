# Context Management P1

## Goal

Bring mycli closer to Hermes-agent context management by hardening the long-task
context foundation: context file loading, cache-aware section metadata,
reference-data fencing, compaction summary continuity, and bounded
doctor/trace diagnostics.

## Background

mycli already has a working context foundation: `TurnContextAssembler`,
`ContextManager`, `CompactionPipeline`, `CacheZones`, SQLite session summaries,
and doctor/trace infrastructure. The current gap is that important context
inputs are not yet loaded and labelled with Hermes-like cache semantics, memory
and summaries are not consistently fenced as reference data, and compaction
decisions are not visible enough for long-session diagnosis.

## In Scope

- Context file loader for project instructions.
- Cache/static/dynamic/ephemeral metadata on turn context sections.
- Fenced rendering for project context, memory, session summaries, and
  compaction rehydration.
- Compaction summary persistence and rehydration continuity.
- Read-only doctor and trace diagnostics for context state.
- Provider-free smoke covering the context-management path.

## Out Of Scope

- ACP, remote agents, swarm, or multi-platform gateway productization.
- Replacing the existing compaction pipeline with a pluggable ContextEngine.
- Cross-session provider prompt-cache productization.
- New third-party dependencies.
- Copying Hermes-agent code.

## Requirements

### 1. Context File Loader

- Load at most one project context source by priority:
  1. `.mycli.md` or `MYCLI.md`, searched from cwd up to git root or workspace root.
  2. `AGENTS.md` or `agents.md`, cwd/workspace-local.
  3. `CLAUDE.md` or `claude.md`, cwd/workspace-local.
  4. `.cursorrules`, cwd/workspace-local.
- Loader returns structured diagnostics: selected source, path, search roots,
  truncated flag, original length, rendered length, and issues.
- Content is bounded with head/tail truncation and a clear truncation marker.
- Prompt-injection scan blocks obvious instruction-hijack phrases and invisible
  control characters. Blocked content is replaced with a bounded diagnostic
  placeholder and never injected raw.
- The loader is provider-free and read-only.

### 2. Cache-Aware Turn Context Sections

- `TurnContextSection` carries a stable cache class:
  - `static`: stable prompt-prefix material such as base/workspace guidance.
  - `dynamic`: session state that can change across turns.
  - `ephemeral`: current-turn-only material such as the latest user request or
    transient runtime reminders.
- Section metadata preserves the cache class and source diagnostics so request
  assembly, trace, and future provider cache policies do not have to infer it
  from section names.
- Existing section ordering remains stable unless a test explicitly updates the
  contract.

### 3. Reference Fencing

- Workspace/project context, memory records, session summaries, and compaction
  rehydration render inside clear reference fences.
- Fences state that the content is background/reference data, not the current
  user instruction.
- The current user request remains unfenced and clearly last in the assembled
  turn context.
- Fencing must avoid duplicating the same memory/session summary text when it
  already appears in replayed conversation history.

### 4. Compaction Continuity

- When LLM summarization compacts a conversation, the summary is available to be
  persisted via the existing session summary path.
- Rehydration loads persisted summaries and includes them in fenced reference
  context on resume.
- Duplicate summaries are not injected repeatedly in the same assembled turn.
- Context overflow/reactive compaction paths continue to preserve suspended
  turns and do not break session recovery.

### 5. Diagnostics

- Doctor includes a read-only `context` or equivalent check summarizing:
  - context loader status and selected source
  - blocked/truncated context file issues
  - session summary count/availability
  - trace-observed context budget and compaction decisions when traces exist
- Trace rows include bounded context diagnostics for:
  - cache zone fingerprint/boundary
  - token budget estimate
  - compaction decision/cost metrics
  - summary persistence status
- Diagnostics must not print raw context file content, raw memory values,
  user text, tool output, headers, or secret-like values.

### 6. Smoke And Regression Safety

- Add `evaluation/context_smoke.py` that builds temporary context files,
  exercises loader/fencing/diagnostics without a provider, and writes a JSON
  report under `evaluation/runs/`.
- Existing subagent, MCP, plugin, and hook smokes must still pass.

## Acceptance Criteria

- Unit tests cover context file priority, upward search, truncation, injection
  blocking, TurnContext cache metadata, fenced rendering, summary rehydration,
  doctor diagnostics, and trace diagnostics.
- `uv run python evaluation/context_smoke.py` passes.
- `uv run python evaluation/subagent_smoke.py` passes.
- `uv run python evaluation/mcp_smoke.py` passes.
- `uv run python evaluation/plugin_runtime_smoke.py` passes.
- `uv run python evaluation/hook_management_smoke.py` passes.
- `uv run ruff check src tests evaluation/context_smoke.py evaluation/subagent_smoke.py evaluation/mcp_smoke.py` passes.
- `uv run mypy src/mycli` passes.
- `uv run pytest tests/unit tests/integration -q` passes.

## Risks

- Over-aggressive injection scanning could block legitimate project docs.
  P1 should use a small conservative denylist and bounded diagnostics.
- Fencing could bloat prompts. P1 should keep fence wording compact and test
  rendered shape.
- Summary persistence should not create duplicate model-visible context after
  resume; tests must cover repeated assembly.
