# Codex-Style Tool Output System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace name-based interpretation of tool payloads with typed, bounded model outputs while preserving TUI display, old sessions, and uncommitted Shell/sub-agent work.

**Architecture:** `ToolResult` gains an optional provider-neutral `ToolModelOutput`. A new projector and shared budgeter turn typed or legacy results into one normalized model projection; execution stores that projection in the existing tool-result block, while TUI continues using `ToolDisplayEnvelope`. Tools migrate in families until the old formatter is only an old-session compatibility adapter.

**Tech Stack:** Python 3.13 dataclasses and typing, pytest, mypy, Ruff, existing RuntimeBlock/Responses/Anthropic adapters, Node TUI regression suite.

---

## File Map

- Create `src/mycli/domain/tooling/output.py`: typed model-output content and truncation metadata.
- Create `src/mycli/services/context/tool_output_budget.py`: shared head-tail text budgeting.
- Create `src/mycli/services/context/tool_output_projector.py`: typed projection and legacy fallback.
- Modify `src/mycli/domain/tooling/calls.py`: add optional `model_output` to `ToolResult`.
- Modify `src/mycli/application/runtime/tools/tool_execution_service.py`: use projected model output and persist provider metadata.
- Modify `src/mycli/schemas/responses_protocol.py`: serialize text or structured tool-result content.
- Modify provider serializers under `src/mycli/llms/adapters/`: preserve content where supported and flatten deterministically elsewhere.
- Modify tool handlers under `src/mycli/tools/` and contributed adapters under `src/mycli/services/`: emit typed output.
- Reduce `src/mycli/services/context/tool_result_formatter.py` to compatibility-only use, then remove runtime dependency.
- Modify `src/mycli/services/context/compaction/pipeline.py`: apply shared budgeting to history.
- Add focused tests under `tests/unit/domain/tooling/`, `tests/unit/services/context/`, tool tests, and provider adapter tests.

### Task 1: Typed Output Domain Contract

**Files:**
- Create: `src/mycli/domain/tooling/output.py`
- Modify: `src/mycli/domain/tooling/calls.py`
- Modify: `src/mycli/domain/tooling/__init__.py`
- Test: `tests/unit/domain/tooling/test_output.py`

- [ ] **Step 1: Write failing construction and validation tests**

```python
def test_tool_model_output_preserves_multiline_text_and_success() -> None:
    output = ToolModelOutput.from_text("one\n```python\nx = 1\n```", success=True)
    assert output.content == (ToolTextContent("one\n```python\nx = 1\n```"),)
    assert output.success is True


def test_tool_result_accepts_optional_typed_model_output() -> None:
    output = ToolModelOutput.from_text("ok", success=True)
    result = ToolResult(success=True, summary="done", model_output=output)
    assert result.model_output is output
```

- [ ] **Step 2: Run tests and verify RED**

Run: `pytest -q tests/unit/domain/tooling/test_output.py`

Expected: import or constructor failure because typed output does not exist.

- [ ] **Step 3: Implement immutable content types**

Implement `ToolTextContent`, `ToolImageContent`, `ToolJsonContent`,
`ToolOutputTruncation`, and `ToolModelOutput`. Validate non-empty image URLs,
normalize content to tuples, and provide `from_text()` and `from_json()` helpers.
Add `model_output: ToolModelOutput | None = None` to `ToolResult` without changing
constructor behavior for existing callers.

- [ ] **Step 4: Run focused tests and type checks**

Run: `pytest -q tests/unit/domain/tooling/test_output.py tests/unit/tools/test_skill_tool.py`

Expected: PASS.

- [ ] **Step 5: Commit the domain contract**

```bash
git add src/mycli/domain/tooling/output.py src/mycli/domain/tooling/calls.py \
  src/mycli/domain/tooling/__init__.py tests/unit/domain/tooling/test_output.py
git commit -m "feat: add typed tool model output contract"
```

### Task 2: Shared Output Budget And Projection

**Files:**
- Create: `src/mycli/services/context/tool_output_budget.py`
- Create: `src/mycli/services/context/tool_output_projector.py`
- Test: `tests/unit/services/context/test_tool_output_budget.py`
- Test: `tests/unit/services/context/test_tool_output_projector.py`

- [ ] **Step 1: Write failing head-tail and legacy fallback tests**

