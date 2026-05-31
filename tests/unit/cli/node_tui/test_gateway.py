from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

from mycli.cli.node_tui.gateway import (
    NodeTuiGateway,
    supported_event_streams,
    supported_rpc_methods,
)
from mycli.cli.node_tui.protocol import RpcRequest
from mycli.domain.runtime import (
    DecisionAction,
    DecisionKind,
    PendingDecision,
    RuntimeStreamEvent,
    TurnResponse,
)
from mycli.domain.runtime.session_history import HistoryItem, HistoryItemType
from mycli.domain.tooling.calls import ToolCall


class FakeSessionService:
    def __init__(self) -> None:
        self.history_items: tuple[HistoryItem, ...] = ()
        self.pending_decision: object | None = None

    def load_pending_decision(self, _session_id: str) -> object | None:
        return self.pending_decision

    def load_suspended_turn(self, _session_id: str) -> object | None:
        return None

    def load_history_items(self, _session_id: str) -> tuple[HistoryItem, ...]:
        return self.history_items

    def list_sessions(self, limit: int = 20):
        del limit
        return (
            SimpleNamespace(
                session_id="demo",
                last_active_at="2026-05-27T01:33:04Z",
                message_count=4,
                status="active",
                summary_count=0,
            ),
        )


class FakeService:
    def __init__(self, workspace_root: Path) -> None:
        self._config = SimpleNamespace(
            session_id="demo",
            workspace_root=workspace_root,
            model="deepseek-v4-flash",
            provider=SimpleNamespace(value="deepseek"),
            protocol=SimpleNamespace(value="chat_completions"),
            max_prompt_tokens=100000,
            tui_startup_mark="default",
        )
        self._session_service = FakeSessionService()

    def inspect_usage(self) -> tuple[str, ...]:
        return ("session=demo", "turns=1")

    def inspect_status(self) -> tuple[str, ...]:
        return ("session=demo context=unknown",)

    def set_view_mode(self, mode: str) -> tuple[str, ...]:
        return (f"mode={mode}",)

    def current_context_window_metrics(self) -> dict[str, object]:
        return {"input_tokens": 123, "max_tokens": 100000, "source": "provider"}

    def resume_session(self, session_id: str | None = None) -> tuple[str, ...]:
        return (f"resumed {session_id or 'demo'}", "messages=4")

    def export_trace_jsonl(self, *, tail: int = 50) -> tuple[str, ...]:
        return tuple(f'{{"kind":"tool_execution","turn_id":"turn_{index}","payload":{{}}}}' for index in range(tail))

    def extension_manifest(self) -> dict[str, object]:
        return {
            "schema_version": 1,
            "agent": {"name": "mycli"},
            "rpc_methods": [{"name": "extension.manifest"}],
            "event_streams": [],
            "capabilities": [],
        }


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
    assert response.error is None


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
    gateway = NodeTuiGateway(service=FakeService(tmp_path))

    response = gateway.handle_request(
        RpcRequest(id="req_1", method="session.bootstrap", params={"protocol_version": 999})
    )

    assert response.error == {
        "code": "incompatible_protocol",
        "message": "Unsupported Node TUI protocol version: 999",
    }


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

    assert usage.result is not None
    assert usage.result["presentation"] == "overlay"
    assert usage.result["exit_requested"] is False
    assert view.result is not None
    assert view.result["view_mode"] == "verbose"
    assert view.result["presentation"] == "transcript"
    assert quit_response.result is not None
    assert quit_response.result["exit_requested"] is True


def test_gateway_transcript_load_projects_history_items(tmp_path: Path) -> None:
    service = FakeService(tmp_path)
    service._session_service.history_items = (
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
    )
    gateway = NodeTuiGateway(service=service)

    response = gateway.handle_request(
        RpcRequest(
            id="req_1",
            method="transcript.load",
            params={"session_id": "demo", "limit": 20, "before": None},
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
        ],
        "next_before": None,
    }


def test_gateway_slash_completion_filters_candidates(tmp_path: Path) -> None:
    gateway = NodeTuiGateway(service=FakeService(tmp_path))

    response = gateway.handle_request(
        RpcRequest(id="req_1", method="completion.slash", params={"prefix": "/sta"})
    )

    assert response.result is not None
    values = [item["value"] for item in response.result["items"]]
    assert "/status" in values
    assert "/stats" in values


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
                "last_active": "2026-05-27T01:33:04Z",
                "message_count": 4,
                "current": True,
            }
        ]
    }
    assert resumed.result == {
        "session_id": "demo",
        "lines": ["[session] resumed demo", "[session] messages=4"],
    }


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
    gateway = NodeTuiGateway(service=FakeService(tmp_path))

    response = gateway.handle_request(RpcRequest(id="req_1", method="missing.method", params={}))

    assert response.error == {
        "code": "method_not_found",
        "message": "Unknown method: missing.method",
    }


