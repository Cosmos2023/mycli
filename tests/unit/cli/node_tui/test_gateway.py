from __future__ import annotations

from collections.abc import Callable
from pathlib import Path
from threading import Event
from types import SimpleNamespace

from mycli.application.turn_service import TurnService
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


StreamSink = Callable[[RuntimeStreamEvent], None]


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

    def list_sessions(self, limit: int = 20) -> tuple[SimpleNamespace, ...]:
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


class FakeService(TurnService):
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
        self.fake_session_service = FakeSessionService()
        self._session_service = self.fake_session_service

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

    def handle_user_turn(
        self,
        message: str,
        stream_sink: StreamSink | None = None,
    ) -> TurnResponse:
        del message, stream_sink
        return TurnResponse(assistant_message="")

    def resolve_pending_decision(self, choice: str) -> TurnResponse:
        del choice
        return TurnResponse(assistant_message="")

    def resolve_pending_clarification(self, request_id: str, response: str) -> TurnResponse:
        del request_id, response
        return TurnResponse(assistant_message="")

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

    def resolve_pending_decision(self, choice: str) -> TurnResponse:
        self.resolved_choices.append(choice)
        self.fake_session_service.pending_decision = None
        return TurnResponse(assistant_message=f"resolved {choice}")

    def resolve_pending_clarification(self, request_id: str, response: str) -> TurnResponse:
        self.clarification_responses.append((request_id, response))
        return TurnResponse(assistant_message=f"clarified {response}")


class BlockingTurnService(FakeTurnService):
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
                        "success": False,
                        "error": "Missing required parameter: content",
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
        return TurnResponse(assistant_message="waiting")


class FailingTurnService(FakeService):
    def handle_user_turn(
        self,
        message: str,
        stream_sink: StreamSink | None = None,
    ) -> TurnResponse:
        del message, stream_sink
        raise RuntimeError("model unavailable")

    def resolve_pending_decision(self, choice: str) -> TurnResponse:
        del choice
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
        "success": True,
    }
    assert next(params for method, params in events if method == "tool.failed") == {
        "client_turn_id": "client_1",
        "tool_id": "call_write_1",
        "call_id": "call_write_1",
        "name": "Write",
        "duration_s": 0.002,
        "summary": "Tool Write could not run.",
        "success": False,
        "error": "Missing required parameter: content",
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


def test_gateway_turn_submit_emits_approval_request_when_waiting(tmp_path: Path) -> None:
    events: list[tuple[str, dict[str, object]]] = []
    service = FakeTurnService(tmp_path)

    def pending_turn(_message: str, stream_sink: StreamSink | None = None) -> TurnResponse:
        del stream_sink
        decision = PendingDecision(
            tool_call=ToolCall(name="Bash", arguments={"command": "git push"}, reason="push"),
            kind=DecisionKind.NEEDS_CHOICE,
            reason="git push requires confirmation.",
            preview="git push",
            options=(DecisionAction.APPROVE_ONCE, DecisionAction.REJECT),
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
    service = BlockingTurnService(tmp_path)
    gateway = NodeTuiGateway(service=service)

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
    assert {
        "state": "interrupted",
        "kind": "interrupted",
        "text": "Interrupted",
        "terminal": True,
        "message": "Interrupt requested",
    } in [params for method, params in events if method == "turn.status"]


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
    assert [method for method, _params in events if method != "runtime.event"] == [
        "turn.started",
        "status.update",
        "approval.respond",
        "turn.completed",
        "turn.status",
        "message.complete",
        "status.update",
        "status.changed",
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
    gateway = NodeTuiGateway(service=FakeTurnService(tmp_path))

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


def test_gateway_decision_resolve_emits_turn_status_for_failures(tmp_path: Path) -> None:
    events: list[tuple[str, dict[str, object]]] = []
    service = FailingTurnService(tmp_path)
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
    assert {
        "client_turn_id": "approval_req_1",
        "state": "failed",
        "kind": "failed",
        "text": "Failed",
        "terminal": True,
        "message": "approval resolution failed",
    } in [params for method, params in events if method == "turn.status"]
