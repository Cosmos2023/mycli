from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

from rich.status import Status
from rich.syntax import Syntax
from rich.text import Text

from mycli.application.turn_service import TurnService
from mycli.cli.main import (
    build_command_handler,
    build_parser,
    build_turn_service,
    handle_slash_command,
    main,
    render_activity_lines,
)
from mycli.cli.rendering import (
    StreamingRenderState,
    render_diff_view,
    render_diff_lines,
    render_streaming_live_output,
    render_streaming_state_lines,
    render_tool_status,
)
from mycli.domain.runtime import (
    ActivityEvent,
    DecisionAction,
    DecisionKind,
    PendingDecision,
    StopReason,
    TurnItem,
    TurnItemType,
    TurnRecord,
    TurnRollout,
    TurnRolloutEvent,
    TurnResponse,
    TurnStatus,
)
from mycli.domain.runtime.tracing import RuntimeTraceEvent
from mycli.domain.tools import ToolCall
from mycli.llms.adapters.native_tool_adapter import NativeToolModelAdapter
from mycli.llms.adapters.responses_adapter import ResponsesModelAdapter


def test_build_parser_uses_mycli_prog_name() -> None:
    parser = build_parser()
    assert parser.prog == "mycli"


def test_build_parser_reads_session_argument() -> None:
    parser = build_parser()
    args = parser.parse_args(["--session", "demo-session"])
    assert args.session == "demo-session"


def test_help_lists_sessions_command() -> None:
    output = handle_slash_command("/help")
    assert "/session" in output
    assert "/sessions" in output
    assert "/context" in output


def test_build_turn_service_uses_cli_and_env_configuration(tmp_path: Path) -> None:
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
            "MYCLI_BASE_URL": "https://example.invalid/v1",
        },
    )

    assert service._config.session_id == "demo"
    assert service._config.model == "gpt-test"
    assert service._config.api_key == "test-key"
    assert service._config.api_base_url == "https://example.invalid/v1"
    assert (
        service._runtime._workspace_log_service.error_log_path()
        == home_dir / ".mycli" / "logs" / "demo" / "error.log"
    )
    assert service._tool_registry.list_names() == [
        "AskUserQuestion",
        "Bash",
        "Edit",
        "Glob",
        "Grep",
        "KillShell",
        "LS",
        "Lint",
        "Plan",
        "Read",
        "Skill",
        "WebFetch",
        "WebSearch",
        "Write",
        "enter_plan_mode",
        "exit_plan_mode",
    ]


def test_build_turn_service_defaults_to_responses_protocol(tmp_path: Path) -> None:
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
        },
    )

    assert isinstance(service._runtime._model_adapter, ResponsesModelAdapter)


def test_turn_service_accepts_stream_sink(tmp_path: Path) -> None:
    class Runtime:
        def __init__(self) -> None:
            self._config = SimpleNamespace(session_id="demo", workspace_root=tmp_path)
            self._tool_registry = SimpleNamespace(list_names=lambda: [])
            self.seen_sink = None

        def handle_user_turn(self, message: str, stream_sink=None) -> TurnResponse:
            self.seen_sink = stream_sink
            if stream_sink is not None:
                stream_sink(SimpleNamespace(kind="text_delta", text="hi", tool_name=None, metadata={}))
            return TurnResponse(assistant_message=f"done {message}")

    runtime = Runtime()
    service = TurnService(
        config=runtime._config,
        home_dir=tmp_path / "home",
        runtime=runtime,
    )
    events = []
    sink = events.append

    response = service.handle_user_turn("hello", stream_sink=sink)

    assert response.assistant_message == "done hello"
    assert runtime.seen_sink is sink
    assert events[0].text == "hi"


def test_build_turn_service_uses_chat_completions_when_protocol_is_explicitly_set(
    tmp_path: Path,
) -> None:
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
            "MYCLI_PROTOCOL": "chat_completions",
        },
    )

    assert isinstance(service._runtime._model_adapter, NativeToolModelAdapter)


def test_build_turn_service_uses_protocol_from_project_config_file(tmp_path: Path) -> None:
    home_dir = tmp_path / "home"
    workspace = tmp_path / "workspace"
    home_dir.mkdir()
    workspace.mkdir()
    (workspace / ".mycli").mkdir()
    (workspace / ".mycli" / "config.toml").write_text(
        'protocol = "chat_completions"\n',
        encoding="utf-8",
    )

    service = build_turn_service(
        cli_args={"session": "demo"},
        cwd=workspace,
        home=home_dir,
        env={
            "MYCLI_API_KEY": "test-key",
        },
    )

    assert isinstance(service._runtime._model_adapter, NativeToolModelAdapter)


def test_build_turn_service_passes_cli_env_to_mcp_config_loader(tmp_path: Path) -> None:
    home_dir = tmp_path / "home"
    workspace = tmp_path / "workspace"
    home_dir.mkdir()
    workspace.mkdir()
    (workspace / ".mycli").mkdir()
    (workspace / ".mycli" / "mcp_servers.toml").write_text(
        "\n".join(
            [
                "[servers.fs]",
                'command = "python"',
                'args = ["server.py"]',
                "[servers.fs.env]",
                'TOKEN = "${MCP_TEST_TOKEN}"',
            ]
        ),
        encoding="utf-8",
    )

    service = build_turn_service(
        cli_args={"session": "demo", "model": "gpt-test"},
        cwd=workspace,
        home=home_dir,
        env={
            "MYCLI_API_KEY": "test-key",
            "MCP_TEST_TOKEN": "from-cli-env",
        },
    )

    provider = service._runtime._contributed_tool_providers[0]
    client = provider.adapter._clients["fs"]
    assert client.config.env["TOKEN"] == "from-cli-env"


