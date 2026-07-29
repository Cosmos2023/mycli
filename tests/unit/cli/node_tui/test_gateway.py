from __future__ import annotations

from collections.abc import Callable
from pathlib import Path
import sqlite3
from threading import Event, Lock, Thread
import time
from types import SimpleNamespace

from mycli.config.auth_store import AuthStore
from mycli.application.turn_service import TurnService
from mycli.application.runtime.session_queue import (
    LegacyQueueMigration,
    QueueMutationResult,
    SessionQueueCoordinator,
)
from mycli.application.runtime.user_input_mailbox import ActiveTurnMailbox
from mycli.cli.node_tui.gateway import (
    NodeTuiGateway,
    _SerializedGatewayWriter,
    _approval_request_payload,
    supported_event_streams,
    supported_rpc_methods,
)
from mycli.cli.node_tui.protocol import (
    RpcNotification,
    RpcRequest,
    RpcResponse,
    decode_message,
    notification,
)
from mycli.domain.conversation import Conversation, Message
from mycli.domain.model_catalog import ModelCatalogEntry, ModelSelection
from mycli.domain.providers import ProtocolId, ProviderId
from mycli.domain.runtime import (
    CollaborationMode,
    DecisionAction,
    DecisionKind,
    MailboxAcceptance,
    ReasoningEffort,
    PendingDecision,
    PendingClarification,
    QueueSnapshot,
    QueuedInputRecord,
    QueuedTurnInput,
    RuntimeStreamEvent,
    RuntimeInterruptToken,
    ShellLifecycleEvent,
    StopReason,
    SuspendedTurn,
    TurnResponse,
    TurnRecord,
    TurnStatus,
    UserMessageInput,
)
from mycli.domain.runtime.session_history import HistoryItem, HistoryItemType
from mycli.domain.tooling.calls import ToolCall
from mycli.services.session_service import SessionService


StreamSink = Callable[[RuntimeStreamEvent], None]


def _gateway_error_events(
    events: list[tuple[str, dict[str, object]]],
) -> list[dict[str, object]]:
    return [params for method, params in events if method == "gateway.error"]


def _assert_accepted_turn(response: RpcResponse, client_turn_id: str) -> str:
    assert response.result is not None
    assert response.result["accepted"] is True
    assert response.result["client_turn_id"] == client_turn_id
    turn_id = response.result["turn_id"]
    assert isinstance(turn_id, str)
    assert turn_id.startswith("turn_")
    return turn_id


def _has_event(
    events: list[tuple[str, dict[str, object]]],
    method: str,
    expected: dict[str, object],
) -> bool:
    return any(
        expected.items() <= params.items()
        for event_method, params in events
        if event_method == method
    )


class FakeSessionService:
    def __init__(self) -> None:
        self.history_items: tuple[HistoryItem, ...] = ()
        self.replay_history_items: tuple[HistoryItem, ...] | None = None
        self.load_history_error: Exception | None = None
        self.snapshot_tui_items: tuple[dict[str, object], ...] = ()
        self.pending_decision: object | None = None
        self.suspended_turn: object | None = None
        self.include_child_session = False
        self.append_command_result_error: Exception | None = None
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
        if self.load_history_error is not None:
            raise self.load_history_error
        return self.history_items

    def load_replay_history_items(self, session_id: str) -> tuple[HistoryItem, ...]:
        history_items = self.load_history_items(session_id)
        return self.replay_history_items or history_items

    def append_command_result(
        self,
        *,
        session_id: str,
        result_id: str,
        command: str,
        text: str,
        display: dict[str, object],
    ) -> None:
        if self.append_command_result_error is not None:
            raise self.append_command_result_error
        self.history_items = (
            *self.history_items,
            HistoryItem(
                id=result_id,
                thread_id=session_id,
                turn_id=result_id,
                type=HistoryItemType.COMMAND_RESULT,
                text=text,
                metadata={
                    "command": command,
                    "display": display,
                    "model_visible": False,
                },
            ),
        )

    def load_snapshot_tui_items(
        self,
        _session_id: str,
    ) -> tuple[dict[str, object], ...]:
        return self.snapshot_tui_items

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
        self._session_title_cache: dict[str, str] = {}
        self.messages: list[str] = []
        self.image_paths: list[tuple[str, ...]] = []
        self.shell_listener: Callable[[ShellLifecycleEvent], None] | None = None
        self.shell_unsubscribe_count = 0
        self.active_shell_rows: tuple[dict[str, object], ...] = ()
        self.model_selections: list[ModelSelection] = []
        self.active_permission_profile = "workspace"

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

    def permission_profile_payload(self) -> dict[str, object]:
        return {
            "active": self.active_permission_profile,
            "profiles": [
                {
                    "id": profile_id,
                    "label": label,
                    "description": description,
                    "current": profile_id == self.active_permission_profile,
                }
                for profile_id, label, description in (
                    (
                        "workspace",
                        "Ask for approval",
                        "Read and edit this workspace; ask before network or outside access.",
                    ),
                    (
                        "full-access",
                        "Full Access",
                        "Access files and network without approval.",
                    ),
                    (
                        "read-only",
                        "Read Only",
                        "Read workspace files; ask before edits or network.",
                    ),
                )
            ],
            "command_allowance_count": 1,
        }

    def set_permission_profile(self, profile_id: str) -> dict[str, object]:
        valid = {"workspace", "full-access", "read-only"}
        if profile_id not in valid:
            raise ValueError(f"Unsupported permission profile '{profile_id}'.")
        self.active_permission_profile = profile_id
        return next(
            profile
            for profile in self.permission_profile_payload()["profiles"]
            if profile["id"] == profile_id
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

    def available_models(self) -> tuple[ModelCatalogEntry, ...]:
        return (
            ModelCatalogEntry(
                provider=ProviderId.DEEPSEEK,
                protocol=ProtocolId.CHAT_COMPLETIONS,
                model="deepseek-v4-flash",
                display_name="deepseek-v4-flash",
                description="Current model",
                base_url="https://api.deepseek.com",
                is_current=self._config.model == "deepseek-v4-flash",
            ),
            ModelCatalogEntry(
                provider=ProviderId.OPENAI,
                protocol=ProtocolId.RESPONSES,
                model="gpt-5.4",
                display_name="gpt-5.4",
                description="Frontier coding model",
                base_url="https://api.openai.com/v1",
                supported_reasoning_efforts=(
                    ReasoningEffort.LOW,
                    ReasoningEffort.MEDIUM,
                    ReasoningEffort.HIGH,
                    ReasoningEffort.XHIGH,
                ),
                default_reasoning_effort=ReasoningEffort.MEDIUM,
                is_current=self._config.model == "gpt-5.4",
            ),
        )

    def select_model(self, selection: ModelSelection) -> ModelCatalogEntry:
        self.model_selections.append(selection)
        self._config.provider = selection.provider
        self._config.protocol = selection.protocol
        self._config.model = selection.model
        self._config.reasoning_effort = selection.reasoning_effort or ReasoningEffort.MEDIUM
        self._config.thinking_effort = self._config.reasoning_effort
        return next(
            entry
            for entry in self.available_models()
            if entry.identity == selection.identity
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

    def resolve_pending_clarification(
        self,
        request_id: str,
        response: str,
        stream_sink: StreamSink | None = None,
    ) -> TurnResponse:
        del request_id, response, stream_sink
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
            shell_kind="powershell",
            shell_edition="core",
        )
    )

    method, payload = next(item for item in emitted if item[0] == "shell.started")
    assert method == "shell.started"
    assert payload["shell_id"] == "shell-1"
    assert payload["call_id"] == "call-1"
    assert payload["sequence"] == 1
    assert payload["shell_kind"] == "powershell"
    assert payload["shell_edition"] == "core"
    assert "shell_path" not in payload
    gateway.close()


def test_gateway_ignores_shell_lifecycle_notification_from_child(
    tmp_path: Path,
) -> None:
    service = FakeService(tmp_path)
    emitted: list[tuple[str, dict[str, object]]] = []
    gateway = NodeTuiGateway(
        service=service,
        emit=lambda method, params: emitted.append((method, params)),
    )

    service.emit_shell_event(
        ShellLifecycleEvent(
            kind="shell.started",
            shell_id="shell-child",
            owner_session_id=f"{service._config.session_id}:dream:turn_1:abcd1234",
            call_id="call-child",
            sequence=1,
            command_preview="find .",
            background=False,
            process_state="running_foreground",
        )
    )

    assert not any(method == "shell.started" for method, _params in emitted)
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


