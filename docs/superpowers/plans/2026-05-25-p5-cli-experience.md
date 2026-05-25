# P5 CLI Experience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Improve daily terminal ergonomics with statusline/context%, view modes, path autocomplete, and better diff rendering while keeping the existing line-oriented CLI.

**Architecture:** Keep rendering concerns in `src/mycli/cli/*` and status inspection in `TurnService`; do not move UI state into model runtime. Add small, typed config fields for view/status behavior, pure helpers for autocomplete and render options, and route `/status` plus `/view` through the existing command handler. No full-screen TUI and no new dependencies.

**Tech Stack:** Python 3.13, stdlib `readline` where available, existing `rich`/`pygments`, dataclasses, pytest, ruff, mypy.

**Spec:** `docs/superpowers/specs/2026-05-25-p5-cli-experience.md`

---

## File Structure

- `src/mycli/domain/runtime/__init__.py`: add `ViewMode` enum and `AgentConfig.view_mode/statusline_enabled`.
- `src/mycli/config/settings.py`: parse `MYCLI_VIEW_MODE`, `MYCLI_STATUSLINE_ENABLED`, `view_mode`, and `statusline_enabled`.
- `src/mycli/application/turn_service.py`: add `inspect_status()`, `inspect_view()`, and `set_view_mode()`.
- `src/mycli/cli/repl.py`: add `/status` and `/view` command routes; support optional `statusline_provider` before prompts.
- `src/mycli/cli/main.py`: pass rendering options/statusline callbacks into REPL and apply view-mode rendering.
- `src/mycli/cli/rendering.py`: add `RenderOptions`; make activity/progress/stream/diff rendering view-mode aware.
- `src/mycli/cli/autocomplete.py`: install `@path` autocomplete through stdlib `readline`; expose pure candidate helper.
- `tests/unit/domain/test_runtime.py`: config defaults for view/statusline.
- `tests/unit/services/test_config_service.py`: config/env parsing tests.
- `tests/unit/cli/test_main.py`: status/view/render/diff unit tests.
- `tests/integration/test_cli_repl.py`: REPL command/statusline/autocomplete integration tests.
- `docs/superpowers/specs/2026-05-18-mycli-vs-claude-code-gap.md`: update CLI experience rows.
- `docs/superpowers/reports/2026-05-25-p5-cli-experience-smoke.md`: smoke report.

---

### Task 1: View And Statusline Config

**Files:**
- Modify: `src/mycli/domain/runtime/__init__.py`
- Modify: `src/mycli/config/settings.py`
- Modify: `tests/unit/domain/test_runtime.py`
- Modify: `tests/unit/services/test_config_service.py`

- [ ] **Step 1: Write failing domain config test**

Append to `tests/unit/domain/test_runtime.py`:

```python
def test_agent_config_exposes_cli_view_defaults(tmp_path: Path) -> None:
    config = AgentConfig(workspace_root=tmp_path)

    assert config.view_mode is ViewMode.DEFAULT
    assert config.statusline_enabled is True
```

Update the imports in that file so `ViewMode` is imported from `mycli.domain.runtime`.

- [ ] **Step 2: Write failing config parsing test**

Append to `tests/unit/services/test_config_service.py`:

```python
def test_config_service_reads_cli_view_settings(tmp_path: Path) -> None:
    home_dir = tmp_path / "home"
    workspace = tmp_path / "workspace"
    home_dir.mkdir()
    workspace.mkdir()
    config_path = workspace / ".mycli" / "config.toml"
    config_path.parent.mkdir()
    config_path.write_text(
        "\n".join(
            [
                'provider = "openai"',
                'model = "primary-model"',
                'view_mode = "focus"',
                "statusline_enabled = false",
            ]
        ),
        encoding="utf-8",
    )

    config = resolve_config(
        cli_args={"session": "demo"},
        env={},
        cwd=workspace,
        home=home_dir,
    )

    assert config.view_mode is ViewMode.FOCUS
    assert config.statusline_enabled is False
```

Also append:

```python
def test_config_service_rejects_unknown_view_mode(tmp_path: Path) -> None:
    home_dir = tmp_path / "home"
    workspace = tmp_path / "workspace"
    home_dir.mkdir()
    workspace.mkdir()

    with pytest.raises(ValueError, match="Unsupported view_mode"):
        resolve_config(
            cli_args={"session": "demo"},
            env={"MYCLI_VIEW_MODE": "cinema"},
            cwd=workspace,
            home=home_dir,
        )
```

