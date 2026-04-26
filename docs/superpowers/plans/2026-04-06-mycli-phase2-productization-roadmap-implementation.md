# mycli Phase 2 Productization Roadmap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `mycli` into a more reliable Phase 2 coding agent by strengthening tool grounding, task execution state, structured tools, traceability, and provider/runtime stability before introducing sandboxing.

**Architecture:** Extend the existing Responses-first runtime instead of replacing it. Keep `AgentRuntime`, `ToolRegistryV2`, `SessionService`, and the existing CLI REPL as the main spine, then add richer task state, structured trace assets, stronger tool result reinjection, and better provider-facing error/capability handling around that spine.

**Tech Stack:** Python 3.13, standard library `dataclasses`/`pathlib`/`json`/`subprocess`, existing Responses runtime, `pytest`, `ruff`, `mypy`

---

## Scope Check

The approved roadmap spans five tightly related workstreams: grounding, task runtime, tool expansion, trace/audit, and provider stability. They all modify the same runtime/session/tool core, so this plan keeps them together as one Phase 2 implementation track, but splits them into independently verifiable tasks.

## File Structure

- Modify: `src/mycli/services/context/context_manager.py`
  Centralizes how tool results are rendered back into transcript-visible evidence.
- Modify: `src/mycli/application/runtime/agent_runtime.py`
  Owns the runtime loop, tool reinjection, plan/task progression, trace event emission, and provider-facing turn handling.
- Modify: `src/mycli/services/planning/planning_service.py`
  Evolves the current plan replacement helper into task-aware state transitions and rendering.
- Modify: `src/mycli/domain/runtime/planning.py`
  Adds stronger task/plan domain state and status transitions.
- Modify: `src/mycli/services/session_service.py`
  Persists plan/task state and trace assets alongside conversation/session data.
- Modify: `src/mycli/cli/main.py`
  Exposes new slash commands for trace/task inspection and registers additional tools.
- Modify: `src/mycli/services/safety_policy.py`
  Classifies new tools and keeps the shell fallback constrained.
- Modify: `src/mycli/infrastructure/models/responses_adapter.py`
  Tightens provider output validation and capability-sensitive handling.
- Modify: `src/mycli/infrastructure/openai_responses_client.py`
  Improves provider error handling and captures provider-level metadata needed for traceability.
- Create: `src/mycli/domain/runtime/tracing.py`
  Defines typed runtime trace records for model turns, tool executions, approvals, and task state changes.
- Create: `src/mycli/services/trace_service.py`
  Writes and loads per-session trace assets.
- Create: `src/mycli/tools/create_file.py`
  Creates UTF-8 text files safely inside the workspace.
- Create: `src/mycli/tools/mkdir.py`
  Creates directories safely inside the workspace.
- Create: `src/mycli/tools/move_path.py`
  Moves files or directories within the workspace.
- Create: `src/mycli/tools/delete_path.py`
  Deletes files or directories within the workspace with bounded scope.
- Create: `src/mycli/tools/git_status.py`
  Returns structured `git status --short --branch` information.
- Create: `src/mycli/tools/git_diff.py`
  Returns structured diff summaries for the repo or a path.
- Create: `src/mycli/tools/git_log.py`
  Returns structured recent commit history.
- Modify: `src/mycli/tools/search_text.py`
  Prefers native `rg` execution when available and falls back to the current Python scanner.
- Modify: `src/mycli/tools/read_file_range.py`
  Improves snippet metadata for downstream grounding and task execution.
- Modify: `README.md`
  Documents the new task, trace, and tool capabilities.
- Create: `tests/unit/services/test_trace_service.py`
  Covers trace persistence and loading.
- Modify: `tests/unit/services/test_context_manager_v2.py`
  Covers richer tool result grounding.
- Modify: `tests/unit/services/test_session_service.py`
  Covers task state and trace-linked session persistence.
- Modify: `tests/unit/application/test_agent_runtime.py`
  Covers task state progression, trace emission, and richer tool reinjection.
- Modify: `tests/unit/tools/test_read_only_tools.py`
  Covers native-`rg` preference and fallback behavior.
