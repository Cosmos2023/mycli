from __future__ import annotations

from collections.abc import Callable
from pathlib import Path
from threading import Event, Lock, Thread
import time
from types import SimpleNamespace

from mycli.config.auth_store import AuthStore
from mycli.application.turn_service import TurnService
from mycli.cli.node_tui.gateway import (
    NodeTuiGateway,
    _SerializedGatewayWriter,
    supported_event_streams,
    supported_rpc_methods,
)
from mycli.cli.node_tui.protocol import (
    RpcNotification,
    RpcRequest,
    decode_message,
    notification,
)
from mycli.domain.conversation import Conversation, Message
from mycli.domain.runtime import (
    CollaborationMode,
    DecisionAction,
    DecisionKind,
    ReasoningEffort,
    PendingDecision,
    PendingClarification,
    RuntimeStreamEvent,
    RuntimeInterruptToken,
    ShellLifecycleEvent,
    StopReason,
    SuspendedTurn,
    TurnResponse,
    TurnRecord,
    TurnStatus,
)
from mycli.domain.runtime.session_history import HistoryItem, HistoryItemType
from mycli.domain.tooling.calls import ToolCall


StreamSink = Callable[[RuntimeStreamEvent], None]


def _gateway_error_events(
    events: list[tuple[str, dict[str, object]]],
) -> list[dict[str, object]]:
    return [params for method, params in events if method == "gateway.error"]


class FakeSessionService:
    def __init__(self) -> None:
        self.history_items: tuple[HistoryItem, ...] = ()
        self.pending_decision: object | None = None
        self.suspended_turn: object | None = None
        self.include_child_session = False
        self.conversations: dict[str, Conversation] = {
            "demo": Conversation(
                session_id="demo",
                messages=[
                    Message(role="user", content="Read pyproject.toml"),
                    Message(role="assistant", content="The project is mycli."),
                    Message(role="tool", content="tool output", tool_call_id="call_1"),
                    Message(role="user", content="Update the TUI"),
                ],
            ),
            "child": Conversation(
                session_id="child",
                parent_id="demo",
                fork_point=2,
                messages=[
                    Message(role="user", content="Read pyproject.toml"),
                    Message(role="assistant", content="Alternative branch"),
                ],
            ),
        }

    def load_pending_decision(self, _session_id: str) -> object | None:
        return self.pending_decision

    def load_suspended_turn(self, _session_id: str) -> object | None:
        return self.suspended_turn

    def load_history_items(self, _session_id: str) -> tuple[HistoryItem, ...]:
        return self.history_items

    def load_conversation(self, session_id: str) -> Conversation:
        return self.conversations.get(session_id, Conversation(session_id=session_id))

    def list_sessions(self, limit: int = 20) -> tuple[SimpleNamespace, ...]:
        sessions = [
            SimpleNamespace(
                session_id="demo",
                workspace_root=Path("/workspace"),
                created_at="2026-05-26T01:33:04Z",
                updated_at="2026-05-27T01:33:04Z",
                last_active_at="2026-05-27T01:33:04Z",
                message_count=4,
                status="active",
                summary_count=0,
            ),
        ]
        if self.include_child_session:
            sessions.append(
                SimpleNamespace(
                    session_id="child",
                    workspace_root=Path("/workspace"),
                    created_at="2026-05-27T02:00:00Z",
                    updated_at="2026-05-27T02:10:00Z",
                    last_active_at="2026-05-27T02:10:00Z",
                    message_count=2,
                    status="active",
                    summary_count=0,
                )
            )
        return tuple(sessions[:limit])


class FakeService(TurnService):
    def __init__(self, workspace_root: Path) -> None:
        self._config = SimpleNamespace(
            session_id="demo",
            workspace_root=workspace_root,
            model="deepseek-v4-flash",
            collaboration_mode=CollaborationMode.DEFAULT,
            reasoning_effort=ReasoningEffort.MEDIUM,
            thinking_enabled=True,
            thinking_effort=ReasoningEffort.MEDIUM,
            provider=SimpleNamespace(value="deepseek"),
            protocol=SimpleNamespace(value="chat_completions"),
            max_prompt_tokens=100000,
            tui_startup_mark="default",
            statusline_enabled=True,
            view_mode=SimpleNamespace(value="default"),
        )
        self.fake_session_service = FakeSessionService()
        self._session_service = self.fake_session_service
        self.messages: list[str] = []
        self.image_paths: list[tuple[str, ...]] = []
        self.shell_listener: Callable[[ShellLifecycleEvent], None] | None = None
        self.shell_unsubscribe_count = 0
        self.active_shell_rows: tuple[dict[str, object], ...] = ()

    def inspect_usage(self) -> tuple[str, ...]:
        return ("session=demo", "turns=1")

    def inspect_file_changes(self) -> tuple[str, ...]:
        return ("modified src/app.tsx", "modified tests/app.test.tsx")

    def inspect_status(self) -> tuple[str, ...]:
        return ("session=demo context=unknown",)

    def inspect_session(self) -> tuple[str, ...]:
        session_name = getattr(self._config, "session_title", None) or self._config.session_id
        return (f"session={session_name}", "messages=3")

    def inspect_permissions(self) -> tuple[str, ...]:
        return (
            "session_allowances=1",
            "allow_session pattern=git push",
            "execpolicy_rules=1",
            "execpolicy source=project decision=allow pattern_length=2",
        )

    def inspect_hooks(self) -> tuple[str, ...]:
        return ("configured:repo:post-tool hook_point=post_tool_use enabled=true",)

    def inspect_skills(self) -> tuple[str, ...]:
        return ("code-review: Review code for bugs",)

    def cancel_background_subagents(self) -> tuple[str, ...]:
        return ("cancelled subagent:demo:sub:turn_1:abcd owner_turn=turn_1",)

    def cancel_background_subagent(self, child_session_id: str) -> tuple[str, ...]:
        return (f"cancelled subagent:{child_session_id} owner_turn=turn_1",)

    def inspect_extensions(self) -> tuple[str, ...]:
        return ("agent=mycli schema=1 rpc_methods=2 event_streams=3",)

    def inspect_plugin_commands(self) -> tuple[str, ...]:
        return ("demo.inspect plugin=demo name=inspect kind=command",)

    def set_view_mode(self, mode: str) -> tuple[str, ...]:
        self._config.view_mode = SimpleNamespace(value=mode)
        return (f"mode={mode}",)

    def inspect_mode(self) -> tuple[str, ...]:
        return (f"collaboration_mode={self._config.collaboration_mode.value}",)

    def set_collaboration_mode(self, mode: str) -> tuple[str, ...]:
        try:
            collaboration_mode = CollaborationMode(mode)
        except ValueError:
            return (f"unsupported collaboration_mode={mode}; allowed=default, plan",)
        self._config.collaboration_mode = collaboration_mode
        return (f"collaboration_mode={collaboration_mode.value}",)

    def set_model_settings(
        self,
        *,
        model: str | None = None,
        thinking_effort: str | None = None,
    ) -> tuple[str, ...]:
        if model is not None:
            self._config.model = model
        if thinking_effort is not None:
            self._config.reasoning_effort = ReasoningEffort(thinking_effort)
            self._config.thinking_effort = ReasoningEffort(thinking_effort)
        return (
            f"model={self._config.model}",
            f"thinking_effort={self._config.thinking_effort.value}",
        )

    def current_context_window_metrics(self) -> dict[str, object]:
        return {"input_tokens": 123, "max_tokens": 100000, "source": "provider"}

    def resume_session(self, session_id: str | None = None) -> tuple[str, ...]:
        if session_id is not None:
            self._config.session_id = session_id
        return (f"resumed {session_id or 'demo'}", "messages=4")

    def register_shell_lifecycle_listener(
        self,
        listener: Callable[[ShellLifecycleEvent], None],
    ) -> Callable[[], None]:
        self.shell_listener = listener

        def unsubscribe() -> None:
            self.shell_unsubscribe_count += 1
            self.shell_listener = None

        return unsubscribe

    def active_background_shells(self) -> tuple[dict[str, object], ...]:
        return self.active_shell_rows

    def stop_background_shells(self) -> tuple[str, ...]:
        self.active_shell_rows = ()
        return ("Stopping all background terminals.",)

    def emit_shell_event(self, event: ShellLifecycleEvent) -> None:
        assert self.shell_listener is not None
        self.shell_listener(event)

    def handle_user_turn(
        self,
        message: str,
        stream_sink: StreamSink | None = None,
        image_paths: tuple[str, ...] = (),
    ) -> TurnResponse:
        del stream_sink
        self.messages.append(message)
        self.image_paths.append(image_paths)
        return TurnResponse(assistant_message="")

    def resolve_pending_decision(
        self,
        choice: str,
        stream_sink: StreamSink | None = None,
    ) -> TurnResponse:
        del choice, stream_sink
        return TurnResponse(assistant_message="")

    def resolve_pending_clarification(self, request_id: str, response: str) -> TurnResponse:
        del request_id, response
        return TurnResponse(assistant_message="")

    def export_trace_jsonl(self, tail: int = 50) -> tuple[str, ...]:
        return tuple(f'{{"kind":"tool_execution","turn_id":"turn_{index}","payload":{{}}}}' for index in range(tail))

    def extension_manifest(self) -> dict[str, object]:
        return {
            "schema_version": 1,
            "agent": {"name": "mycli"},
            "rpc_methods": [{"name": "extension.manifest"}],
            "event_streams": [],
            "capabilities": [],
        }

    def queue_steering_message(self, message: str) -> tuple[tuple[str, ...], tuple[str, ...]]:
        del message
        return (), ()

    def queue_follow_up_message(self, message: str) -> tuple[tuple[str, ...], tuple[str, ...]]:
        del message
        return (), ()

    def queued_messages(self) -> tuple[tuple[str, ...], tuple[str, ...]]:
        return (), ()

    def clear_queued_messages(self) -> tuple[tuple[str, ...], tuple[str, ...]]:
        return (), ()


def test_gateway_bootstrap_returns_structured_runtime_state(tmp_path: Path) -> None:
    gateway = NodeTuiGateway(service=FakeService(tmp_path))

    response = gateway.handle_request(
        RpcRequest(
            id="req_1",
            method="session.bootstrap",
            params={"protocol_version": 1, "client": {"name": "test", "version": "0"}},
        )
    )

    assert response.result is not None
    assert response.result["protocol_version"] == 1
    assert response.result["session_id"] == "demo"
    assert response.result["workspace"] == str(tmp_path)
    assert response.result["provider"] == "deepseek/chat_completions"
    assert response.result["status"]["turn_running"] is False
    assert response.result["status"]["queued_steering"] == []
    assert response.result["status"]["queued_follow_up"] == []
    assert response.result["status"]["trust"] == {
        "state": "unknown",
        "workspace": str(tmp_path),
        "source": "fallback",
        "enforced": False,
    }
    assert {
        "id": "deepseek",
        "name": "DeepSeek",
        "configured": False,
        "default_model": "deepseek-chat",
    } in response.result["auth_providers"]
    assert response.error is None


def test_gateway_emits_shell_lifecycle_notification(tmp_path: Path) -> None:
    service = FakeService(tmp_path)
    emitted: list[tuple[str, dict[str, object]]] = []
    gateway = NodeTuiGateway(
        service=service,
        emit=lambda method, params: emitted.append((method, params)),
    )

    service.emit_shell_event(
        ShellLifecycleEvent(
            kind="shell.started",
            shell_id="shell-1",
            owner_session_id=service._config.session_id,
            call_id="call-1",
            sequence=1,
            command_preview="uv run dev",
            background=True,
            process_state="running_background",
        )
    )

    method, payload = next(item for item in emitted if item[0] == "shell.started")
    assert method == "shell.started"
    assert payload["shell_id"] == "shell-1"
    assert payload["call_id"] == "call-1"
    assert payload["sequence"] == 1
    gateway.close()


def test_gateway_bootstrap_and_status_include_active_background_shells(
    tmp_path: Path,
) -> None:
    service = FakeService(tmp_path)
    row = {
        "shell_id": "shell-1",
        "background": True,
        "status": "running",
        "process_state": "running_background",
        "command_preview": "uv run dev",
    }
    service.active_shell_rows = (row,)
    gateway = NodeTuiGateway(service=service)

    bootstrap = gateway._handle_bootstrap({"protocol_version": 1})
    status = gateway._status_payload()

    assert bootstrap["background_shells"] == [row]
    assert status["background_shells"] == [row]
    gateway.close()


def test_gateway_rebinds_shell_listener_after_session_resume(tmp_path: Path) -> None:
    service = FakeService(tmp_path)
    gateway = NodeTuiGateway(service=service)
    previous_listener = service.shell_listener

    result = gateway._handle_session_resume({"session_id": "resumed"})

    assert result["session_id"] == "resumed"
    assert service.shell_unsubscribe_count == 1
    assert service.shell_listener is not None
    assert service.shell_listener is not previous_listener
    gateway.close()