Update imports to include `pytest` if it is not already imported and `ViewMode` from `mycli.domain.runtime`.

- [ ] **Step 3: Run tests to verify they fail**

Run:

```bash
uv run pytest tests/unit/domain/test_runtime.py::test_agent_config_exposes_cli_view_defaults tests/unit/services/test_config_service.py::test_config_service_reads_cli_view_settings tests/unit/services/test_config_service.py::test_config_service_rejects_unknown_view_mode -q
```

Expected: fails because `ViewMode`, `view_mode`, and `statusline_enabled` are not defined.

- [ ] **Step 4: Add `ViewMode` and config fields**

In `src/mycli/domain/runtime/__init__.py`, add near `ReasoningEffort`:

```python
class ViewMode(StrEnum):
    DEFAULT = "default"
    VERBOSE = "verbose"
    FOCUS = "focus"
```

Add fields to `AgentConfig` after `heartbeat_interval_seconds`:

```python
    view_mode: ViewMode = ViewMode.DEFAULT
    statusline_enabled: bool = True
```

Add `"ViewMode"` to `__all__`.

- [ ] **Step 5: Parse settings**

In `src/mycli/config/settings.py`, import `ViewMode` and add helper:

```python
def _parse_view_mode(value: object) -> ViewMode:
    raw = str(value or ViewMode.DEFAULT.value).strip().lower()
    try:
        return ViewMode(raw)
    except ValueError as exc:
        allowed = ", ".join(item.value for item in ViewMode)
        raise ValueError(f"Unsupported view_mode '{raw}'. Supported values: {allowed}.") from exc
```

Near the heartbeat parsing, add:

```python
    view_mode_value = (
        env.get("MYCLI_VIEW_MODE")
        or project_config.get("view_mode")
        or user_config.get("view_mode")
        or ViewMode.DEFAULT.value
    )
    statusline_enabled_raw: object | None = env.get("MYCLI_STATUSLINE_ENABLED")
    if statusline_enabled_raw is None:
        statusline_enabled_raw = (
            project_config["statusline_enabled"]
            if "statusline_enabled" in project_config
            else user_config.get("statusline_enabled")
        )
    statusline_enabled_value = _parse_optional_bool(statusline_enabled_raw)
```

Pass into `AgentConfig(...)`:

```python
        view_mode=_parse_view_mode(view_mode_value),
        statusline_enabled=True if statusline_enabled_value is None else statusline_enabled_value,
```

- [ ] **Step 6: Run focused tests**

Run:

```bash
uv run pytest tests/unit/domain/test_runtime.py::test_agent_config_exposes_cli_view_defaults tests/unit/services/test_config_service.py::test_config_service_reads_cli_view_settings tests/unit/services/test_config_service.py::test_config_service_rejects_unknown_view_mode -q
```

Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add src/mycli/domain/runtime/__init__.py src/mycli/config/settings.py tests/unit/domain/test_runtime.py tests/unit/services/test_config_service.py
git commit -m "Add CLI view mode configuration"
```

Use Lore trailers:

```text
Constraint: View mode must affect CLI rendering only, not runtime/model behavior.
Rejected: Store view mode in REPL globals only | slash commands and config inspection need one source of truth.
Confidence: high
Scope-risk: narrow
Tested: uv run pytest tests/unit/domain/test_runtime.py::test_agent_config_exposes_cli_view_defaults tests/unit/services/test_config_service.py::test_config_service_reads_cli_view_settings tests/unit/services/test_config_service.py::test_config_service_rejects_unknown_view_mode -q
```

---

### Task 2: Status Inspection And Commands

**Files:**
- Modify: `src/mycli/application/turn_service.py`
- Modify: `src/mycli/cli/repl.py`
- Modify: `tests/unit/cli/test_main.py`
- Modify: `tests/integration/test_cli_repl.py`

- [ ] **Step 1: Write failing `inspect_status()` test**

Append to `tests/unit/cli/test_main.py`:

```python
def test_turn_service_inspect_status_reports_session_model_and_context(tmp_path: Path) -> None:
    home_dir = tmp_path / "home"
    workspace = tmp_path / "workspace"
    home_dir.mkdir()
    workspace.mkdir()
    service = build_turn_service(
        cli_args={"session": "demo", "model": "gpt-test"},
        cwd=workspace,
        home=home_dir,
        env={
            "MYCLI_API_KEY": "test-key",
            "MYCLI_PROVIDER": "deepseek",
            "MYCLI_PROTOCOL": "chat_completions",
        },
    )
    service._observability_service.record_context_window(
        {
            "input_tokens": 300,
            "max_tokens": 1200,
            "usage_ratio": 0.25,
            "source": "provider",
        }
    )

    assert service.inspect_status() == (
        "session=demo model=gpt-test provider=deepseek/chat_completions context=25.0% tokens=300/1200 pending=no suspended=no",
    )