- Create: `tests/unit/tools/test_workspace_management_tools.py`
  Covers `create_file`, `mkdir`, `move_path`, and `delete_path`.
- Create: `tests/unit/tools/test_git_tools.py`
  Covers `git_status`, `git_diff`, and `git_log`.
- Modify: `tests/unit/cli/test_main.py`
  Covers new slash commands and tool registration.

## Task 1: Strengthen Tool Result Grounding

**Files:**
- Modify: `src/mycli/services/context/context_manager.py`
- Modify: `src/mycli/application/runtime/agent_runtime.py`
- Modify: `tests/unit/services/test_context_manager_v2.py`
- Modify: `tests/unit/application/test_agent_runtime.py`

- [ ] **Step 1: Write the failing tests for richer search, file, and edit evidence**

```python
def test_context_manager_renders_diff_preview_from_payload() -> None:
    manager = ContextManager()

    rendered = manager.render_tool_result(
        ToolResultV2(
            success=True,
            summary="Updated README.md",
            raw_payload={"diff": "--- README.md\n+++ README.md\n@@\n-old\n+new\n"},
        ),
        max_chars=400,
    )

    assert "Updated README.md" in rendered
    assert "+new" in rendered


def test_agent_runtime_reinjects_grounded_search_matches_into_tool_message(tmp_path: Path) -> None:
    adapter = InspectThenDoneAdapter()
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=adapter,
    )
    (tmp_path / "README.md").write_text("search_text mention\n", encoding="utf-8")

    runtime.handle_user_turn("search for search_text")

    assert any(
        message.role == "tool"
        and "README.md:1" in message.content
        for message in adapter.seen_messages[-1]
    )
```

- [ ] **Step 2: Run the targeted tests to verify they fail**

Run: `uv run pytest tests/unit/services/test_context_manager_v2.py tests/unit/application/test_agent_runtime.py -k grounded -v`

Expected: FAIL because `render_tool_result()` and runtime reinjection do not yet include diff snippets and consistent grounded evidence for all tool types

- [ ] **Step 3: Extend `ContextManager` to render structured evidence from `raw_payload`**

```python
# src/mycli/services/context/context_manager.py
class ContextManager:
    def render_tool_result(self, result: ToolResultV2, *, max_chars: int = 400) -> str:
        sections: list[str] = [result.summary]
        payload = result.raw_payload

        matches = payload.get("matches")
        if isinstance(matches, list) and matches:
            sections.append("Matches:")
            sections.extend(self._render_match_lines(matches[:5]))

        content = payload.get("content")
        if isinstance(content, str) and content:
            sections.append(f"Content preview: {self._normalize_whitespace(content)[:240]}")

        diff = payload.get("diff")
        if isinstance(diff, str) and diff:
            sections.append(f"Diff preview: {self._normalize_whitespace(diff)[:240]}")

        rendered = "\n".join(section for section in sections if section)
        return rendered if len(rendered) <= max_chars else rendered[: max_chars - 3] + "..."
```

- [ ] **Step 4: Update runtime reinjection to preserve grounded tool messages consistently**

```python
# src/mycli/application/runtime/agent_runtime.py
self._record_tool_message(
    conversation,
    tool_name=normalized_call.name,
    content=self._context_manager.render_tool_result(
        result,
        max_chars=800,
    ),
    tool_call_id=normalized_call.call_id,
)
```

- [ ] **Step 5: Re-run the focused tests and then the full runtime/context suite**