def test_main_starts_repl_with_turn_and_decision_handlers(monkeypatch, tmp_path: Path) -> None:
    events: dict[str, object] = {}

    class FakeService:
        _config = SimpleNamespace(session_id="demo")
        _session_service = SimpleNamespace(
            load_pending_decision=lambda _session_id: PendingDecision(
                tool_call=ToolCall(
                    name="run_shell",
                    arguments={"args": ["git", "push"]},
                    reason="publish branch",
                ),
                kind=DecisionKind.NEEDS_CHOICE,
                reason="Push modifies remote state.",
                preview="git push",
                options=(
                    DecisionAction.APPROVE_ONCE,
                    DecisionAction.REJECT,
                    DecisionAction.ALLOW_SESSION,
                ),
                command_pattern="git push",
            )
        )

        def handle_user_turn(self, _message: str) -> TurnResponse:
            return TurnResponse(
                assistant_message="final answer",
                activity_events=(
                    ActivityEvent(kind="thinking", message="Thinking: inspect repo"),
                    ActivityEvent(kind="tool_started", message="Reading: README.md"),
                ),
                progress_updates=("Inspecting the repository",),
                plan_steps=("in_progress: Inspect runtime entrypoints",),
                pending_decision=PendingDecision(
                    tool_call=ToolCall(
                        name="run_shell",
                        arguments={"args": ["git", "push"]},
                        reason="publish branch",
                    ),
                    kind=DecisionKind.NEEDS_CHOICE,
                    reason="Push modifies remote state.",
                    preview="git push",
                    options=(
                        DecisionAction.APPROVE_ONCE,
                        DecisionAction.REJECT,
                        DecisionAction.ALLOW_SESSION,
                    ),
                    command_pattern="git push",
                ),
            )

        def resolve_pending_decision(self, choice: str) -> TurnResponse:
            return TurnResponse(
                assistant_message=f"resolved {choice}",
                progress_updates=("[decision] approved",),
            )

    monkeypatch.setattr("mycli.cli.main.build_turn_service", lambda *args, **kwargs: FakeService())

    def fake_run_repl(
        turn_handler,
        *,
        session_id: str,
        decision_handler,
        pending_decision_provider,
        **_kwargs,
    ) -> None:
        events["session_id"] = session_id
        events["turn_output"] = list(turn_handler("inspect repo"))
        events["has_pending_decision"] = pending_decision_provider()
        events["decision_output"] = list(decision_handler("3"))

    monkeypatch.setattr("mycli.cli.main.run_repl", fake_run_repl)

    exit_code = main(argv=["--session", "demo"], cwd=tmp_path, home=tmp_path / "home", env={})

    assert exit_code == 0
    assert events["session_id"] == "demo"
    assert events["has_pending_decision"] is True
    assert events["turn_output"] == [
        "[activity] Thinking: inspect repo",
        "[activity] Reading: README.md",
        "[progress] Inspecting the repository",
        "[plan] in_progress: Inspect runtime entrypoints",
        "[decision] 发现需要确认的操作：",
        "[decision] Tool: run_shell",
        "[decision] Preview: git push",
        "[decision] Reason: Push modifies remote state.",
        "[1] 仅本次允许",
        "[2] 拒绝",
        "[3] 本次会话内始终允许同类命令",
        "final answer",
    ]
    assert events["decision_output"] == ["[decision] approved", "resolved 3"]


def test_main_keeps_existing_output_when_no_activity_events_are_present(
    monkeypatch, tmp_path: Path
) -> None:
    events: dict[str, object] = {}

    class FakeService:
        _config = SimpleNamespace(session_id="demo")
        _session_service = SimpleNamespace(load_pending_decision=lambda _session_id: None)

        def handle_user_turn(self, _message: str) -> TurnResponse:
            return TurnResponse(
                assistant_message="plain answer",
                progress_updates=("Working",),
            )

        def resolve_pending_decision(self, choice: str) -> TurnResponse:
            return TurnResponse(assistant_message=choice)

    monkeypatch.setattr("mycli.cli.main.build_turn_service", lambda *args, **kwargs: FakeService())

    def fake_run_repl(turn_handler, **_kwargs) -> None:
        events["turn_output"] = list(turn_handler("inspect repo"))

    monkeypatch.setattr("mycli.cli.main.run_repl", fake_run_repl)

    exit_code = main(argv=["--session", "demo"], cwd=tmp_path, home=tmp_path / "home", env={})

    assert exit_code == 0
    assert events["turn_output"] == [
        "[progress] Working",
        "plain answer",
    ]