```python
def test_budgeter_retains_head_and_tail_with_explicit_marker() -> None:
    output = ToolModelOutput.from_text("HEAD\n" + "x" * 200 + "\nTAIL", success=True)
    projected = ToolOutputBudgeter().apply(output, max_chars=80)
    text = projected.text_content()
    assert "HEAD" in text
    assert "TAIL" in text
    assert "chars omitted" in text
    assert projected.truncation is not None


def test_projector_prefers_typed_output_over_legacy_payload() -> None:
    result = ToolResult(
        success=True,
        summary="legacy summary",
        raw_payload={"content": "legacy body"},
        model_output=ToolModelOutput.from_text("typed body", success=True),
    )
    projection = ToolModelOutputProjector().project("Anything", result)
    assert projection.text_content() == "typed body"
```

- [ ] **Step 2: Run tests and verify RED**

Run: `pytest -q tests/unit/services/context/test_tool_output_budget.py tests/unit/services/context/test_tool_output_projector.py`

Expected: modules do not exist.

- [ ] **Step 3: Implement deterministic budgeting and compatibility projection**

The budgeter combines text segments for accounting, preserves images, serializes
JSON with `ensure_ascii=False, sort_keys=True, separators=(",", ":")`, and records
original/retained/omitted characters. The projector selects budget classes via an
explicit enum supplied by migrated outputs; legacy fallback delegates temporarily
to `ToolResultFormatter` and then wraps its bounded text as typed output.

- [ ] **Step 4: Run focused tests**

Run: `pytest -q tests/unit/services/context/test_tool_output_budget.py tests/unit/services/context/test_tool_output_projector.py tests/unit/services/context/test_tool_result_formatter.py`

Expected: PASS.

- [ ] **Step 5: Commit projection primitives**

```bash
git add src/mycli/services/context/tool_output_budget.py \
  src/mycli/services/context/tool_output_projector.py \
  tests/unit/services/context/test_tool_output_budget.py \
  tests/unit/services/context/test_tool_output_projector.py
git commit -m "feat: project and budget tool model outputs"
```

### Task 3: Connect The Runtime And Provider Wire Formats

**Files:**
- Modify: `src/mycli/application/runtime/tools/tool_execution_service.py`
- Modify: `src/mycli/schemas/responses_protocol.py`
- Modify: `src/mycli/llms/adapters/responses_serialization.py`
- Modify: `src/mycli/llms/adapters/anthropic_messages_adapter.py`
- Modify: `src/mycli/llms/adapters/native_tool_adapter.py`
- Test: `tests/unit/application/test_tool_execution_service.py`
- Test: `tests/unit/infrastructure/models/test_responses_adapter.py`
- Test: `tests/unit/infrastructure/models/test_anthropic_messages_adapter.py`
- Test: `tests/unit/infrastructure/models/test_native_tool_adapter.py`

- [ ] **Step 1: Write failing runtime and wire-shape tests**

Test that a typed text/JSON result is projected once, guarded once, and stored in
`function_call_output_payload`. Verify Responses preserves structured content when
supported, Anthropic emits tool-result content items, and Chat-compatible adapters
receive deterministic text fallback.

```python
assert tool_block.metadata["function_call_output_payload"]["success"] is True
assert tool_block.metadata["function_call_output_payload"]["structured_content"] == [
    {"count": 2}
]
```

- [ ] **Step 2: Run tests and verify RED**

Run: `pytest -q tests/unit/application/test_tool_execution_service.py -k model_output tests/unit/infrastructure/models/test_responses_adapter.py tests/unit/infrastructure/models/test_anthropic_messages_adapter.py tests/unit/infrastructure/models/test_native_tool_adapter.py`

Expected: typed payload metadata or structured serialization assertions fail.

- [ ] **Step 3: Replace runtime name-based rendering for typed results**

Inject `ToolModelOutputProjector` into `ToolExecutionService`. Convert projected
content into guarded transcript text plus provider content metadata. Continue
using the old context manager only inside the projector's legacy branch.

- [ ] **Step 4: Extend provider-neutral serialization**

Allow `ResponsesFunctionCallOutputPayload.to_wire_output()` to return normalized
structured content when provider capability permits it. Anthropic tool results use
content items. Chat/DeepSeek/Qwen flatten text and stable JSON; unsupported images
become bounded `[image: URL]` text instead of disappearing.