Run: `uv run pytest tests/unit/services/test_context_manager_v2.py tests/unit/application/test_agent_runtime.py -v`

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/mycli/services/context/context_manager.py src/mycli/application/runtime/agent_runtime.py tests/unit/services/test_context_manager_v2.py tests/unit/application/test_agent_runtime.py
git commit -m "feat: improve grounded tool result reinjection"
```

## Task 2: Upgrade Plan State Into Task Runtime

**Files:**
- Modify: `src/mycli/domain/runtime/planning.py`
- Modify: `src/mycli/services/planning/planning_service.py`
- Modify: `src/mycli/services/session_service.py`
- Modify: `src/mycli/application/runtime/agent_runtime.py`
- Modify: `tests/unit/services/test_session_service.py`
- Create: `tests/unit/services/test_planning_service.py`

- [ ] **Step 1: Write the failing tests for task status transitions and persistence**

```python
def test_planning_service_marks_single_task_completed() -> None:
    service = PlanningService()
    state = PlanState(
        items=(
            PlanItem(id="inspect", content="Inspect repo", status=PlanStatus.IN_PROGRESS),
            PlanItem(id="edit", content="Edit README", status=PlanStatus.PENDING),
        )
    )

    updated = service.mark_completed(state, "inspect")

    assert updated.items[0].status is PlanStatus.COMPLETED


def test_session_service_persists_task_checkpoint_metadata(tmp_path: Path) -> None:
    session = SessionService(home_dir=tmp_path)
    state = PlanState(
        items=(PlanItem(id="inspect", content="Inspect repo", status=PlanStatus.IN_PROGRESS),)
    )

    session.save_plan_state("demo", state)
    loaded = session.load_plan_state("demo")

    assert loaded.items[0].id == "inspect"
    assert loaded.items[0].status is PlanStatus.IN_PROGRESS
```

- [ ] **Step 2: Run the planning/session tests to verify they fail**

Run: `uv run pytest tests/unit/services/test_planning_service.py tests/unit/services/test_session_service.py -k plan -v`

Expected: FAIL because `PlanningService` does not yet expose task transition helpers and the tests do not exist

- [ ] **Step 3: Extend the planning domain with explicit task transitions**

```python
# src/mycli/domain/runtime/planning.py
@dataclass(slots=True, frozen=True)
class PlanState:
    items: tuple[PlanItem, ...] = ()

    def replace_item(self, item_id: str, status: PlanStatus) -> "PlanState":
        return PlanState(
            items=tuple(
                PlanItem(id=item.id, content=item.content, status=status if item.id == item_id else item.status)
                for item in self.items
            )
        )
```

- [ ] **Step 4: Add `PlanningService` helpers for task transitions and rendering**

```python
# src/mycli/services/planning/planning_service.py
class PlanningService:
    def mark_completed(self, state: PlanState, item_id: str) -> PlanState:
        return state.replace_item(item_id, PlanStatus.COMPLETED)

    def mark_in_progress(self, state: PlanState, item_id: str) -> PlanState:
        return state.replace_item(item_id, PlanStatus.IN_PROGRESS)
```

- [ ] **Step 5: Update runtime to use task transitions after successful tool/application steps**

```python
# src/mycli/application/runtime/agent_runtime.py
if normalized_call.name == "update_plan":
    plan_state = self._planning_service.replace(normalized_call.arguments["items"])
elif current_task_id is not None:
    plan_state = self._planning_service.mark_completed(plan_state, current_task_id)
```

- [ ] **Step 6: Re-run the planning/session/runtime tests**

Run: `uv run pytest tests/unit/services/test_planning_service.py tests/unit/services/test_session_service.py tests/unit/application/test_agent_runtime.py -v`

Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/mycli/domain/runtime/planning.py src/mycli/services/planning/planning_service.py src/mycli/services/session_service.py src/mycli/application/runtime/agent_runtime.py tests/unit/services/test_planning_service.py tests/unit/services/test_session_service.py tests/unit/application/test_agent_runtime.py
git commit -m "feat: add task-aware planning state"
```

## Task 3: Expand Structured Workspace and Git Tools

**Files:**
- Create: `src/mycli/tools/create_file.py`
- Create: `src/mycli/tools/mkdir.py`
- Create: `src/mycli/tools/move_path.py`
- Create: `src/mycli/tools/delete_path.py`
- Create: `src/mycli/tools/git_status.py`
- Create: `src/mycli/tools/git_diff.py`
- Create: `src/mycli/tools/git_log.py`
- Modify: `src/mycli/tools/search_text.py`
- Modify: `src/mycli/tools/read_file_range.py`
- Modify: `src/mycli/cli/main.py`
- Modify: `src/mycli/services/safety_policy.py`
- Create: `tests/unit/tools/test_workspace_management_tools.py`
- Create: `tests/unit/tools/test_git_tools.py`
- Modify: `tests/unit/tools/test_read_only_tools.py`
- Modify: `tests/unit/cli/test_main.py`