def test_main_renders_activity_from_turn_items_when_present(monkeypatch, tmp_path: Path) -> None:
    events: dict[str, object] = {}

    class FakeService:
        _config = SimpleNamespace(session_id="demo")
        _session_service = SimpleNamespace(load_pending_decision=lambda _session_id: None)

        def handle_user_turn(self, _message: str) -> TurnResponse:
            return TurnResponse(
                assistant_message="plain answer",
                turn=TurnRecord(
                    thread_id="demo",
                    turn_id="turn_1",
                    status=TurnStatus.COMPLETED,
                    stop_reason=StopReason.ASSISTANT_COMPLETED,
                    started_at="2026-04-11T00:00:00+00:00",
                    completed_at="2026-04-11T00:00:01+00:00",
                    items=(
                        TurnItem(type=TurnItemType.REASONING, text="inspect repo"),
                        TurnItem(
                            type=TurnItemType.TOOL_CALL,
                            text="README.md",
                            tool_name="read_file",
                            call_id="call_1",
                        ),
                        TurnItem(
                            type=TurnItemType.TOOL_RESULT,
                            text="README.md",
                            tool_name="read_file",
                            call_id="call_1",
                        ),
                    ),
                ),
            )

        def resolve_pending_decision(self, choice: str) -> TurnResponse:
            return TurnResponse(assistant_message=choice)

    monkeypatch.setattr("mycli.cli.main.build_turn_service", lambda *args, **kwargs: FakeService())

    def fake_run_repl(turn_handler, **_kwargs) -> None:
        events["turn_output"] = list(turn_handler("inspect repo"))

    monkeypatch.setattr("mycli.cli.main.run_repl", fake_run_repl)

    exit_code = main(argv=["--session", "demo"], cwd=tmp_path, home=tmp_path / "home", env={})

    assert exit_code == 0
    assert events["turn_output"] == [
        "[activity] Thinking: inspect repo",
        "[activity] Reading: README.md",
        "[activity] Done reading: README.md",
        "plain answer",
    ]


def test_render_activity_lines_coalesces_reasoning_fragments_from_turn_items() -> None:
    response = TurnResponse(
        assistant_message="plain answer",
        turn=TurnRecord(
            thread_id="demo",
            turn_id="turn_1",
            status=TurnStatus.COMPLETED,
            stop_reason=StopReason.ASSISTANT_COMPLETED,
            started_at="2026-04-11T00:00:00+00:00",
            completed_at="2026-04-11T00:00:01+00:00",
            items=(
                TurnItem(type=TurnItemType.REASONING, text="The"),
                TurnItem(type=TurnItemType.REASONING, text=" user wants"),
                TurnItem(type=TurnItemType.REASONING, text=" a short summary."),
                TurnItem(
                    type=TurnItemType.TOOL_CALL,
                    text="pyproject.toml",
                    tool_name="read_file",
                    call_id="call_1",
                ),
                TurnItem(
                    type=TurnItemType.REASONING,
                    text="Summarize",
                    metadata={"activity_kind": "planning"},
                ),
                TurnItem(
                    type=TurnItemType.REASONING,
                    text=" the architecture next.",
                    metadata={"activity_kind": "planning"},
                ),
            ),
        ),
    )

    assert render_activity_lines(response) == [
        "[activity] 正在理解任务目标",
        "[activity] Reading: pyproject.toml",
        "[activity] 正在整理结论",
    ]


def test_render_activity_lines_preserves_provider_reasoning_content_verbatim() -> None:
    reasoning_content = (
        "The user wants me to read mission.txt. "
        "I need to inspect mission.txt before answering, even if this sentence is long enough "
        "that ordinary reasoning rendering would normally summarize it."
    )
    response = TurnResponse(
        assistant_message="Read complete",
        turn=TurnRecord(
            thread_id="demo",
            turn_id="turn_1",
            status=TurnStatus.COMPLETED,
            stop_reason=StopReason.ASSISTANT_COMPLETED,
            started_at="2026-04-26T00:00:00+00:00",
            completed_at="2026-04-26T00:00:01+00:00",
            items=(
                TurnItem(
                    type=TurnItemType.REASONING,
                    text=f"Thinking: {reasoning_content}",
                    metadata={
                        "provider": "deepseek",
                        "source": "provider_reasoning_content",
                        "deepseek": {"reasoning_content": reasoning_content},
                    },
                ),
                TurnItem(
                    type=TurnItemType.TOOL_CALL,
                    text="Reading: mission.txt",
                    tool_name="read_file",
                    call_id="call_read_file_1",
                ),
            ),
        ),
    )

    assert render_activity_lines(response) == [
        f"[activity] Thinking: {reasoning_content}",
        "[activity] Reading: mission.txt",
    ]


def test_render_activity_lines_turns_exploration_reasoning_into_semantic_activity() -> None:
    response = TurnResponse(
        assistant_message="plain answer",
        turn=TurnRecord(
            thread_id="demo",
            turn_id="turn_1",
            status=TurnStatus.COMPLETED,
            stop_reason=StopReason.ASSISTANT_COMPLETED,
            started_at="2026-04-11T00:00:00+00:00",
            completed_at="2026-04-11T00:00:01+00:00",
            items=(
                TurnItem(type=TurnItemType.REASONING, text="Thinking: Let me look at"),
                TurnItem(type=TurnItemType.REASONING, text="Thinking:  the py project.toml"),
                TurnItem(type=TurnItemType.REASONING, text="Thinking:  for entry points, the README"),
                TurnItem(type=TurnItemType.REASONING, text="Thinking:  for project overview, and the src directory structure."),
            ),
        ),
    )

    assert render_activity_lines(response) == [
        "[activity] 正在查看 `pyproject.toml`、`README.md`、`src/`",
    ]