```

If `ObservabilityService` does not expose `record_context_window`, use the existing method used by context tests in the same file to populate context metrics.

- [ ] **Step 2: Write failing command handler test**

In `test_build_command_handler_exposes_runtime_inspection_commands`, add methods to `FakeService`:

```python
        def inspect_status(self) -> tuple[str, ...]:
            return ("session=demo model=gpt-test provider=openai/responses context=unknown pending=no suspended=no",)

        def inspect_view(self) -> tuple[str, ...]:
            return ("view_mode=default",)

        def set_view_mode(self, mode: str) -> tuple[str, ...]:
            return (f"view_mode={mode}",)
```

Add assertions:

```python
    assert list(handler("/status")) == [
        "[status] session=demo model=gpt-test provider=openai/responses context=unknown pending=no suspended=no"
    ]
    assert list(handler("/view")) == ["[view] view_mode=default"]
    assert list(handler("/view focus")) == ["[view] view_mode=focus"]
```

- [ ] **Step 3: Write failing REPL statusline test**

Append to `tests/integration/test_cli_repl.py`:

```python
def test_run_repl_prints_statusline_before_prompt_when_provider_exists() -> None:
    outputs: list[str] = []
    scripted_inputs = iter(["/quit"])

    run_repl(
        turn_handler=lambda _message: "unused",
        statusline_provider=lambda: ("session=demo context=unknown",),
        input_func=lambda _prompt: next(scripted_inputs),
        output_func=outputs.append,
    )

    assert outputs[0] == "[status] session=demo context=unknown"
    assert outputs[-1] == "Bye."
```

- [ ] **Step 4: Run tests to verify failure**

Run:

```bash
uv run pytest tests/unit/cli/test_main.py::test_turn_service_inspect_status_reports_session_model_and_context tests/unit/cli/test_main.py::test_build_command_handler_exposes_runtime_inspection_commands tests/integration/test_cli_repl.py::test_run_repl_prints_statusline_before_prompt_when_provider_exists -q
```

Expected: fails because status/view handlers and REPL statusline support are missing.

- [ ] **Step 5: Implement `TurnService.inspect_status()`**

In `src/mycli/application/turn_service.py`, add:

```python
    def inspect_status(self) -> tuple[str, ...]:
        snapshot = self._observability_service.snapshot()
        context_window = snapshot.context_window
        input_tokens = self._int_metric(context_window.get("input_tokens"))
        total_tokens = self._int_metric(context_window.get("total_tokens"))
        max_tokens = self._int_metric(context_window.get("max_tokens")) or self._config.max_prompt_tokens
        token_count = input_tokens if input_tokens > 0 else total_tokens
        usage_ratio = context_window.get("usage_ratio")
        context = "unknown"
        tokens = ""
        if isinstance(usage_ratio, (int, float)) and not isinstance(usage_ratio, bool):
            context = f"{float(usage_ratio):.1%}"
        elif token_count > 0 and max_tokens > 0:
            context = f"{(token_count / max_tokens):.1%}"
        if token_count > 0 and max_tokens > 0:
            tokens = f" tokens={token_count}/{max_tokens}"
        pending = self._session_service.load_pending_decision(self._config.session_id)
        suspended = self._session_service.load_suspended_turn(self._config.session_id)
        return (
            f"session={self._config.session_id} "
            f"model={self._config.model} "
            f"provider={self._config.provider.value}/{self._config.protocol.value} "
            f"context={context}"
            f"{tokens} "
            f"pending={'yes' if pending is not None else 'no'} "
            f"suspended={'yes' if suspended is not None else 'no'}",
        )