- [ ] **Step 1: Write the failing tests for file-management and git tools**

```python
def test_create_file_writes_utf8_text(tmp_path: Path) -> None:
    tool = CreateFileTool(tmp_path)
    result = tool.run(
        ToolCall(name="create_file", arguments={"path": "notes.txt", "content": "hello\n"}, reason="create note")
    )

    assert result.success is True
    assert (tmp_path / "notes.txt").read_text(encoding="utf-8") == "hello\n"


def test_git_status_returns_branch_and_entries(tmp_path: Path) -> None:
    subprocess.run(["git", "init"], cwd=tmp_path, check=True, capture_output=True, text=True)
    (tmp_path / "README.md").write_text("hello\n", encoding="utf-8")

    tool = GitStatusTool(tmp_path)
    result = tool.run(ToolCall(name="git_status", arguments={}, reason="inspect repo"))

    assert result.success is True
    assert "entries" in result.raw_payload
```

- [ ] **Step 2: Run the targeted tool tests to verify they fail**

Run: `uv run pytest tests/unit/tools/test_workspace_management_tools.py tests/unit/tools/test_git_tools.py -v`

Expected: FAIL because the tool modules do not exist yet

- [ ] **Step 3: Implement bounded workspace management tools**

```python
# src/mycli/tools/create_file.py
class CreateFileTool:
    spec = ToolSpec(
        name="create_file",
        description="Create a UTF-8 text file in the workspace.",
        parameters=(
            ToolParameter(name="path", type="string", required=True),
            ToolParameter(name="content", type="string", required=True),
        ),
        risk_level="medium",
    )
```

- [ ] **Step 4: Implement structured git inspection tools**

```python
# src/mycli/tools/git_status.py
completed = run_command(args=["git", "status", "--short", "--branch"], cwd=self._workspace_root)
return ToolResultV2(
    success=completed.returncode == 0,
    summary="Loaded git status",
    raw_payload={"stdout": completed.stdout, "entries": completed.stdout.splitlines()},
)
```

- [ ] **Step 5: Update `search_text` to prefer native `rg` with Python fallback**

```python
# src/mycli/tools/search_text.py
rg_binary = shutil.which("rg")
if rg_binary:
    return self._search_with_rg(...)
return self._search_with_python(...)
```

- [ ] **Step 6: Register the tools and classify their risk levels**

```python
# src/mycli/cli/main.py
tool_registry = ToolRegistryV2.from_tools(
    [
        CreateFileTool(workspace_root),
        MkdirTool(workspace_root),
        MovePathTool(workspace_root),
        DeletePathTool(workspace_root),
        GitStatusTool(workspace_root),
        GitDiffTool(workspace_root),
        GitLogTool(workspace_root),
        ...
    ]
)
```

- [ ] **Step 7: Re-run tool and CLI tests**

Run: `uv run pytest tests/unit/tools/test_workspace_management_tools.py tests/unit/tools/test_git_tools.py tests/unit/tools/test_read_only_tools.py tests/unit/cli/test_main.py -v`

Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/mycli/tools/create_file.py src/mycli/tools/mkdir.py src/mycli/tools/move_path.py src/mycli/tools/delete_path.py src/mycli/tools/git_status.py src/mycli/tools/git_diff.py src/mycli/tools/git_log.py src/mycli/tools/search_text.py src/mycli/tools/read_file_range.py src/mycli/cli/main.py src/mycli/services/safety_policy.py tests/unit/tools/test_workspace_management_tools.py tests/unit/tools/test_git_tools.py tests/unit/tools/test_read_only_tools.py tests/unit/cli/test_main.py
git commit -m "feat: expand structured workspace and git tools"
```

## Task 4: Add Session Trace and Audit Assets

**Files:**
- Create: `src/mycli/domain/runtime/tracing.py`
- Create: `src/mycli/services/trace_service.py`
- Modify: `src/mycli/application/runtime/agent_runtime.py`
- Modify: `src/mycli/services/session_service.py`
- Modify: `src/mycli/cli/main.py`
- Create: `tests/unit/services/test_trace_service.py`
- Modify: `tests/unit/application/test_agent_runtime.py`
- Modify: `tests/unit/cli/test_main.py`

- [ ] **Step 1: Write the failing tests for trace persistence and CLI inspection**

```python
def test_trace_service_round_trips_tool_event(tmp_path: Path) -> None:
    service = TraceService(home_dir=tmp_path)
    event = RuntimeTraceEvent(
        kind="tool_execution",
        turn_id="turn_1",
        payload={"tool_name": "search_text", "summary": "Found 2 matches"},
    )

    service.append("demo", event)
    loaded = service.load("demo")

    assert loaded[0].payload["tool_name"] == "search_text"