def test_render_activity_lines_semanticizes_reasoning_before_summary_truncation() -> None:
    response = TurnResponse(
        assistant_message="plain answer",
        turn=TurnRecord(
            thread_id="demo",
            turn_id="turn_1",
            status=TurnStatus.COMPLETED,
            stop_reason=StopReason.ASSISTANT_COMPLETED,
            started_at="2026-04-11T00:00:00+00:00",
            completed_at="2026-04-11T00:00:01+00:00",
            items=(
                TurnItem(type=TurnItemType.REASONING, text="Thinking: This is a Python project"),
                TurnItem(type=TurnItemType.REASONING, text="Thinking:  with `src/` directory."),
                TurnItem(type=TurnItemType.REASONING, text="Thinking:  I need to look"),
                TurnItem(type=TurnItemType.REASONING, text="Thinking:  at `pyproject.toml`"),
                TurnItem(type=TurnItemType.REASONING, text="Thinking:  and the `src/` directory structure."),
            ),
        ),
    )

    assert render_activity_lines(response) == [
        "[activity] 正在查看 `pyproject.toml`、`src/`",
    ]


def test_render_activity_lines_prefers_structured_repo_analysis_stage_messages() -> None:
    response = TurnResponse(
        assistant_message="plain answer",
        turn=TurnRecord(
            thread_id="demo",
            turn_id="turn_1",
            status=TurnStatus.COMPLETED,
            stop_reason=StopReason.ASSISTANT_COMPLETED,
            started_at="2026-04-11T00:00:00+00:00",
            completed_at="2026-04-11T00:00:01+00:00",
            items=(
                TurnItem(type=TurnItemType.REASONING, text="Planning: 正在检查仓库结构"),
                TurnItem(type=TurnItemType.REASONING, text="Thinking: for entry points, the README and src tree"),
            ),
        ),
    )

    assert render_activity_lines(response) == [
        "[activity] 正在检查仓库结构",
    ]


def test_render_activity_lines_suppresses_summary_draft_after_structured_answer_stage() -> None:
    response = TurnResponse(
        assistant_message="plain answer",
        turn=TurnRecord(
            thread_id="demo",
            turn_id="turn_1",
            status=TurnStatus.COMPLETED,
            stop_reason=StopReason.ASSISTANT_COMPLETED,
            started_at="2026-04-11T00:00:00+00:00",
            completed_at="2026-04-11T00:00:01+00:00",
            items=(
                TurnItem(type=TurnItemType.REASONING, text="Planning: 已从确认的证据收口回答"),
                TurnItem(
                    type=TurnItemType.REASONING,
                    text="Planning: Plan:\n根据已确认的 pyproject.toml，这个仓库的入口是 src/mycli/cli/main.py",
                ),
            ),
        ),
    )

    assert render_activity_lines(response) == [
        "[activity] 已从确认的证据收口回答",
    ]


def test_render_activity_lines_deduplicates_repeated_semantic_reasoning() -> None:
    response = TurnResponse(
        assistant_message="plain answer",
        turn=TurnRecord(
            thread_id="demo",
            turn_id="turn_1",
            status=TurnStatus.COMPLETED,
            stop_reason=StopReason.ASSISTANT_COMPLETED,
            started_at="2026-04-11T00:00:00+00:00",
            completed_at="2026-04-11T00:00:01+00:00",
            items=(
                TurnItem(type=TurnItemType.REASONING, text="Thinking: The user wants a short summary."),
                TurnItem(
                    type=TurnItemType.TOOL_CALL,
                    text="Listing: src",
                    tool_name="list_directory",
                    call_id="call_1",
                ),
                TurnItem(
                    type=TurnItemType.TOOL_RESULT,
                    text="Done: list_directory",
                    tool_name="list_directory",
                    call_id="call_1",
                ),
                TurnItem(type=TurnItemType.REASONING, text="Thinking: The user wants a short summary."),
            ),
        ),
    )

    assert render_activity_lines(response) == [
        "[activity] 正在理解任务目标",
        "[activity] Listing: src",
        "[activity] Done: list_directory",
    ]


def test_render_activity_lines_filters_prompt_scaffolding_reasoning_noise() -> None:
    response = TurnResponse(
        assistant_message="plain answer",
        turn=TurnRecord(
            thread_id="demo",
            turn_id="turn_1",
            status=TurnStatus.COMPLETED,
            stop_reason=StopReason.ASSISTANT_COMPLETED,
            started_at="2026-04-11T00:00:00+00:00",
            completed_at="2026-04-11T00:00:01+00:00",
            items=(
                TurnItem(type=TurnItemType.REASONING, text='Planning: "Current plan"'),
                TurnItem(type=TurnItemType.REASONING, text="Planning: , update_plan`"),
                TurnItem(type=TurnItemType.REASONING, text="Planning: _text, update_plan"),
                TurnItem(type=TurnItemType.REASONING, text="Planning: /plans/`,"),
                TurnItem(type=TurnItemType.REASONING, text="Planning: plan: none`."),
                TurnItem(
                    type=TurnItemType.TOOL_CALL,
                    text="Reading: README.md",
                    tool_name="read_file",
                    call_id="call_1",
                ),
            ),
        ),
    )

    assert render_activity_lines(response) == [
        "[activity] Reading: README.md",
    ]