```

Add:

```python
    def inspect_view(self) -> tuple[str, ...]:
        return (f"view_mode={self._config.view_mode.value}",)

    def set_view_mode(self, mode: str) -> tuple[str, ...]:
        try:
            view_mode = ViewMode(mode.strip().lower())
        except ValueError:
            allowed = ", ".join(item.value for item in ViewMode)
            return (f"unsupported view_mode={mode}; allowed={allowed}",)
        self._config = replace(self._config, view_mode=view_mode)
        if self._runtime is not None:
            self._runtime.rebind_session(self._config)
        return (f"view_mode={view_mode.value}",)
```

Import `ViewMode`.

- [ ] **Step 6: Add command routes and help text**

In `src/mycli/cli/repl.py`, update `/help` list with:

```python
                "/status",
                "/view [default|verbose|focus]",
```

In `build_command_handler()`, add before `/stats`:

```python
        if command == "/status":
            return [f"[status] {line}" for line in service.inspect_status()]
        if command.startswith("/view"):
            parts = command.split(maxsplit=1)
            if len(parts) == 1:
                return [f"[view] {line}" for line in service.inspect_view()]
            return [f"[view] {line}" for line in service.set_view_mode(parts[1])]
```

- [ ] **Step 7: Add REPL statusline provider**

In `run_repl(...)`, add parameter:

```python
    statusline_provider: Callable[[], Iterable[str]] | None = None,
```

At the top of the loop, before `input_func("> ")`:

```python
        if statusline_provider is not None:
            for line in statusline_provider():
                output_func(f"[status] {line}")
```

Keep behavior unchanged when provider is `None`.

- [ ] **Step 8: Run focused tests**

Run:

```bash
uv run pytest tests/unit/cli/test_main.py::test_turn_service_inspect_status_reports_session_model_and_context tests/unit/cli/test_main.py::test_build_command_handler_exposes_runtime_inspection_commands tests/integration/test_cli_repl.py::test_run_repl_prints_statusline_before_prompt_when_provider_exists -q
```

Expected: all pass.

- [ ] **Step 9: Commit**

```bash
git add src/mycli/application/turn_service.py src/mycli/cli/repl.py tests/unit/cli/test_main.py tests/integration/test_cli_repl.py
git commit -m "Expose CLI status and view commands"
```

Use Lore trailers:

```text
Constraint: Statusline is display-only and must not enter conversation history.
Rejected: Compute status in REPL only | command handler and tests need reusable application-level inspection.
Confidence: high
Scope-risk: narrow
Tested: uv run pytest status/view command tests
```

---

### Task 3: Render Options And View Modes

**Files:**
- Modify: `src/mycli/cli/rendering.py`
- Modify: `src/mycli/cli/main.py`
- Modify: `tests/unit/cli/test_main.py`
- Modify: `tests/integration/test_cli_repl.py`

- [ ] **Step 1: Write failing rendering tests**

Append to `tests/unit/cli/test_main.py`:

```python
def test_focus_render_options_suppress_tool_exposure_and_stream_echo() -> None:
    response = TurnResponse(
        assistant_message="hello world",
        streamed_chunks=("hello ", "world"),
        turn=TurnRecord(
            thread_id="demo",
            turn_id="turn_1",
            status=TurnStatus.COMPLETED,
            stop_reason=StopReason.ASSISTANT_COMPLETED,
            started_at="2026-05-25T00:00:00Z",
            completed_at="2026-05-25T00:00:01Z",
            items=(
                TurnItem(
                    type=TurnItemType.TOOL_EXPOSURE,
                    text="Read, Grep",
                    metadata={"tool_names": ["Read", "Grep"]},
                ),
            ),
        ),
    )
    options = RenderOptions(view_mode=ViewMode.FOCUS)

    assert render_activity_lines(response, options=options) == []
    assert render_stream_lines(response, options=options) == []