class FakeTurnService(FakeService):
    def __init__(self, workspace_root: Path) -> None:
        super().__init__(workspace_root)
        self.turn_calls: list[str] = []
        self.resolved_choices: list[str] = []

    def handle_user_turn(self, message: str, stream_sink=None) -> TurnResponse:
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

    def resolve_pending_decision(self, choice: str) -> TurnResponse:
        self.resolved_choices.append(choice)
        self._session_service.pending_decision = None
        return TurnResponse(assistant_message=f"resolved {choice}")


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
    assert [method for method, _params in events] == [
        "turn.started",
        "status.update",
        "turn.event",
        "turn.event",
        "turn.event",
        "turn.event",
        "turn.completed",
        "status.update",
        "status.changed",
    ]
    assert events[1][1] == {
        "client_turn_id": "client_1",
        "state": "running",
        "kind": "running",
        "text": "Running",
    }
    completed = events[-3][1]
    assert completed["assistant_message"] == "hello world"
    assert completed["progress_updates"] == ["[progress] done"]
    assert completed["plan_steps"] == ["completed: smoke"]
    assert completed["turn_state"] == "completed"
    assert events[-2][1] == {
        "client_turn_id": "client_1",
        "state": "completed",
        "kind": "completed",
        "text": "Completed",
    }


def test_gateway_turn_submit_emits_approval_request_when_waiting(tmp_path: Path) -> None:
    events: list[tuple[str, dict[str, object]]] = []
    service = FakeTurnService(tmp_path)

    def pending_turn(_message: str, stream_sink=None) -> TurnResponse:
        del stream_sink
        decision = PendingDecision(
            tool_call=ToolCall(name="Bash", arguments={"command": "git push"}, reason="push"),
            kind=DecisionKind.NEEDS_CHOICE,
            reason="git push requires confirmation.",
            preview="git push",
            options=(DecisionAction.APPROVE_ONCE, DecisionAction.REJECT),
        )
        service._session_service.pending_decision = decision
        return TurnResponse(assistant_message="", pending_decision=decision)

    service.handle_user_turn = pending_turn  # type: ignore[method-assign]
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
        "decision_id": "decision_current",
        "preview": "git push",
        "reason": "git push requires confirmation.",
        "tool_name": "Bash",
        "options": [
            {"choice": "approve_once", "label": "Allow once"},
            {"choice": "reject", "label": "Reject"},
        ],
    }
    completed = next(params for method, params in events if method == "turn.completed")
    assert completed["turn_state"] == "waiting_approval"
    assert {
        "client_turn_id": "client_1",
        "state": "waiting_approval",
        "kind": "waiting_approval",
        "text": "Waiting approval",
    } in [params for method, params in events if method == "status.update"]


def test_gateway_turn_submit_rejects_empty_and_concurrent_turns(tmp_path: Path) -> None:
    gateway = NodeTuiGateway(service=FakeTurnService(tmp_path))

    empty = gateway.handle_request(
        RpcRequest(id="req_1", method="turn.submit", params={"message": "   "})
    )
    accepted = gateway.handle_request(
        RpcRequest(id="req_2", method="turn.submit", params={"message": "hello"})
    )
    concurrent = gateway.handle_request(
        RpcRequest(id="req_3", method="turn.submit", params={"message": "again"})
    )
    gateway.wait_for_current_turn(timeout=2.0)

    assert empty.error == {"code": "invalid_params", "message": "message is required."}
    assert accepted.result == {"accepted": True, "client_turn_id": "req_2"}
    assert concurrent.error == {"code": "turn_in_progress", "message": "A turn is already running."}


def test_gateway_turn_interrupt_reports_running_state(tmp_path: Path) -> None:
    gateway = NodeTuiGateway(service=FakeTurnService(tmp_path))
    idle = gateway.handle_request(RpcRequest(id="req_1", method="turn.interrupt", params={}))
    accepted = gateway.handle_request(
        RpcRequest(id="req_2", method="turn.submit", params={"message": "hello"})
    )
    running = gateway.handle_request(RpcRequest(id="req_3", method="turn.interrupt", params={}))
    gateway.wait_for_current_turn(timeout=2.0)

    assert idle.result == {"interrupted": False}
    assert accepted.result == {"accepted": True, "client_turn_id": "req_2"}
    assert running.result == {"interrupted": True}


def test_gateway_decision_resolve_maps_choice_and_emits_turn_events(tmp_path: Path) -> None:
    events: list[tuple[str, dict[str, object]]] = []
    service = FakeTurnService(tmp_path)
    service._session_service.pending_decision = PendingDecision(
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
    assert [method for method, _params in events] == [
        "turn.started",
        "status.update",
        "approval.respond",
        "turn.completed",
        "status.update",
        "status.changed",
    ]


def test_gateway_approval_respond_maps_choice_and_keeps_decision_resolve_compatible(
    tmp_path: Path,
) -> None:
    service = FakeTurnService(tmp_path)
    service._session_service.pending_decision = PendingDecision(
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