def test_gateway_lists_and_updates_permissions_during_running_turn(tmp_path: Path) -> None:
    events: list[tuple[str, dict[str, object]]] = []
    service = FakeService(tmp_path)
    gateway = NodeTuiGateway(
        service=service,
        emit=lambda method, params: events.append((method, params)),
    )
    gateway._turn_running = True

    listed = gateway.handle_request(
        RpcRequest(id="req_1", method="permissions.list", params={})
    )
    updated = gateway.handle_request(
        RpcRequest(
            id="req_2",
            method="permissions.update",
            params={"profile": "full-access"},
        )
    )

    assert listed.error is None
    assert listed.result["active"] == "workspace"
    assert listed.result["command_allowance_count"] == 1
    assert updated.error is None
    assert updated.result["selected"]["id"] == "full-access"
    assert updated.result["permissions"]["active"] == "full-access"
    assert any(
        method == "status.changed"
        and params["permissions"]["active"] == "full-access"
        for method, params in events
    )


def test_gateway_bootstrap_and_status_include_permission_profiles(tmp_path: Path) -> None:
    gateway = NodeTuiGateway(service=FakeService(tmp_path))

    bootstrap = gateway.handle_request(
        RpcRequest(id="req_1", method="session.bootstrap", params={"protocol_version": 1})
    )
    status = gateway.handle_request(
        RpcRequest(id="req_2", method="status.inspect", params={})
    )

    assert bootstrap.result["permissions"]["active"] == "workspace"
    assert bootstrap.result["status"]["permissions"]["active"] == "workspace"
    assert status.result["permissions"]["profiles"][0]["current"] is True


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


def test_gateway_forwards_transient_stream_retry_lifecycle(tmp_path: Path) -> None:
    events: list[tuple[str, dict[str, object]]] = []
    gateway = NodeTuiGateway(
        service=FakeService(tmp_path),
        emit=lambda method, params: events.append((method, params)),
    )

    gateway._forward_stream_event(
        "client_1",
        RuntimeStreamEvent(kind="stream_attempt_reset"),
    )
    gateway._forward_stream_event(
        "client_1",
        RuntimeStreamEvent(
            kind="stream_retrying",
            text="Reconnecting... 2/5",
            metadata={
                "attempt": 2,
                "max_retries": 5,
                "delay_seconds": 0.4,
                "additional_details": "Idle timeout waiting for SSE",
            },
        ),
    )

    assert events[0] == ("message.reset", {"client_turn_id": "client_1"})
    assert events[2] == (
        "stream.retrying",
        {
            "client_turn_id": "client_1",
            "text": "Reconnecting... 2/5",
            "attempt": 2,
            "max_retries": 5,
            "delay_seconds": 0.4,
            "additional_details": "Idle timeout waiting for SSE",
        },
    )


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
        RpcRequest(
            id="req_2",
            method="command.run",
            params={"command": "/help", "surface": "cli"},
        )
    )

    assert response.result is not None
    assert response.result["execution"] == "backend"
    assert response.result["display"]["kind"] == "diagnostic"
    assert response.result["lines"] == ["Usage", "Session: demo", "Turns: 1"]
    assert response.result["mutated_session"] is False
    assert help_response.result is not None
    assert any("/status" in line for line in help_response.result["lines"])


def test_gateway_command_run_returns_overlay_result_without_persisting(
    tmp_path: Path,
) -> None:
    service = FakeService(tmp_path)
    gateway = NodeTuiGateway(service=service)

    response = gateway.handle_request(
        RpcRequest(id="cmd", method="command.run", params={"command": "/tools"})
    )

    assert response.result is not None
    assert "result_id" not in response.result
    assert response.result["presentation"] == "overlay"
    assert response.result["display"]["kind"] == "list"
    assert service.fake_session_service.load_history_items("demo") == ()


def test_unknown_command_returns_compact_error_display(tmp_path: Path) -> None:
    gateway = NodeTuiGateway(service=FakeService(tmp_path))

    response = gateway.handle_request(
        RpcRequest(id="bad", method="command.run", params={"command": "/memroy"})
    )

    assert response.error is None
    assert response.result is not None
    assert response.result["result_id"].startswith("command:")
    assert response.result["display"]["kind"] == "error"
    assert response.result["display"].get("suggestions", []) == []


def test_command_result_does_not_attempt_session_persistence(
    tmp_path: Path,
) -> None:
    service = FakeService(tmp_path)
    service.fake_session_service.append_command_result_error = sqlite3.OperationalError(
        "x" * 2_000
    )
    events: list[tuple[str, dict[str, object]]] = []
    gateway = NodeTuiGateway(
        service=service,
        emit=lambda method, params: events.append((method, params)),
    )

    response = gateway.handle_request(
        RpcRequest(id="cmd", method="command.run", params={"command": "/tools"})
    )

    assert response.error is None
    assert response.result is not None
    assert response.result["display"]["kind"] == "list"
    persistence_warnings = [
        payload
        for method, payload in events
        if method == "gateway.error"
        and payload.get("code") == "command_result_persistence_failed"
    ]
    assert persistence_warnings == []
    assert service.fake_session_service.load_history_items("demo") == ()


def test_non_transcript_commands_do_not_persist_results(tmp_path: Path) -> None:
    service = FakeService(tmp_path)
    gateway = NodeTuiGateway(service=service)

    tui_action = gateway.handle_request(
        RpcRequest(id="model", method="command.run", params={"command": "/model"})
    )
    quit_response = gateway.handle_request(
        RpcRequest(
            id="quit",
            method="command.run",
            params={"command": "/quit", "surface": "cli"},
        )
    )

    assert tui_action.result is not None
    assert "result_id" not in tui_action.result
    assert quit_response.result is not None
    assert "result_id" not in quit_response.result
    assert service.fake_session_service.history_items == ()


def test_session_mutation_returns_destination_session_without_persisting_notice(
    tmp_path: Path,
) -> None:
    service = FakeService(tmp_path)
    gateway = NodeTuiGateway(service=service)

    response = gateway.handle_request(
        RpcRequest(
            id="resume",
            method="command.run",
            params={"command": "/resume target", "surface": "cli"},
        )
    )

    assert response.result is not None
    assert response.result["mutated_session"] is True
    assert response.result["session_id"] == "target"
    assert "result_id" not in response.result
    assert service.fake_session_service.history_items == ()


def test_gateway_command_list_returns_only_canonical_tui_commands(tmp_path: Path) -> None:
    gateway = NodeTuiGateway(service=FakeService(tmp_path))

    response = gateway.handle_request(
        RpcRequest(id="list", method="command.list", params={"surface": "tui"})
    )

    assert response.result is not None
    commands = response.result["commands"]
    names = [item["name"] for item in commands]
    assert names == [
        "/model",
        "/plan",
        "/permissions",
        "/new",
        "/resume",
        "/fork",
        "/status",
        "/usage",
        "/compact",
        "/skills",
        "/tools",
        "/tasks",
        "/ps",
        "/changes",
        "/help",
        "/quit",
    ]
    assert len(names) == 16
    assert "/usage" in names
    assert "/status usage" not in names
    assert "/theme" not in names


def test_gateway_command_list_filters_tui_only_commands_for_cli(tmp_path: Path) -> None:
    gateway = NodeTuiGateway(service=FakeService(tmp_path))

    response = gateway.handle_request(
        RpcRequest(id="list", method="command.list", params={"surface": "cli"})
    )

    assert response.result is not None
    names = [item["name"] for item in response.result["commands"]]
    assert "/usage" in names
    assert "/settings" not in names
    assert "/copy" not in names


def test_gateway_command_run_returns_tui_action_for_bare_model(tmp_path: Path) -> None:
    gateway = NodeTuiGateway(service=FakeService(tmp_path))

    response = gateway.handle_request(
        RpcRequest(
            id="model",
            method="command.run",
            params={"command": "/model", "surface": "tui"},
        )
    )

    assert response.result == {
        "execution": "tui",
        "client_action": "open_model_selector",
        "args": "",
        "command_id": "model",
    }


def test_gateway_command_run_executes_inline_model_on_backend(tmp_path: Path) -> None:
    gateway = NodeTuiGateway(service=FakeService(tmp_path))

    response = gateway.handle_request(
        RpcRequest(
            id="model",
            method="command.run",
            params={"command": "/model gpt-test", "surface": "tui"},
        )
    )

    assert response.result is not None
    assert response.result["execution"] == "backend"
    assert response.result["mutated_model"] is True


def test_gateway_model_list_returns_backend_catalog(tmp_path: Path) -> None:
    gateway = NodeTuiGateway(service=FakeService(tmp_path))

    response = gateway.handle_request(
        RpcRequest(id="models", method="model.list", params={})
    )

    assert response.error is None
    assert response.result is not None
    assert [model["model"] for model in response.result["models"]] == [
        "deepseek-v4-flash",
        "gpt-5.4",
    ]
    assert response.result["models"][1]["supported_reasoning_efforts"] == [
        "low",
        "medium",
        "high",
        "xhigh",
    ]