```

Append:

```python
def test_verbose_render_options_keep_stream_lines_with_final_answer() -> None:
    response = TurnResponse(
        assistant_message="hello world",
        streamed_chunks=("hello ", "world"),
    )

    assert render_stream_lines(
        response,
        options=RenderOptions(view_mode=ViewMode.VERBOSE),
    ) == ["[stream] hello ", "[stream] world"]
```

Update imports to include `RenderOptions`, `ViewMode`, and `StopReason`.

- [ ] **Step 2: Write failing main view-mode test**

Append to `tests/integration/test_cli_repl.py`:

```python
def test_main_applies_focus_view_mode_to_turn_rendering(monkeypatch, tmp_path: Path) -> None:
    outputs: list[str] = []
    scripted_inputs = iter(["hello", "/quit"])

    class FakeService:
        def __init__(self) -> None:
            self._config = type(
                "Config",
                (),
                {
                    "session_id": "demo",
                    "view_mode": ViewMode.FOCUS,
                    "statusline_enabled": False,
                },
            )()
            self._session_service = type(
                "Sessions",
                (),
                {"load_pending_decision": lambda _self, _session_id: None},
            )()

        def handle_user_turn(self, message: str, stream_sink=None) -> TurnResponse:
            del message, stream_sink
            return TurnResponse(
                assistant_message="hello world",
                streamed_chunks=("hello ", "world"),
                activity_events=(ActivityEvent(kind="tool_exposure", message="Read, Grep"),),
            )

        def resolve_pending_decision(self, choice: str) -> TurnResponse:
            del choice
            return TurnResponse(assistant_message="unused")

    monkeypatch.setattr("mycli.cli.main.build_turn_service", lambda *args, **kwargs: FakeService())

    assert main(
        ["--session", "demo"],
        cwd=tmp_path,
        home=tmp_path / "home",
        env={"MYCLI_API_KEY": "x"},
        input_func=lambda _prompt: next(scripted_inputs),
        output_func=outputs.append,
    ) == 0

    assert "hello world" in outputs
    assert not any(line.startswith("[stream]") for line in outputs)
    assert not any("Tool exposure" in line for line in outputs)
```

Import `ActivityEvent` and `ViewMode`.

- [ ] **Step 3: Run tests to verify failure**

Run:

```bash
uv run pytest tests/unit/cli/test_main.py::test_focus_render_options_suppress_tool_exposure_and_stream_echo tests/unit/cli/test_main.py::test_verbose_render_options_keep_stream_lines_with_final_answer tests/integration/test_cli_repl.py::test_main_applies_focus_view_mode_to_turn_rendering -q
```

Expected: fails because `RenderOptions` and option-aware renderers are missing.

- [ ] **Step 4: Add `RenderOptions` and option-aware rendering**

In `src/mycli/cli/rendering.py`, import `ViewMode` and add near `StreamingRenderState`:

```python
@dataclass(slots=True, frozen=True)
class RenderOptions:
    view_mode: ViewMode = ViewMode.DEFAULT
    diff_max_lines: int = 80
    show_statusline: bool = True
```

Change signatures:

```python
def render_activity_lines(response: object, *, options: RenderOptions | None = None) -> list[str]:
def render_progress_lines(response: object, *, options: RenderOptions | None = None) -> list[str]:
def render_stream_lines(response: object, *, options: RenderOptions | None = None) -> list[str]:
```

Rules:

```python
    options = options or RenderOptions()
```

In `render_activity_lines`, if `options.view_mode is ViewMode.FOCUS`, filter lines containing `"Tool exposure:"`.

In `render_stream_lines`, keep current default behavior, but:

```python
    if options.view_mode is ViewMode.FOCUS:
        return []
    if options.view_mode is ViewMode.VERBOSE:
        # render chunks even when final answer exists
```

In `render_progress_lines`, focus mode should keep only updates starting with `[decision]`, `[heartbeat]`, or `[resume]`.

- [ ] **Step 5: Wire options in `main.py`**

In `src/mycli/cli/main.py`, import `RenderOptions` and `ViewMode`.

After building `service`, define:

```python
    def render_options() -> RenderOptions:
        config = service._config
        return RenderOptions(
            view_mode=config.view_mode,
            show_statusline=config.statusline_enabled,
            diff_max_lines=240 if config.view_mode is ViewMode.VERBOSE else 80,
        )