- [ ] **Step 5: Run provider and runtime tests**

Run: `pytest -q tests/unit/application/test_tool_execution_service.py tests/unit/infrastructure/models/test_responses_adapter.py tests/unit/infrastructure/models/test_anthropic_messages_adapter.py tests/unit/infrastructure/models/test_native_tool_adapter.py tests/unit/infrastructure/test_provider_adapters.py`

Expected: PASS.

- [ ] **Step 6: Commit runtime integration**

```bash
git add src/mycli/application/runtime/tools/tool_execution_service.py \
  src/mycli/schemas/responses_protocol.py src/mycli/llms/adapters \
  tests/unit/application/test_tool_execution_service.py \
  tests/unit/infrastructure/models tests/unit/infrastructure/test_provider_adapters.py
git commit -m "feat: serialize typed tool outputs to model providers"
```

### Task 4: Remove Skill Duplication

**Files:**
- Modify: `src/mycli/tools/skill.py`
- Modify: `src/mycli/application/runtime/tools/tool_execution_service.py`
- Test: `tests/unit/tools/test_skill_tool.py`
- Test: `tests/unit/application/test_tool_execution_service.py`
- Test: `tests/unit/application/test_agent_runtime.py`

- [ ] **Step 1: Write a failing one-body-occurrence test**

```python
skill_body = "Find correctness bugs first."
model_visible = "\n".join(message.content for message in conversation.messages)
assert model_visible.count(skill_body) == 1
assert conversation.messages[-2].role == "tool"
assert conversation.messages[-2].content == "Activated skill: code-review"
assert conversation.messages[-1].metadata["kind"] == "skill_instructions"
```

- [ ] **Step 2: Run tests and verify RED**

Run: `pytest -q tests/unit/application/test_tool_execution_service.py -k skill`

Expected: skill body occurs twice.

- [ ] **Step 3: Emit compact typed acknowledgement from Skill**

Keep the trusted body only in the persistent skill instruction message. Preserve
the existing invoked-skill snapshot and replay metadata.

- [ ] **Step 4: Run Skill lifecycle tests**

Run: `pytest -q tests/unit/tools/test_skill_tool.py tests/unit/application/test_skill_tool_lifecycle.py tests/unit/application/test_tool_execution_service.py -k skill tests/unit/application/test_agent_runtime.py -k skill`

Expected: PASS.

- [ ] **Step 5: Commit Skill migration**

```bash
git add src/mycli/tools/skill.py \
  src/mycli/application/runtime/tools/tool_execution_service.py \
  tests/unit/tools/test_skill_tool.py tests/unit/application/test_tool_execution_service.py \
  tests/unit/application/test_agent_runtime.py
git commit -m "fix: include loaded skill instructions once"
```

### Task 5: Migrate Web, Lint, And Sub-Agent Outputs

**Files:**
- Modify: `src/mycli/tools/web_search.py`
- Modify: `src/mycli/tools/web_fetch.py`
- Modify: `src/mycli/tools/lint.py`
- Modify: `src/mycli/tools/task.py`
- Modify: `src/mycli/tools/subagent_output.py`
- Modify: `src/mycli/services/subagents/provider.py`
- Modify: `src/mycli/services/subagents/tool_result_payload.py`
- Test: `tests/unit/tools/test_web_search.py`
- Test: `tests/unit/tools/test_web_fetch.py`
- Test: `tests/unit/tools/test_lint.py`
- Test: `tests/unit/tools/test_subagent_output.py`
- Test: `tests/unit/application/test_subagent_tool_lifecycle.py`

- [ ] **Step 1: Write failing information-preservation tests**

Assert WebSearch includes result titles and URLs, WebFetch preserves line breaks,
Lint includes file/line/rule/message, and SubagentOutput includes child id, status,
and multiline report. Assert none contains file-read completion instructions.

- [ ] **Step 2: Run tests and verify RED**

Run: `pytest -q tests/unit/tools/test_web_search.py tests/unit/tools/test_web_fetch.py tests/unit/tools/test_lint.py tests/unit/tools/test_subagent_output.py`

Expected: missing test modules or missing typed outputs/detail assertions.

- [ ] **Step 3: Add tool-family presenters and typed outputs**