def test_gateway_model_select_applies_structured_selection_and_refreshes_status(
    tmp_path: Path,
) -> None:
    events: list[tuple[str, dict[str, object]]] = []
    service = FakeService(tmp_path)
    gateway = NodeTuiGateway(
        service=service,
        emit=lambda method, params: events.append((method, params)),
    )

    response = gateway.handle_request(
        RpcRequest(
            id="select",
            method="model.select",
            params={
                "provider": "openai",
                "protocol": "responses",
                "model": "gpt-5.4",
                "base_url": "https://api.openai.com/v1",
                "reasoning_effort": "high",
            },
        )
    )

    assert response.error is None
    assert response.result is not None
    assert response.result["selected"]["model"] == "gpt-5.4"
    assert response.result["status"]["model"] == "gpt-5.4"
    assert response.result["status"]["provider"] == "openai/responses"
    assert service.model_selections == [
        ModelSelection(
            provider=ProviderId.OPENAI,
            protocol=ProtocolId.RESPONSES,
            model="gpt-5.4",
            base_url="https://api.openai.com/v1",
            reasoning_effort=ReasoningEffort.HIGH,
        )
    ]
    assert any(method == "status.changed" for method, _params in events)


def test_gateway_model_select_rejects_selection_while_turn_is_running(tmp_path: Path) -> None:
    service = FakeService(tmp_path)
    gateway = NodeTuiGateway(service=service)
    gateway._turn_running = True

    response = gateway.handle_request(
        RpcRequest(
            id="select",
            method="model.select",
            params={
                "provider": "openai",
                "protocol": "responses",
                "model": "gpt-5.4",
                "base_url": "https://api.openai.com/v1",
                "reasoning_effort": "medium",
            },
        )
    )

    assert response.error is not None
    assert response.error["code"] == "turn_in_progress"
    assert service.model_selections == []


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
    assert stopped.result["display"]["kind"] == "notice"
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
    assert response.result["display"]["kind"] == "notice"
    assert response.result["lines"] == [
        "cancelled subagent:demo:sub:turn_1:abcd owner_turn=turn_1"
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
    assert response.result["display"]["kind"] == "notice"
    assert response.result["lines"] == [
        "cancelled subagent:demo:sub:turn_1:abcd owner_turn=turn_1"
    ]


def test_gateway_command_run_legacy_session_alias_opens_resume_picker(tmp_path: Path) -> None:
    gateway = NodeTuiGateway(service=FakeService(tmp_path))

    response = gateway.handle_request(
        RpcRequest(id="req_1", method="command.run", params={"command": "/session"})
    )

    assert response.result is not None
    assert response.result["execution"] == "tui"
    assert response.result["client_action"] == "open_session_selector"


def test_gateway_command_run_returns_presentation_and_view_mode(tmp_path: Path) -> None:
    gateway = NodeTuiGateway(service=FakeService(tmp_path))

    usage = gateway.handle_request(
        RpcRequest(id="req_1", method="command.run", params={"command": "/usage"})
    )
    view = gateway.handle_request(
        RpcRequest(
            id="req_2",
            method="command.run",
            params={"command": "/view verbose", "surface": "cli"},
        )
    )
    quit_response = gateway.handle_request(
        RpcRequest(
            id="req_3",
            method="command.run",
            params={"command": "/quit", "surface": "cli"},
        )
    )
    changes = gateway.handle_request(
        RpcRequest(id="req_4", method="command.run", params={"command": "/changes"})
    )
    permissions = gateway.handle_request(
        RpcRequest(id="req_5", method="command.run", params={"command": "/permissions"})
    )

    assert usage.result is not None
    assert usage.result["presentation"] == "transcript"
    assert usage.result["exit_requested"] is False
    assert view.result is not None
    assert view.result["view_mode"] == "verbose"
    assert view.result["presentation"] == "transcript"
    assert quit_response.result is not None
    assert quit_response.result["exit_requested"] is True
    assert changes.result is not None
    assert changes.result["presentation"] == "transcript"
    assert changes.result["presentation_hint"] == "file changes"
    assert permissions.result is not None
    assert permissions.result == {
        "execution": "tui",
        "client_action": "open_permissions",
        "args": "",
        "command_id": "permissions",
    }


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
    assert response.result["display"]["kind"] == "notice"
    assert response.result["lines"] == ["model=gpt-5.4; thinking_effort=high"]
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
    assert response.result["display"]["kind"] == "notice"
    assert response.result["lines"] == ["collaboration_mode=plan"]
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
        HistoryItem(
            id="hist_tool_result",
            thread_id="demo",
            turn_id="turn_1",
            type=HistoryItemType.TOOL_RESULT,
            text="file contents",
            tool_name="Read",
            call_id="call_read_1",
            metadata={
                "created_at": "2026-05-27T08:00:03Z",
                "success": True,
                "duration_ms": 25,
            },
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
                "metadata": {
                    "tool_name": "Read",
                    "call_id": "call_read_1",
                    "duration_ms": 25,
                    "status": "done",
                    "success": True,
                    "output_preview": "file contents",
                },
            },
        ],
        "next_before": None,
    }


def test_gateway_transcript_load_upgrades_legacy_tagged_command_output(
    tmp_path: Path,
) -> None:
    service = FakeService(tmp_path)
    service.fake_session_service.history_items = (
        HistoryItem(
            id="legacy-usage",
            thread_id="demo",
            turn_id="turn-1",
            type=HistoryItemType.WARNING,
            text=(
                "[usage] session=demo turns=3\n"
                "[usage] cumulative_usage input_tokens=100 cache_read_tokens=80"
            ),
            metadata={"command": "/usage", "model_visible": False},
        ),
    )
    gateway = NodeTuiGateway(service=service)

    response = gateway.handle_request(
        RpcRequest(
            id="legacy",
            method="transcript.load",
            params={"session_id": "demo"},
        )
    )

    assert response.result is not None
    assert response.result["items"] == []
    assert service.fake_session_service.history_items[0].type is HistoryItemType.WARNING


def test_gateway_transcript_load_keeps_malformed_legacy_text_exact(
    tmp_path: Path,
) -> None:
    text = '[tool] Read description="unterminated'
    service = FakeService(tmp_path)
    service.fake_session_service.history_items = (
        HistoryItem(
            id="legacy-malformed",
            thread_id="demo",
            turn_id="turn-1",
            type=HistoryItemType.WARNING,
            text=text,
            metadata={"command": "/tools", "model_visible": False},
        ),
    )
    gateway = NodeTuiGateway(service=service)

    response = gateway.handle_request(
        RpcRequest(id="legacy", method="transcript.load", params={"session_id": "demo"})
    )

    assert response.result is not None
    assert response.result["items"][0]["type"] == "warning"
    assert response.result["items"][0]["text"] == text


def test_gateway_snapshot_fallback_hides_legacy_tagged_command_output(
    tmp_path: Path,
) -> None:
    service = FakeService(tmp_path)
    service.fake_session_service.snapshot_tui_items = (
        {
            "id": "legacy-undo",
            "type": "system_notice",
            "text": "[undo] Restored app.py",
            "created_at": "",
            "folded": False,
            "metadata": {"command": "/undo"},
        },
    )
    service.fake_session_service.load_history_error = sqlite3.DatabaseError(
        "database unavailable"
    )
    gateway = NodeTuiGateway(service=service)

    response = gateway.handle_request(
        RpcRequest(id="legacy", method="transcript.load", params={"session_id": "demo"})
    )

    assert response.result is not None
    assert [item["type"] for item in response.result["items"]] == ["warning"]