def test_main_omits_duplicate_progress_lines_when_turn_activity_is_present(
    monkeypatch, tmp_path: Path
) -> None:
    events: dict[str, object] = {}

    class FakeService:
        _config = SimpleNamespace(session_id="demo")
        _session_service = SimpleNamespace(load_pending_decision=lambda _session_id: None)

        def handle_user_turn(self, _message: str) -> TurnResponse:
            return TurnResponse(
                assistant_message="plain answer",
                progress_updates=("The user wants a short summary.",),
                turn=TurnRecord(
                    thread_id="demo",
                    turn_id="turn_1",
                    status=TurnStatus.COMPLETED,
                    stop_reason=StopReason.ASSISTANT_COMPLETED,
                    started_at="2026-04-11T00:00:00+00:00",
                    completed_at="2026-04-11T00:00:01+00:00",
                    items=(
                        TurnItem(type=TurnItemType.REASONING, text="Thinking: The"),
                        TurnItem(type=TurnItemType.REASONING, text="Thinking:  user wants"),
                        TurnItem(type=TurnItemType.REASONING, text="Thinking:  a short summary."),
                        TurnItem(
                            type=TurnItemType.TOOL_CALL,
                            text="Reading: pyproject.toml",
                            tool_name="read_file",
                            call_id="call_1",
                        ),
                    ),
                ),
            )

        def resolve_pending_decision(self, choice: str) -> TurnResponse:
            return TurnResponse(assistant_message=choice)

    monkeypatch.setattr("mycli.cli.main.build_turn_service", lambda *args, **kwargs: FakeService())

    def fake_run_repl(turn_handler, **_kwargs) -> None:
        events["turn_output"] = list(turn_handler("inspect repo"))

    monkeypatch.setattr("mycli.cli.main.run_repl", fake_run_repl)

    exit_code = main(argv=["--session", "demo"], cwd=tmp_path, home=tmp_path / "home", env={})

    assert exit_code == 0
    assert events["turn_output"] == [
        "[activity] 正在理解任务目标",
        "[activity] Reading: pyproject.toml",
        "plain answer",
    ]


def test_main_renders_error_details_when_present(monkeypatch, tmp_path: Path) -> None:
    events: dict[str, object] = {}

    class FakeService:
        _config = SimpleNamespace(session_id="demo")
        _session_service = SimpleNamespace(load_pending_decision=lambda _session_id: None)

        def handle_user_turn(self, _message: str) -> TurnResponse:
            return TurnResponse(
                assistant_message="Model request failed: boom",
                error_details=(
                    "Details logged to log/error.log",
                    "Raw error saved to log/model-raw/demo-turn_1-error.json",
                ),
            )

        def resolve_pending_decision(self, choice: str) -> TurnResponse:
            return TurnResponse(assistant_message=choice)

    monkeypatch.setattr("mycli.cli.main.build_turn_service", lambda *args, **kwargs: FakeService())

    def fake_run_repl(turn_handler, **_kwargs) -> None:
        events["turn_output"] = list(turn_handler("inspect repo"))

    monkeypatch.setattr("mycli.cli.main.run_repl", fake_run_repl)

    exit_code = main(argv=["--session", "demo"], cwd=tmp_path, home=tmp_path / "home", env={})

    assert exit_code == 0
    assert events["turn_output"] == [
        "[error] Details logged to log/error.log",
        "[error] Raw error saved to log/model-raw/demo-turn_1-error.json",
        "Model request failed: boom",
    ]


def test_main_skips_streamed_answer_chunks_when_final_message_is_present(
    monkeypatch, tmp_path: Path
) -> None:
    events: dict[str, object] = {}

    class FakeService:
        _config = SimpleNamespace(session_id="demo")
        _session_service = SimpleNamespace(load_pending_decision=lambda _session_id: None)

        def handle_user_turn(self, _message: str) -> TurnResponse:
            return TurnResponse(
                assistant_message="Repository summary complete.",
                activity_events=(ActivityEvent(kind="thinking", message="Thinking: inspect pyproject first"),),
                streamed_chunks=("Repository ", "summary complete.",),
            )

        def resolve_pending_decision(self, choice: str) -> TurnResponse:
            return TurnResponse(assistant_message=choice)

    monkeypatch.setattr("mycli.cli.main.build_turn_service", lambda *args, **kwargs: FakeService())

    def fake_run_repl(turn_handler, **_kwargs) -> None:
        events["turn_output"] = list(turn_handler("inspect repo"))

    monkeypatch.setattr("mycli.cli.main.run_repl", fake_run_repl)

    exit_code = main(argv=["--session", "demo"], cwd=tmp_path, home=tmp_path / "home", env={})

    assert exit_code == 0
    assert events["turn_output"] == [
        "[activity] Thinking: inspect pyproject first",
        "Repository summary complete.",
    ]


def test_streaming_render_state_accumulates_chunks_and_tool_status() -> None:
    state = StreamingRenderState()

    assert state.start_tool("read_file", "README.md") == "[tool] running read_file: README.md"
    assert state.append_chunk("hello") == "[stream] hello"
    assert state.append_chunk(" world") == "[stream] hello world"
    assert state.text == "hello world"
    assert state.finish_tool("read_file", "README.md") == "[tool] done read_file: README.md"
    assert state.active_tool is None


def test_render_streaming_state_lines_shows_accumulated_output() -> None:
    response = TurnResponse(
        assistant_message="",
        streamed_chunks=("hello", " ", "world"),
    )

    assert render_streaming_state_lines(response) == [
        "[stream] hello",
        "[stream] hello ",
        "[stream] hello world",
    ]


def test_render_streaming_live_output_uses_rich_text() -> None:
    response = TurnResponse(
        assistant_message="",
        streamed_chunks=("hello", " ", "world"),
    )

    rendered = render_streaming_live_output(response)

    assert [item.plain for item in rendered] == ["hello", "hello ", "hello world"]
    assert all(isinstance(item, Text) for item in rendered)