class ConcurrentWriteProcess:
    def __init__(self) -> None:
        self.lines: list[str] = []
        self.entered = 0
        self.max_entered = 0
        self.lock = Lock()

    def write_line(self, line: str) -> None:
        with self.lock:
            self.entered += 1
            self.max_entered = max(self.max_entered, self.entered)
        time.sleep(0.02)
        self.lines.append(line)
        with self.lock:
            self.entered -= 1


def test_serialized_gateway_writer_prevents_concurrent_process_writes() -> None:
    process = ConcurrentWriteProcess()
    writer = _SerializedGatewayWriter(process)
    threads = [
        Thread(
            target=writer.write,
            args=(notification("shell.output", {"sequence": index}),),
        )
        for index in range(2)
    ]

    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert process.max_entered == 1
    assert len(process.lines) == 2
    assert all(isinstance(decode_message(line), RpcNotification) for line in process.lines)


def test_gateway_auth_api_key_save_persists_credentials(tmp_path: Path) -> None:
    gateway = NodeTuiGateway(service=FakeService(tmp_path))

    response = gateway.handle_request(
        RpcRequest(
            id="req_1",
            method="auth.api_key.save",
            params={"provider_id": "deepseek", "api_key": "sk-test"},
        )
    )

    assert response.error is None
    assert response.result == {"ok": True, "provider_id": "deepseek", "message": "Saved API key for DeepSeek."}
    assert AuthStore.from_home(tmp_path).get_api_key("deepseek") == "sk-test"


def test_gateway_bootstrap_and_status_include_optional_session_title(tmp_path: Path) -> None:
    service = FakeService(tmp_path)
    service._config.session_title = "Boss reply follow-up"
    gateway = NodeTuiGateway(service=service)

    response = gateway.handle_request(
        RpcRequest(id="req_1", method="session.bootstrap", params={"protocol_version": 1})
    )
    status = gateway.handle_request(RpcRequest(id="req_2", method="status.inspect", params={}))

    assert response.error is None
    assert response.result["session_title"] == "Boss reply follow-up"
    assert response.result["welcome"]["session_title"] == "Boss reply follow-up"
    assert response.result["status"]["session_title"] == "Boss reply follow-up"
    assert status.result["session_title"] == "Boss reply follow-up"


def test_gateway_forwards_compaction_lifecycle_events(tmp_path: Path) -> None:
    events: list[tuple[str, dict[str, object]]] = []
    gateway = NodeTuiGateway(
        service=FakeService(tmp_path),
        emit=lambda method, params: events.append((method, params)),
    )

    gateway._forward_stream_event(
        "client_1",
        RuntimeStreamEvent(
            kind="compaction_started",
            metadata={
                "source": "pre_request",
                "before_tokens": 120000,
                "max_tokens": 128000,
            },
        ),
    )
    gateway._forward_stream_event(
        "client_1",
        RuntimeStreamEvent(
            kind="compaction_completed",
            metadata={
                "source": "pre_request",
                "status": "compressed",
                "before_tokens": 120000,
                "after_tokens": 42000,
                "max_tokens": 128000,
                "duration_s": 2.5,
            },
        ),
    )

    assert events[0] == (
        "compaction.started",
        {
            "client_turn_id": "client_1",
            "source": "pre_request",
            "before_tokens": 120000,
            "max_tokens": 128000,
        },
    )
    assert events[1] == (
        "runtime.event",
        {
            "version": 1,
            "sequence": 1,
            "type": "compaction.started",
            "payload": events[0][1],
            "timestamp": events[1][1]["timestamp"],
        },
    )
    assert events[2][0] == "compaction.completed"
    assert events[2][1]["client_turn_id"] == "client_1"
    assert events[2][1]["status"] == "compressed"
    assert events[2][1]["after_tokens"] == 42000
    assert events[3][0] == "runtime.event"
    assert events[3][1]["type"] == "compaction.completed"


def test_gateway_workspace_trust_status_returns_safe_fallback(tmp_path: Path) -> None:
    gateway = NodeTuiGateway(service=FakeService(tmp_path))

    response = gateway.handle_request(
        RpcRequest(id="req_1", method="workspace.trust.status", params={})
    )

    assert response.result == {
        "state": "unknown",
        "workspace": str(tmp_path),
        "source": "fallback",
        "enforced": False,
    }


def test_gateway_workspace_trust_set_fallback_does_not_claim_enforcement(tmp_path: Path) -> None:
    events: list[tuple[str, dict[str, object]]] = []
    gateway = NodeTuiGateway(service=FakeService(tmp_path), emit=lambda method, params: events.append((method, params)))

    response = gateway.handle_request(
        RpcRequest(id="req_1", method="workspace.trust.set", params={"state": "untrusted"})
    )

    assert response.result is not None
    assert response.result["state"] == "untrusted"
    assert response.result["requested_state"] == "untrusted"
    assert response.result["enforced"] is False
    assert "not available yet" in str(response.result["message"])
    assert any(method == "workspace.trust.changed" for method, _params in events)

    status_response = gateway.handle_request(
        RpcRequest(id="req_2", method="workspace.trust.status", params={})
    )
    assert status_response.result is not None
    assert status_response.result["state"] == "untrusted"
    assert status_response.result["enforced"] is False


def test_gateway_bootstrap_includes_welcome_payload(tmp_path: Path) -> None:
    gateway = NodeTuiGateway(service=FakeService(tmp_path))

    response = gateway.handle_request(
        RpcRequest(
            id="req_1",
            method="session.bootstrap",
            params={"protocol_version": 1, "client": {"name": "test", "version": "0"}},
        )
    )

    assert response.result is not None
    welcome = response.result["welcome"]
    assert welcome["session_id"] == "demo"
    assert welcome["workspace"] == str(tmp_path)
    assert welcome["model"] == "deepseek-v4-flash"
    assert welcome["provider"] == "deepseek/chat_completions"
    assert welcome["context_window"] == {
        "used_tokens": 123,
        "max_tokens": 100000,
        "source": "provider",
    }
    assert welcome["startup_mark"]["name"] == "default"
    assert "mycli" in welcome["startup_mark"]["text"].lower()
    assert "/help" in welcome["tips"]


def test_gateway_rejects_incompatible_protocol_version(tmp_path: Path) -> None:
    events: list[tuple[str, dict[str, object]]] = []
    gateway = NodeTuiGateway(
        service=FakeService(tmp_path),
        emit=lambda method, params: events.append((method, params)),
    )

    response = gateway.handle_request(
        RpcRequest(id="req_1", method="session.bootstrap", params={"protocol_version": 999})
    )

    assert response.error == {
        "code": "incompatible_protocol",
        "message": "Unsupported Node TUI protocol version: 999",
    }
    assert {
        "code": "incompatible_protocol",
        "message": "Unsupported Node TUI protocol version: 999",
        "method": "session.bootstrap",
    } in _gateway_error_events(events)


def test_gateway_command_run_delegates_existing_commands(tmp_path: Path) -> None:
    gateway = NodeTuiGateway(service=FakeService(tmp_path))

    response = gateway.handle_request(
        RpcRequest(id="req_1", method="command.run", params={"command": "/usage"})
    )
    help_response = gateway.handle_request(
        RpcRequest(id="req_2", method="command.run", params={"command": "/help"})
    )

    assert response.result is not None
    assert response.result["lines"] == ["[usage] session=demo", "[usage] turns=1"]
    assert response.result["mutated_session"] is False
    assert help_response.result is not None
    assert any("/status" in line for line in help_response.result["lines"])


def test_gateway_command_run_returns_structured_background_shells_and_stop(
    tmp_path: Path,
) -> None:
    service = FakeService(tmp_path)
    service.active_shell_rows = (
        {
            "shell_id": "shell-1",
            "background": True,
            "status": "running",
            "process_state": "running_background",
            "command_preview": "uv run dev",
            "output": "ready\n",
        },
    )
    gateway = NodeTuiGateway(service=service)

    processes = gateway.handle_request(
        RpcRequest(id="req-ps", method="command.run", params={"command": "/ps"})
    )
    stopped = gateway.handle_request(
        RpcRequest(id="req-stop", method="command.run", params={"command": "/stop"})
    )

    assert processes.result is not None
    assert processes.result["command_kind"] == "background_shells"
    assert processes.result["processes"][0]["shell_id"] == "shell-1"
    assert processes.result["processes"][0]["command_preview"] == "uv run dev"
    assert processes.result["processes"][0]["output"] == "ready\n"
    assert stopped.result is not None
    assert stopped.result["command_kind"] == "shell_stop"
    assert stopped.result["lines"] == ["Stopping all background terminals."]
    gateway.close()


def test_gateway_command_run_can_cancel_background_subagents(tmp_path: Path) -> None:
    gateway = NodeTuiGateway(service=FakeService(tmp_path))

    response = gateway.handle_request(
        RpcRequest(
            id="req_1",
            method="command.run",
            params={"command": "/tasks kill-agents"},
        )
    )

    assert response.result is not None
    assert response.result["lines"] == [
        "[subagent] cancelled subagent:demo:sub:turn_1:abcd owner_turn=turn_1"
    ]


def test_gateway_command_run_can_cancel_one_background_subagent(tmp_path: Path) -> None:
    gateway = NodeTuiGateway(service=FakeService(tmp_path))

    response = gateway.handle_request(
        RpcRequest(
            id="req_1",
            method="command.run",
            params={"command": "/tasks agents kill demo:sub:turn_1:abcd"},
        )
    )

    assert response.result is not None
    assert response.result["lines"] == [
        "[subagent] cancelled subagent:demo:sub:turn_1:abcd owner_turn=turn_1"
    ]


def test_gateway_command_run_session_displays_title_not_raw_session_id(tmp_path: Path) -> None:
    service = FakeService(tmp_path)
    service._config.session_title = "Boss reply follow-up"
    gateway = NodeTuiGateway(service=service)

    response = gateway.handle_request(
        RpcRequest(id="req_1", method="command.run", params={"command": "/session"})
    )

    assert response.result is not None
    assert response.result["lines"][:2] == [
        "[session] session=Boss reply follow-up",
        "[session] messages=3",
    ]


def test_gateway_command_run_returns_presentation_and_view_mode(tmp_path: Path) -> None:
    gateway = NodeTuiGateway(service=FakeService(tmp_path))

    usage = gateway.handle_request(
        RpcRequest(id="req_1", method="command.run", params={"command": "/usage"})
    )
    view = gateway.handle_request(
        RpcRequest(id="req_2", method="command.run", params={"command": "/view verbose"})
    )
    quit_response = gateway.handle_request(
        RpcRequest(id="req_3", method="command.run", params={"command": "/quit"})
    )
    changes = gateway.handle_request(
        RpcRequest(id="req_4", method="command.run", params={"command": "/changes"})
    )
    permissions = gateway.handle_request(
        RpcRequest(id="req_5", method="command.run", params={"command": "/permissions"})
    )

    assert usage.result is not None
    assert usage.result["presentation"] == "overlay"
    assert usage.result["exit_requested"] is False
    assert view.result is not None
    assert view.result["view_mode"] == "verbose"
    assert view.result["presentation"] == "transcript"
    assert quit_response.result is not None
    assert quit_response.result["exit_requested"] is True
    assert changes.result is not None
    assert changes.result["presentation"] == "overlay"
    assert changes.result["presentation_hint"] == "file changes"
    assert permissions.result is not None
    assert permissions.result["presentation"] == "overlay"
    assert permissions.result["lines"] == [
        "[permission] session_allowances=1",
        "[permission] allow_session pattern=git push",
        "[permission] execpolicy_rules=1",
        "[permission] execpolicy source=project decision=allow pattern_length=2",
    ]


def test_gateway_settings_load_and_save_persist_shell_settings(tmp_path: Path) -> None:
    home = tmp_path / "home"
    home.mkdir()
    service = FakeService(tmp_path)
    service._home_dir = home
    gateway = NodeTuiGateway(service=service)

    load_response = gateway.handle_request(RpcRequest(id="req_1", method="settings.load", params={}))
    save_response = gateway.handle_request(
        RpcRequest(
            id="req_2",
            method="settings.save",
            params={
                "settings": {
                    "statusbarMode": "compact",
                    "viewMode": "focus",
                    "theme": "light",
                    "hideThinking": False,
                    "toolDetailsDefault": "expanded",
                    "hardwareCursor": True,
                    "clearOnShrink": False,
                    "terminalProgress": False,
                    "subagentDensity": "detailed",
                }
            },
        )
    )

    assert load_response.result is not None
    assert load_response.result["settings"]["statusbar_mode"] == "full"
    assert save_response.result is not None
    assert save_response.result["settings"] == {
        "statusbar_mode": "compact",
        "view_mode": "focus",
        "theme": "light",
        "hide_thinking": False,
        "tool_details_default": "expanded",
        "hardware_cursor": True,
        "clear_on_shrink": False,
        "terminal_progress": False,
        "subagent_density": "detailed",
    }
    assert (home / ".mycli" / "config.toml").read_text(encoding="utf-8") == "\n".join(
        [
            "[tui]",
            'view_mode = "focus"',
            "statusline_enabled = true",
            'statusbar_mode = "compact"',
            'theme = "light"',
            "hide_thinking = false",
            "clear_on_shrink = false",
            "hardware_cursor = true",
            'subagent_density = "detailed"',
            "terminal_progress = false",
            'tool_details_default = "expanded"',
            "",
        ]
    )
    assert service._config.view_mode.value == "focus"