def test_build_command_handler_exposes_trace_command() -> None:
    class FakeService:
        def inspect_trace(self) -> tuple[str, ...]:
            return ("tool_execution search_text",)

    handler = build_command_handler(FakeService())
    assert list(handler("/trace")) == ["[trace] tool_execution search_text"]
```

- [ ] **Step 2: Run the trace/CLI tests to verify they fail**

Run: `uv run pytest tests/unit/services/test_trace_service.py tests/unit/cli/test_main.py -k trace -v`

Expected: FAIL because trace service, runtime events, and `/trace` do not exist

- [ ] **Step 3: Define typed trace records and a persistence service**

```python
# src/mycli/domain/runtime/tracing.py
@dataclass(slots=True, frozen=True)
class RuntimeTraceEvent:
    kind: str
    turn_id: str
    payload: dict[str, object]


# src/mycli/services/trace_service.py
class TraceService:
    def append(self, session_id: str, event: RuntimeTraceEvent) -> None:
        ...
```

- [ ] **Step 4: Emit trace events from runtime for model turns, tools, approvals, and plan changes**

```python
# src/mycli/application/runtime/agent_runtime.py
self._trace_service.append(
    self._config.session_id,
    RuntimeTraceEvent(
        kind="tool_execution",
        turn_id=turn_id,
        payload={"tool_name": normalized_call.name, "summary": result.summary},
    ),
)
```

- [ ] **Step 5: Expose `/trace` from the CLI**

```python
# src/mycli/cli/main.py
if command == "/trace":
    return [f"[trace] {line}" for line in service.inspect_trace()]
```

- [ ] **Step 6: Re-run trace/runtime/CLI tests**

Run: `uv run pytest tests/unit/services/test_trace_service.py tests/unit/application/test_agent_runtime.py tests/unit/cli/test_main.py -v`

Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/mycli/domain/runtime/tracing.py src/mycli/services/trace_service.py src/mycli/application/runtime/agent_runtime.py src/mycli/services/session_service.py src/mycli/cli/main.py tests/unit/services/test_trace_service.py tests/unit/application/test_agent_runtime.py tests/unit/cli/test_main.py
git commit -m "feat: add runtime trace and audit assets"
```

## Task 5: Tighten Provider and Runtime Stability

**Files:**
- Modify: `src/mycli/infrastructure/openai_responses_client.py`
- Modify: `src/mycli/infrastructure/models/responses_adapter.py`
- Modify: `src/mycli/application/runtime/agent_runtime.py`
- Modify: `src/mycli/services/config_service.py`
- Modify: `README.md`
- Create: `tests/unit/infrastructure/test_openai_responses_client.py`
- Modify: `tests/unit/infrastructure/models/test_responses_adapter.py`
- Modify: `tests/unit/application/test_agent_runtime.py`

- [ ] **Step 1: Write the failing tests for provider-facing error normalization**