def test_render_tool_status_uses_rich_status() -> None:
    rendered = render_tool_status("read_file", "README.md")

    assert isinstance(rendered, Status)
    assert rendered.status == "read_file: README.md"


def test_render_diff_view_uses_rich_syntax() -> None:
    rendered = render_diff_view("+new")

    assert isinstance(rendered, Syntax)
    assert rendered.code == "+new"


def test_render_diff_lines_adds_line_numbers_and_markers() -> None:
    assert render_diff_lines("@@ -1 +1 @@\n-old\n+new") == [
        "   1 [@]@@ -1 +1 @@",
        "   2 [-]-old",
        "   3 [+]+new",
    ]


def test_build_command_handler_exposes_runtime_inspection_commands() -> None:
    class FakeService:
        def undo_last_file_change(self):
            return "Restored notes.txt"

        def inspect_plan(self) -> tuple[str, ...]:
            return ("in_progress: Inspect runtime entrypoints",)

        def inspect_skills(self) -> tuple[str, ...]:
            return ("repository-analysis: Inspect repos",)

        def inspect_tools(self) -> tuple[str, ...]:
            return ("read_file [low]: Read a file",)

        def inspect_memory(self) -> tuple[str, ...]:
            return ("preference tone=concise",)

        def inspect_trace(self) -> tuple[str, ...]:
            return ("tool_execution search_text",)

        def inspect_session(self) -> tuple[str, ...]:
            return ("session=demo", "messages=3")

        def inspect_sessions(self) -> tuple[str, ...]:
            return ("* demo active messages=3", "  backlog active messages=1")

        def inspect_stats(self) -> tuple[str, ...]:
            return ("cache_hit_rate=0.5", "alerts=none")

        def inspect_context(self) -> tuple[str, ...]:
            return ("budget input_tokens=900 max_tokens=1000 usage_ratio=90.0% source=provider",)

        def inspect_usage(self) -> tuple[str, ...]:
            return ("session=demo", "turns=1")

        def resume_session(self, session_id=None) -> tuple[str, ...]:
            return (f"resumed {session_id or 'demo'}", "messages=3")

        def fork_session(self, source_session_id=None, new_session_id=None, fork_point=None) -> tuple[str, ...]:
            return (
                f"forked {source_session_id or 'demo'} -> {new_session_id or 'demo-fork'}",
                f"fork_point={fork_point}",
            )

    handler = build_command_handler(FakeService())

    assert list(handler("/plan")) == ["[plan] in_progress: Inspect runtime entrypoints"]
    assert list(handler("/skills")) == ["[skill] repository-analysis: Inspect repos"]
    assert list(handler("/tools")) == ["[tool] read_file [low]: Read a file"]
    assert list(handler("/memory")) == ["[memory] preference tone=concise"]
    assert list(handler("/trace")) == ["[trace] tool_execution search_text"]
    assert list(handler("/session")) == ["[session] session=demo", "[session] messages=3"]
    assert list(handler("/sessions")) == [
        "[session] * demo active messages=3",
        "[session]   backlog active messages=1",
    ]
    assert list(handler("/undo")) == ["[undo] Restored notes.txt"]
    assert list(handler("/stats")) == ["[stats] cache_hit_rate=0.5", "[stats] alerts=none"]
    assert list(handler("/context")) == [
        "[context] budget input_tokens=900 max_tokens=1000 usage_ratio=90.0% source=provider"
    ]
    assert list(handler("/usage")) == ["[usage] session=demo", "[usage] turns=1"]
    assert list(handler("/resume backlog")) == [
        "[session] resumed backlog",
        "[session] messages=3",
    ]
    assert list(handler("/fork demo branch 2")) == [
        "[session] forked demo -> branch",
        "[session] fork_point=2",
    ]


def test_turn_service_inspect_context_reports_empty_metrics(tmp_path: Path) -> None:
    home_dir = tmp_path / "home"
    workspace = tmp_path / "workspace"
    home_dir.mkdir()
    workspace.mkdir()
    service = build_turn_service(
        cli_args={"session": "demo", "model": "gpt-test"},
        cwd=workspace,
        home=home_dir,
        env={"MYCLI_API_KEY": "test-key"},
    )

    assert service.inspect_context() == ("no context metrics available",)


def test_turn_service_inspect_context_reports_budget_and_compaction(tmp_path: Path) -> None:
    home_dir = tmp_path / "home"
    workspace = tmp_path / "workspace"
    home_dir.mkdir()
    workspace.mkdir()
    service = build_turn_service(
        cli_args={"session": "demo", "model": "gpt-test"},
        cwd=workspace,
        home=home_dir,
        env={"MYCLI_API_KEY": "test-key"},
    )
    metrics = service._observability_service.metrics
    metrics.record_budget(total_tokens=900, max_tokens=1000)
    metrics.record_context_window(
        {
            "total_tokens": 900,
            "max_tokens": 1000,
            "usage_ratio": 0.9,
            "fresh_tokens": 700,
            "tool_result_tokens": 250,
            "duplicate_tool_result_tokens": 50,
            "evictable_tool_result_tokens": 100,
        }
    )
    metrics.record_compaction(before_tokens=1200, after_tokens=300, level="L4")
    metrics.record_l4_decision(decision="summarize", source="pre_request")

    lines = service.inspect_context()

    assert lines[0] == "budget total_tokens=900 max_tokens=1000 usage_ratio=90.0% source=estimate"
    assert (
        "context_window fresh_tokens=700 tool_result_tokens=250 "
        "duplicate_tool_result_tokens=50 evictable_tool_result_tokens=100"
    ) in lines
    assert (
        "compaction L4=1 before_tokens=1200 after_tokens=300 ratio=25.0% "
        "last_decision=summarize source=pre_request"
    ) in lines