def test_gateway_settings_save_rejects_invalid_values(tmp_path: Path) -> None:
    service = FakeService(tmp_path)
    service._home_dir = tmp_path / "home"
    gateway = NodeTuiGateway(service=service)

    response = gateway.handle_request(
        RpcRequest(
            id="req_1",
            method="settings.save",
            params={"settings": {"statusbarMode": "cinema"}},
        )
    )

    assert response.error is not None
    assert response.error["code"] == "invalid_params"
    assert "Unsupported statusbar_mode" in response.error["message"]


def test_gateway_resource_list_projects_runtime_resources(tmp_path: Path) -> None:
    gateway = NodeTuiGateway(service=FakeService(tmp_path))

    response = gateway.handle_request(RpcRequest(id="req_1", method="resource.list", params={}))

    assert response.result is not None
    resources = response.result["resources"]
    assert isinstance(resources, list)
    assert {resource["type"] for resource in resources} >= {"hook", "plugin", "skill", "prompt", "theme"}
    assert any(
        resource["type"] == "hook"
        and resource["name"] == "configured:repo:post-tool"
        and resource["command"] == "/tools hooks"
        and resource["enabled"] is True
        for resource in resources
    )
    assert any(
        resource["type"] == "plugin"
        and resource["name"] == "demo.inspect"
        and resource["command"] == "/tools plugins"
        for resource in resources
    )


def test_gateway_command_run_updates_model_and_thinking_effort(tmp_path: Path) -> None:
    events: list[tuple[str, dict[str, object]]] = []
    service = FakeService(tmp_path)
    gateway = NodeTuiGateway(service=service, emit=lambda method, params: events.append((method, params)))

    response = gateway.handle_request(
        RpcRequest(
            id="req_1",
            method="command.run",
            params={"command": "/model gpt-5.4 --thinking-effort high"},
        )
    )

    assert response.result is not None
    assert response.result["lines"] == [
        "[model] model=gpt-5.4",
        "[model] thinking_effort=high",
    ]
    assert service._config.model == "gpt-5.4"
    assert service._config.reasoning_effort == ReasoningEffort.HIGH
    assert service._config.thinking_effort == ReasoningEffort.HIGH
    status_events = [params for method, params in events if method == "status.changed"]
    assert status_events
    assert status_events[-1]["model"] == "gpt-5.4"
    assert status_events[-1]["thinking_effort"] == "high"


def test_gateway_command_run_updates_collaboration_mode(tmp_path: Path) -> None:
    events: list[tuple[str, dict[str, object]]] = []
    service = FakeService(tmp_path)
    gateway = NodeTuiGateway(service=service, emit=lambda method, params: events.append((method, params)))

    response = gateway.handle_request(
        RpcRequest(
            id="req_1",
            method="command.run",
            params={"command": "/mode plan"},
        )
    )

    assert response.result is not None
    assert response.result["lines"] == ["[mode] collaboration_mode=plan"]
    assert response.result["mutated_mode"] is True
    assert response.result["collaboration_mode"] == "plan"
    assert service._config.collaboration_mode == CollaborationMode.PLAN
    status_events = [params for method, params in events if method == "status.changed"]
    assert status_events
    assert status_events[-1]["collaboration_mode"] == "plan"


def test_gateway_transcript_load_projects_history_items(tmp_path: Path) -> None:
    service = FakeService(tmp_path)
    service.fake_session_service.history_items = (
        HistoryItem(
            id="hist_user",
            thread_id="demo",
            turn_id="turn_1",
            type=HistoryItemType.USER_MESSAGE,
            text="Read pyproject.toml",
            metadata={"created_at": "2026-05-27T08:00:00Z"},
        ),
        HistoryItem(
            id="hist_assistant",
            thread_id="demo",
            turn_id="turn_1",
            type=HistoryItemType.ASSISTANT_MESSAGE,
            text="The project is mycli.",
            metadata={"created_at": "2026-05-27T08:00:01Z"},
        ),
        HistoryItem(
            id="hist_tool",
            thread_id="demo",
            turn_id="turn_1",
            type=HistoryItemType.TOOL_CALL,
            text="/Users/cosmos/.mycli/sessions/demo/session.json",
            tool_name="Read",
            call_id="call_read_1",
            metadata={"created_at": "2026-05-27T08:00:02Z"},
        ),
    )
    gateway = NodeTuiGateway(service=service)

    response = gateway.handle_request(
        RpcRequest(
            id="req_1",
            method="transcript.load",
            params={"session_id": "demo", "before": None},
        )
    )

    assert response.result == {
        "session_id": "demo",
        "items": [
            {
                "id": "hist_user",
                "type": "user",
                "text": "Read pyproject.toml",
                "created_at": "2026-05-27T08:00:00Z",
                "folded": False,
                "metadata": {},
            },
            {
                "id": "hist_assistant",
                "type": "assistant_final",
                "text": "The project is mycli.",
                "created_at": "2026-05-27T08:00:01Z",
                "folded": False,
                "metadata": {},
            },
            {
                "id": "hist_tool",
                "type": "tool_summary",
                "text": "/Users/cosmos/.mycli/sessions/demo/session.json",
                "created_at": "2026-05-27T08:00:02Z",
                "folded": False,
                "metadata": {"tool_name": "Read", "call_id": "call_read_1"},
            },
        ],
        "next_before": None,
    }


def test_gateway_transcript_load_limit_returns_tail_with_cursor(tmp_path: Path) -> None:
    service = FakeService(tmp_path)
    service.fake_session_service.history_items = tuple(
        HistoryItem(
            id=f"hist_{index}",
            thread_id="demo",
            turn_id=f"turn_{index}",
            type=HistoryItemType.USER_MESSAGE,
            text=f"message {index}",
            metadata={"created_at": f"2026-05-27T08:00:0{index}Z"},
        )
        for index in range(3)
    )
    gateway = NodeTuiGateway(service=service)

    response = gateway.handle_request(
        RpcRequest(
            id="req_1",
            method="transcript.load",
            params={"session_id": "demo", "limit": 2, "before": None},
        )
    )

    assert response.result is not None
    assert [item["id"] for item in response.result["items"]] == ["hist_1", "hist_2"]
    assert response.result["next_before"] == "hist_1"


def test_gateway_slash_completion_filters_candidates(tmp_path: Path) -> None:
    gateway = NodeTuiGateway(service=FakeService(tmp_path))

    response = gateway.handle_request(
        RpcRequest(id="req_1", method="completion.slash", params={"prefix": "/sta"})
    )

    assert response.result is not None
    values = [item["value"] for item in response.result["items"]]
    assert "/status" in values
    assert "/status stats" in values

    maintenance_response = gateway.handle_request(
        RpcRequest(id="req_2", method="completion.slash", params={"prefix": "/session m"})
    )

    assert maintenance_response.result is not None
    maintenance_items = maintenance_response.result["items"]
    assert maintenance_items == [
        {
            "value": "/session maintenance",
            "description": "Show session storage maintenance dry-run",
        },
        {
            "value": "/session maintenance --apply-empty",
            "description": "Delete empty session maintenance candidates",
        },
        {
            "value": "/session maintenance --apply-orphans",
            "description": "Delete orphan session child rows",
        },
        {
            "value": "/session maintenance --apply-vacuum",
            "description": "Run explicit SQLite vacuum for session storage",
        },
    ]