Keep raw payloads unchanged for TUI and hooks. Build model output from structured
payload fields, preserve report/Markdown whitespace, and assign appropriate budget
classes and `contains_external_context` values.

- [ ] **Step 4: Run tool and lifecycle tests**

Run: `pytest -q tests/unit/tools/test_web_search.py tests/unit/tools/test_web_fetch.py tests/unit/tools/test_lint.py tests/unit/tools/test_subagent_output.py tests/unit/application/test_subagent_tool_lifecycle.py tests/unit/application/runtime/subagents`

Expected: PASS.

- [ ] **Step 5: Commit high-loss tool migration**

```bash
git add src/mycli/tools/web_search.py src/mycli/tools/web_fetch.py \
  src/mycli/tools/lint.py src/mycli/tools/task.py src/mycli/tools/subagent_output.py \
  src/mycli/services/subagents tests/unit/tools tests/unit/application/test_subagent_tool_lifecycle.py
git commit -m "feat: preserve web diagnostic and subagent tool outputs"
```

### Task 6: Migrate MCP And Plugin Outputs

**Files:**
- Modify: `src/mycli/services/mcp/tool_adapter.py`
- Modify: `src/mycli/services/plugins/tool.py`
- Test: `tests/unit/services/test_mcp_provider.py`
- Test: `tests/unit/services/test_mcp_client.py`
- Test: `tests/unit/services/test_plugin_runtime.py`

- [ ] **Step 1: Write failing mixed-content tests**

Create MCP results containing text, image, resource, and structured content. Assert
text and structured content reach the normalized model output, images survive for
Responses/Anthropic, and Chat fallback names the omitted media. Add plugin tests
for typed output, dictionaries, strings, and exceptions.

- [ ] **Step 2: Run tests and verify RED**

Run: `pytest -q tests/unit/services/test_mcp_provider.py tests/unit/services/test_mcp_client.py tests/unit/services/test_plugin_runtime.py`

Expected: typed content preservation assertions fail.

- [ ] **Step 3: Implement contributed-tool adapters**

Convert MCP content blocks by type without flattening them into `summary`. Preserve
bounded raw payload for diagnostics. Let plugins return `ToolResult`,
`ToolModelOutput`, dictionaries, or strings and normalize each deterministically.

- [ ] **Step 4: Run contributed-tool tests**

Run: `pytest -q tests/unit/services/test_mcp_provider.py tests/unit/services/test_mcp_client.py tests/unit/services/test_plugin_runtime.py tests/unit/infrastructure/models/test_responses_adapter.py tests/unit/infrastructure/models/test_anthropic_messages_adapter.py`

Expected: PASS.

- [ ] **Step 5: Commit contributed-tool migration**

```bash
git add src/mycli/services/mcp/tool_adapter.py src/mycli/services/plugins/tool.py \
  tests/unit/services/test_mcp_provider.py tests/unit/services/test_mcp_client.py \
  tests/unit/services/test_plugin_runtime.py
git commit -m "feat: preserve structured contributed tool outputs"
```

### Task 7: Migrate Remaining Built-In Tool Families

**Files:**
- Modify: `src/mycli/tools/read/__init__.py`
- Modify: `src/mycli/tools/bash.py`
- Modify: `src/mycli/tools/shell_output.py`
- Modify: `src/mycli/tools/write.py`
- Modify: `src/mycli/tools/edit.py`
- Modify: `src/mycli/tools/patch.py`
- Modify: `src/mycli/tools/ls.py`
- Modify: `src/mycli/tools/glob.py`
- Modify: `src/mycli/tools/grep.py`
- Modify: `src/mycli/tools/git_tools.py`
- Modify: `src/mycli/tools/plan.py`
- Modify: `src/mycli/tools/plan_mode.py`
- Modify: `src/mycli/tools/ask_user_question.py`
- Modify: `src/mycli/tools/kill_shell.py`
- Modify: `src/mycli/tools/send_message.py`
- Test: existing corresponding tests under `tests/unit/tools/`
- Test: `tests/unit/services/context/test_tool_output_projector.py`

- [ ] **Step 1: Parameterize failing coverage for every registered tool**

Build a registry coverage test that executes or constructs representative success
and failure results for every built-in name and asserts an explicit typed output is
present. Control acknowledgements must be compact; Read/code/Shell output must
preserve whitespace; mutations and Git must retain bounded diffs.