def test_turn_service_inspect_context_uses_total_tokens_from_runtime_metrics(tmp_path: Path) -> None:
    home_dir = tmp_path / "home"
    workspace = tmp_path / "workspace"
    home_dir.mkdir()
    workspace.mkdir()
    service = build_turn_service(
        cli_args={"session": "demo", "model": "gpt-test"},
        cwd=workspace,
        home=home_dir,
        env={"MYCLI_API_KEY": "test-key"},
    )
    metrics = service._observability_service.metrics
    metrics.record_budget(total_tokens=100, max_tokens=1000)
    metrics.record_context_window(
        {
            "total_tokens": 900,
            "max_tokens": 1000,
            "usage_ratio": 0.9,
            "fresh_tokens": 700,
            "tool_result_tokens": 250,
            "duplicate_tool_result_tokens": 50,
            "evictable_tool_result_tokens": 100,
        }
    )

    lines = service.inspect_context()

    assert lines[0] == "budget total_tokens=900 max_tokens=1000 usage_ratio=90.0% source=estimate"


def test_turn_service_inspect_context_preserves_provider_input_token_label(tmp_path: Path) -> None:
    home_dir = tmp_path / "home"
    workspace = tmp_path / "workspace"
    home_dir.mkdir()
    workspace.mkdir()
    service = build_turn_service(
        cli_args={"session": "demo", "model": "gpt-test"},
        cwd=workspace,
        home=home_dir,
        env={"MYCLI_API_KEY": "test-key"},
    )
    metrics = service._observability_service.metrics
    metrics.record_context_window(
        {
            "input_tokens": 640,
            "max_tokens": 1000,
            "usage_ratio": 0.64,
            "source": "provider",
            "fresh_tokens": 500,
            "tool_result_tokens": 100,
            "duplicate_tool_result_tokens": 20,
            "evictable_tool_result_tokens": 30,
        }
    )

    lines = service.inspect_context()

    assert lines[0] == "budget input_tokens=640 max_tokens=1000 usage_ratio=64.0% source=provider"


def test_turn_service_inspect_context_uses_budget_curve_when_no_context_window(tmp_path: Path) -> None:
    home_dir = tmp_path / "home"
    workspace = tmp_path / "workspace"
    home_dir.mkdir()
    workspace.mkdir()
    service = build_turn_service(
        cli_args={"session": "demo", "model": "gpt-test"},
        cwd=workspace,
        home=home_dir,
        env={"MYCLI_API_KEY": "test-key"},
    )
    service._observability_service.metrics.record_budget(total_tokens=420, max_tokens=1000)

    lines = service.inspect_context()

    estimated_total_tokens = int(round(0.42 * service._config.max_prompt_tokens))
    assert lines[0] == (
        f"budget total_tokens={estimated_total_tokens} "
        f"max_tokens={service._config.max_prompt_tokens} "
        "usage_ratio=42.0% source=estimate"
    )


def test_turn_service_inspect_context_reports_l4_decision_without_compaction(tmp_path: Path) -> None:
    home_dir = tmp_path / "home"
    workspace = tmp_path / "workspace"
    home_dir.mkdir()
    workspace.mkdir()
    service = build_turn_service(
        cli_args={"session": "demo", "model": "gpt-test"},
        cwd=workspace,
        home=home_dir,
        env={"MYCLI_API_KEY": "test-key"},
    )
    service._observability_service.metrics.record_l4_decision(
        decision="skip",
        source="pre_request",
    )

    lines = service.inspect_context()

    assert lines != ("no context metrics available",)
    assert lines == ("l4 last_decision=skip source=pre_request",)


def test_turn_service_inspect_usage_sums_model_usage_rollouts(tmp_path: Path) -> None:
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
            "MYCLI_USAGE_INPUT_COST_PER_1K": "0.001",
            "MYCLI_USAGE_OUTPUT_COST_PER_1K": "0.002",
            "MYCLI_USAGE_CACHE_READ_COST_PER_1K": "0.0001",
            "MYCLI_USAGE_CACHE_WRITE_COST_PER_1K": "0.0002",
        },
    )

    usage_item = TurnItem(
        type=TurnItemType.MODEL_USAGE,
        metadata={
            "input_tokens": 1000,
            "output_tokens": 200,
            "total_tokens": 1200,
            "cache_read_tokens": 300,
            "cache_write_tokens": 100,
        },
    )
    service._session_service.append_turn_rollout(
        "demo",
        TurnRollout(
            thread_id="demo",
            turn_id="turn_1",
            status=TurnStatus.COMPLETED,
            started_at="2026-05-19T00:00:00Z",
            completed_at="2026-05-19T00:00:01Z",
            stop_reason=StopReason.ASSISTANT_COMPLETED,
            events=(
                TurnRolloutEvent(
                    event_id="turn_1:trace:1",
                    kind="turn_item",
                    created_at="2026-05-19T00:00:01Z",
                    payload=usage_item.to_dict(),
                ),
            ),
        ),
    )

    lines = service.inspect_usage()

    assert lines == (
        "session=demo",
        "turns=1",
        "input_tokens=1000 output_tokens=200 total_tokens=1200 cache_read_tokens=300 cache_write_tokens=100",
        "estimated_cost=0.00145",
    )