def test_gateway_path_completion_stays_inside_workspace(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    (workspace / "src").mkdir()
    (workspace / "src" / "main.py").write_text("print('ok')", encoding="utf-8")
    gateway = NodeTuiGateway(service=FakeService(workspace))

    inside = gateway.handle_request(
        RpcRequest(id="req_1", method="completion.path", params={"prefix": "@src/ma"})
    )
    outside = gateway.handle_request(
        RpcRequest(id="req_2", method="completion.path", params={"prefix": "@../"})
    )

    assert inside.result == {"items": [{"value": "@src/main.py", "kind": "file"}]}
    assert outside.result == {"items": []}


def test_gateway_session_list_and_resume(tmp_path: Path) -> None:
    gateway = NodeTuiGateway(service=FakeService(tmp_path))

    listed = gateway.handle_request(RpcRequest(id="req_1", method="session.list", params={}))
    resumed = gateway.handle_request(
        RpcRequest(id="req_2", method="session.resume", params={"session_id": "demo"})
    )

    assert listed.result == {
        "sessions": [
            {
                "id": "demo",
                "created": "2026-05-26T01:33:04Z",
                "updated": "2026-05-27T01:33:04Z",
                "last_active": "2026-05-27T01:33:04Z",
                "modified": "2026-05-27T01:33:04Z",
                "message_count": 4,
                "cwd": "/workspace",
                "workspace": "/workspace",
                "current": True,
            }
        ]
    }
    assert resumed.result == {
        "session_id": "demo",
        "lines": ["[session] resumed demo", "[session] messages=4"],
    }


def test_gateway_session_tree_projects_branch_and_message_nodes(tmp_path: Path) -> None:
    service = FakeService(tmp_path)
    service.fake_session_service.include_child_session = True
    gateway = NodeTuiGateway(service=service)

    response = gateway.handle_request(RpcRequest(id="req_1", method="session.tree", params={}))

    assert response.result is not None
    assert response.result["session_id"] == "demo"
    assert response.result["active_path"] == ["demo"]
    node_by_id = {node["id"]: node for node in response.result["nodes"]}
    assert node_by_id["session:demo"] == {
        "id": "session:demo",
        "kind": "session",
        "session_id": "demo",
        "parent_id": None,
        "depth": 0,
        "role": "session",
        "summary": "demo",
        "timestamp": "2026-05-27T01:33:04Z",
        "label": "",
        "message_index": None,
        "tool_name": "",
        "active": True,
        "on_active_path": True,
        "message_count": 4,
        "preview": "Read pyproject.toml\nThe project is mycli.\ntool output",
    }
    assert node_by_id["session:child"]["parent_id"] == "session:demo"
    assert node_by_id["session:child"]["depth"] == 1
    assert node_by_id["session:child"]["on_active_path"] is False
    assert node_by_id["session:demo:message:0"] == {
        "id": "session:demo:message:0",
        "kind": "message",
        "session_id": "demo",
        "parent_id": "session:demo",
        "depth": 1,
        "role": "user",
        "summary": "Read pyproject.toml",
        "timestamp": "",
        "label": "",
        "message_index": 0,
        "anchor_id": "",
        "tool_name": "",
        "active": False,
        "on_active_path": True,
        "message_count": None,
        "preview": "Read pyproject.toml",
    }


def test_gateway_session_resume_emits_status_snapshot_for_active_session(
    tmp_path: Path,
) -> None:
    events: list[tuple[str, dict[str, object]]] = []
    gateway = NodeTuiGateway(
        service=FakeService(tmp_path),
        emit=lambda method, params: events.append((method, params)),
    )

    response = gateway.handle_request(
        RpcRequest(id="req_1", method="session.resume", params={"session_id": "demo"})
    )

    assert response.error is None
    assert events[0] == ("session.changed", {"session_id": "demo"})
    assert events[1][0] == "status.changed"
    assert events[1][1]["session_id"] == "demo"
    assert events[1][1]["pending_decision"] is False
    assert events[1][1]["suspended_turn"] is False


def test_gateway_session_resume_reemits_pending_approval_payload(tmp_path: Path) -> None:
    events: list[tuple[str, dict[str, object]]] = []
    service = FakeService(tmp_path)
    service.fake_session_service.pending_decision = PendingDecision(
        tool_call=ToolCall(
            name="Bash",
            arguments={"command": "git push"},
            reason="push",
            call_id="call_resume_approval_1",
        ),
        kind=DecisionKind.NEEDS_CHOICE,
        reason="git push requires confirmation.",
        preview="git push",
        options=(DecisionAction.APPROVE_ONCE, DecisionAction.REJECT),
    )
    gateway = NodeTuiGateway(
        service=service,
        emit=lambda method, params: events.append((method, params)),
    )

    response = gateway.handle_request(
        RpcRequest(id="req_1", method="session.resume", params={"session_id": "demo"})
    )

    assert response.error is None
    assert [method for method, _params in events if method != "runtime.event"] == [
        "session.changed",
        "status.changed",
        "approval.request",
    ]
    approval = next(params for method, params in events if method == "approval.request")
    assert approval["decision_id"] == "call_resume_approval_1"
    assert approval["client_turn_id"] == "demo"


def test_gateway_forwards_subagent_progress_updates(tmp_path: Path) -> None:
    events: list[tuple[str, dict[str, object]]] = []
    gateway = NodeTuiGateway(
        service=FakeService(tmp_path),
        emit=lambda method, params: events.append((method, params)),
    )

    gateway._forward_stream_event(
        "client_1",
        RuntimeStreamEvent(
            kind="subagent_update",
            metadata={
                "subagent": {
                    "run_id": "subagent-a1",
                    "child_session_id": "child-session-1",
                    "role": "explore",
                    "status": "running",
                    "progress": [{"kind": "tool_call", "summary": "Read path=src/app.py"}],
                }
            },
        ),
    )

    params = next(params for method, params in events if method == "subagent.updated")
    assert params["client_turn_id"] == "client_1"
    assert params["subagent"]["progress"][0]["summary"] == "Read path=src/app.py"


def test_gateway_session_resume_reemits_pending_clarification_payload(tmp_path: Path) -> None:
    events: list[tuple[str, dict[str, object]]] = []
    service = FakeService(tmp_path)
    service.fake_session_service.suspended_turn = SuspendedTurn(
        user_message="choose next slice",
        conversation=(),
        pending_clarification=PendingClarification(
            request_id="call_resume_question_1",
            tool_call=ToolCall(
                name="AskUserQuestion",
                arguments={
                    "question": "Which slice should come next?",
                    "options": [{"label": "Runtime"}, {"label": "TUI"}],
                },
                reason="clarify scope",
                call_id="call_resume_question_1",
            ),
            question="Which slice should come next?",
            options=({"label": "Runtime"}, {"label": "TUI"}),
            header="Scope",
            multi_select=False,
        ),
        suspend_reason=StopReason.CLARIFICATION_REQUIRED,
    )
    gateway = NodeTuiGateway(
        service=service,
        emit=lambda method, params: events.append((method, params)),
    )

    response = gateway.handle_request(
        RpcRequest(id="req_1", method="session.resume", params={"session_id": "demo"})
    )

    assert response.error is None
    assert [method for method, _params in events if method != "runtime.event"] == [
        "session.changed",
        "status.changed",
        "clarify.request",
    ]
    clarify = next(params for method, params in events if method == "clarify.request")
    assert clarify["request_id"] == "call_resume_question_1"
    assert clarify["client_turn_id"] == "demo"
    assert clarify["question"] == "Which slice should come next?"


def test_gateway_trace_export_returns_unprefixed_jsonl_rows(tmp_path: Path) -> None:
    gateway = NodeTuiGateway(service=FakeService(tmp_path))

    response = gateway.handle_request(
        RpcRequest(id="req_1", method="trace.export", params={"tail": 2})
    )

    assert response.result == {
        "session_id": "demo",
        "format": "jsonl",
        "rows": [
            '{"kind":"tool_execution","turn_id":"turn_0","payload":{}}',
            '{"kind":"tool_execution","turn_id":"turn_1","payload":{}}',
        ],
    }


def test_gateway_trace_export_uses_default_tail_for_invalid_values(tmp_path: Path) -> None:
    gateway = NodeTuiGateway(service=FakeService(tmp_path))

    response = gateway.handle_request(
        RpcRequest(id="req_1", method="trace.export", params={"tail": 0})
    )

    assert response.result is not None
    assert len(response.result["rows"]) == 50


def test_gateway_extension_manifest_returns_service_manifest(tmp_path: Path) -> None:
    gateway = NodeTuiGateway(service=FakeService(tmp_path))

    response = gateway.handle_request(
        RpcRequest(id="req_1", method="extension.manifest", params={})
    )

    assert response.result == {
        "schema_version": 1,
        "agent": {"name": "mycli"},
        "rpc_methods": [{"name": "extension.manifest"}],
        "event_streams": [],
        "capabilities": [],
    }


def test_gateway_extension_manifest_can_include_runtime_contributed_tools(tmp_path: Path) -> None:
    from mycli.domain.tooling.contributed_tools import (
        ToolContributionDescriptor,
        ToolContributionLifecycleState,
        ToolContributionRegistration,
        ToolContributionScope,
        ToolContributionSource,
    )
    from mycli.domain.tool_exposure import ToolRouteKey
    from mycli.services.extensions import ExtensionManifestService
    from mycli.tools.base import ToolResult, ToolSpec

    class FakeTool:
        spec = ToolSpec(name="skill_review", description="Load review skill")

        def execute(self, arguments: dict[str, object]) -> ToolResult:
            del arguments
            return ToolResult(success=True, summary="ok")

    class RuntimeManifestService(FakeService):
        def extension_manifest(self) -> dict[str, object]:
            tool = FakeTool()
            registration = ToolContributionRegistration(
                descriptor=ToolContributionDescriptor(
                    tool_id="skill:review",
                    display_name="skill_review",
                    description=tool.spec.description,
                    route_key=ToolRouteKey.local("skill_review"),
                    source=ToolContributionSource.PROVIDER,
                    scope=ToolContributionScope.THREAD,
                    lifecycle_state=ToolContributionLifecycleState.EXPOSED,
                    spec=tool.spec,
                    origin_metadata={"skill": "review", "legacy_route_name": "skill.review"},
                ),
                tool=tool,
            )
            return ExtensionManifestService(contributed_tools=(registration,)).manifest()

    gateway = NodeTuiGateway(service=RuntimeManifestService(tmp_path))

    response = gateway.handle_request(
        RpcRequest(id="req_1", method="extension.manifest", params={})
    )

    assert response.result is not None
    tools = {tool["name"]: tool for tool in response.result["tool_manifest"]["tools"]}
    assert tools["skill_review"]["source"] == "skill"
    assert tools["skill_review"]["toolset"] == "external"


def test_extension_manifest_advertises_only_supported_gateway_methods() -> None:
    from mycli.services.extensions import ExtensionManifestService

    manifest = ExtensionManifestService().manifest()
    advertised_methods = {method["name"] for method in manifest["rpc_methods"]}

    assert advertised_methods <= supported_rpc_methods()


def test_extension_manifest_advertises_only_supported_event_streams() -> None:
    from mycli.services.extensions import ExtensionManifestService

    manifest = ExtensionManifestService().manifest()
    advertised_streams = {event["name"] for event in manifest["event_streams"]}

    assert advertised_streams <= supported_event_streams()


def test_gateway_unknown_method_returns_json_rpc_error(tmp_path: Path) -> None:
    events: list[tuple[str, dict[str, object]]] = []
    gateway = NodeTuiGateway(
        service=FakeService(tmp_path),
        emit=lambda method, params: events.append((method, params)),
    )

    response = gateway.handle_request(RpcRequest(id="req_1", method="missing.method", params={}))

    assert response.error == {
        "code": "method_not_found",
        "message": "Unknown method: missing.method",
    }
    assert {
        "code": "method_not_found",
        "message": "Unknown method: missing.method",
        "method": "missing.method",
    } in _gateway_error_events(events)


class ExplodingStatusService(FakeService):
    def current_context_window_metrics(self) -> dict[str, object]:
        raise RuntimeError("status exploded")


def test_gateway_unexpected_request_error_returns_json_rpc_error_and_event(
    tmp_path: Path,
) -> None:
    events: list[tuple[str, dict[str, object]]] = []
    gateway = NodeTuiGateway(
        service=ExplodingStatusService(tmp_path),
        emit=lambda method, params: events.append((method, params)),
    )

    response = gateway.handle_request(RpcRequest(id="req_1", method="status.inspect", params={}))

    assert response.error == {
        "code": "internal_error",
        "message": "Internal gateway error.",
    }
    assert (
        "gateway.error",
        {
            "code": "internal_error",
            "message": "Internal gateway error.",
            "detail": "status exploded",
            "method": "status.inspect",
        },
    ) in events
    assert {
        "type": "gateway.error",
        "payload": {
            "code": "internal_error",
            "message": "Internal gateway error.",
            "detail": "status exploded",
            "method": "status.inspect",
        },
    }.items() <= next(
        params
        for method, params in events
        if method == "runtime.event" and params["type"] == "gateway.error"
    ).items()


class FakeTurnService(FakeService):
    def __init__(self, workspace_root: Path) -> None:
        super().__init__(workspace_root)
        self.turn_calls: list[str] = []
        self.resolved_choices: list[str] = []
        self.clarification_responses: list[tuple[str, str]] = []
        self.interrupt_requests: list[str | None] = []
        self.steering_messages: list[str] = []
        self.follow_up_messages: list[str] = []
        self.steering_image_paths: list[tuple[str, ...]] = []
        self.follow_up_image_paths: list[tuple[str, ...]] = []

    def handle_user_turn(
        self,
        message: str,
        stream_sink: StreamSink | None = None,
    ) -> TurnResponse:
        self.turn_calls.append(message)
        if stream_sink is not None:
            stream_sink(RuntimeStreamEvent(kind="reasoning", text="thinking"))
            stream_sink(RuntimeStreamEvent(kind="tool_call", tool_name="Read"))
            stream_sink(RuntimeStreamEvent(kind="text_delta", text="hello"))
            stream_sink(RuntimeStreamEvent(kind="completed", metadata={"response_status": "completed"}))
        return TurnResponse(
            assistant_message="hello world",
            streamed_chunks=("hello", " world"),
            progress_updates=("[progress] done",),
            plan_steps=("completed: smoke",),
        )

    def resolve_pending_decision(
        self,
        choice: str,
        stream_sink: StreamSink | None = None,
    ) -> TurnResponse:
        self.resolved_choices.append(choice)
        self.fake_session_service.pending_decision = None
        if stream_sink is not None:
            stream_sink(RuntimeStreamEvent(kind="text_delta", text=f"resolved-stream-{choice}"))
        if choice == "2":
            return TurnResponse(
                assistant_message="Rejected Bash. Pending decision cleared.",
                turn=TurnRecord(
                    thread_id="demo",
                    turn_id="turn_rejected",
                    status=TurnStatus.REJECTED,
                    started_at="2026-05-31T00:00:00Z",
                    completed_at="2026-05-31T00:00:01Z",
                    stop_reason=StopReason.APPROVAL_REJECTED,
                    user_message="push",
                    items=(),
                ),
            )
        return TurnResponse(assistant_message=f"resolved {choice}")

    def resolve_pending_clarification(self, request_id: str, response: str) -> TurnResponse:
        self.clarification_responses.append((request_id, response))
        return TurnResponse(assistant_message=f"clarified {response}")

    def record_turn_interrupt_request(self, *, client_turn_id: str | None = None) -> None:
        self.interrupt_requests.append(client_turn_id)

    def queue_steering_message(
        self,
        message: str,
        *,
        image_paths: tuple[str, ...] = (),
        client_turn_id: str | None = None,
    ) -> tuple[tuple[str, ...], tuple[str, ...]]:
        del client_turn_id
        self.steering_messages.append(message)
        self.steering_image_paths.append(image_paths)
        return tuple(self.steering_messages), tuple(self.follow_up_messages)

    def queue_follow_up_message(
        self,
        message: str,
        *,
        image_paths: tuple[str, ...] = (),
        client_turn_id: str | None = None,
    ) -> tuple[tuple[str, ...], tuple[str, ...]]:
        del client_turn_id
        self.follow_up_messages.append(message)
        self.follow_up_image_paths.append(image_paths)
        return tuple(self.steering_messages), tuple(self.follow_up_messages)

    def queued_messages(self) -> tuple[tuple[str, ...], tuple[str, ...]]:
        return tuple(self.steering_messages), tuple(self.follow_up_messages)

    def clear_queued_messages(self) -> tuple[tuple[str, ...], tuple[str, ...]]:
        steering = tuple(self.steering_messages)
        follow_up = tuple(self.follow_up_messages)
        self.steering_messages.clear()
        self.follow_up_messages.clear()
        return steering, follow_up


class BlockingTurnService(FakeTurnService):
    def __init__(self, workspace_root: Path) -> None:
        super().__init__(workspace_root)
        self.started = Event()
        self.first_streamed = Event()
        self.release = Event()

    def handle_user_turn(
        self,
        message: str,
        stream_sink: StreamSink | None = None,
    ) -> TurnResponse:
        del message, stream_sink
        self.started.set()
        if not self.release.wait(timeout=2.0):
            raise AssertionError("blocking fake turn was not released")
        return TurnResponse(assistant_message="")


class BlockingLateCompletionTurnService(BlockingTurnService):
    def handle_user_turn(
        self,
        message: str,
        stream_sink: StreamSink | None = None,
    ) -> TurnResponse:
        del message
        self.started.set()
        if stream_sink is not None:
            stream_sink(RuntimeStreamEvent(kind="text_delta", text="late draft"))
        self.first_streamed.set()
        if not self.release.wait(timeout=2.0):
            raise AssertionError("blocking fake turn was not released")
        return TurnResponse(assistant_message="late normal answer")


class InterruptibleStreamTurnService(FakeTurnService):
    def __init__(self, workspace_root: Path) -> None:
        super().__init__(workspace_root)
        self.started = Event()
        self.first_streamed = Event()
        self.release = Event()
        self.interrupted = False

    def handle_user_turn(
        self,
        message: str,
        stream_sink: StreamSink | None = None,
    ) -> TurnResponse:
        del message
        self.started.set()
        if stream_sink is not None:
            stream_sink(RuntimeStreamEvent(kind="reasoning", text="first chunk"))
        self.first_streamed.set()
        if not self.release.wait(timeout=2.0):
            raise AssertionError("interruptible fake turn was not released")
        if stream_sink is not None:
            try:
                stream_sink(RuntimeStreamEvent(kind="reasoning", text="after interrupt"))
            except KeyboardInterrupt:
                self.interrupted = True
                return TurnResponse(
                    assistant_message="Interrupt requested",
                    turn=TurnRecord(
                        thread_id="demo",
                        turn_id="turn_interrupted",
                        status=TurnStatus.INTERRUPTED,
                        started_at="2026-05-31T00:00:00Z",
                        completed_at="2026-05-31T00:00:01Z",
                        stop_reason=StopReason.INTERRUPTED,
                        user_message="hello",
                    ),
                )
        return TurnResponse(assistant_message="late normal answer")


class TokenAwareBlockingTurnService(FakeTurnService):
    def __init__(self, workspace_root: Path) -> None:
        super().__init__(workspace_root)
        self.started = Event()
        self.release = Event()
        self.seen_token: RuntimeInterruptToken | None = None

    def handle_user_turn(
        self,
        message: str,
        stream_sink: StreamSink | None = None,
        interrupt_token: RuntimeInterruptToken | None = None,
    ) -> TurnResponse:
        del message, stream_sink
        self.seen_token = interrupt_token
        self.started.set()
        if not self.release.wait(timeout=2.0):
            raise AssertionError("token-aware fake turn was not released")
        if interrupt_token is not None:
            interrupt_token.raise_if_interrupted()
        return TurnResponse(assistant_message="late normal answer")


class BlockingNoInterruptHookService(FakeService):
    def __init__(self, workspace_root: Path) -> None:
        super().__init__(workspace_root)
        self.started = Event()
        self.release = Event()

    def handle_user_turn(
        self,
        message: str,
        stream_sink: StreamSink | None = None,
    ) -> TurnResponse:
        del message, stream_sink
        self.started.set()
        if not self.release.wait(timeout=2.0):
            raise AssertionError("blocking fake turn was not released")
        return TurnResponse(assistant_message="")


class FakeToolLifecycleTurnService(FakeService):
    def handle_user_turn(
        self,
        message: str,
        stream_sink: StreamSink | None = None,
    ) -> TurnResponse:
        del message
        if stream_sink is not None:
            stream_sink(
                RuntimeStreamEvent(
                    kind="tool_start",
                    tool_name="Read",
                    metadata={
                        "tool_id": "call_read_1",
                        "call_id": "call_read_1",
                        "name": "Read",
                        "context": "README.md",
                        "args_preview": "path=README.md",
                    },
                )
            )
            stream_sink(
                RuntimeStreamEvent(
                    kind="tool_progress",
                    tool_name="Read",
                    metadata={
                        "tool_id": "call_read_1",
                        "call_id": "call_read_1",
                        "name": "Read",
                        "stage": "executing",
                        "message": "Executing Read",
                        "args_preview": "path=README.md",
                    },
                )
            )
            stream_sink(
                RuntimeStreamEvent(
                    kind="tool_complete",
                    tool_name="Read",
                    metadata={
                        "tool_id": "call_read_1",
                        "call_id": "call_read_1",
                        "name": "Read",
                        "duration_s": 0.125,
                        "summary": "Read README.md",
                        "summary_chars": len("Read README.md"),
                        "summary_truncated": False,
                        "success": True,
                    },
                )
            )
            stream_sink(
                RuntimeStreamEvent(
                    kind="tool_failed",
                    tool_name="Write",
                    metadata={
                        "tool_id": "call_write_1",
                        "call_id": "call_write_1",
                        "name": "Write",
                        "duration_s": 0.002,
                        "summary": "Tool Write could not run.",
                        "summary_chars": len("Tool Write could not run."),
                        "summary_truncated": False,
                        "success": False,
                        "error": "Missing required parameter: content",
                        "error_chars": len("Missing required parameter: content"),
                        "error_truncated": False,
                    },
                )
            )
        return TurnResponse(assistant_message="done")


class FakeClarifyTurnService(FakeService):
    def handle_user_turn(
        self,
        message: str,
        stream_sink: StreamSink | None = None,
    ) -> TurnResponse:
        del message
        if stream_sink is not None:
            stream_sink(
                RuntimeStreamEvent(
                    kind="clarify_request",
                    tool_name="AskUserQuestion",
                    metadata={
                        "request_id": "call_question_1",
                        "tool_id": "call_question_1",
                        "call_id": "call_question_1",
                        "tool_name": "AskUserQuestion",
                        "question": "Which slice should come next?",
                        "options": [
                            {"label": "Runtime", "description": "Only runtime contract"},
                            {"label": "TUI", "description": "Render the request"},
                        ],
                        "header": "Scope",
                        "multi_select": False,
                    },
                )
            )
        return TurnResponse(
            assistant_message="waiting",
            turn=TurnRecord(
                thread_id="demo",
                turn_id="turn_waiting_clarification",
                status=TurnStatus.WAITING_CLARIFICATION,
                started_at="2026-05-31T00:00:00Z",
                completed_at="2026-05-31T00:00:01Z",
                stop_reason=StopReason.CLARIFICATION_REQUIRED,
                user_message="ask",
                items=(),
            ),
        )


class FailingTurnService(FakeService):
    def handle_user_turn(
        self,
        message: str,
        stream_sink: StreamSink | None = None,
    ) -> TurnResponse:
        del message, stream_sink
        raise RuntimeError("model unavailable")

    def resolve_pending_decision(
        self,
        choice: str,
        stream_sink: StreamSink | None = None,
    ) -> TurnResponse:
        del choice, stream_sink
        raise RuntimeError("approval resolution failed")


def test_gateway_turn_submit_emits_ordered_events(tmp_path: Path) -> None:
    events: list[tuple[str, dict[str, object]]] = []
    gateway = NodeTuiGateway(
        service=FakeTurnService(tmp_path),
        emit=lambda method, params: events.append((method, params)),
    )

    response = gateway.handle_request(
        RpcRequest(
            id="req_1",
            method="turn.submit",
            params={"message": "hello", "client_turn_id": "client_1"},
        )
    )
    gateway.wait_for_current_turn(timeout=2.0)

    assert response.result == {"accepted": True, "client_turn_id": "client_1"}
    direct_events = [(method, params) for method, params in events if method != "runtime.event"]
    methods = [method for method, _params in direct_events]
    assert methods[:2] == ["turn.started", "status.update"]
    assert methods.count("turn.event") == 4
    assert "reasoning.delta" in methods
    assert "thinking.delta" in methods
    assert "message.delta" in methods
    assert "message.complete" in methods
    assert methods[-5:] == [
        "turn.completed",
        "turn.status",
        "message.complete",
        "status.update",
        "status.changed",
    ]
    assert direct_events[1][1] == {
        "client_turn_id": "client_1",
        "state": "running",
        "kind": "running",
        "text": "Running",
    }
    completed = next(params for method, params in events if method == "turn.completed")
    assert completed["assistant_message"] == "hello world"
    assert completed["progress_updates"] == ["[progress] done"]
    assert completed["plan_steps"] == ["completed: smoke"]
    assert completed["turn_state"] == "completed"
    assert next(params for method, params in direct_events if method == "turn.status") == {
        "client_turn_id": "client_1",
        "state": "completed",
        "kind": "completed",
        "text": "Completed",
        "terminal": True,
    }
    assert direct_events[-3][1] == {
        "client_turn_id": "client_1",
        "text": "hello world",
        "final": True,
        "source": "turn_response",
    }
    assert direct_events[-2][1] == {
        "client_turn_id": "client_1",
        "state": "completed",
        "kind": "completed",
        "text": "Completed",
    }


def test_gateway_turn_submit_forwards_local_image_paths(tmp_path: Path) -> None:
    service = FakeService(tmp_path)
    gateway = NodeTuiGateway(service=service)

    response = gateway.handle_request(
        RpcRequest(
            id="req_1",
            method="turn.submit",
            params={
                "message": "describe [image #1]",
                "client_turn_id": "client_1",
                "local_images": [
                    {"path": "/tmp/screenshot.png", "placeholder": "[image #1]"},
                    {"path": "/tmp/screenshot.png", "placeholder": "[image #1]"},
                    "/tmp/second.jpg",
                ],
            },
        )
    )
    gateway.wait_for_current_turn(timeout=2.0)

    assert response.result == {"accepted": True, "client_turn_id": "client_1"}
    assert service.messages == ["describe [image #1]"]
    assert service.image_paths == [("/tmp/screenshot.png", "/tmp/second.jpg")]


def test_gateway_forwards_message_and_reasoning_typed_stream_events(tmp_path: Path) -> None:
    events: list[tuple[str, dict[str, object]]] = []
    gateway = NodeTuiGateway(
        service=FakeTurnService(tmp_path),
        emit=lambda method, params: events.append((method, params)),
    )

    response = gateway.handle_request(
        RpcRequest(
            id="req_1",
            method="turn.submit",
            params={"message": "hello", "client_turn_id": "client_1"},
        )
    )
    gateway.wait_for_current_turn(timeout=2.0)

    assert response.result == {"accepted": True, "client_turn_id": "client_1"}
    methods = [method for method, _params in events]
    assert "reasoning.delta" in methods
    assert "thinking.delta" in methods
    assert "message.delta" in methods
    assert "message.complete" in methods
    assert methods.count("turn.event") == 4
    message_complete_payloads = [
        params for method, params in events if method == "message.complete"
    ]
    assert next(params for method, params in events if method == "reasoning.delta") == {
        "client_turn_id": "client_1",
        "text": "thinking",
    }
    assert next(params for method, params in events if method == "thinking.delta") == {
        "client_turn_id": "client_1",
        "text": "thinking",
    }
    assert next(params for method, params in events if method == "message.delta") == {
        "client_turn_id": "client_1",
        "text": "hello",
    }
    assert message_complete_payloads == [
        {
            "client_turn_id": "client_1",
            "response_status": "completed",
        },
        {
            "client_turn_id": "client_1",
            "text": "hello world",
            "final": True,
            "source": "turn_response",
        },
    ]


def test_gateway_forwards_plan_updated_stream_event(tmp_path: Path) -> None:
    events: list[tuple[str, dict[str, object]]] = []
    service = FakeService(tmp_path)

    def plan_turn(
        _message: str,
        stream_sink: Callable[[RuntimeStreamEvent], None] | None = None,
    ) -> TurnResponse:
        if stream_sink is not None:
            stream_sink(
                RuntimeStreamEvent(
                    kind="plan_updated",
                    metadata={
                        "plan_steps": [
                            "completed: Inspect runtime state",
                            "in_progress: Render active plan",
                            "pending: Verify shell tests",
                        ],
                        "source": "Plan",
                    },
                )
            )
        return TurnResponse(assistant_message="Working on it")

    service.handle_user_turn = plan_turn  # type: ignore[assignment, method-assign]
    gateway = NodeTuiGateway(
        service=service,
        emit=lambda method, params: events.append((method, params)),
    )

    response = gateway.handle_request(
        RpcRequest(
            id="req_1",
            method="turn.submit",
            params={"message": "do it", "client_turn_id": "client_1"},
        )
    )
    gateway.wait_for_current_turn(timeout=2.0)

    assert response.result == {"accepted": True, "client_turn_id": "client_1"}
    direct_events = [(method, params) for method, params in events if method != "runtime.event"]
    assert ("plan.updated",) in [(method,) for method, _params in direct_events]
    assert next(params for method, params in direct_events if method == "plan.updated") == {
        "client_turn_id": "client_1",
        "plan_steps": [
            "completed: Inspect runtime state",
            "in_progress: Render active plan",
            "pending: Verify shell tests",
        ],
        "source": "Plan",
    }


def test_gateway_bounds_final_message_complete_text(tmp_path: Path) -> None:
    events: list[tuple[str, dict[str, object]]] = []
    service = FakeTurnService(tmp_path)
    long_message = "x" * 16_010

    def long_turn(
        _message: str,
        stream_sink: Callable[[RuntimeStreamEvent], None] | None = None,
    ) -> TurnResponse:
        del stream_sink
        return TurnResponse(assistant_message=long_message)

    service.handle_user_turn = long_turn  # type: ignore[assignment, method-assign]
    gateway = NodeTuiGateway(
        service=service,
        emit=lambda method, params: events.append((method, params)),
    )

    response = gateway.handle_request(
        RpcRequest(
            id="req_1",
            method="turn.submit",
            params={"message": "hello", "client_turn_id": "client_1"},
        )
    )
    gateway.wait_for_current_turn(timeout=2.0)

    assert response.result == {"accepted": True, "client_turn_id": "client_1"}
    final_complete = next(params for method, params in events if method == "message.complete")
    assert final_complete == {
        "client_turn_id": "client_1",
        "text": "x" * 16_000,
        "final": True,
        "source": "turn_response",
        "truncated": True,
        "original_length": 16_010,
    }


def test_gateway_emits_proposed_plan_as_special_event(tmp_path: Path) -> None:
    events: list[tuple[str, dict[str, object]]] = []
    service = FakeService(tmp_path)
    plan_message = (
        "I checked the repo.\n"
        "<proposed_plan>\n"
        "# Plan\n"
        "- Add parser\n"
        "- Render plan block\n"
        "</proposed_plan>\n"
        "Ready when you switch modes."
    )

    def plan_turn(
        _message: str,
        stream_sink: Callable[[RuntimeStreamEvent], None] | None = None,
    ) -> TurnResponse:
        del stream_sink
        return TurnResponse(assistant_message=plan_message)

    service.handle_user_turn = plan_turn  # type: ignore[assignment, method-assign]
    gateway = NodeTuiGateway(
        service=service,
        emit=lambda method, params: events.append((method, params)),
    )

    response = gateway.handle_request(
        RpcRequest(
            id="req_1",
            method="turn.submit",
            params={"message": "make a plan", "client_turn_id": "client_1"},
        )
    )
    gateway.wait_for_current_turn(timeout=2.0)

    assert response.result == {"accepted": True, "client_turn_id": "client_1"}
    direct_events = [(method, params) for method, params in events if method != "runtime.event"]
    methods = [method for method, _params in direct_events]
    assert "plan.proposed" in methods
    assert methods.index("plan.proposed") < methods.index("turn.completed")
    assert next(params for method, params in direct_events if method == "plan.proposed") == {
        "client_turn_id": "client_1",
        "text": "# Plan\n- Add parser\n- Render plan block",
        "source": "assistant_message",
    }
    completed = next(params for method, params in direct_events if method == "turn.completed")
    assert completed["assistant_message"] == "I checked the repo.\nReady when you switch modes."
    final_complete = next(
        params
        for method, params in direct_events
        if method == "message.complete" and params.get("final") is True
    )
    assert final_complete["text"] == "I checked the repo.\nReady when you switch modes."


def test_gateway_mirrors_runtime_notifications_with_versioned_envelopes(tmp_path: Path) -> None:
    events: list[tuple[str, dict[str, object]]] = []
    gateway = NodeTuiGateway(
        service=FakeTurnService(tmp_path),
        emit=lambda method, params: events.append((method, params)),
    )

    response = gateway.handle_request(
        RpcRequest(
            id="req_1",
            method="turn.submit",
            params={"message": "hello", "client_turn_id": "client_1"},
        )
    )
    gateway.wait_for_current_turn(timeout=2.0)

    assert response.result == {"accepted": True, "client_turn_id": "client_1"}
    envelopes = [params for method, params in events if method == "runtime.event"]
    direct_events = [(method, params) for method, params in events if method != "runtime.event"]
    assert envelopes
    assert len(envelopes) == len(direct_events)
    assert [envelope["sequence"] for envelope in envelopes] == list(range(1, len(envelopes) + 1))
    for envelope, (method, params) in zip(envelopes, direct_events, strict=True):
        assert envelope["version"] == 1
        assert envelope["type"] == method
        assert envelope["payload"] == params
        assert isinstance(envelope["timestamp"], float)
    assert all(envelope["type"] != "runtime.event" for envelope in envelopes)


def test_gateway_runtime_event_envelope_does_not_recurse(tmp_path: Path) -> None:
    events: list[tuple[str, dict[str, object]]] = []
    gateway = NodeTuiGateway(
        service=FakeTurnService(tmp_path),
        emit=lambda method, params: events.append((method, params)),
    )

    gateway._emit_event("runtime.event", {"type": "status.update", "payload": {}})

    assert events == [("runtime.event", {"type": "status.update", "payload": {}})]


def test_gateway_forwards_tool_lifecycle_events_as_tool_notifications(tmp_path: Path) -> None:
    events: list[tuple[str, dict[str, object]]] = []
    gateway = NodeTuiGateway(
        service=FakeToolLifecycleTurnService(tmp_path),
        emit=lambda method, params: events.append((method, params)),
    )

    response = gateway.handle_request(
        RpcRequest(
            id="req_1",
            method="turn.submit",
            params={"message": "hello", "client_turn_id": "client_1"},
        )
    )
    gateway.wait_for_current_turn(timeout=2.0)

    assert response.result == {"accepted": True, "client_turn_id": "client_1"}
    methods = [method for method, _params in events]
    assert "tool.start" in methods
    assert "tool.progress" in methods
    assert "tool.complete" in methods
    assert "tool.failed" in methods
    assert "turn.event" not in methods
    assert next(params for method, params in events if method == "tool.start") == {
        "client_turn_id": "client_1",
        "tool_id": "call_read_1",
        "call_id": "call_read_1",
        "name": "Read",
        "context": "README.md",
        "args_preview": "path=README.md",
    }
    assert next(params for method, params in events if method == "tool.progress") == {
        "client_turn_id": "client_1",
        "tool_id": "call_read_1",
        "call_id": "call_read_1",
        "name": "Read",
        "stage": "executing",
        "message": "Executing Read",
        "args_preview": "path=README.md",
    }
    assert next(params for method, params in events if method == "tool.complete") == {
        "client_turn_id": "client_1",
        "tool_id": "call_read_1",
        "call_id": "call_read_1",
        "name": "Read",
        "duration_s": 0.125,
        "summary": "Read README.md",
        "summary_chars": len("Read README.md"),
        "summary_truncated": False,
        "success": True,
    }
    assert next(params for method, params in events if method == "tool.failed") == {
        "client_turn_id": "client_1",
        "tool_id": "call_write_1",
        "call_id": "call_write_1",
        "name": "Write",
        "duration_s": 0.002,
        "summary": "Tool Write could not run.",
        "summary_chars": len("Tool Write could not run."),
        "summary_truncated": False,
        "success": False,
        "error": "Missing required parameter: content",
        "error_chars": len("Missing required parameter: content"),
        "error_truncated": False,
    }


def test_gateway_forwards_clarify_request_and_runtime_event_mirror(tmp_path: Path) -> None:
    events: list[tuple[str, dict[str, object]]] = []
    gateway = NodeTuiGateway(
        service=FakeClarifyTurnService(tmp_path),
        emit=lambda method, params: events.append((method, params)),
    )

    response = gateway.handle_request(
        RpcRequest(
            id="req_1",
            method="turn.submit",
            params={"message": "ask", "client_turn_id": "client_1"},
        )
    )
    gateway.wait_for_current_turn(timeout=2.0)

    assert response.result == {"accepted": True, "client_turn_id": "client_1"}
    clarify = next(params for method, params in events if method == "clarify.request")
    assert clarify == {
        "client_turn_id": "client_1",
        "request_id": "call_question_1",
        "tool_id": "call_question_1",
        "call_id": "call_question_1",
        "tool_name": "AskUserQuestion",
        "question": "Which slice should come next?",
        "options": [
            {"label": "Runtime", "description": "Only runtime contract"},
            {"label": "TUI", "description": "Render the request"},
        ],
        "header": "Scope",
        "multi_select": False,
    }
    assert {
        "type": "clarify.request",
        "payload": clarify,
    }.items() <= next(
        params
        for method, params in events
        if method == "runtime.event" and params["type"] == "clarify.request"
    ).items()
    assert {
        "client_turn_id": "client_1",
        "state": "waiting_clarification",
        "kind": "waiting_clarification",
        "text": "Waiting clarification",
        "terminal": False,
    } in [params for method, params in events if method == "turn.status"]
    assert {
        "client_turn_id": "client_1",
        "state": "waiting_clarification",
        "kind": "waiting_clarification",
        "text": "Waiting clarification",
    } in [params for method, params in events if method == "status.update"]
    final_completes = [
        params
        for method, params in events
        if method == "message.complete" and params.get("final") is True
    ]
    assert final_completes == []


def test_gateway_turn_submit_emits_approval_request_when_waiting(tmp_path: Path) -> None:
    events: list[tuple[str, dict[str, object]]] = []
    service = FakeTurnService(tmp_path)

    def pending_turn(_message: str, stream_sink: StreamSink | None = None) -> TurnResponse:
        del stream_sink
        decision = PendingDecision(
            tool_call=ToolCall(
                name="Bash",
                arguments={"command": "git push"},
                reason="push",
                call_id="call_push_1",
            ),
            kind=DecisionKind.NEEDS_CHOICE,
            reason="git push requires confirmation.",
            preview="git push",
            options=(DecisionAction.APPROVE_ONCE, DecisionAction.REJECT),
            metadata={
                "content_preview": "print('hello')",
                "content_line_count": 1,
                "content_truncated": False,
            },
        )
        service.fake_session_service.pending_decision = decision
        return TurnResponse(assistant_message="", pending_decision=decision)

    service.handle_user_turn = pending_turn  # type: ignore[method-assign, assignment]
    gateway = NodeTuiGateway(
        service=service,
        emit=lambda method, params: events.append((method, params)),
    )

    response = gateway.handle_request(
        RpcRequest(
            id="req_1",
            method="turn.submit",
            params={"message": "push", "client_turn_id": "client_1"},
        )
    )
    gateway.wait_for_current_turn(timeout=2.0)

    assert response.result == {"accepted": True, "client_turn_id": "client_1"}
    assert "approval.request" in [method for method, _params in events]
    approval = next(params for method, params in events if method == "approval.request")
    assert approval == {
        "client_turn_id": "client_1",
        "decision_id": "call_push_1",
        "preview": "git push",
        "action": "Bash",
        "cwd": str(Path.cwd()),
        "reason": "git push requires confirmation.",
        "risk": "needs_choice",
        "risk_reason": "git push requires confirmation.",
        "tool_name": "Bash",
        "content_preview": "print('hello')",
        "content_line_count": 1,
        "content_truncated": False,
        "options": [
            {"choice": "approve_once", "label": "Allow once"},
            {"choice": "reject", "label": "Reject"},
        ],
    }
    completed = next(params for method, params in events if method == "turn.completed")
    assert completed["turn_state"] == "waiting_approval"
    final_completes = [
        params
        for method, params in events
        if method == "message.complete" and params.get("final") is True
    ]
    assert final_completes == []
    assert {
        "client_turn_id": "client_1",
        "state": "waiting_approval",
        "kind": "waiting_approval",
        "text": "Waiting approval",
        "terminal": False,
    } in [params for method, params in events if method == "turn.status"]
    assert {
        "client_turn_id": "client_1",
        "state": "waiting_approval",
        "kind": "waiting_approval",
        "text": "Waiting approval",
    } in [params for method, params in events if method == "status.update"]


def test_gateway_turn_submit_rejects_empty_and_concurrent_turns(tmp_path: Path) -> None:
    events: list[tuple[str, dict[str, object]]] = []
    service = BlockingTurnService(tmp_path)
    gateway = NodeTuiGateway(
        service=service,
        emit=lambda method, params: events.append((method, params)),
    )

    empty = gateway.handle_request(
        RpcRequest(id="req_1", method="turn.submit", params={"message": "   "})
    )
    accepted = gateway.handle_request(
        RpcRequest(id="req_2", method="turn.submit", params={"message": "hello"})
    )
    assert service.started.wait(timeout=2.0)
    concurrent = gateway.handle_request(
        RpcRequest(id="req_3", method="turn.submit", params={"message": "again"})
    )
    service.release.set()
    gateway.wait_for_current_turn(timeout=2.0)

    assert empty.error == {"code": "invalid_params", "message": "message is required."}
    assert accepted.result == {"accepted": True, "client_turn_id": "req_2"}
    assert concurrent.error == {"code": "turn_in_progress", "message": "A turn is already running."}
    assert {
        "code": "invalid_params",
        "message": "message is required.",
        "method": "turn.submit",
    } in _gateway_error_events(events)
    assert {
        "code": "turn_in_progress",
        "message": "A turn is already running.",
        "method": "turn.submit",
    } in _gateway_error_events(events)


def test_gateway_turn_submit_emits_turn_status_for_failures(tmp_path: Path) -> None:
    events: list[tuple[str, dict[str, object]]] = []
    gateway = NodeTuiGateway(
        service=FailingTurnService(tmp_path),
        emit=lambda method, params: events.append((method, params)),
    )

    response = gateway.handle_request(
        RpcRequest(
            id="req_1",
            method="turn.submit",
            params={"message": "hello", "client_turn_id": "client_1"},
        )
    )
    gateway.wait_for_current_turn(timeout=2.0)

    assert response.result == {"accepted": True, "client_turn_id": "client_1"}
    assert {
        "client_turn_id": "client_1",
        "state": "failed",
        "kind": "failed",
        "text": "Failed",
        "terminal": True,
        "message": "model unavailable",
    } in [params for method, params in events if method == "turn.status"]


def test_gateway_turn_interrupt_reports_running_state(tmp_path: Path) -> None:
    events: list[tuple[str, dict[str, object]]] = []
    service = BlockingTurnService(tmp_path)
    gateway = NodeTuiGateway(
        service=service,
        emit=lambda method, params: events.append((method, params)),
    )
    idle = gateway.handle_request(RpcRequest(id="req_1", method="turn.interrupt", params={}))
    accepted = gateway.handle_request(
        RpcRequest(id="req_2", method="turn.submit", params={"message": "hello"})
    )
    assert service.started.wait(timeout=2.0)
    running = gateway.handle_request(RpcRequest(id="req_3", method="turn.interrupt", params={}))
    service.release.set()
    gateway.wait_for_current_turn(timeout=2.0)

    assert idle.result == {"interrupted": False}
    assert accepted.result == {"accepted": True, "client_turn_id": "req_2"}
    assert running.result == {"interrupted": True}
    assert service.interrupt_requests == ["req_2"]
    assert {
        "client_turn_id": "req_2",
        "state": "interrupted",
        "kind": "interrupted",
        "text": "Interrupted",
        "terminal": True,
        "message": "Interrupt requested",
    } in [params for method, params in events if method == "turn.status"]
    assert {
        "client_turn_id": "req_2",
        "state": "interrupted",
        "kind": "interrupted",
        "text": "Interrupted",
        "message": "Interrupt requested",
    } in [params for method, params in events if method == "status.update"]


def test_gateway_turn_interrupt_suppresses_late_normal_completion(tmp_path: Path) -> None:
    events: list[tuple[str, dict[str, object]]] = []
    service = BlockingLateCompletionTurnService(tmp_path)
    gateway = NodeTuiGateway(
        service=service,
        emit=lambda method, params: events.append((method, params)),
    )

    accepted = gateway.handle_request(
        RpcRequest(
            id="req_1",
            method="turn.submit",
            params={"message": "hello", "client_turn_id": "client_1"},
        )
    )
    assert service.started.wait(timeout=2.0)
    assert service.first_streamed.wait(timeout=2.0)
    interrupted = gateway.handle_request(RpcRequest(id="req_2", method="turn.interrupt", params={}))
    service.release.set()
    gateway.wait_for_current_turn(timeout=2.0)

    assert accepted.result == {"accepted": True, "client_turn_id": "client_1"}
    assert interrupted.result == {"interrupted": True}
    assert service.interrupt_requests == ["client_1"]

    terminal_events = [
        (method, params)
        for method, params in events
        if params.get("client_turn_id") == "client_1"
        and method in {"turn.completed", "turn.status", "message.complete", "status.update"}
    ]
    assert ("turn.completed",) not in [(method,) for method, _params in terminal_events]
    assert not any(
        method == "message.complete" and params.get("final") is True
        for method, params in terminal_events
    )
    assert not any(
        method == "turn.status" and params.get("state") == "completed"
        for method, params in terminal_events
    )
    assert not any(
        method == "status.update" and params.get("state") == "completed"
        for method, params in terminal_events
    )
    assert {
        "client_turn_id": "client_1",
        "state": "interrupted",
        "kind": "interrupted",
        "text": "Interrupted",
        "terminal": True,
        "message": "Interrupt requested",
    } in [params for method, params in events if method == "turn.status"]
    assert {
        "client_turn_id": "client_1",
        "reason": "interrupt_requested",
        "suppressed_state": "completed",
    } in [params for method, params in events if method == "turn.completion_suppressed"]


def test_gateway_turn_interrupt_raises_on_later_stream_events(tmp_path: Path) -> None:
    events: list[tuple[str, dict[str, object]]] = []
    service = InterruptibleStreamTurnService(tmp_path)
    gateway = NodeTuiGateway(
        service=service,
        emit=lambda method, params: events.append((method, params)),
    )

    accepted = gateway.handle_request(
        RpcRequest(
            id="req_1",
            method="turn.submit",
            params={"message": "hello", "client_turn_id": "client_1"},
        )
    )
    assert service.started.wait(timeout=2.0)
    assert service.first_streamed.wait(timeout=2.0)
    interrupted = gateway.handle_request(RpcRequest(id="req_2", method="turn.interrupt", params={}))
    service.release.set()
    gateway.wait_for_current_turn(timeout=2.0)

    assert accepted.result == {"accepted": True, "client_turn_id": "client_1"}
    assert interrupted.result == {"interrupted": True}
    assert service.interrupted is True
    assert not any(
        method == "message.delta" and params.get("text") == "after interrupt"
        for method, params in events
    )
    assert {
        "client_turn_id": "client_1",
        "state": "interrupted",
        "kind": "interrupted",
        "text": "Interrupted",
        "terminal": True,
        "message": "Interrupt requested",
    } in [params for method, params in events if method == "turn.status"]


def test_gateway_turn_interrupt_requests_runtime_interrupt_token(tmp_path: Path) -> None:
    events: list[tuple[str, dict[str, object]]] = []
    service = TokenAwareBlockingTurnService(tmp_path)
    gateway = NodeTuiGateway(
        service=service,
        emit=lambda method, params: events.append((method, params)),
    )

    accepted = gateway.handle_request(
        RpcRequest(
            id="req_1",
            method="turn.submit",
            params={"message": "hello", "client_turn_id": "client_1"},
        )
    )
    assert service.started.wait(timeout=2.0)
    assert service.seen_token is not None
    interrupted = gateway.handle_request(RpcRequest(id="req_2", method="turn.interrupt", params={}))
    service.release.set()
    gateway.wait_for_current_turn(timeout=2.0)

    assert accepted.result == {"accepted": True, "client_turn_id": "client_1"}
    assert interrupted.result == {"interrupted": True}
    assert service.seen_token.interrupted is True
    assert service.seen_token.reason == "interrupt"
    assert {
        "client_turn_id": "client_1",
        "turn_state": "interrupted",
        "assistant_message": "Interrupt requested",
        "activity_events": [],
        "progress_updates": [],
        "plan_steps": [],
        "pending_decision": False,
        "usage": {},
    } in [params for method, params in events if method == "turn.completed"]


def test_gateway_turn_interrupt_keeps_fake_services_without_diagnostic_hook_compatible(
    tmp_path: Path,
) -> None:
    service = BlockingNoInterruptHookService(tmp_path)
    gateway = NodeTuiGateway(service=service)

    accepted = gateway.handle_request(
        RpcRequest(id="req_1", method="turn.submit", params={"message": "hello"})
    )
    assert service.started.wait(timeout=2.0)
    interrupted = gateway.handle_request(RpcRequest(id="req_2", method="turn.interrupt", params={}))
    service.release.set()
    gateway.wait_for_current_turn(timeout=2.0)

    assert accepted.result == {"accepted": True, "client_turn_id": "req_1"}
    assert interrupted.result == {"interrupted": True}


def test_gateway_queues_steering_and_follow_up_while_turn_runs(tmp_path: Path) -> None:
    events: list[tuple[str, dict[str, object]]] = []
    service = BlockingTurnService(tmp_path)
    gateway = NodeTuiGateway(
        service=service,
        emit=lambda method, params: events.append((method, params)),
    )

    accepted = gateway.handle_request(
        RpcRequest(id="req_1", method="turn.submit", params={"message": "hello"})
    )
    assert service.started.wait(timeout=2.0)
    steering = gateway.handle_request(
        RpcRequest(
            id="req_2",
            method="turn.steer",
            params={
                "message": "steer now [image #1]",
                "local_images": [{"path": "/tmp/steer.png", "placeholder": "[image #1]"}],
            },
        )
    )
    follow_up = gateway.handle_request(
        RpcRequest(
            id="req_3",
            method="turn.follow_up",
            params={
                "message": "after this [image #1]",
                "local_images": [{"path": "/tmp/follow.png", "placeholder": "[image #1]"}],
            },
        )
    )
    cleared = gateway.handle_request(
        RpcRequest(id="req_4", method="turn.queue.clear", params={})
    )
    service.release.set()
    gateway.wait_for_current_turn(timeout=2.0)

    assert accepted.result == {"accepted": True, "client_turn_id": "req_1"}
    assert steering.result == {
        "accepted": True,
        "steering": ["steer now [image #1]"],
        "follow_up": [],
        "has_pending_input": True,
        "activity": {
            "kind": "pending_input",
            "has_pending_input": True,
            "steering_count": 1,
            "follow_up_count": 0,
        },
    }
    assert follow_up.result == {
        "accepted": True,
        "steering": ["steer now [image #1]"],
        "follow_up": ["after this [image #1]"],
        "has_pending_input": True,
        "activity": {
            "kind": "pending_input",
            "has_pending_input": True,
            "steering_count": 1,
            "follow_up_count": 1,
        },
    }
    assert cleared.result == {
        "steering": ["steer now [image #1]"],
        "follow_up": ["after this [image #1]"],
        "has_pending_input": True,
        "activity": {
            "kind": "pending_input",
            "has_pending_input": True,
            "steering_count": 1,
            "follow_up_count": 1,
        },
    }
    assert service.steering_image_paths == [("/tmp/steer.png",)]
    assert service.follow_up_image_paths == [("/tmp/follow.png",)]
    queue_events = [params for method, params in events if method == "turn.queue.updated"]
    assert any(
        params["steering"] == ["steer now [image #1]"] and params["follow_up"] == []
        for params in queue_events
    )
    assert any(
        params["steering"] == ["steer now [image #1]"]
        and params["follow_up"] == ["after this [image #1]"]
        for params in queue_events
    )
    assert any(
        params["steering"] == [] and params["follow_up"] == []
        and params["has_pending_input"] is False
        for params in queue_events
    )


def test_gateway_decision_resolve_maps_choice_and_emits_turn_events(tmp_path: Path) -> None:
    events: list[tuple[str, dict[str, object]]] = []
    service = FakeTurnService(tmp_path)
    service.fake_session_service.pending_decision = PendingDecision(
        tool_call=ToolCall(name="Bash", arguments={"command": "git push"}, reason="push"),
        kind=DecisionKind.NEEDS_CHOICE,
        reason="git push requires confirmation.",
        preview="git push",
        options=(DecisionAction.APPROVE_ONCE, DecisionAction.REJECT),
    )
    gateway = NodeTuiGateway(
        service=service,
        emit=lambda method, params: events.append((method, params)),
    )

    response = gateway.handle_request(
        RpcRequest(
            id="req_1",
            method="decision.resolve",
            params={"decision_id": "decision_current", "choice": "approve_once"},
        )
    )
    gateway.wait_for_current_turn(timeout=2.0)

    assert response.result == {
        "accepted": True,
        "decision_id": "decision_current",
        "client_turn_id": "approval_req_1",
    }
    assert service.resolved_choices == ["1"]
    methods = [method for method, _params in events if method != "runtime.event"]
    assert methods[:3] == ["turn.started", "status.update", "approval.respond"]
    assert "message.delta" in methods
    assert "turn.completed" in methods
    assert "turn.status" in methods
    assert "status.changed" in methods
    assert methods.index("approval.respond") < methods.index("message.delta")
    final_complete = next(params for method, params in events if method == "message.complete")
    assert final_complete == {
        "client_turn_id": "approval_req_1",
        "text": "resolved 1",
        "final": True,
        "source": "turn_response",
    }


def test_gateway_approval_respond_maps_choice_and_keeps_decision_resolve_compatible(
    tmp_path: Path,
) -> None:
    service = FakeTurnService(tmp_path)
    service.fake_session_service.pending_decision = PendingDecision(
        tool_call=ToolCall(name="Bash", arguments={"command": "git push"}, reason="push"),
        kind=DecisionKind.NEEDS_CHOICE,
        reason="git push requires confirmation.",
        preview="git push",
        options=(DecisionAction.APPROVE_ONCE, DecisionAction.REJECT),
    )
    gateway = NodeTuiGateway(service=service)

    response = gateway.handle_request(
        RpcRequest(
            id="req_1",
            method="approval.respond",
            params={"decision_id": "decision_current", "choice": "reject"},
        )
    )
    gateway.wait_for_current_turn(timeout=2.0)

    assert response.result == {
        "accepted": True,
        "decision_id": "decision_current",
        "client_turn_id": "approval_req_1",
    }
    assert service.resolved_choices == ["2"]


def test_gateway_approval_respond_accepts_stable_decision_id(tmp_path: Path) -> None:
    service = FakeTurnService(tmp_path)
    service.fake_session_service.pending_decision = PendingDecision(
        tool_call=ToolCall(
            name="Bash",
            arguments={"command": "git push"},
            reason="push",
            call_id="call_push_1",
        ),
        kind=DecisionKind.NEEDS_CHOICE,
        reason="git push requires confirmation.",
        preview="git push",
        options=(DecisionAction.APPROVE_ONCE, DecisionAction.REJECT),
    )
    gateway = NodeTuiGateway(service=service)

    response = gateway.handle_request(
        RpcRequest(
            id="req_1",
            method="approval.respond",
            params={"decision_id": "call_push_1", "choice": "approve_once"},
        )
    )
    gateway.wait_for_current_turn(timeout=2.0)

    assert response.result == {
        "accepted": True,
        "decision_id": "call_push_1",
        "client_turn_id": "approval_req_1",
    }
    assert service.resolved_choices == ["1"]


def test_gateway_approval_resume_emits_followup_approval_request(
    tmp_path: Path,
) -> None:
    class FollowupApprovalService(FakeTurnService):
        def resolve_pending_decision(
            self,
            choice: str,
            stream_sink: StreamSink | None = None,
        ) -> TurnResponse:
            del stream_sink
            self.resolved_choices.append(choice)
            next_decision = PendingDecision(
                tool_call=ToolCall(
                    name="Bash",
                    arguments={"command": "git status"},
                    reason="inspect status",
                    call_id="call_status_2",
                ),
                kind=DecisionKind.NEEDS_CHOICE,
                reason="Shell command requires confirmation.",
                preview="git status",
                options=(DecisionAction.APPROVE_ONCE, DecisionAction.REJECT),
            )
            self.fake_session_service.pending_decision = next_decision
            return TurnResponse(assistant_message="", pending_decision=next_decision)

    events: list[tuple[str, dict[str, object]]] = []
    service = FollowupApprovalService(tmp_path)
    service.fake_session_service.pending_decision = PendingDecision(
        tool_call=ToolCall(
            name="Bash",
            arguments={"command": "lsof -i -P -n"},
            reason="inspect ports",
            call_id="call_lsof_1",
        ),
        kind=DecisionKind.NEEDS_CHOICE,
        reason="Shell command requires confirmation.",
        preview="lsof -i -P -n",
        options=(DecisionAction.APPROVE_ONCE, DecisionAction.REJECT),
    )
    gateway = NodeTuiGateway(service=service, emit=lambda method, params: events.append((method, params)))

    response = gateway.handle_request(
        RpcRequest(
            id="req_1",
            method="approval.respond",
            params={"decision_id": "call_lsof_1", "choice": "approve_once"},
        )
    )
    gateway.wait_for_current_turn(timeout=2.0)

    assert response.result == {
        "accepted": True,
        "decision_id": "call_lsof_1",
        "client_turn_id": "approval_req_1",
    }
    approval_requests = [
        params for method, params in events if method == "approval.request"
    ]
    assert approval_requests == [
        {
            "client_turn_id": "approval_req_1",
            "decision_id": "call_status_2",
            "preview": "git status",
            "reason": "Shell command requires confirmation.",
            "tool_name": "Bash",
            "options": [
                {"choice": "approve_once", "label": "Allow once"},
                {"choice": "reject", "label": "Reject"},
            ],
            "action": "Bash",
            "cwd": str(Path.cwd()),
            "risk": "needs_choice",
            "risk_reason": "Shell command requires confirmation.",
        }
    ]


def test_gateway_approval_resume_forwards_stream_events(tmp_path: Path) -> None:
    class ToolLifecycleApprovalService(FakeTurnService):
        def resolve_pending_decision(
            self,
            choice: str,
            stream_sink: StreamSink | None = None,
        ) -> TurnResponse:
            self.resolved_choices.append(choice)
            self.fake_session_service.pending_decision = None
            if stream_sink is not None:
                stream_sink(
                    RuntimeStreamEvent(
                        kind="tool_start",
                        tool_name="Bash",
                        metadata={
                            "tool_id": "call_lsof_1",
                            "call_id": "call_lsof_1",
                            "name": "Bash",
                            "context": "local",
                        },
                    )
                )
                stream_sink(
                    RuntimeStreamEvent(
                        kind="tool_complete",
                        tool_name="Bash",
                        metadata={
                            "tool_id": "call_lsof_1",
                            "call_id": "call_lsof_1",
                            "name": "Bash",
                            "duration_s": 0.01,
                            "summary": "Command exited with 0",
                            "summary_chars": 21,
                            "summary_truncated": False,
                            "success": True,
                        },
                    )
                )
                stream_sink(RuntimeStreamEvent(kind="text_delta", text=f"resolved-stream-{choice}"))
            return TurnResponse(assistant_message=f"resolved {choice}")

    events: list[tuple[str, dict[str, object]]] = []
    service = ToolLifecycleApprovalService(tmp_path)
    service.fake_session_service.pending_decision = PendingDecision(
        tool_call=ToolCall(
            name="Bash",
            arguments={"command": "lsof -i -P -n"},
            reason="inspect ports",
            call_id="call_lsof_1",
        ),
        kind=DecisionKind.NEEDS_CHOICE,
        reason="Shell command requires confirmation.",
        preview="lsof -i -P -n",
        options=(DecisionAction.APPROVE_ONCE, DecisionAction.REJECT),
    )
    gateway = NodeTuiGateway(service=service, emit=lambda method, params: events.append((method, params)))

    response = gateway.handle_request(
        RpcRequest(
            id="req_1",
            method="approval.respond",
            params={"decision_id": "call_lsof_1", "choice": "approve_once"},
        )
    )
    gateway.wait_for_current_turn(timeout=2.0)

    assert response.result == {
        "accepted": True,
        "decision_id": "call_lsof_1",
        "client_turn_id": "approval_req_1",
    }
    assert ("approval.respond", {
        "client_turn_id": "approval_req_1",
        "decision_id": "call_lsof_1",
        "choice": "approve_once",
    }) in events
    assert any(
        method == "message.delta" and params.get("text") == "resolved-stream-1"
        for method, params in events
    )
    assert any(
        method == "tool.start"
        and params.get("client_turn_id") == "approval_req_1"
        and params.get("tool_id") == "call_lsof_1"
        for method, params in events
    )
    assert any(
        method == "tool.complete"
        and params.get("client_turn_id") == "approval_req_1"
        and params.get("tool_id") == "call_lsof_1"
        for method, params in events
    )


def test_gateway_approval_respond_rejects_stale_decision_id(tmp_path: Path) -> None:
    events: list[tuple[str, dict[str, object]]] = []
    service = FakeTurnService(tmp_path)
    service.fake_session_service.pending_decision = PendingDecision(
        tool_call=ToolCall(
            name="Bash",
            arguments={"command": "git push"},
            reason="push",
            call_id="call_push_1",
        ),
        kind=DecisionKind.NEEDS_CHOICE,
        reason="git push requires confirmation.",
        preview="git push",
        options=(DecisionAction.APPROVE_ONCE, DecisionAction.REJECT),
    )
    gateway = NodeTuiGateway(
        service=service,
        emit=lambda method, params: events.append((method, params)),
    )

    response = gateway.handle_request(
        RpcRequest(
            id="req_1",
            method="approval.respond",
            params={"decision_id": "call_old", "choice": "approve_once"},
        )
    )

    assert response.error == {
        "code": "decision_not_pending",
        "message": "No pending decision matches the provided decision_id.",
    }
    assert service.resolved_choices == []
    assert {
        "code": "decision_not_pending",
        "message": "No pending decision matches the provided decision_id.",
        "method": "approval.respond",
    } in _gateway_error_events(events)


def test_gateway_approval_respond_rejects_unsupported_choice_with_error_event(
    tmp_path: Path,
) -> None:
    events: list[tuple[str, dict[str, object]]] = []
    service = FakeTurnService(tmp_path)
    service.fake_session_service.pending_decision = PendingDecision(
        tool_call=ToolCall(name="Bash", arguments={"command": "git push"}, reason="push"),
        kind=DecisionKind.NEEDS_CHOICE,
        reason="git push requires confirmation.",
        preview="git push",
        options=(DecisionAction.APPROVE_ONCE, DecisionAction.REJECT),
    )
    gateway = NodeTuiGateway(
        service=service,
        emit=lambda method, params: events.append((method, params)),
    )

    response = gateway.handle_request(
        RpcRequest(
            id="req_1",
            method="approval.respond",
            params={"decision_id": "decision_current", "choice": "forever"},
        )
    )

    assert response.error == {
        "code": "invalid_params",
        "message": "Unsupported decision choice.",
    }
    assert service.resolved_choices == []
    assert {
        "code": "invalid_params",
        "message": "Unsupported decision choice.",
        "method": "approval.respond",
    } in _gateway_error_events(events)


def test_gateway_approval_respond_rejects_missing_pending_decision_with_error_event(
    tmp_path: Path,
) -> None:
    events: list[tuple[str, dict[str, object]]] = []
    service = FakeTurnService(tmp_path)
    gateway = NodeTuiGateway(
        service=service,
        emit=lambda method, params: events.append((method, params)),
    )

    response = gateway.handle_request(
        RpcRequest(
            id="req_1",
            method="approval.respond",
            params={"decision_id": "decision_current", "choice": "reject"},
        )
    )

    assert response.error == {
        "code": "decision_not_pending",
        "message": "No pending decision is available.",
    }
    assert service.resolved_choices == []
    assert {
        "code": "decision_not_pending",
        "message": "No pending decision is available.",
        "method": "approval.respond",
    } in _gateway_error_events(events)


def test_gateway_approval_reject_emits_rejected_terminal_status(tmp_path: Path) -> None:
    events: list[tuple[str, dict[str, object]]] = []
    service = FakeTurnService(tmp_path)
    service.fake_session_service.pending_decision = PendingDecision(
        tool_call=ToolCall(name="Bash", arguments={"command": "git push"}, reason="push"),
        kind=DecisionKind.NEEDS_CHOICE,
        reason="git push requires confirmation.",
        preview="git push",
        options=(DecisionAction.APPROVE_ONCE, DecisionAction.REJECT),
    )
    gateway = NodeTuiGateway(
        service=service,
        emit=lambda method, params: events.append((method, params)),
    )

    response = gateway.handle_request(
        RpcRequest(
            id="req_1",
            method="approval.respond",
            params={"decision_id": "decision_current", "choice": "reject"},
        )
    )
    gateway.wait_for_current_turn(timeout=2.0)

    assert response.result == {
        "accepted": True,
        "decision_id": "decision_current",
        "client_turn_id": "approval_req_1",
    }
    assert {
        "client_turn_id": "approval_req_1",
        "state": "rejected",
        "kind": "rejected",
        "text": "Rejected",
        "terminal": True,
        "message": "Rejected Bash. Pending decision cleared.",
    } in [params for method, params in events if method == "turn.status"]
    assert {
        "client_turn_id": "approval_req_1",
        "state": "rejected",
        "kind": "rejected",
        "text": "Rejected",
        "message": "Rejected Bash. Pending decision cleared.",
    } in [params for method, params in events if method == "status.update"]


def test_gateway_clarify_respond_validates_request_and_emits_turn_events(tmp_path: Path) -> None:
    events: list[tuple[str, dict[str, object]]] = []
    service = FakeTurnService(tmp_path)
    gateway = NodeTuiGateway(
        service=service,
        emit=lambda method, params: events.append((method, params)),
    )

    response = gateway.handle_request(
        RpcRequest(
            id="req_1",
            method="clarify.respond",
            params={"request_id": "call_question_1", "response": "Runtime"},
        )
    )
    gateway.wait_for_current_turn(timeout=2.0)

    assert response.result == {
        "accepted": True,
        "request_id": "call_question_1",
        "client_turn_id": "clarify_req_1",
    }
    assert service.clarification_responses == [("call_question_1", "Runtime")]
    assert [method for method, _params in events if method != "runtime.event"] == [
        "turn.started",
        "status.update",
        "clarify.respond",
        "turn.completed",
        "turn.status",
        "message.complete",
        "status.update",
        "status.changed",
    ]
    clarify = next(params for method, params in events if method == "clarify.respond")
    assert clarify == {
        "client_turn_id": "clarify_req_1",
        "request_id": "call_question_1",
        "response": "Runtime",
    }
    assert {
        "type": "clarify.respond",
        "payload": clarify,
    }.items() <= next(
        params
        for method, params in events
        if method == "runtime.event" and params["type"] == "clarify.respond"
    ).items()


def test_gateway_clarify_respond_rejects_blank_response(tmp_path: Path) -> None:
    events: list[tuple[str, dict[str, object]]] = []
    gateway = NodeTuiGateway(
        service=FakeTurnService(tmp_path),
        emit=lambda method, params: events.append((method, params)),
    )

    response = gateway.handle_request(
        RpcRequest(
            id="req_1",
            method="clarify.respond",
            params={"request_id": "call_question_1", "response": "   "},
        )
    )

    assert response.error == {
        "code": "invalid_params",
        "message": "response is required.",
    }
    assert {
        "code": "invalid_params",
        "message": "response is required.",
        "method": "clarify.respond",
    } in _gateway_error_events(events)


def test_gateway_decision_resolve_emits_turn_status_for_failures(tmp_path: Path) -> None:
    events: list[tuple[str, dict[str, object]]] = []
    service = FailingTurnService(tmp_path)
    service.fake_session_service.pending_decision = PendingDecision(
        tool_call=ToolCall(name="Bash", arguments={"command": "git push"}, reason="push"),
        kind=DecisionKind.NEEDS_CHOICE,
        reason="git push requires confirmation.",
        preview="git push",
        options=(DecisionAction.APPROVE_ONCE, DecisionAction.REJECT),
    )
    gateway = NodeTuiGateway(
        service=service,
        emit=lambda method, params: events.append((method, params)),
    )

    response = gateway.handle_request(
        RpcRequest(
            id="req_1",
            method="decision.resolve",
            params={"decision_id": "decision_current", "choice": "approve_once"},
        )
    )
    gateway.wait_for_current_turn(timeout=2.0)

    assert response.result == {
        "accepted": True,
        "decision_id": "decision_current",
        "client_turn_id": "approval_req_1",
    }
    assert {
        "client_turn_id": "approval_req_1",
        "state": "failed",
        "kind": "failed",
        "text": "Failed",
        "terminal": True,
        "message": "approval resolution failed",
    } in [params for method, params in events if method == "turn.status"]
