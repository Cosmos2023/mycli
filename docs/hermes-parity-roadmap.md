# mycli Hermes-like Foundation Roadmap

This document is the live roadmap for the Hermes-like local agent foundation.
Update it after each completed slice so future work starts from the current
state instead of re-litigating old gap notes.

## Baseline

- Baseline branch: `feature/mycli-hermes-parity-consolidated`
- Current worktree: `feature/mycli-context-management-p1`
- Default merge policy: do not merge to `main` unless the user explicitly says `合吧` or `合入 main`.
- Reference systems: Hermes-agent for local-agent maturity, Codex for context/runtime request shape, OpenCode/Claude-style rules for project instruction ergonomics.
- Scope: local coding-agent foundation. Do not productize ACP, remote agents, browser/computer-use, cron, packaging, or enterprise policy in this phase.

## Current Foundation State

The consolidated baseline already includes these foundation slices:

- Local tools foundation: built-in manifest, toolset metadata, read/write/edit/patch/search/shell/git tooling, lifecycle traces, deterministic tool smoke.
- Hook/plugin foundation: hook lifecycle and plugin/contributed tool surfaces.
- MCP P0: local stdio MCP discovery, contributed tool conversion, manifest exposure, doctor diagnostics, provider-free smoke.
- Subagent P0: profile-backed subagent tools, manifest exposure, bounded diagnostics, provider-free smoke.
- Context P1: turn context sections, static/dynamic/ephemeral cache classes, workspace instructions, memory/session summary/compaction rehydration, context diagnostics, doctor/smoke coverage.

Estimated foundation parity with Hermes-agent: about 60-65% for core local-agent foundation, about 35-45% for full product parity.

## Roadmap

Work proceeds in this order unless a blocker forces a local prerequisite. Avoid field-level or guard-only tasks; each slice must produce runnable behavior, tests, and a short report.

| Order | Slice | Status | Purpose |
| --- | --- | --- | --- |
| 1 | Provider / Cache Policy P1 | Done | Turn context cache metadata into provider request-shape behavior. |
| 2 | Context Budget / Eviction P1 | Done | Manage whole-turn context size, not only conversation compaction. |
| 3 | Subagent Context Sharing / Fork P1 | Done | Let child agents inherit stable context without polluting parent transcript. |
| 4 | MCP Usability P1 | Next | Move MCP from P0 smokeable to reliable local tool ecosystem entry. |
| 5 | Real Task Evaluation P1 | Pending | Validate the agent on realistic multi-tool workflows. |
| 6 | Consolidation / Main Merge Decision | Pending | Run gates, update parity report, and decide whether to merge. |

## Slice Details

### 1. Provider / Cache Policy P1

Goal: make `static` / `dynamic` / `ephemeral` context metadata influence the real provider-visible request shape.

Scope:

- Keep stable system, tool schema, workspace context, and stable tool exposure before dynamic sections.
- Keep dynamic memory, conversation, plan, and compaction rehydration after the stable prefix.
- Keep ephemeral user request and runtime reminders at the end.
- Emit trace data for cache boundary, first changed section, section hashes, and estimated cacheable prefix.
- Extend doctor to flag missing section source/hash/cache-class metadata.

Expected effect:

- Repeated long-task turns keep a more stable prompt prefix.
- Cache diagnostics become actionable instead of descriptive only.
- Later budget and subagent work can depend on a stable request-shape contract.

Acceptance:

- Same workspace/tools with different user requests keeps stable prefix hash unchanged.
- Workspace instruction changes identify the first changed section.
- Request shape integration tests cover ordering and hashes.
- Provider-free smoke exports cache diagnostics.

### 2. Context Budget / Eviction P1

Goal: make mycli manage the full turn context under provider window pressure.

Scope:

- Assign priority and budget policy to every context section type.
- Degrade in order: old memory/session summaries, project context, conversation/rehydration, then low-value tool evidence.
- Always preserve current user request and required runtime safety instructions.
- Trace and doctor report trimmed sections, reason, and remaining budget.
- Add provider-free oversized-context smoke.

Expected effect:

- Large project docs, memory, summaries, or tool results no longer silently crowd out critical context.
- Context-window failures become less likely before model calls.

### 3. Subagent Context Sharing / Fork P1

Goal: make local subagents inherit useful parent context with clear boundaries.

Scope:

- Support lightweight fork context: stable baseline, memory fence, session summary, selected tool exposure.
- Keep child transcript/trace independent.
- Return only child summary/evidence to parent context.
- Enforce child tool/permission scope no broader than parent scope.

Expected effect:

- Subagents can work with parent context without copying the entire parent transcript.
- Child results improve parent work without polluting parent history.

### 4. MCP Usability P1

Goal: make local MCP tools reliable and diagnosable enough for normal agent use.

Scope:

- Improve MCP server discovery diagnostics and manifest stability.
- Align MCP timeout/failure/approval semantics with local tool lifecycle.
- Produce model-friendly MCP tool result summaries.
- Keep raw server output in trace/log references rather than the model context.
- Do not implement ACP or remote-agent productization here.

Expected effect:

- MCP failures identify config, server startup, schema, timeout, approval, or execution cause.
- Agent can use MCP tools without special-case context pollution.

### 5. Real Task Evaluation P1

Goal: measure whether the foundation performs real work, not just unit tests.

Scope:

- Refresh evaluation scenarios for realistic workflows:
  repo onboarding, small code edit, data summary, doc lookup, tool-heavy refactor,
  delegated subagent analysis, MCP-backed lookup, resume/long task.
- Make run reports readable: final answer, tool timeline, approvals, context diagnostics, failures, score.

Expected effect:

- Next priorities are based on observed failures in real tasks.

### 6. Consolidation / Main Merge Decision