- [ ] **Step 2: Run the coverage test and verify RED**

Run: `pytest -q tests/unit/services/context/test_tool_output_projector.py -k registered`

Expected: remaining tool names are reported as legacy.

- [ ] **Step 3: Add typed output to each remaining tool family**

Extract small presenter helpers per family rather than importing the global legacy
formatter. Reuse the shared budget classes and preserve existing raw payload and
evidence contracts.

- [ ] **Step 4: Run all tool and formatter compatibility tests**

Run: `pytest -q tests/unit/tools tests/integration/test_toolset_smoke.py tests/unit/services/context/test_tool_output_projector.py tests/unit/services/context/test_tool_result_formatter.py`

Expected: PASS with every current registry tool using typed output; formatter tests
remain only for old-session compatibility.

- [ ] **Step 5: Commit built-in migration**

```bash
git add src/mycli/tools tests/unit/tools tests/integration/test_toolset_smoke.py \
  tests/unit/services/context/test_tool_output_projector.py
git commit -m "feat: migrate built-in tools to typed model outputs"
```

### Task 8: Unify History Budgeting And Retire Runtime Formatter Use

**Files:**
- Modify: `src/mycli/services/context/compaction/pipeline.py`
- Modify: `src/mycli/services/context/context_manager.py`
- Modify: `src/mycli/services/context/tool_result_formatter.py`
- Modify: `src/mycli/application/runtime/tools/tool_execution_service.py`
- Test: `tests/unit/services/context/compaction/test_pipeline.py`
- Test: `tests/unit/services/test_context_manager.py`
- Test: `tests/unit/services/context/test_tool_output_projector.py`

- [ ] **Step 1: Write failing history-normalization tests**

Assert fresh and replayed typed outputs use the same head-tail budget, preserve
success and structured metadata, and do not invoke `ToolResultFormatter`. Assert
old stored text remains replayable.

- [ ] **Step 2: Run tests and verify RED**

Run: `pytest -q tests/unit/services/context/compaction/test_pipeline.py tests/unit/services/test_context_manager.py tests/unit/services/context/test_tool_output_projector.py`

Expected: history still rebuilds results through the old formatter.

- [ ] **Step 3: Move compaction to the shared budgeter**

Use stored function-output payload metadata when available. Keep a small
`LegacyToolResultAdapter` for old records and remove runtime name-based calls from
`ContextManager` and `ToolExecutionService`.

- [ ] **Step 4: Run context and request-shape suites**

Run: `pytest -q tests/unit/services/context tests/unit/services/test_context_manager.py tests/unit/services/test_request_shape_builder.py tests/unit/services/test_request_shape_payload_formatter.py`

Expected: PASS.

- [ ] **Step 5: Commit context migration**

```bash
git add src/mycli/services/context src/mycli/application/runtime/tools/tool_execution_service.py \
  tests/unit/services/context tests/unit/services/test_context_manager.py \
  tests/unit/services/test_request_shape_builder.py \
  tests/unit/services/test_request_shape_payload_formatter.py
git commit -m "refactor: budget typed tool outputs in conversation history"
```

### Task 9: Full Verification And Documentation

**Files:**
- Modify: `docs/superpowers/specs/2026-07-15-codex-style-tool-output-system-design.md` only if implementation evidence requires a factual correction.

- [ ] **Step 1: Run Python tests**

Run: `pytest -q`

Expected: all tests pass.

- [ ] **Step 2: Run static checks**

Run: `ruff check src tests`

Expected: no violations.

Run: `mypy src/mycli`

Expected: no errors.

- [ ] **Step 3: Run TUI regression tests and typecheck**

Run: `npm test --prefix tui/mycli-shell`

Expected: all tests pass.

Run: `npm run typecheck --prefix tui/mycli-shell`

Expected: no TypeScript errors.

- [ ] **Step 4: Verify repository hygiene**

Run: `git diff --check`

Expected: no whitespace errors. Confirm `.codex/config.toml` remains unstaged and
no unrelated user changes were reverted.

- [ ] **Step 5: Record final evidence**

Summarize migrated tool families, provider wire behavior, test totals, and any
remaining compatibility adapter. Do not mark the migration complete while a
registered tool still silently drops model-visible payload details.