def test_gateway_transcript_load_projects_plan_updates_in_order(tmp_path: Path) -> None:
    service = FakeService(tmp_path)
    service.fake_session_service.history_items = (
        HistoryItem(
            id="hist_user",
            thread_id="demo",
            turn_id="turn_1",
            type=HistoryItemType.USER_MESSAGE,
            text="Inspect runtime",
        ),
        HistoryItem(
            id="hist_plan",
            thread_id="demo",
            turn_id="turn_1",
            type=HistoryItemType.PLAN_UPDATE,
            text="Updated Plan",
            metadata={
                "source": "Plan",
                "completed": 0,
                "total": 1,
                "items": [
                    {
                        "id": "inspect",
                        "text": "Inspect runtime",
                        "status": "in_progress",
                    }
                ],
                "model_visible": False,
            },
        ),
        HistoryItem(
            id="hist_assistant",
            thread_id="demo",
            turn_id="turn_1",
            type=HistoryItemType.ASSISTANT_MESSAGE,
            text="Working on it",
        ),
    )
    gateway = NodeTuiGateway(service=service)

    response = gateway.handle_request(
        RpcRequest(
            id="req_plan_history",
            method="transcript.load",
            params={"session_id": "demo", "before": None},
        )
    )

    assert response.result is not None
    assert [item["type"] for item in response.result["items"]] == [
        "user",
        "plan_update",
        "assistant_final",
    ]
    assert response.result["items"][1]["metadata"]["items"][0] == {
        "id": "inspect",
        "text": "Inspect runtime",
        "status": "in_progress",
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


def test_gateway_transcript_load_uses_normalized_approval_replay_before_pagination(
    tmp_path: Path,
) -> None:
    service = FakeService(tmp_path)
    original = HistoryItem(
        id="user-original",
        thread_id="demo",
        turn_id="turn-original",
        type=HistoryItemType.USER_MESSAGE,
        text="inspect cpu",
    )
    legacy_duplicate = HistoryItem(
        id="user-legacy",
        thread_id="demo",
        turn_id="turn-approval",
        type=HistoryItemType.USER_MESSAGE,
        text="inspect cpu",
    )
    assistant = HistoryItem(
        id="assistant",
        thread_id="demo",
        turn_id="turn-approval",
        type=HistoryItemType.ASSISTANT_MESSAGE,
        text="CPU is idle",
    )
    service.fake_session_service.history_items = (
        original,
        legacy_duplicate,
        assistant,
    )
    service.fake_session_service.replay_history_items = (original, assistant)
    gateway = NodeTuiGateway(service=service)

    full = gateway.handle_request(
        RpcRequest(
            id="req_full",
            method="transcript.load",
            params={"session_id": "demo", "before": None},
        )
    )
    tail = gateway.handle_request(
        RpcRequest(
            id="req_tail",
            method="transcript.load",
            params={"session_id": "demo", "limit": 2, "before": None},
        )
    )

    assert full.result is not None
    assert [item["id"] for item in full.result["items"]] == [
        "user-original",
        "assistant",
    ]
    assert tail.result is not None
    assert [item["id"] for item in tail.result["items"]] == [
        "user-original",
        "assistant",
    ]
    assert tail.result["next_before"] is None


def test_gateway_transcript_load_falls_back_to_snapshot_on_sqlite_error(
    tmp_path: Path,
) -> None:
    service = FakeService(tmp_path)
    service.fake_session_service.snapshot_tui_items = (
        {
            "id": "user-1",
            "type": "user",
            "text": "visible history",
            "created_at": "",
            "folded": False,
            "metadata": {},
        },
    )
    service.fake_session_service.load_history_error = sqlite3.DatabaseError(
        "database unavailable"
    )
    gateway = NodeTuiGateway(service=service)

    response = gateway.handle_request(
        RpcRequest(
            id="req-1",
            method="transcript.load",
            params={"session_id": "demo", "before": None},
        )
    )

    assert response.result is not None
    assert response.result["read_only"] is True
    assert response.result["items"][0]["type"] == "warning"
    assert response.result["items"][1]["text"] == "visible history"


def test_gateway_normal_transcript_projection_drops_provider_metadata(
    tmp_path: Path,
) -> None:
    service = FakeService(tmp_path)
    service.fake_session_service.history_items = (
        HistoryItem(
            id="hist-tool",
            thread_id="demo",
            turn_id="turn-1",
            type=HistoryItemType.TOOL_CALL,
            text="Read pyproject.toml",
            tool_name="Read",
            call_id="call-1",
            metadata={
                "provider_id": "private",
                "created_at": "2026-07-12T10:00:00Z",
            },
        ),
    )
    gateway = NodeTuiGateway(service=service)

    response = gateway.handle_request(
        RpcRequest(
            id="req-1",
            method="transcript.load",
            params={"session_id": "demo"},
        )
    )

    assert response.result is not None
    assert response.result["items"][0]["metadata"] == {
        "tool_name": "Read",
        "call_id": "call-1",
        "status": "running",
    }


def test_gateway_slash_completion_filters_candidates(tmp_path: Path) -> None:
    gateway = NodeTuiGateway(service=FakeService(tmp_path))

    response = gateway.handle_request(
        RpcRequest(id="req_1", method="completion.slash", params={"prefix": "/sta"})
    )

    assert response.result is not None
    values = [item["value"] for item in response.result["items"]]
    assert "/status" in values
    assert "/stats" not in values
    assert "/status stats" not in values

    maintenance_response = gateway.handle_request(
        RpcRequest(id="req_2", method="completion.slash", params={"prefix": "/session m"})
    )

    assert maintenance_response.result == {"items": []}


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
    from mycli.domain.tooling.exposure import ToolRouteKey
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

    def resolve_pending_clarification(
        self,
        request_id: str,
        response: str,
        stream_sink: StreamSink | None = None,
    ) -> TurnResponse:
        del stream_sink
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


class QueuePopTurnService(FakeTurnService):
    def __init__(self, workspace_root: Path) -> None:
        super().__init__(workspace_root)
        self.steering_inputs: list[QueuedTurnInput] = []
        self.follow_up_inputs: list[QueuedTurnInput] = []

    def queue_steering_message(
        self,
        message: str,
        *,
        image_paths: tuple[str, ...] = (),
        client_turn_id: str | None = None,
    ) -> tuple[tuple[str, ...], tuple[str, ...]]:
        self.steering_inputs.append(
            QueuedTurnInput(
                kind="steering",
                text=message,
                image_paths=image_paths,
                client_turn_id=client_turn_id,
            )
        )
        return self.queued_messages()

    def queue_follow_up_message(
        self,
        message: str,
        *,
        image_paths: tuple[str, ...] = (),
        client_turn_id: str | None = None,
    ) -> tuple[tuple[str, ...], tuple[str, ...]]:
        self.follow_up_inputs.append(
            QueuedTurnInput(
                kind="follow_up",
                text=message,
                image_paths=image_paths,
                client_turn_id=client_turn_id,
            )
        )
        return self.queued_messages()

    def queued_messages(self) -> tuple[tuple[str, ...], tuple[str, ...]]:
        return (
            tuple(item.text for item in self.steering_inputs),
            tuple(item.text for item in self.follow_up_inputs),
        )

    def queued_input_items(
        self,
    ) -> tuple[tuple[QueuedTurnInput, ...], tuple[QueuedTurnInput, ...]]:
        return tuple(self.steering_inputs), tuple(self.follow_up_inputs)

    def pop_last_follow_up_input(self) -> QueuedTurnInput | None:
        if not self.follow_up_inputs:
            return None
        return self.follow_up_inputs.pop()


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


class TypedSteeringTurnService(BlockingTurnService):
    def __init__(self, workspace_root: Path) -> None:
        super().__init__(workspace_root)
        self.mailbox = ActiveTurnMailbox()

    def begin_active_turn_mailbox(
        self,
        turn_id: str,
        *,
        steerable: bool,
        turn_kind: str = "regular",
    ) -> None:
        self.mailbox.begin(turn_id, steerable=steerable, turn_kind=turn_kind)

    def close_active_turn_mailbox(self, turn_id: str) -> tuple[UserMessageInput, ...]:
        return self.mailbox.close_and_drain(turn_id)

    def steer_active_turn(self, item: UserMessageInput) -> MailboxAcceptance:
        assert item.target_turn_id is not None
        return self.mailbox.accept(item.target_turn_id, item)

    def handle_user_turn(
        self,
        message: str,
        stream_sink: StreamSink | None = None,
        *,
        turn_id: str | None = None,
    ) -> TurnResponse:
        del message, stream_sink
        assert turn_id is not None
        self.started.set()
        if not self.release.wait(timeout=2.0):
            raise AssertionError("blocking fake turn was not released")
        self.close_active_turn_mailbox(turn_id)
        return TurnResponse(assistant_message="")


class UserLifecycleTurnService(FakeTurnService):
    def handle_user_turn(
        self,
        message: str,
        stream_sink: StreamSink | None = None,
        *,
        turn_id: str | None = None,
        client_user_message_id: str | None = None,
    ) -> TurnResponse:
        assert turn_id is not None
        assert client_user_message_id is not None
        assert stream_sink is not None
        item = {
            "id": f"{turn_id}:user:{client_user_message_id}",
            "type": "user_message",
            "client_user_message_id": client_user_message_id,
            "content": message,
            "source": "submit",
        }
        stream_sink(
            RuntimeStreamEvent(
                kind="item_started",
                metadata={"turn_id": turn_id, "item": item},
            )
        )
        stream_sink(
            RuntimeStreamEvent(
                kind="item_completed",
                metadata={"turn_id": turn_id, "item": item},
            )
        )
        stream_sink(RuntimeStreamEvent(kind="reasoning", text="thinking"))
        return TurnResponse(assistant_message="done")


def test_turn_steer_mismatch_returns_actual_turn_id(tmp_path: Path) -> None:
    service = TypedSteeringTurnService(tmp_path)
    gateway = NodeTuiGateway(service=service)
    try:
        submitted = gateway.handle_request(
            RpcRequest(
                id="submit",
                method="turn.submit",
                params={
                    "message": "start",
                    "client_turn_id": "turn-client",
                    "client_user_message_id": "user-client",
                },
            )
        )
        assert service.started.wait(timeout=2)
        assert submitted.result is not None
        actual_turn_id = str(submitted.result["turn_id"])

        response = gateway.handle_request(
            RpcRequest(
                id="steer",
                method="turn.steer",
                params={
                    "client_user_message_id": "client-1",
                    "expected_turn_id": "turn-stale",
                    "message": "inspect",
                },
            )
        )

        assert response.error == {
            "code": "turn_id_mismatch",
            "message": (
                f"expected active turn turn-stale but found {actual_turn_id}"
            ),
            "data": {"actual_turn_id": actual_turn_id},
        }
    finally:
        service.release.set()
        gateway.wait_for_current_turn(timeout=2)
        gateway.close()


def test_gateway_forwards_user_item_lifecycle_before_model_events(
    tmp_path: Path,
) -> None:
    events: list[tuple[str, dict[str, object]]] = []
    gateway = NodeTuiGateway(
        service=UserLifecycleTurnService(tmp_path),
        emit=lambda method, params: events.append((method, params)),
    )

    response = gateway.handle_request(
        RpcRequest(
            id="submit",
            method="turn.submit",
            params={
                "message": "inspect",
                "client_turn_id": "turn-client",
                "client_user_message_id": "user-client",
            },
        )
    )
    gateway.wait_for_current_turn(timeout=2)
    gateway.close()

    assert response.result is not None
    direct = [(method, params) for method, params in events if method != "runtime.event"]
    lifecycle = [
        (method, params)
        for method, params in direct
        if method in {"item.started", "item.completed"}
    ]
    assert [method for method, _params in lifecycle] == [
        "item.started",
        "item.completed",
    ]
    assert lifecycle[0][1]["item"] == lifecycle[1][1]["item"]
    assert lifecycle[1][1]["item"]["client_user_message_id"] == "user-client"
    assert next(
        index for index, (method, _params) in enumerate(direct) if method == "item.completed"
    ) < next(
        index for index, (method, _params) in enumerate(direct) if method == "reasoning.delta"
    )
    mirrored_types = [
        params["type"] for method, params in events if method == "runtime.event"
    ]
    assert "item.started" in mirrored_types
    assert "item.completed" in mirrored_types


class QueueSchedulingTurnService(FakeTurnService):
    def __init__(self, workspace_root: Path) -> None:
        super().__init__(workspace_root)
        self.started = Event()
        self.second_started = Event()
        self.release = Event()
        self.blocker_checked = Event()
        self.queue_blocked = False
        self.user_messages: list[str] = []
        self.server_turn_ids: list[str] = []
        self._queue = SessionQueueCoordinator(
            session_id="demo",
            session_service=SessionService(home_dir=workspace_root / "home"),
        )

    def handle_user_turn(
        self,
        message: str,
        stream_sink: StreamSink | None = None,
        *,
        turn_id: str | None = None,
    ) -> TurnResponse:
        del stream_sink
        if turn_id is None:
            raise AssertionError("gateway did not pass a server turn id")
        self.user_messages.append(message)
        self.server_turn_ids.append(turn_id)
        if len(self.user_messages) == 1:
            self.started.set()
            if not self.release.wait(timeout=2.0):
                raise AssertionError("first turn was not released")
        else:
            self.second_started.set()
        return TurnResponse(assistant_message=f"response {len(self.user_messages)}")

    def queue_steering_input(
        self,
        message: str,
        *,
        image_paths: tuple[str, ...] = (),
        client_turn_id: str,
        expected_turn_id: str,
        active_turn_id: str | None,
        steerable: bool,
    ) -> QueueMutationResult:
        return self._queue.enqueue_steer(
            text=message,
            image_paths=image_paths,
            client_turn_id=client_turn_id,
            expected_turn_id=expected_turn_id,
            active_turn_id=active_turn_id,
            steerable=steerable,
        )

    def queue_snapshot(self) -> QueueSnapshot:
        return self._queue.snapshot()

    def legacy_user_queue_migration(self) -> LegacyQueueMigration | None:
        return self._queue.legacy_user_queue_migration()

    def ack_legacy_user_queue_migration(self, token: str) -> None:
        self._queue.ack_legacy_user_queue_migration(token)

    def queue_follow_up_input(
        self,
        message: str,
        *,
        image_paths: tuple[str, ...] = (),
        client_turn_id: str,
        source: str = "user",
    ) -> QueueMutationResult:
        return self._queue.enqueue_follow_up(
            text=message,
            image_paths=image_paths,
            client_turn_id=client_turn_id,
            source=source,
        )

    def next_queued_turn(self) -> QueuedInputRecord | None:
        return self._queue.next_end_of_turn()

    def mark_queued_turn_started(self, queue_id: str) -> QueueSnapshot:
        return self._queue.mark_started(queue_id)

    def subscribe_queue(
        self,
        listener: Callable[[QueueSnapshot], None],
    ) -> Callable[[], None]:
        return self._queue.subscribe(listener)

    def queue_drain_blocked(self) -> bool:
        self.blocker_checked.set()
        return self.queue_blocked


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

    _assert_accepted_turn(response, "client_1")
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
    assert {
        "client_turn_id": "client_1",
        "state": "running",
        "kind": "running",
        "text": "Running",
    }.items() <= direct_events[1][1].items()
    completed = next(params for method, params in events if method == "turn.completed")
    assert completed["assistant_message"] == "hello world"
    assert completed["progress_updates"] == ["[progress] done"]
    assert completed["plan_steps"] == ["completed: smoke"]
    assert completed["turn_state"] == "completed"
    assert {
        "client_turn_id": "client_1",
        "state": "completed",
        "kind": "completed",
        "text": "Completed",
        "terminal": True,
    }.items() <= next(
        params for method, params in direct_events if method == "turn.status"
    ).items()
    assert direct_events[-3][1] == {
        "client_turn_id": "client_1",
        "text": "hello world",
        "final": True,
        "source": "turn_response",
    }
    assert {
        "client_turn_id": "client_1",
        "state": "completed",
        "kind": "completed",
        "text": "Completed",
    }.items() <= direct_events[-2][1].items()


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

    _assert_accepted_turn(response, "client_1")
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

    _assert_accepted_turn(response, "client_1")
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
                        "plan": {
                            "items": [
                                {
                                    "id": "inspect",
                                    "text": "Inspect runtime state",
                                    "status": "completed",
                                },
                                {
                                    "id": "render",
                                    "text": "Render active plan",
                                    "status": "in_progress",
                                },
                                {
                                    "id": "verify",
                                    "text": "Verify shell tests",
                                    "status": "pending",
                                },
                            ]
                        },
                        "source": "Plan",
                        "completed": 1,
                        "total": 3,
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

    _assert_accepted_turn(response, "client_1")
    direct_events = [(method, params) for method, params in events if method != "runtime.event"]
    assert ("plan.updated",) in [(method,) for method, _params in direct_events]
    assert next(params for method, params in direct_events if method == "plan.updated") == {
        "client_turn_id": "client_1",
        "plan_steps": [
            "completed: Inspect runtime state",
            "in_progress: Render active plan",
            "pending: Verify shell tests",
        ],
        "plan": {
            "items": [
                {
                    "id": "inspect",
                    "text": "Inspect runtime state",
                    "status": "completed",
                },
                {
                    "id": "render",
                    "text": "Render active plan",
                    "status": "in_progress",
                },
                {
                    "id": "verify",
                    "text": "Verify shell tests",
                    "status": "pending",
                },
            ]
        },
        "source": "Plan",
        "completed": 1,
        "total": 3,
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

    _assert_accepted_turn(response, "client_1")
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

    _assert_accepted_turn(response, "client_1")
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

    _assert_accepted_turn(response, "client_1")
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

    _assert_accepted_turn(response, "client_1")
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

    _assert_accepted_turn(response, "client_1")
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
    assert _has_event(events, "turn.status", {
        "client_turn_id": "client_1",
        "state": "waiting_clarification",
        "kind": "waiting_clarification",
        "text": "Waiting clarification",
        "terminal": False,
    })
    assert _has_event(events, "status.update", {
        "client_turn_id": "client_1",
        "state": "waiting_clarification",
        "kind": "waiting_clarification",
        "text": "Waiting clarification",
    })
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

    _assert_accepted_turn(response, "client_1")
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
    assert _has_event(events, "turn.status", {
        "client_turn_id": "client_1",
        "state": "waiting_approval",
        "kind": "waiting_approval",
        "text": "Waiting approval",
        "terminal": False,
    })
    assert _has_event(events, "status.update", {
        "client_turn_id": "client_1",
        "state": "waiting_approval",
        "kind": "waiting_approval",
        "text": "Waiting approval",
    })


def test_gateway_approval_payload_exposes_always_allow_and_bounded_preview() -> None:
    decision = PendingDecision(
        tool_call=ToolCall(
            name="Shell",
            arguments={"command": "python -m pytest -q"},
            reason="run tests",
            call_id="call_pytest_1",
        ),
        kind=DecisionKind.NEEDS_CHOICE,
        reason="Unknown command requires approval.",
        preview="python -m pytest -q",
        options=(
            DecisionAction.APPROVE_ONCE,
            DecisionAction.REJECT,
            DecisionAction.ALWAYS_ALLOW,
        ),
        proposed_execpolicy_pattern=("python", "-m", "x" * 200),
    )

    payload = _approval_request_payload("client_1", decision)

    assert payload["options"][-1] == {
        "choice": "always_allow",
        "label": "Always allow",
    }
    preview = str(payload["persistent_rule_preview"])
    assert len(preview) == 160
    assert preview.startswith('["python", "-m", "')
    assert preview.endswith("...")


def test_gateway_maps_always_allow_to_stable_choice_four(tmp_path: Path) -> None:
    service = FakeTurnService(tmp_path)
    service.fake_session_service.pending_decision = PendingDecision(
        tool_call=ToolCall(
            name="Shell",
            arguments={"command": "python -m pytest"},
            reason="run tests",
        ),
        kind=DecisionKind.NEEDS_CHOICE,
        reason="Unknown command requires approval.",
        preview="python -m pytest",
        options=(
            DecisionAction.APPROVE_ONCE,
            DecisionAction.REJECT,
            DecisionAction.ALWAYS_ALLOW,
        ),
        proposed_execpolicy_pattern=("python", "-m", "pytest"),
    )
    gateway = NodeTuiGateway(service=service)

    response = gateway.handle_request(
        RpcRequest(
            id="req_always",
            method="approval.respond",
            params={
                "decision_id": "decision_current",
                "choice": "always_allow",
            },
        )
    )
    gateway.wait_for_current_turn(timeout=2.0)

    assert response.error is None
    assert service.resolved_choices == ["4"]


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
    _assert_accepted_turn(accepted, "req_2")
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

    _assert_accepted_turn(response, "client_1")
    assert _has_event(events, "turn.status", {
        "client_turn_id": "client_1",
        "state": "failed",
        "kind": "failed",
        "text": "Failed",
        "terminal": True,
        "message": "model unavailable",
    })


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
    _assert_accepted_turn(accepted, "req_2")
    assert running.result == {"interrupted": True}
    assert service.interrupt_requests == ["req_2"]
    assert _has_event(events, "turn.status", {
        "client_turn_id": "req_2",
        "state": "interrupted",
        "kind": "interrupted",
        "text": "Interrupted",
        "terminal": True,
        "message": "Interrupt requested",
    })
    assert _has_event(events, "status.update", {
        "client_turn_id": "req_2",
        "state": "interrupted",
        "kind": "interrupted",
        "text": "Interrupted",
        "message": "Interrupt requested",
    })


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

    _assert_accepted_turn(accepted, "client_1")
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
    assert _has_event(events, "turn.status", {
        "client_turn_id": "client_1",
        "state": "interrupted",
        "kind": "interrupted",
        "text": "Interrupted",
        "terminal": True,
        "message": "Interrupt requested",
    })
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

    _assert_accepted_turn(accepted, "client_1")
    assert interrupted.result == {"interrupted": True}
    assert service.interrupted is True
    assert not any(
        method == "message.delta" and params.get("text") == "after interrupt"
        for method, params in events
    )
    assert _has_event(events, "turn.status", {
        "client_turn_id": "client_1",
        "state": "interrupted",
        "kind": "interrupted",
        "text": "Interrupted",
        "terminal": True,
        "message": "Interrupt requested",
    })


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
    interrupted = gateway.handle_request(
        RpcRequest(
            id="req_2",
            method="turn.interrupt",
            params={"rollback_user_input": True},
        )
    )
    service.release.set()
    gateway.wait_for_current_turn(timeout=2.0)

    turn_id = _assert_accepted_turn(accepted, "client_1")
    assert interrupted.result == {"interrupted": True}
    assert service.seen_token.interrupted is True
    assert service.seen_token.reason == "interrupt"
    assert service.seen_token.rollback_user_input is True
    assert {
        "client_turn_id": "client_1",
        "turn_id": turn_id,
        "turn_state": "interrupted",
        "assistant_message": "Interrupt requested",
        "activity_events": [],
        "progress_updates": [],
        "plan_steps": [],
        "pending_decision": False,
        "usage": {},
    } in [params for method, params in events if method == "turn.completed"]


def test_gateway_turn_interrupt_does_not_wait_for_blocking_cleanup_callback(
    tmp_path: Path,
) -> None:
    class BlockingCleanupTurnService(FakeTurnService):
        def __init__(self, root: Path) -> None:
            super().__init__(root)
            self.started = Event()
            self.cleanup_started = Event()
            self.release_cleanup = Event()

        def handle_user_turn(
            self,
            message: str,
            stream_sink: StreamSink | None = None,
            interrupt_token: RuntimeInterruptToken | None = None,
        ) -> TurnResponse:
            del message, stream_sink
            assert interrupt_token is not None

            def blocking_cleanup() -> None:
                self.cleanup_started.set()
                self.release_cleanup.wait(timeout=2.0)

            interrupt_token.add_callback(blocking_cleanup)
            self.started.set()
            interrupt_token.wait(2.0)
            interrupt_token.raise_if_interrupted()
            raise AssertionError("turn was not interrupted")

    service = BlockingCleanupTurnService(tmp_path)
    gateway = NodeTuiGateway(service=service)
    accepted = gateway.handle_request(
        RpcRequest(id="req_1", method="turn.submit", params={"message": "hello"})
    )
    assert accepted.error is None
    assert service.started.wait(timeout=1.0)

    started_at = time.monotonic()
    interrupted = gateway.handle_request(
        RpcRequest(id="req_2", method="turn.interrupt", params={})
    )
    elapsed = time.monotonic() - started_at

    assert interrupted.result == {"interrupted": True}
    assert elapsed < 0.05
    assert service.cleanup_started.wait(timeout=1.0)
    gateway.wait_for_current_turn(timeout=1.0)
    assert gateway._turn_running is False
    service.release_cleanup.set()


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

    _assert_accepted_turn(accepted, "req_1")
    assert interrupted.result == {"interrupted": True}


def test_gateway_queue_pop_returns_latest_follow_up_and_remaining_snapshot(
    tmp_path: Path,
) -> None:
    service = QueuePopTurnService(tmp_path)
    service.queue_steering_message(
        "keep steering [image #1]",
        image_paths=("/tmp/steer.png",),
    )
    service.queue_follow_up_message("first")
    service.queue_follow_up_message(
        "second [image #1]",
        image_paths=("/tmp/second.png",),
        client_turn_id="follow-up-2",
    )
    events: list[tuple[str, dict[str, object]]] = []
    gateway = NodeTuiGateway(
        service=service,
        emit=lambda method, params: events.append((method, params)),
    )

    response = gateway.handle_request(
        RpcRequest(id="pop-1", method="turn.queue.pop", params={})
    )

    assert response.result is not None
    assert response.result["item"] == {
        "kind": "follow_up",
        "message": "second [image #1]",
        "text": "second [image #1]",
        "source": "user",
        "local_images": [
            {"path": "/tmp/second.png", "placeholder": "[image #1]"}
        ],
        "client_turn_id": "follow-up-2",
    }
    assert response.result["steering"] == ["keep steering [image #1]"]
    assert response.result["follow_up"] == ["first"]
    assert response.result["has_pending_input"] is True
    assert any(
        method == "turn.queue.updated"
        and params["steering"] == ["keep steering [image #1]"]
        and params["follow_up"] == ["first"]
        for method, params in events
    )

    remaining = gateway.handle_request(
        RpcRequest(id="pop-2", method="turn.queue.pop", params={})
    )
    assert remaining.result is not None
    assert remaining.result["item"] is not None
    assert remaining.result["item"]["message"] == "first"

    empty = gateway.handle_request(
        RpcRequest(id="pop-3", method="turn.queue.pop", params={})
    )
    assert empty.result is not None
    assert empty.result["item"] is None
    assert empty.result["steering"] == ["keep steering [image #1]"]
    assert empty.result["follow_up"] == []

    status = gateway._status_payload()
    assert status["queued_steering_items"] == [
        {
            "kind": "steering",
            "message": "keep steering [image #1]",
            "text": "keep steering [image #1]",
            "source": "user",
            "local_images": [
                {"path": "/tmp/steer.png", "placeholder": "[image #1]"}
            ],
        }
    ]
    assert status["queued_follow_up_items"] == []


def test_gateway_exposes_server_turn_id_and_rejects_stale_steer(tmp_path: Path) -> None:
    service = QueueSchedulingTurnService(tmp_path)
    gateway = NodeTuiGateway(service=service)
    try:
        started = gateway.handle_request(
            RpcRequest(
                id="submit",
                method="turn.submit",
                params={"message": "start", "client_turn_id": "client-start"},
            )
        )
        assert service.started.wait(timeout=2.0)
        assert started.result is not None
        turn_id = str(started.result["turn_id"])

        response = gateway.handle_request(
            RpcRequest(
                id="steer",
                method="turn.steer",
                params={
                    "message": "inspect",
                    "client_turn_id": "client-steer",
                    "expected_turn_id": f"{turn_id}-stale",
                },
            )
        )

        assert started.result == {
            "accepted": True,
            "client_turn_id": "client-start",
            "turn_id": turn_id,
        }
        assert response.result is not None
        assert response.result["disposition"] == "deferred_to_end_of_turn"
        assert response.result["queue_items"]["rejected_steers"][0]["message"] == "inspect"
    finally:
        service.release.set()
        gateway.wait_for_current_turn(timeout=2.0)
        gateway.close()


def test_gateway_repeats_legacy_queue_handoff_until_matching_ack(
    tmp_path: Path,
) -> None:
    service = QueueSchedulingTurnService(tmp_path)
    service._queue.enqueue_steer(
        text="retry",
        client_turn_id="legacy-steer",
        expected_turn_id="turn-old",
        active_turn_id=None,
        steerable=False,
    )
    service._queue.enqueue_follow_up(
        text="later",
        client_turn_id="legacy-follow-up",
        image_paths=("/tmp/later.png",),
    )
    gateway = NodeTuiGateway(service=service)
    peer_gateway = NodeTuiGateway(service=service)
    try:
        request = RpcRequest(
            id="bootstrap-1",
            method="session.bootstrap",
            params={"protocol_version": 1},
        )
        first = gateway.handle_request(request)
        second = gateway.handle_request(
            RpcRequest(
                id="bootstrap-2",
                method="session.bootstrap",
                params={"protocol_version": 1},
            )
        )

        assert first.result is not None
        assert second.result is not None
        migration = first.result["legacy_user_queue_migration"]
        assert migration == second.result["legacy_user_queue_migration"]
        assert service.user_messages == []
        assert [record["kind"] for record in migration["records"]] == [
            "rejected_steer",
            "follow_up",
        ]
        assert migration["records"][1]["local_images"] == [
            {"path": "/tmp/later.png", "placeholder": "[image #1]"}
        ]

        ack = gateway.handle_request(
            RpcRequest(
                id="ack",
                method="turn.queue.migration.ack",
                params={"token": migration["token"]},
            )
        )
        after = gateway.handle_request(
            RpcRequest(
                id="bootstrap-3",
                method="session.bootstrap",
                params={"protocol_version": 1},
            )
        )

        assert ack.result == {"acknowledged": True, "token": migration["token"]}
        assert after.result is not None
        assert "legacy_user_queue_migration" not in after.result
        assert service.queue_snapshot().active_records() == ()

        stale = gateway.handle_request(
            RpcRequest(
                id="stale",
                method="turn.queue.migration.ack",
                params={"token": migration["token"]},
            )
        )
        assert stale.error is not None
        assert stale.error["code"] == "queue_conflict"

        peer_stale = peer_gateway.handle_request(
            RpcRequest(
                id="peer-stale",
                method="turn.queue.migration.ack",
                params={"token": migration["token"]},
            )
        )
        assert peer_stale.error is not None
        assert peer_stale.error["code"] == "queue_conflict"
        assert peer_gateway._legacy_queue_migration_pending is False
    finally:
        peer_gateway.close()
        gateway.close()


def test_gateway_starts_rejected_steer_as_a_new_server_turn(tmp_path: Path) -> None:
    service = QueueSchedulingTurnService(tmp_path)
    events: list[tuple[str, dict[str, object]]] = []
    gateway = NodeTuiGateway(
        service=service,
        emit=lambda method, params: events.append((method, params)),
    )
    try:
        first = gateway.handle_request(
            RpcRequest(
                id="submit",
                method="turn.submit",
                params={"message": "start", "client_turn_id": "client-start"},
            )
        )
        assert service.started.wait(timeout=2.0)
        assert first.result is not None
        steered = gateway.handle_request(
            RpcRequest(
                id="steer",
                method="turn.steer",
                params={
                    "message": "retry",
                    "client_turn_id": "client-steer",
                    "expected_turn_id": f"{first.result['turn_id']}-stale",
                },
            )
        )
        service.release.set()
        assert service.second_started.wait(timeout=2.0)
        gateway.wait_for_current_turn(timeout=2.0)

        started_ids = [
            str(params["turn_id"])
            for method, params in events
            if method == "turn.started"
        ]
        assert len(started_ids) == 2
        assert started_ids[0] != started_ids[1]
        assert service.server_turn_ids == started_ids
        assert service.user_messages == ["start", "retry"]
        assert steered.result is not None
        queue_id = str(steered.result["queue_items"]["rejected_steers"][0]["queue_id"])
        queued_event_index, queued_event = next(
            (index, params)
            for index, (method, params) in enumerate(events)
            if method == "turn.event"
            and params.get("kind") == "queued_message_committed"
        )
        second_started_index = next(
            index
            for index, (method, params) in enumerate(events)
            if method == "turn.started" and params.get("turn_id") == started_ids[1]
        )
        assert queued_event_index < second_started_index
        assert queued_event["text"] == "retry"
        assert queued_event["metadata"] == {
            "queued": True,
            "queue_kind": "rejected_steer",
            "source": "user",
            "queue_id": queue_id,
            "client_turn_id": "client-steer",
        }
    finally:
        service.release.set()
        gateway.close()


def test_gateway_retains_queue_while_interaction_is_pending(tmp_path: Path) -> None:
    service = QueueSchedulingTurnService(tmp_path)
    service.queue_blocked = True
    gateway = NodeTuiGateway(service=service)
    try:
        gateway.handle_request(
            RpcRequest(
                id="submit",
                method="turn.submit",
                params={"message": "start", "client_turn_id": "client-start"},
            )
        )
        assert service.started.wait(timeout=2.0)
        queued = gateway.handle_request(
            RpcRequest(
                id="follow",
                method="turn.follow_up",
                params={"message": "later", "client_turn_id": "client-follow"},
            )
        )
        service.release.set()
        gateway.wait_for_current_turn(timeout=2.0)
        assert service.blocker_checked.wait(timeout=2.0)

        assert service.user_messages == ["start"]
        assert queued.result is not None
        assert queued.result["queue_items"]["follow_ups"][0]["message"] == "later"
        assert [item.text for item in service.queue_snapshot().follow_ups] == ["later"]
    finally:
        service.release.set()
        gateway.close()


class StartFailingThread(Thread):
    def start(self) -> None:
        raise RuntimeError("worker start failed")


class FailSecondThreadFactory:
    def __init__(self) -> None:
        self.calls = 0

    def __call__(
        self,
        *,
        target: Callable[..., object],
        kwargs: dict[str, object],
        daemon: bool,
    ) -> Thread:
        self.calls += 1
        thread_type = Thread if self.calls == 1 else StartFailingThread
        return thread_type(target=target, kwargs=kwargs, daemon=daemon)


def test_gateway_keeps_record_when_next_worker_cannot_start(tmp_path: Path) -> None:
    service = QueueSchedulingTurnService(tmp_path)
    failure_seen = Event()

    def emit(method: str, params: dict[str, object]) -> None:
        if method == "gateway.error" and params.get("code") == "queue_worker_start_failed":
            failure_seen.set()

    gateway = NodeTuiGateway(
        service=service,
        emit=emit,
        turn_thread_factory=FailSecondThreadFactory(),
    )
    try:
        first = gateway.handle_request(
            RpcRequest(
                id="submit",
                method="turn.submit",
                params={"message": "start", "client_turn_id": "client-start"},
            )
        )
        assert service.started.wait(timeout=2.0)
        assert first.result is not None
        gateway.handle_request(
            RpcRequest(
                id="steer",
                method="turn.steer",
                params={
                    "message": "retry",
                    "client_turn_id": "client-steer",
                    "expected_turn_id": f"{first.result['turn_id']}-stale",
                },
            )
        )
        service.release.set()
        assert failure_seen.wait(timeout=2.0)

        assert service.user_messages == ["start"]
        assert [item.text for item in service.queue_snapshot().rejected_steers] == [
            "retry"
        ]
    finally:
        service.release.set()
        gateway.close()


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

    _assert_accepted_turn(accepted, "req_1")
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
    turn_id = response.result["turn_id"]

    assert response.result == {
        "accepted": True,
        "decision_id": "decision_current",
        "client_turn_id": "approval_req_1",
        "turn_id": turn_id,
    }
    assert isinstance(turn_id, str) and turn_id.startswith("turn_")
    assert next(params for method, params in events if method == "turn.started")[
        "turn_id"
    ] == turn_id
    assert next(params for method, params in events if method == "turn.completed")[
        "turn_id"
    ] == turn_id
    assert service.resolved_choices == ["1"]
    methods = [method for method, _params in events if method != "runtime.event"]
    assert methods[:3] == ["turn.started", "status.update", "approval.respond"]
    assert "message.delta" in methods
    assert "turn.completed" in methods
    assert "turn.status" in methods
    assert "status.changed" in methods
    assert methods.index("approval.respond") < methods.index("message.delta")
    direct_events = [item for item in events if item[0] != "runtime.event"]
    first_message_delta = next(
        index for index, (method, _params) in enumerate(direct_events) if method == "message.delta"
    )
    running_updates = [
        params
        for method, params in direct_events[:first_message_delta]
        if method == "status.update"
    ]
    assert [params["text"] for params in running_updates] == [
        "Resolving approval",
        "Running",
    ]
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

    _assert_accepted_turn(response, "approval_req_1")
    assert response.result["decision_id"] == "decision_current"
    assert service.resolved_choices == ["2"]
    status_texts = [
        params["text"]
        for method, params in events
        if method == "status.update"
    ]
    assert status_texts == ["Resolving approval", "Rejected"]


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

    _assert_accepted_turn(response, "approval_req_1")
    assert response.result["decision_id"] == "call_push_1"
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

    _assert_accepted_turn(response, "approval_req_1")
    assert response.result["decision_id"] == "call_lsof_1"
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

    turn_id = _assert_accepted_turn(response, "approval_req_1")
    assert response.result["decision_id"] == "call_lsof_1"
    assert ("approval.respond", {
        "client_turn_id": "approval_req_1",
        "turn_id": turn_id,
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


def test_gateway_approval_worker_contains_keyboard_interrupt(tmp_path: Path) -> None:
    class InterruptingApprovalService(FakeTurnService):
        def resolve_pending_decision(
            self,
            choice: str,
            stream_sink: StreamSink | None = None,
        ) -> TurnResponse:
            del choice, stream_sink
            raise KeyboardInterrupt()

    events: list[tuple[str, dict[str, object]]] = []
    gateway = NodeTuiGateway(
        service=InterruptingApprovalService(tmp_path),
        emit=lambda method, params: events.append((method, params)),
    )

    gateway._run_decision_worker(
        choice="1",
        client_turn_id="approval_req_1",
        turn_id="turn_approval_1",
        decision_id="call_shell_1",
    )

    assert any(method == "turn.interrupted" for method, _params in events)
    assert any(
        method == "turn.status" and params.get("state") == "interrupted"
        for method, params in events
    )
    assert not any(method == "turn.failed" for method, _params in events)


def test_gateway_interrupt_propagates_token_to_approval_resume(tmp_path: Path) -> None:
    class TokenAwareApprovalService(FakeTurnService):
        def __init__(self, root: Path) -> None:
            super().__init__(root)
            self.started = Event()
            self.seen_token: RuntimeInterruptToken | None = None

        def resolve_pending_decision(
            self,
            choice: str,
            stream_sink: StreamSink | None = None,
            interrupt_token: RuntimeInterruptToken | None = None,
        ) -> TurnResponse:
            del choice, stream_sink
            self.seen_token = interrupt_token
            self.started.set()
            assert interrupt_token is not None
            interrupt_token.wait(5)
            interrupt_token.raise_if_interrupted()
            raise AssertionError("approval resume was not interrupted")

    service = TokenAwareApprovalService(tmp_path)
    service.fake_session_service.pending_decision = PendingDecision(
        tool_call=ToolCall(
            name="Bash",
            arguments={"command": "pwd"},
            reason="inspect",
            call_id="call_interrupt_approval",
        ),
        kind=DecisionKind.NEEDS_CHOICE,
        reason="approval required",
        preview="pwd",
        options=(DecisionAction.APPROVE_ONCE, DecisionAction.REJECT),
    )
    gateway = NodeTuiGateway(service=service)

    accepted = gateway.handle_request(
        RpcRequest(
            id="req_approval",
            method="approval.respond",
            params={"decision_id": "call_interrupt_approval", "choice": "approve_once"},
        )
    )
    assert accepted.error is None
    assert service.started.wait(timeout=1)
    gateway.handle_request(RpcRequest(id="req_interrupt", method="turn.interrupt", params={}))
    gateway.wait_for_current_turn(timeout=1)

    assert service.seen_token is not None
    assert service.seen_token.interrupted is True


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

    turn_id = _assert_accepted_turn(response, "approval_req_1")
    assert response.result["decision_id"] == "decision_current"
    assert {
        "client_turn_id": "approval_req_1",
        "turn_id": turn_id,
        "state": "rejected",
        "kind": "rejected",
        "text": "Rejected",
        "terminal": True,
        "message": "Rejected Bash. Pending decision cleared.",
    } in [params for method, params in events if method == "turn.status"]
    assert {
        "client_turn_id": "approval_req_1",
        "turn_id": turn_id,
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
    turn_id = response.result["turn_id"]

    assert response.result == {
        "accepted": True,
        "request_id": "call_question_1",
        "client_turn_id": "clarify_req_1",
        "turn_id": turn_id,
    }
    assert isinstance(turn_id, str) and turn_id.startswith("turn_")
    assert next(params for method, params in events if method == "turn.started")[
        "turn_id"
    ] == turn_id
    assert next(params for method, params in events if method == "turn.completed")[
        "turn_id"
    ] == turn_id
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
        "turn_id": turn_id,
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


def test_gateway_clarification_resume_forwards_stream_events(tmp_path: Path) -> None:
    class StreamingClarificationService(FakeTurnService):
        def resolve_pending_clarification(
            self,
            request_id: str,
            response: str,
            stream_sink: StreamSink | None = None,
        ) -> TurnResponse:
            self.clarification_responses.append((request_id, response))
            if stream_sink is not None:
                stream_sink(RuntimeStreamEvent(kind="reasoning", text="continuing"))
                stream_sink(
                    RuntimeStreamEvent(
                        kind="tool_start",
                        tool_name="Read",
                        metadata={"tool_id": "call_read_1", "call_id": "call_read_1"},
                    )
                )
                stream_sink(
                    RuntimeStreamEvent(
                        kind="tool_complete",
                        tool_name="Read",
                        metadata={
                            "tool_id": "call_read_1",
                            "call_id": "call_read_1",
                            "success": True,
                        },
                    )
                )
                stream_sink(RuntimeStreamEvent(kind="text_delta", text="continued answer"))
            return TurnResponse(assistant_message="continued answer")

    events: list[tuple[str, dict[str, object]]] = []
    service = StreamingClarificationService(tmp_path)
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

    _assert_accepted_turn(response, "clarify_req_1")
    assert any(
        method == "reasoning.delta" and params.get("text") == "continuing"
        for method, params in events
    )
    assert any(
        method == "tool.start" and params.get("tool_id") == "call_read_1"
        for method, params in events
    )
    assert any(
        method == "tool.complete" and params.get("tool_id") == "call_read_1"
        for method, params in events
    )
    assert any(
        method == "message.delta" and params.get("text") == "continued answer"
        for method, params in events
    )


def test_gateway_clarification_worker_contains_keyboard_interrupt(tmp_path: Path) -> None:
    class InterruptingClarificationService(FakeTurnService):
        def resolve_pending_clarification(
            self,
            request_id: str,
            response: str,
            stream_sink: StreamSink | None = None,
        ) -> TurnResponse:
            del request_id, response, stream_sink
            raise KeyboardInterrupt()

    events: list[tuple[str, dict[str, object]]] = []
    gateway = NodeTuiGateway(
        service=InterruptingClarificationService(tmp_path),
        emit=lambda method, params: events.append((method, params)),
    )

    gateway._run_clarification_worker(
        request_id="call_question_1",
        response="Runtime",
        client_turn_id="clarify_req_1",
        turn_id="turn_clarify_1",
    )

    assert any(method == "turn.interrupted" for method, _params in events)
    assert any(
        method == "turn.status" and params.get("state") == "interrupted"
        for method, params in events
    )
    assert not any(method == "turn.failed" for method, _params in events)


def test_gateway_interrupt_propagates_token_to_clarification_resume(tmp_path: Path) -> None:
    class TokenAwareClarificationService(FakeTurnService):
        def __init__(self, root: Path) -> None:
            super().__init__(root)
            self.started = Event()
            self.seen_token: RuntimeInterruptToken | None = None

        def resolve_pending_clarification(
            self,
            request_id: str,
            response: str,
            stream_sink: StreamSink | None = None,
            interrupt_token: RuntimeInterruptToken | None = None,
        ) -> TurnResponse:
            del request_id, response, stream_sink
            self.seen_token = interrupt_token
            self.started.set()
            assert interrupt_token is not None
            interrupt_token.wait(5)
            interrupt_token.raise_if_interrupted()
            raise AssertionError("clarification resume was not interrupted")

    service = TokenAwareClarificationService(tmp_path)
    gateway = NodeTuiGateway(service=service)

    accepted = gateway.handle_request(
        RpcRequest(
            id="req_clarify",
            method="clarify.respond",
            params={"request_id": "call_question_1", "response": "Runtime"},
        )
    )
    assert accepted.error is None
    assert service.started.wait(timeout=1)
    gateway.handle_request(RpcRequest(id="req_interrupt", method="turn.interrupt", params={}))
    gateway.wait_for_current_turn(timeout=1)

    assert service.seen_token is not None
    assert service.seen_token.interrupted is True


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

    turn_id = _assert_accepted_turn(response, "approval_req_1")
    assert response.result["decision_id"] == "decision_current"
    assert {
        "client_turn_id": "approval_req_1",
        "turn_id": turn_id,
        "state": "failed",
        "kind": "failed",
        "text": "Failed",
        "terminal": True,
        "message": "approval resolution failed",
    } in [params for method, params in events if method == "turn.status"]