```

Use options in `handle_user_message()`:

```python
        options = render_options()
        rendered: list[str] = render_activity_lines(response, options=options)
        rendered.extend(render_error_lines(response))
        rendered.extend(render_progress_lines(response, options=options))
```

Use options in `resolve_pending_decision()`.

Pass statusline provider:

```python
        statusline_provider=(
            service.inspect_status if service._config.statusline_enabled else None
        ),
```

If config may change via `/view`, pass a closure:

```python
        statusline_provider=lambda: service.inspect_status()
        if service._config.statusline_enabled
        else (),
```

- [ ] **Step 6: Run focused tests**

Run:

```bash
uv run pytest tests/unit/cli/test_main.py::test_focus_render_options_suppress_tool_exposure_and_stream_echo tests/unit/cli/test_main.py::test_verbose_render_options_keep_stream_lines_with_final_answer tests/integration/test_cli_repl.py::test_main_applies_focus_view_mode_to_turn_rendering -q
```

Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add src/mycli/cli/rendering.py src/mycli/cli/main.py tests/unit/cli/test_main.py tests/integration/test_cli_repl.py
git commit -m "Apply CLI view modes to rendering"
```

Use Lore trailers:

```text
Constraint: View modes must change display only, not runtime behavior or history.
Rejected: Separate REPL implementations per mode | too much branching for line-oriented UI.
Confidence: medium
Scope-risk: moderate
Tested: uv run pytest view-mode rendering tests
```

---

### Task 4: Diff Rendering V2

**Files:**
- Modify: `src/mycli/cli/rendering.py`
- Modify: `tests/unit/cli/test_main.py`

- [ ] **Step 1: Write failing diff folding tests**

Append to `tests/unit/cli/test_main.py`:

```python
def test_render_diff_lines_reports_omitted_tail_count() -> None:
    diff = "\n".join(f"+line {index}" for index in range(1, 6))

    assert render_diff_lines(diff, max_lines=3) == [
        "   1 [+]+line 1",
        "   2 [+]+line 2",
        "   3 [+]+line 3",
        "... 2 lines omitted",
    ]
```

Append:

```python
def test_activity_diff_lines_reports_omitted_tail_count() -> None:
    turn = TurnRecord(
        thread_id="demo",
        turn_id="turn_1",
        status=TurnStatus.COMPLETED,
        stop_reason=StopReason.ASSISTANT_COMPLETED,
        started_at="2026-05-25T00:00:00Z",
        completed_at="2026-05-25T00:00:01Z",
        items=(
            TurnItem(
                type=TurnItemType.TOOL_RESULT,
                text="Edited notes.txt",
                tool_name="Edit",
                metadata={"diff": "\n".join(f"+line {index}" for index in range(1, 6))},
            ),
        ),
    )
    response = TurnResponse(assistant_message="done", turn=turn)

    assert render_activity_lines(
        response,
        options=RenderOptions(diff_max_lines=2),
    )[-1] == "[diff] ... 3 lines omitted"
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
uv run pytest tests/unit/cli/test_main.py::test_render_diff_lines_reports_omitted_tail_count tests/unit/cli/test_main.py::test_activity_diff_lines_reports_omitted_tail_count -q
```

Expected: fails because current truncation line says `truncated after`.

- [ ] **Step 3: Implement omitted-tail rendering**

In `render_diff_lines()`:

```python
    lines = diff.splitlines()
    for number, line in enumerate(lines[:max_lines], start=1):
        rendered.append(f"{number:>4} {_diff_prefix(line)}{line}")
    omitted = len(lines) - max_lines
    if omitted > 0:
        rendered.append(f"... {omitted} lines omitted")
```

In `_render_activity_diff_lines()`:

```python
    lines = diff.splitlines()
    for number, line in enumerate(lines[:max_lines], start=1):
        rendered.append(f"[diff] {number:04d} {line}")
    omitted = len(lines) - max_lines
    if omitted > 0:
        rendered.append(f"[diff] ... {omitted} lines omitted")
```

Ensure `_render_turn_activity_lines()` passes `options.diff_max_lines` into `_render_activity_diff_lines()`.

- [ ] **Step 4: Run diff tests**

Run:

```bash
uv run pytest tests/unit/cli/test_main.py::test_render_diff_lines_reports_omitted_tail_count tests/unit/cli/test_main.py::test_activity_diff_lines_reports_omitted_tail_count tests/unit/cli/test_main.py::test_render_diff_lines_adds_line_numbers_and_markers -q
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/mycli/cli/rendering.py tests/unit/cli/test_main.py
git commit -m "Fold long CLI diff output"
```

Use Lore trailers:

```text
Constraint: Diff output must remain line-oriented for non-rich terminals.
Rejected: Interactive expand/collapse | requires a TUI/input loop redesign.
Confidence: high
Scope-risk: narrow
Tested: uv run pytest diff rendering tests
```

---

### Task 5: Workspace Path Autocomplete

**Files:**
- Create: `src/mycli/cli/autocomplete.py`
- Modify: `src/mycli/cli/main.py`
- Modify: `src/mycli/cli/repl.py`
- Modify: `tests/integration/test_cli_repl.py`

- [ ] **Step 1: Write failing candidate tests**

Append to `tests/integration/test_cli_repl.py`:

```python
def test_path_completion_candidates_complete_workspace_paths(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    (workspace / "README.md").write_text("hi", encoding="utf-8")
    (workspace / "src").mkdir()
    (workspace / "src" / "main.py").write_text("print('hi')", encoding="utf-8")

    assert path_completion_candidates(workspace, "@R") == ("@README.md",)
    assert path_completion_candidates(workspace, "@src/") == ("@src/main.py",)
```

Append:

```python
def test_path_completion_candidates_reject_outside_workspace(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    (tmp_path / "secret.txt").write_text("no", encoding="utf-8")

    assert path_completion_candidates(workspace, "@../") == ()
```

Import `path_completion_candidates` from `mycli.cli.autocomplete`.

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
uv run pytest tests/integration/test_cli_repl.py::test_path_completion_candidates_complete_workspace_paths tests/integration/test_cli_repl.py::test_path_completion_candidates_reject_outside_workspace -q
```

Expected: fails because module is missing.

- [ ] **Step 3: Implement autocomplete module**

Create `src/mycli/cli/autocomplete.py`:

```python
from __future__ import annotations

from collections.abc import Callable
from pathlib import Path


def path_completion_candidates(workspace_root: Path, token: str) -> tuple[str, ...]:
    if not token.startswith("@"):
        return ()
    raw = token[1:]
    if raw.startswith("../") or raw == "..":
        return ()
    root = workspace_root.resolve()
    base = root / raw
    parent = base.parent if raw else root
    prefix = base.name if raw else ""
    try:
        resolved_parent = parent.resolve()
    except OSError:
        return ()
    if not _is_relative_to(resolved_parent, root) or not resolved_parent.is_dir():
        return ()
    candidates: list[str] = []
    for child in sorted(resolved_parent.iterdir(), key=lambda path: path.name):
        if prefix and not child.name.startswith(prefix):
            continue
        try:
            resolved_child = child.resolve()
        except OSError:
            continue
        if not _is_relative_to(resolved_child, root):
            continue
        rel = child.relative_to(root).as_posix()
        suffix = "/" if child.is_dir() else ""
        candidates.append(f"@{rel}{suffix}")
    return tuple(candidates)


def install_path_autocomplete(*, workspace_root: Path) -> Callable[[], None]:
    try:
        import readline
    except ImportError:
        return lambda: None

    previous_completer = readline.get_completer()

    def completer(text: str, state: int) -> str | None:
        candidates = path_completion_candidates(workspace_root, text)
        if state < len(candidates):
            return candidates[state]
        return None

    readline.set_completer(completer)
    try:
        readline.parse_and_bind("tab: complete")
    except Exception:
        pass

    def cleanup() -> None:
        readline.set_completer(previous_completer)

    return cleanup