```python
def test_responses_client_surfaces_provider_name_in_http_error(monkeypatch) -> None:
    client = OpenAIResponsesClient(
        api_key="test",
        base_url="https://example.invalid/v1",
        model="gpt-5",
        max_output_tokens=256,
    )

    with pytest.raises(ModelResponseError) as exc:
        client.create_response(input_items=[], tools=[])

    assert "provider" in str(exc.value).lower()


def test_responses_adapter_rejects_message_items_without_supported_output_content() -> None:
    adapter = ResponsesModelAdapter(client=DummyClient({"output": [{"type": "message", "content": [{}]}]}))

    with pytest.raises(ModelResponseError):
        adapter.next_turn(items=[], tools=[])
```

- [ ] **Step 2: Run the infrastructure/runtime tests to verify they fail**

Run: `uv run pytest tests/unit/infrastructure/test_openai_responses_client.py tests/unit/infrastructure/models/test_responses_adapter.py tests/unit/application/test_agent_runtime.py -k provider -v`

Expected: FAIL because provider-level errors and unsupported output handling are not yet normalized well enough

- [ ] **Step 3: Improve Responses client error messages and metadata handling**

```python
# src/mycli/infrastructure/openai_responses_client.py
provider_name = self._base_url.split("/")[2]
raise ModelResponseError(
    f"Model provider '{provider_name}' returned HTTP {exc.code}: {detail}"
)
```

- [ ] **Step 4: Tighten adapter validation and runtime error rendering**

```python
# src/mycli/infrastructure/models/responses_adapter.py
if item_type == "message" and not blocks_from_message:
    raise ModelResponseError("Responses message item did not contain supported output_text content.")

# src/mycli/application/runtime/agent_runtime.py
except ModelResponseError as exc:
    return TurnResponse(
        assistant_message=f"Model request failed: {exc}",
        progress_updates=(),
        plan_steps=self._planning_service.render_steps(plan_state),
    )
```

- [ ] **Step 5: Update config/docs to reflect the stronger provider behavior contract**

```toml
# README / config examples
protocol = "responses"
# Providers should either support /responses or explicitly use legacy_chat
```

- [ ] **Step 6: Re-run the infrastructure/runtime suite**

Run: `uv run pytest tests/unit/infrastructure/test_openai_responses_client.py tests/unit/infrastructure/models/test_responses_adapter.py tests/unit/application/test_agent_runtime.py -v`

Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/mycli/infrastructure/openai_responses_client.py src/mycli/infrastructure/models/responses_adapter.py src/mycli/application/runtime/agent_runtime.py src/mycli/services/config_service.py README.md tests/unit/infrastructure/test_openai_responses_client.py tests/unit/infrastructure/models/test_responses_adapter.py tests/unit/application/test_agent_runtime.py
git commit -m "feat: tighten provider and runtime stability"
```

## Task 6: Run Phase 2 Verification Pass

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update README to reflect Phase 2 capabilities**

```markdown
## Current capabilities

- Grounded tool-result reinjection
- Task-aware planning state
- Structured file and git tools
- Runtime trace inspection via `/trace`
- Responses-first provider stability improvements
```

- [ ] **Step 2: Run the focused Phase 2 verification suite**

Run: `uv run pytest tests/unit/services/test_context_manager_v2.py tests/unit/services/test_planning_service.py tests/unit/services/test_trace_service.py tests/unit/tools/test_workspace_management_tools.py tests/unit/tools/test_git_tools.py tests/unit/application/test_agent_runtime.py tests/unit/cli/test_main.py -v`

Expected: PASS

- [ ] **Step 3: Run repository-wide verification**

Run: `uv run pytest -q`
Expected: PASS

Run: `uv run ruff check .`
Expected: exit code 0

Run: `uv run mypy src`
Expected: exit code 0

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: capture phase 2 productization status"
```

## Self-Review

- Spec coverage: this plan covers the five approved Phase 2 workstreams from the roadmap: grounding, task runtime, structured tool expansion, trace/audit, and provider/runtime stability.
- Placeholder scan: all tasks include exact files, tests, commands, and intended code shapes; no `TODO`/`TBD` placeholders remain.
- Type consistency: task names, tool names, and runtime services are used consistently across later tasks; `search_text`, `read_file_range`, `TraceService`, and `PlanState` remain the shared names throughout the plan.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-06-mycli-phase2-productization-roadmap-implementation.md`. Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