def test_turn_service_inspect_usage_reports_unavailable_cost_without_prices(tmp_path: Path) -> None:
    home_dir = tmp_path / "home"
    workspace = tmp_path / "workspace"
    home_dir.mkdir()
    workspace.mkdir()
    service = build_turn_service(
        cli_args={"session": "demo", "model": "gpt-test"},
        cwd=workspace,
        home=home_dir,
        env={"MYCLI_API_KEY": "test-key"},
    )

    assert service.inspect_usage() == (
        "session=demo",
        "turns=0",
        "input_tokens=0 output_tokens=0 total_tokens=0 cache_read_tokens=0 cache_write_tokens=0",
        "estimated_cost=unavailable",
    )


def test_turn_service_inspect_usage_ignores_budget_input_tokens(tmp_path: Path) -> None:
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
            "MYCLI_USAGE_INPUT_COST_PER_1K": "0.001",
            "MYCLI_USAGE_OUTPUT_COST_PER_1K": "0.002",
        },
    )

    usage_item = TurnItem(
        type=TurnItemType.MODEL_USAGE,
        metadata={
            "input_tokens": 0,
            "budget_input_tokens": 900,
            "output_tokens": 0,
            "total_tokens": 1800,
            "cache_read_tokens": 0,
            "cache_write_tokens": 0,
        },
    )
    service._session_service.append_turn_rollout(
        "demo",
        TurnRollout(
            thread_id="demo",
            turn_id="turn_1",
            status=TurnStatus.COMPLETED,
            started_at="2026-05-19T00:00:00Z",
            completed_at="2026-05-19T00:00:01Z",
            stop_reason=StopReason.ASSISTANT_COMPLETED,
            events=(
                TurnRolloutEvent(
                    event_id="turn_1:trace:1",
                    kind="turn_item",
                    created_at="2026-05-19T00:00:01Z",
                    payload=usage_item.to_dict(),
                ),
            ),
        ),
    )

    assert service.inspect_usage() == (
        "session=demo",
        "turns=1",
        "input_tokens=0 output_tokens=0 total_tokens=1800 cache_read_tokens=0 cache_write_tokens=0",
        "estimated_cost=0.00000",
    )


def test_turn_service_inspect_trace_includes_tool_summary_and_arguments(tmp_path: Path) -> None:
    home_dir = tmp_path / "home"
    workspace = tmp_path / "workspace"
    home_dir.mkdir()
    workspace.mkdir()

    service = build_turn_service(
        cli_args={"session": "demo", "model": "gpt-test"},
        cwd=workspace,
        home=home_dir,
        env={"MYCLI_API_KEY": "test-key"},
    )
    service._trace_service.append(
        "demo",
        RuntimeTraceEvent(
            kind="tool_execution",
            turn_id="turn_1",
            payload={
                "tool_name": "run_shell",
                "arguments": {"args": ["pwd"]},
                "summary": "Command exited with 0",
                "stdout_preview": "/Users/cosmos/Desktop/mycli",
            },
        ),
    )

    rendered = service.inspect_trace()

    assert rendered == (
        "tool_execution run_shell args=pwd summary=Command exited with 0 stdout=/Users/cosmos/Desktop/mycli",
    )


def test_turn_service_inspect_trace_renders_tool_lifecycle_events(tmp_path: Path) -> None:
    home_dir = tmp_path / "home"
    workspace = tmp_path / "workspace"
    home_dir.mkdir()
    workspace.mkdir()

    service = build_turn_service(
        cli_args={"session": "demo", "model": "gpt-test"},
        cwd=workspace,
        home=home_dir,
        env={"MYCLI_API_KEY": "test-key"},
    )
    service._trace_service.append(
        "demo",
        RuntimeTraceEvent(
            kind="tool_lifecycle",
            turn_id="turn_1",
            payload={
                "route_name": "workspace_summary",
                "scope": "thread",
                "state": "completed",
                "source": "runtime",
            },
        ),
    )

    rendered = service.inspect_trace()

    assert rendered == (
        "tool_lifecycle workspace_summary scope=thread state=completed source=runtime",
    )


def test_turn_service_inspect_trace_prefers_high_signal_events_over_turn_items(tmp_path: Path) -> None:
    home_dir = tmp_path / "home"
    workspace = tmp_path / "workspace"
    home_dir.mkdir()
    workspace.mkdir()

    service = build_turn_service(
        cli_args={"session": "demo", "model": "gpt-test"},
        cwd=workspace,
        home=home_dir,
        env={"MYCLI_API_KEY": "test-key"},
    )
    for index in range(12):
        service._trace_service.append(
            "demo",
            RuntimeTraceEvent(
                kind="turn_item",
                turn_id="turn_1",
                payload={"index": index},
            ),
        )
    service._trace_service.append(
        "demo",
        RuntimeTraceEvent(
            kind="tool_lifecycle",
            turn_id="turn_1",
            payload={
                "route_name": "workspace_summary",
                "scope": "thread",
                "state": "completed",
                "source": "runtime",
            },
        ),
    )

    rendered = service.inspect_trace()

    assert rendered == (
        "tool_lifecycle workspace_summary scope=thread state=completed source=runtime",
    )