def _is_relative_to(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False
```

- [ ] **Step 4: Wire installation into `main.py`**

In `src/mycli/cli/main.py`, import:

```python
from mycli.cli.autocomplete import install_path_autocomplete
```

Before `run_repl(...)`:

```python
    cleanup_autocomplete = install_path_autocomplete(workspace_root=service._config.workspace_root)
    try:
        run_repl(...)
    finally:
        cleanup_autocomplete()
```

Keep existing `return 0` after the `try/finally`.

- [ ] **Step 5: Run autocomplete tests**

Run:

```bash
uv run pytest tests/integration/test_cli_repl.py::test_path_completion_candidates_complete_workspace_paths tests/integration/test_cli_repl.py::test_path_completion_candidates_reject_outside_workspace -q
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/mycli/cli/autocomplete.py src/mycli/cli/main.py tests/integration/test_cli_repl.py
git commit -m "Add workspace path autocomplete"
```

Use Lore trailers:

```text
Constraint: Autocomplete must not escape the workspace or require a new input dependency.
Rejected: prompt_toolkit | too large for this line-oriented P5 slice.
Confidence: medium
Scope-risk: narrow
Tested: uv run pytest autocomplete tests
```

---

### Task 6: Docs And Smoke

**Files:**
- Modify: `docs/superpowers/specs/2026-05-18-mycli-vs-claude-code-gap.md`
- Create: `docs/superpowers/reports/2026-05-25-p5-cli-experience-smoke.md`

- [ ] **Step 1: Run focused CLI tests**

Run:

```bash
uv run pytest tests/unit/cli/test_main.py tests/integration/test_cli_repl.py -q
```

Expected: all pass.

- [ ] **Step 2: Run full verification**

Run:

```bash
uv run ruff check src tests
uv run mypy src/mycli
uv run pytest -q
```

Expected:

- ruff: `All checks passed!`
- mypy: `Success: no issues found`
- pytest: all tests passed

- [ ] **Step 3: Update gap doc**

In `docs/superpowers/specs/2026-05-18-mycli-vs-claude-code-gap.md`, add current status bullet:

```markdown
- P5 CLI experience：line-oriented statusline/context%、view modes、workspace `@path` autocomplete、diff folding、`/status` 与 `/view`。
```

Update rows:

- `1.15 /context 实时可视化`: mention statusline/context% but keep ⚠️ because no rich/TUI bar.
- `9.2 Diff 展示`: mention folded numbered diff and rich syntax helper; keep ⚠️ because no interactive diff.
- `9.6 statusLine 可定制`: move from ❌ to ⚠️.
- `9.7 viewMode`: move from ❌ to ⚠️.
- `9.9 自动补全`: move from ❌ to ⚠️.

- [ ] **Step 4: Write smoke report**

Create `docs/superpowers/reports/2026-05-25-p5-cli-experience-smoke.md`:

```markdown
# P5 CLI Experience Smoke

## Commands

- `uv run pytest tests/unit/cli/test_main.py tests/integration/test_cli_repl.py -q`
- `uv run ruff check src tests`
- `uv run mypy src/mycli`
- `uv run pytest -q`

## Covered

- `/status` reports session/model/provider/context state.
- `/view` can inspect and update view mode.
- Focus mode suppresses low-value activity and stream echo while keeping final answers.
- Verbose mode can retain stream lines.
- Large diffs report omitted tail counts.
- `@path` autocomplete suggests workspace-local paths and rejects outside traversal.

## Not Covered

- No full-screen TUI.
- No interactive diff expand/collapse.
- No prompt_toolkit integration.
- No voice/vim/editor mode.
```

- [ ] **Step 5: Commit docs**

```bash
git add docs/superpowers/specs/2026-05-18-mycli-vs-claude-code-gap.md docs/superpowers/reports/2026-05-25-p5-cli-experience-smoke.md
git commit -m "Document CLI experience verification"
```

Use Lore trailers:

```text
Constraint: P5 deliberately stays line-oriented instead of introducing a TUI.
Rejected: Mark CLI rows complete | statusline/autocomplete/view modes are partial Claude parity, not full feature equivalence.
Confidence: high
Scope-risk: narrow
Tested: uv run ruff check src tests; uv run mypy src/mycli; uv run pytest -q
```

---

## Self-Review Checklist

- [ ] Spec coverage: tasks cover config, statusline, `/status`, `/view`, view mode rendering, diff folding, autocomplete, docs, and smoke.
- [ ] Placeholder scan: no TBD/TODO/fill-in instructions remain.
- [ ] Type consistency: `ViewMode`, `RenderOptions`, `view_mode`, and `statusline_enabled` are named consistently.
- [ ] Safety: statusline/autocomplete/rendering do not alter model-visible context or provider requests.