Goal: finish the phase cleanly and decide whether to merge.

Scope:

- Run Python and Node gates.
- Update parity estimate and gap report.
- Summarize completed modules, remaining Hermes gaps, merge risk, and next phase.
- Do not merge to `main` without explicit user approval.

## Completion Log

Append one entry per completed slice.

### 2026-06-04 - Provider / Cache Policy P1

- Branch: `feature/mycli-context-management-p1`
- Commit: this slice commit
- Changed scope: request-shape fragment stability/order, provider-visible
  static/dynamic/ephemeral context ordering, cache boundary diagnostics, doctor
  cache metadata checks, and focused tests.
- Tests:
  - `uv run pytest tests/unit/services/test_request_shape_builder.py tests/unit/services/test_cache_shape_diagnostics.py tests/unit/domain/runtime/test_request_shape.py -q`
  - `uv run pytest tests/unit/services/test_doctor_service.py -q -k 'context_diagnostics or cache_shape_metadata'`
  - `uv run pytest tests/unit/application/test_agent_runtime.py -q -k 'request_shape or cache_shape_diagnostic'`
  - `uv run pytest tests/unit/services/test_request_shape_payload_formatter.py -q`
- Smoke/evaluation: `uv run python evaluation/context_smoke.py`
- Parity impact: stable context metadata now affects the actual provider request
  shape, not only trace descriptions. Cache diagnostics report stable prefix
  boundary and metadata completeness for doctor/actionable debugging.
- Remaining risks: provider-specific paid prompt-cache controls are still not
  implemented; context over-budget eviction remains the next slice.
- Next recommended slice: Context Budget / Eviction P1.

### 2026-06-04 - Context Budget / Eviction P1

- Branch: `feature/mycli-context-management-p1`
- Commit: this slice commit
- Changed scope: section-level turn context budgeter, runtime context assembly
  trimming, context budget trace diagnostics, doctor context-budget summary, and
  provider-free oversized-context smoke.
- Tests:
  - `uv run pytest tests/unit/services/test_section_budget.py tests/unit/services/test_turn_context_assembler.py tests/unit/services/test_request_shape_builder.py tests/unit/services/test_cache_shape_diagnostics.py tests/unit/domain/runtime/test_request_shape.py tests/unit/services/test_request_shape_payload_formatter.py -q`
  - `uv run pytest tests/unit/application/test_agent_runtime.py -q -k 'request_shape or cache_shape_diagnostic or context_budget'`
  - `uv run pytest tests/unit/services/test_doctor_service.py -q`
- Smoke/evaluation: `uv run python evaluation/context_smoke.py`
- Parity impact: oversized workspace/memory/conversation/rehydration sections are
  now trimmed before provider request construction, while current user request,
  tool exposure, and base instructions stay preserved.
- Remaining risks: trimming is deterministic and provider-free, not semantic
  LLM summarization; full provider tokenizer fidelity is still absent.
- Next recommended slice: Subagent Context Sharing / Fork P1.

### 2026-06-04 - Subagent Context Sharing / Fork P1

- Branch: `feature/mycli-context-management-p1`
- Commit: this slice commit
- Changed scope: subagent fork context snapshot domain model, child prompt
  reference-context injection, child transcript inherited-context rows,
  parent-bounded context diagnostics, `subagent_context_fork` trace events,
  Task tool payload diagnostics, and provider-free subagent smoke.
- Tests:
  - `uv run pytest tests/unit/application/runtime/subagents/test_child_loop.py tests/unit/application/runtime/subagents/test_sub_agent_service.py tests/unit/tools/test_task_tool.py -q`
  - `uv run pytest tests/unit/application/test_subagent_tool_lifecycle.py tests/unit/application/test_agent_runtime.py tests/unit/application/test_turn_service_subagents.py tests/unit/services/test_extension_manifest.py tests/unit/services/test_subagent_registry.py tests/unit/services/test_doctor_service.py -q -k 'subagent or manifest or doctor'`
  - `uv run pytest tests/unit/services/test_request_shape_builder.py tests/unit/services/test_cache_shape_diagnostics.py tests/unit/domain/runtime/test_request_shape.py tests/unit/services/test_request_shape_payload_formatter.py tests/unit/services/test_section_budget.py tests/unit/services/test_turn_context_assembler.py -q`
  - `uv run ruff check src/mycli/domain/subagents.py src/mycli/application/runtime/subagents src/mycli/application/runtime/agent_runtime.py src/mycli/services/subagents/tool_result_payload.py tests/unit/application/runtime/subagents tests/unit/tools/test_task_tool.py evaluation/subagent_smoke.py`
- Smoke/evaluation: `uv run python evaluation/subagent_smoke.py`
- Parity impact: child agents now receive a bounded inherited parent-context
  reference bundle with stable baseline fragments, optional memory/session
  fences, selected tool scope, and bounded diagnostics while keeping child
  transcript independent from parent history.
- Remaining risks: fork context is deterministic reference transfer, not yet
  semantic child-specific summarization or provider-level cache controls.
- Next recommended slice: MCP Usability P1.

Template:

```text
### YYYY-MM-DD - <Slice Name>

- Branch:
- Commit:
- Changed scope:
- Tests:
- Smoke/evaluation:
- Parity impact:
- Remaining risks:
- Next recommended slice:
```

## Guardrails

- Do not copy Hermes-agent code.
- Do not create micro-slices for a single field, single guard, or single doctor count.
- Do not mix ACP, remote agents, browser/computer-use, cron, or packaging into this roadmap.
- Every slice must include runnable behavior, tests, and diagnostic visibility.
- Keep architecture boundaries: domain is pure, application orchestrates, services provide cross-cutting support, CLI/TUI are gateway surfaces.
