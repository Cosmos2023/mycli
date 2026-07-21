from __future__ import annotations

import json
import os
from collections.abc import Callable
from dataclasses import replace
from pathlib import Path
from threading import Event, Lock
import time
from types import SimpleNamespace
from typing import Any, cast

from mycli.application.runtime.agent_runtime import AgentRuntime
from mycli.application.turn_service import TurnService
from mycli.cli.node_tui.process import NodeTuiProcess
from mycli.cli.node_tui.gateway import NodeTuiGateway, run_node_tui_gateway
from mycli.cli.node_tui.protocol import RpcRequest
from mycli.domain.conversation import Conversation
from mycli.domain.runtime import (
    AgentConfig,
    CollaborationMode,
    DecisionAction,
    DecisionKind,
    ModelTurnResult,
    PendingDecision,
    PendingClarification,
    ReasoningEffort,
    RuntimeBlock,
    RuntimeItem,
    RuntimeStreamEvent,
    StopReason,
    SuspendedTurn,
    TurnRecord,
    TurnResponse,
    TurnStatus,
)
from mycli.domain.tooling.calls import ToolCall
from mycli.tools.registry import ToolRegistry
from mycli.tools.bash import BashTool
from mycli.tools.shell_registry import SHELL_REGISTRY
from mycli.tools.write import WriteTool


def node_scripted_client_args(repo_root: Path) -> list[str]:
    return [
        str(repo_root / "tui" / "mycli-shell" / "node_modules" / ".bin" / "tsx"),
        str(repo_root / "tui" / "mycli-shell" / "test" / "support" / "scripted-client.ts"),
    ]


def e2e_config(**overrides: object) -> SimpleNamespace:
    values: dict[str, object] = {
        "session_id": "demo",
        "workspace_root": Path.cwd(),
        "model": "gpt-smoke",
        "collaboration_mode": CollaborationMode.DEFAULT,
        "reasoning_effort": ReasoningEffort.MEDIUM,
        "thinking_enabled": True,
        "thinking_effort": ReasoningEffort.MEDIUM,
        "provider": SimpleNamespace(value="test"),
        "protocol": SimpleNamespace(value="chat_completions"),
        "max_prompt_tokens": 12000,
        "tui_startup_mark": "default",
    }
    values.update(overrides)
    return SimpleNamespace(**values)


class FakeNodeProcess:
    def __init__(self, incoming: list[str]) -> None:
        self.incoming = incoming
        self.written: list[str] = []
        self.terminated = False

    def start(self) -> None:
        return None

    def read_line(self) -> str:
        if not self.incoming:
            return ""
        return self.incoming.pop(0)

    def write_line(self, line: str) -> None:
        self.written.append(line)

    def wait(self) -> int:
        return 0

    def terminate(self) -> None:
        self.terminated = True


class BrokenPipeNodeProcess(FakeNodeProcess):
    def __init__(self, incoming: list[str], *, fail_after_writes: int) -> None:
        super().__init__(incoming)
        self.fail_after_writes = fail_after_writes

    def write_line(self, line: str) -> None:
        if len(self.written) >= self.fail_after_writes:
            raise BrokenPipeError
        super().write_line(line)


class FakeService:
    def __init__(self, workspace_root: Path) -> None:
        self._config = e2e_config(
            session_id="demo",
            workspace_root=workspace_root,
            model="gpt-test",
            provider=SimpleNamespace(value="deepseek"),
        )
        self._session_service = SimpleNamespace(
            load_pending_decision=lambda _session_id: None,
            load_suspended_turn=lambda _session_id: None,
            list_sessions=lambda limit=20: (),
            append_command_result=lambda **_kwargs: None,
        )

    def current_context_window_metrics(self) -> dict[str, object]:
        return {}

    def handle_user_turn(
        self,
        message: str,
        stream_sink: Callable[[RuntimeStreamEvent], None] | None = None,
    ) -> TurnResponse:
        assert message == "hello"
        if stream_sink is not None:
            stream_sink(RuntimeStreamEvent(kind="text_delta", text="hi"))
        return TurnResponse(assistant_message="hi")

    def inspect_usage(self) -> tuple[str, ...]:
        return ("session=demo", "turns=1")

    def resume_session(self, session_id: str | None = None) -> tuple[str, ...]:
        return (f"resumed {session_id}",)


def test_gateway_stops_only_owned_background_shells_without_model_requests(
    tmp_path: Path,
) -> None:
    class NoModelRequestsAdapter:
        def __init__(self) -> None:
            self.calls = 0

        def next_turn(self, *, items: object, tools: object) -> ModelTurnResult:
            del items, tools
            self.calls += 1
            raise AssertionError("shell lifecycle must not request the model")

    adapter = NoModelRequestsAdapter()
    bash = BashTool(tmp_path)
    config = AgentConfig(
        workspace_root=tmp_path,
        session_id="gateway-shell-owner",
    )
    runtime = AgentRuntime(
        model_adapter=adapter,
        tool_registry=ToolRegistry.from_tools([bash]),
        config=config,
        home_dir=tmp_path / "home",
    )
    service = TurnService(
        runtime=runtime,
        config=config,
        home_dir=tmp_path / "home",
    )
    events: list[tuple[str, dict[str, object]]] = []
    gateway = NodeTuiGateway(
        service=service,
        emit=lambda method, params: events.append((method, params)),
    )
    first = bash.execute({"command": "sleep 30", "run_in_background": True})
    second = bash.execute({"command": "sleep 30", "run_in_background": True})
    foreign = SHELL_REGISTRY.execute(
        "sleep 30",
        owner_session_id="gateway-shell-foreign",
        workdir=str(tmp_path),
        background=True,
    )
    first_id = str(first.raw_payload["shell_id"])
    second_id = str(second.raw_payload["shell_id"])
    foreign_id = str(foreign["shell_id"])

    try:
        active_rows = gateway._status_payload()["background_shells"]
        assert isinstance(active_rows, list)
        assert len(active_rows) == 2

        ps_response = gateway.handle_request(
            RpcRequest(
                id="req-ps-real",
                method="command.run",
                params={"command": "/ps"},
            )
        )
        assert ps_response.result is not None
        assert ps_response.result["command_kind"] == "background_shells"
        assert {
            row["shell_id"] for row in ps_response.result["processes"]
        } == {first_id, second_id}

        stop_response = gateway.handle_request(
            RpcRequest(
                id="req-stop-real",
                method="command.run",
                params={"command": "/stop"},
            )
        )
        assert stop_response.result is not None
        assert stop_response.result["command_kind"] == "shell_stop"

        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            terminal_ids = [
                payload["shell_id"]
                for method, payload in events
                if method == "shell.completed"
            ]
            steering, _ = runtime.queued_messages()
            if len(terminal_ids) >= 2 and len(steering) >= 2:
                break
            time.sleep(0.01)

        assert first_id not in SHELL_REGISTRY.processes()
        assert second_id not in SHELL_REGISTRY.processes()
        assert foreign_id in SHELL_REGISTRY.processes()
        terminal_ids = [
            payload["shell_id"]
            for method, payload in events
            if method == "shell.completed"
        ]
        assert terminal_ids.count(first_id) == 1
        assert terminal_ids.count(second_id) == 1
        steering, follow_up = runtime.queued_messages()
        assert follow_up == ()
        assert len(steering) == 2
        assert sum(first_id in message for message in steering) == 1
        assert sum(second_id in message for message in steering) == 1
        assert adapter.calls == 0
    finally:
        gateway.close()
        SHELL_REGISTRY.kill(
            foreign_id,
            owner_session_id="gateway-shell-foreign",
        )
        runtime.close()


def test_run_node_tui_gateway_processes_fake_node_requests(tmp_path: Path) -> None:
    process = FakeNodeProcess(
        [
            '{"jsonrpc":"2.0","id":"1","method":"session.bootstrap","params":{"protocol_version":1}}\n',
            '{"jsonrpc":"2.0","id":"2","method":"turn.submit","params":{"message":"hello","client_turn_id":"c1"}}\n',
            '{"jsonrpc":"2.0","id":"3","method":"command.run","params":{"command":"/usage"}}\n',
            '{"jsonrpc":"2.0","id":"4","method":"shutdown","params":{}}\n',
        ]
    )

    exit_code = run_node_tui_gateway(service=cast(TurnService, FakeService(tmp_path)), process=process)

    assert exit_code == 0
    output = "".join(process.written)
    assert '"id":"1"' in output
    assert '"method":"turn.started"' in output
    assert '"method":"turn.event"' in output
    assert '"method":"turn.completed"' in output
    assert '"Session: demo"' in output
    assert '"kind":"diagnostic"' in output


def test_run_node_tui_gateway_handles_node_broken_pipe(tmp_path: Path) -> None:
    process = BrokenPipeNodeProcess(
        [
            '{"jsonrpc":"2.0","id":"1","method":"session.bootstrap","params":{"protocol_version":1}}\n',
            '{"jsonrpc":"2.0","id":"2","method":"turn.submit","params":{"message":"hello","client_turn_id":"c1"}}\n',
        ],
        fail_after_writes=2,
    )

    exit_code = run_node_tui_gateway(service=cast(TurnService, FakeService(tmp_path)), process=process)

    assert exit_code == 0
    assert process.terminated is True


def test_run_node_tui_gateway_reports_non_request_messages_with_declared_error_code(
    tmp_path: Path,
) -> None:
    process = FakeNodeProcess(
        [
            '{"jsonrpc":"2.0","method":"client.notification","params":{}}\n',
            '{"jsonrpc":"2.0","id":"1","method":"shutdown","params":{}}\n',
        ]
    )

    exit_code = run_node_tui_gateway(service=cast(TurnService, FakeService(tmp_path)), process=process)

    assert exit_code == 0
    output = "".join(process.written)
    assert '"method":"gateway.error"' in output
    assert '"code":"invalid_params"' in output
    assert '"message":"Expected request."' in output
    assert '"code":"invalid_request"' not in output


class E2ESessionService:
    def append_command_result(self, **_kwargs: object) -> None:
        return None

    def load_pending_decision(self, _session_id: str) -> object | None:
        return None

    def load_suspended_turn(self, _session_id: str) -> object | None:
        return None

    def load_history_items(self, _session_id: str) -> tuple[object, ...]:
        return ()

    def list_sessions(self, limit: int = 20) -> tuple[object, ...]:
        del limit
        return ()


class E2ETypedStreamService:
    def __init__(self, workspace_root: Path) -> None:
        self._config = e2e_config(
            session_id="typed-smoke",
            workspace_root=workspace_root,
        )
        self._session_service = E2ESessionService()
        self.messages: list[str] = []

    def current_context_window_metrics(self) -> dict[str, object]:
        return {"input_tokens": 10, "max_tokens": 12000, "source": "test"}

    def handle_user_turn(
        self,
        message: str,
        stream_sink: Callable[[RuntimeStreamEvent], None] | None = None,
    ) -> TurnResponse:
        self.messages.append(message)
        if stream_sink is not None:
            stream_sink(RuntimeStreamEvent(kind="reasoning", text="checking files"))
            stream_sink(RuntimeStreamEvent(kind="text_delta", text="hel"))
            stream_sink(RuntimeStreamEvent(kind="text_delta", text="lo"))
            stream_sink(
                RuntimeStreamEvent(kind="completed", metadata={"response_status": "completed"})
            )
        return TurnResponse(assistant_message="hello final")

    def inspect_usage(self) -> tuple[str, ...]:
        return ("session=typed-smoke",)

    def inspect_status(self) -> tuple[str, ...]:
        return ("session=typed-smoke context=test",)

    def set_view_mode(self, mode: str) -> tuple[str, ...]:
        return (f"mode={mode}",)

    def resume_session(self, session_id: str | None = None) -> tuple[str, ...]:
        return (f"resumed {session_id or 'typed-smoke'}",)


def test_run_node_tui_gateway_with_real_node_scripted_client_typed_stream(
    tmp_path: Path,
) -> None:
    repo_root = Path(__file__).resolve().parents[2]
    dump_path = tmp_path / "node-state.json"
    process = NodeTuiProcess(
        args=node_scripted_client_args(repo_root),
        env={
            **os.environ,
            "MYCLI_NODE_TUI_SCRIPT": json.dumps(["/help", "/usage", "hello"]),
            "MYCLI_NODE_TUI_STATE_DUMP": str(dump_path),
        },
        cwd=repo_root,
    )
    service = E2ETypedStreamService(tmp_path)

    exit_code = run_node_tui_gateway(service=cast(TurnService, service), process=process)

    assert exit_code == 0
    assert service.messages == ["hello"]
    state = json.loads(dump_path.read_text(encoding="utf-8"))
    command_items = [
        item
        for item in state["transcript"]
        if item["type"] in {"command_output", "command_result"}
    ]
    assert len(command_items) == 2
    assert "/usage" in command_items[0]["text"]
    assert "/status usage" not in command_items[0]["text"]
    assert command_items[1]["type"] == "command_result"
    assert command_items[1]["text"] == "Usage\nSession: typed-smoke"
    assert command_items[1]["metadata"]["command"] == "/usage"
    assert command_items[1]["metadata"]["display"]["kind"] == "diagnostic"
    assistant_items = [
        item for item in state["transcript"] if item["type"] in {"assistant_stream", "assistant_final"}
    ]
    assert [item["text"] for item in assistant_items] == ["hello final"]
    assert "checking files" not in assistant_items[0]["text"]
    assert "hellohello" not in assistant_items[0]["text"]


class E2EWaitingSessionService:
    def __init__(self) -> None:
        self.pending_decision: PendingDecision | None = None
        self.suspended_turn: TurnRecord | None = None

    def append_command_result(self, **_kwargs: object) -> None:
        return None

    def load_pending_decision(self, _session_id: str) -> object | None:
        return self.pending_decision

    def load_suspended_turn(self, _session_id: str) -> object | None:
        return self.suspended_turn

    def load_history_items(self, _session_id: str) -> tuple[object, ...]:
        return ()

    def list_sessions(self, limit: int = 20) -> tuple[object, ...]:
        del limit
        return ()


class E2EWaitingStateService:
    def __init__(self, workspace_root: Path) -> None:
        self._config = e2e_config(
            session_id="waiting-smoke",
            workspace_root=workspace_root,
        )
        self._session_service = E2EWaitingSessionService()
        self.messages: list[str] = []
        self.resolved_choices: list[str] = []
        self.clarification_responses: list[tuple[str, str]] = []

    def current_context_window_metrics(self) -> dict[str, object]:
        return {"input_tokens": 10, "max_tokens": 12000, "source": "test"}

    def handle_user_turn(
        self,
        message: str,
        stream_sink: Callable[[RuntimeStreamEvent], None] | None = None,
    ) -> TurnResponse:
        self.messages.append(message)
        if message == "needs approval":
            decision = PendingDecision(
                tool_call=ToolCall(
                    name="Bash",
                    arguments={"command": "git push"},
                    reason="approval smoke",
                    call_id="call_approval_1",
                ),
                kind=DecisionKind.NEEDS_CHOICE,
                reason="git push requires confirmation.",
                preview="git push",
                options=(DecisionAction.APPROVE_ONCE, DecisionAction.REJECT),
            )
            self._session_service.pending_decision = decision
            return TurnResponse(assistant_message="", pending_decision=decision)
        if message == "needs clarification":
            turn = TurnRecord(
                thread_id="waiting-smoke",
                turn_id="turn_clarify_1",
                status=TurnStatus.WAITING_CLARIFICATION,
                started_at="2026-05-31T00:00:00Z",
                stop_reason=StopReason.CLARIFICATION_REQUIRED,
                user_message=message,
            )
            self._session_service.suspended_turn = turn
            if stream_sink is not None:
                stream_sink(
                    RuntimeStreamEvent(
                        kind="clarify_request",
                        metadata={
                            "request_id": "call_question_1",
                            "tool_id": "call_question_1",
                            "call_id": "call_question_1",
                            "tool_name": "AskUserQuestion",
                            "question": "Which slice should come next?",
                            "options": [{"label": "Runtime"}, {"label": "TUI"}],
                            "header": "Scope",
                            "multi_select": False,
                        },
                    )
                )
            return TurnResponse(assistant_message="", turn=turn)
        raise AssertionError(f"unexpected message: {message}")

    def resolve_pending_decision(
        self,
        choice: str,
        stream_sink: Callable[[RuntimeStreamEvent], None] | None = None,
    ) -> TurnResponse:
        del stream_sink
        self.resolved_choices.append(choice)
        self._session_service.pending_decision = None
        if choice == "2":
            return TurnResponse(
                assistant_message="Rejected Bash. Pending decision cleared.",
                turn=TurnRecord(
                    thread_id="waiting-smoke",
                    turn_id="turn_rejected_1",
                    status=TurnStatus.REJECTED,
                    started_at="2026-05-31T00:00:00Z",
                    stop_reason=StopReason.APPROVAL_REJECTED,
                    user_message="needs approval",
                ),
            )
        return TurnResponse(assistant_message="approval resolved")

    def resolve_pending_clarification(self, request_id: str, response: str) -> TurnResponse:
        self.clarification_responses.append((request_id, response))
        self._session_service.suspended_turn = None
        return TurnResponse(assistant_message="clarification resolved")

    def inspect_usage(self) -> tuple[str, ...]:
        return ("session=waiting-smoke",)

    def inspect_status(self) -> tuple[str, ...]:
        return ("session=waiting-smoke context=test",)

    def set_view_mode(self, mode: str) -> tuple[str, ...]:
        return (f"mode={mode}",)

    def resume_session(self, session_id: str | None = None) -> tuple[str, ...]:
        return (f"resumed {session_id or 'waiting-smoke'}",)


def test_run_node_tui_gateway_with_real_node_scripted_client_waiting_state_routes(
    tmp_path: Path,
) -> None:
    repo_root = Path(__file__).resolve().parents[2]
    dump_path = tmp_path / "node-waiting-state.json"
    process = NodeTuiProcess(
        args=node_scripted_client_args(repo_root),
        env={
            **os.environ,
            "MYCLI_NODE_TUI_SCRIPT": json.dumps(
                [
                    "needs approval",
                    {"type": "approval.respond", "choice": "approve_once"},
                    "needs clarification",
                    {"type": "clarify.respond", "response": "Runtime"},
                ]
            ),
            "MYCLI_NODE_TUI_STATE_DUMP": str(dump_path),
        },
        cwd=repo_root,
    )
    service = E2EWaitingStateService(tmp_path)

    exit_code = run_node_tui_gateway(service=cast(TurnService, service), process=process)

    assert exit_code == 0
    assert service.messages == ["needs approval", "needs clarification"]
    assert service.resolved_choices == ["1"]
    assert service.clarification_responses == [("call_question_1", "Runtime")]
    state = json.loads(dump_path.read_text(encoding="utf-8"))
    assert state["pendingApproval"] is None
    assert state["pendingClarification"] is None
    assert state["liveStatus"]["state"] == "completed"
    approval_items = [item for item in state["transcript"] if item["type"] == "approval"]
    clarification_items = [item for item in state["transcript"] if item["type"] == "clarification"]
    assert approval_items == []
    assert clarification_items == []
    assistant_items = [
        item for item in state["transcript"] if item["type"] in {"assistant_stream", "assistant_final"}
    ]
    assert [item["text"] for item in assistant_items] == [
        "approval resolved",
        "clarification resolved",
    ]


def test_run_node_tui_gateway_with_real_node_scripted_client_approval_reject(
    tmp_path: Path,
) -> None:
    repo_root = Path(__file__).resolve().parents[2]
    dump_path = tmp_path / "node-approval-reject-state.json"
    process = NodeTuiProcess(
        args=node_scripted_client_args(repo_root),
        env={
            **os.environ,
            "MYCLI_NODE_TUI_SCRIPT": json.dumps(
                [
                    "needs approval",
                    {"type": "approval.respond", "choice": "reject"},
                ]
            ),
            "MYCLI_NODE_TUI_STATE_DUMP": str(dump_path),
        },
        cwd=repo_root,
    )
    service = E2EWaitingStateService(tmp_path)

    exit_code = run_node_tui_gateway(service=cast(TurnService, service), process=process)

    assert exit_code == 0
    assert service.messages == ["needs approval"]
    assert service.resolved_choices == ["2"]
    state = json.loads(dump_path.read_text(encoding="utf-8"))
    assert state["pendingApproval"] is None
    assert state["pendingClarification"] is None
    assert state["liveStatus"]["state"] == "rejected"
    assert state["liveStatus"]["message"] == "Rejected Bash. Pending decision cleared."
    assistant_items = [
        item for item in state["transcript"] if item["type"] in {"assistant_stream", "assistant_final"}
    ]
    assert assistant_items == []


def test_run_node_tui_gateway_with_real_runtime_strict_write_approval(
    tmp_path: Path,
) -> None:
    class WriteThenDoneAdapter:
        def __init__(self) -> None:
            self.calls = 0

        def next_turn(self, *, items, tools):
            del items, tools
            self.calls += 1
            if self.calls == 1:
                return ModelTurnResult(
                    items=(
                        RuntimeItem(
                            role="assistant",
                            blocks=(
                                RuntimeBlock(
                                    type="tool_call",
                                    tool_name="Write",
                                    tool_arguments={
                                        "file_path": "notes.txt",
                                        "content": "hello from tui\n",
                                    },
                                    call_id="call_write_strict_1",
                                ),
                            ),
                        ),
                    ),
                    done=False,
                )
            return ModelTurnResult(
                items=(
                    RuntimeItem(
                        role="assistant",
                        blocks=(RuntimeBlock(type="text", text="Write approved."),),
                    ),
                ),
                done=True,
            )

    repo_root = Path(__file__).resolve().parents[2]
    dump_path = tmp_path / "node-strict-write-approval.json"
    runtime = AgentRuntime(
        model_adapter=WriteThenDoneAdapter(),
        tool_registry=ToolRegistry.from_tools((WriteTool(tmp_path),)),
        config=AgentConfig(
            workspace_root=tmp_path,
            session_id="strict-write-smoke",
            auto_approve_medium=False,
        ),
        home_dir=tmp_path / "home",
    )
    service = TurnService(
        runtime=runtime,
        config=runtime._config,
        home_dir=tmp_path / "home",
    )
    process = NodeTuiProcess(
        args=node_scripted_client_args(repo_root),
        env={
            **os.environ,
            "MYCLI_NODE_TUI_SCRIPT": json.dumps(
                [
                    "write notes",
                    {"type": "approval.respond", "choice": "approve_once"},
                ]
            ),
            "MYCLI_NODE_TUI_STATE_DUMP": str(dump_path),
        },
        cwd=repo_root,
    )

    exit_code = run_node_tui_gateway(service=service, process=process)

    assert exit_code == 0
    assert (tmp_path / "notes.txt").read_text(encoding="utf-8") == "hello from tui\n"
    state = json.loads(dump_path.read_text(encoding="utf-8"))
    assert state["pendingApproval"] is None
    assert state["liveStatus"]["state"] == "completed"
    approval_items = [item for item in state["transcript"] if item["type"] == "approval"]
    assert approval_items == []
    assistant_items = [
        item for item in state["transcript"] if item["type"] in {"assistant_stream", "assistant_final"}
    ]
    assert [item["text"] for item in assistant_items] == ["Write approved."]


def test_run_node_tui_gateway_with_real_node_scripted_client_wrong_approval_id(
    tmp_path: Path,
) -> None:
    repo_root = Path(__file__).resolve().parents[2]
    dump_path = tmp_path / "node-approval-wrong-id-state.json"
    process = NodeTuiProcess(
        args=node_scripted_client_args(repo_root),
        env={
            **os.environ,
            "MYCLI_NODE_TUI_SCRIPT": json.dumps(
                [
                    "needs approval",
                    {
                        "type": "approval.respond_raw",
                        "decision_id": "wrong_decision",
                        "choice": "reject",
                        "expect_error": True,
                    },
                ]
            ),
            "MYCLI_NODE_TUI_STATE_DUMP": str(dump_path),
        },
        cwd=repo_root,
    )
    service = E2EWaitingStateService(tmp_path)

    exit_code = run_node_tui_gateway(service=cast(TurnService, service), process=process)

    assert exit_code == 0
    assert service.messages == ["needs approval"]
    assert service.resolved_choices == []
    state = json.loads(dump_path.read_text(encoding="utf-8"))
    assert state["pendingApproval"]["decision_id"] == "call_approval_1"
    assert state["liveStatus"]["state"] == "waiting_approval"
    errors = [item for item in state["transcript"] if item["type"] == "error"]
    assert len(errors) == 1
    assert errors[0]["text"] == "No pending decision matches the provided decision_id."
    assert {
        "code": "decision_not_pending",
        "message": "No pending decision matches the provided decision_id.",
        "method": "approval.respond",
    }.items() <= errors[0]["metadata"].items()


def test_run_node_tui_gateway_scripted_expected_failed_state(
    tmp_path: Path,
) -> None:
    repo_root = Path(__file__).resolve().parents[2]
    dump_path = tmp_path / "node-expected-failed-state.json"
    process = NodeTuiProcess(
        args=node_scripted_client_args(repo_root),
        env={
            **os.environ,
            "MYCLI_NODE_TUI_SCRIPT": json.dumps(
                [
                    {
                        "type": "turn.submit_expect",
                        "message": "fail once",
                        "expected_state": "failed",
                    },
                ]
            ),
            "MYCLI_NODE_TUI_STATE_DUMP": str(dump_path),
        },
        cwd=repo_root,
    )
    service = E2EFailureRecoveryService(tmp_path)

    exit_code = run_node_tui_gateway(service=cast(TurnService, service), process=process)

    assert exit_code == 0
    assert service.messages == ["fail once"]
    state = json.loads(dump_path.read_text(encoding="utf-8"))
    assert state["turnRunning"] is False
    assert state["currentTurnId"] is None
    assert state["liveStatus"]["state"] == "failed"
    errors = [item for item in state["transcript"] if item["type"] == "error"]
    assert [item["text"] for item in errors] == ["Provider failed after retries."]


def test_run_node_tui_gateway_scripted_expected_waiting_states(
    tmp_path: Path,
) -> None:
    repo_root = Path(__file__).resolve().parents[2]

    approval_dump_path = tmp_path / "node-expected-waiting-approval.json"
    approval_process = NodeTuiProcess(
        args=node_scripted_client_args(repo_root),
        env={
            **os.environ,
            "MYCLI_NODE_TUI_SCRIPT": json.dumps(
                [
                    {
                        "type": "turn.submit_expect",
                        "message": "needs approval",
                        "expected_state": "waiting_approval",
                    },
                ]
            ),
            "MYCLI_NODE_TUI_STATE_DUMP": str(approval_dump_path),
        },
        cwd=repo_root,
    )
    approval_service = E2EWaitingStateService(tmp_path)

    approval_exit_code = run_node_tui_gateway(
        service=cast(TurnService, approval_service),
        process=approval_process,
    )

    assert approval_exit_code == 0
    assert approval_service.messages == ["needs approval"]
    approval_state = json.loads(approval_dump_path.read_text(encoding="utf-8"))
    assert approval_state["liveStatus"]["state"] == "waiting_approval"
    assert approval_state["pendingApproval"]["decision_id"] == "call_approval_1"

    clarification_dump_path = tmp_path / "node-expected-waiting-clarification.json"
    clarification_process = NodeTuiProcess(
        args=node_scripted_client_args(repo_root),
        env={
            **os.environ,
            "MYCLI_NODE_TUI_SCRIPT": json.dumps(
                [
                    {
                        "type": "turn.submit_expect",
                        "message": "needs clarification",
                        "expected_state": "waiting_clarification",
                    },
                ]
            ),
            "MYCLI_NODE_TUI_STATE_DUMP": str(clarification_dump_path),
        },
        cwd=repo_root,
    )
    clarification_service = E2EWaitingStateService(tmp_path)

    clarification_exit_code = run_node_tui_gateway(
        service=cast(TurnService, clarification_service),
        process=clarification_process,
    )

    assert clarification_exit_code == 0
    assert clarification_service.messages == ["needs clarification"]
    clarification_state = json.loads(clarification_dump_path.read_text(encoding="utf-8"))
    assert clarification_state["liveStatus"]["state"] == "waiting_clarification"
    assert clarification_state["pendingClarification"]["request_id"] == "call_question_1"


class E2EToolLifecycleService:
    def __init__(self, workspace_root: Path) -> None:
        self._config = e2e_config(
            session_id="tool-lifecycle-smoke",
            workspace_root=workspace_root,
        )
        self._session_service = E2ESessionService()
        self.messages: list[str] = []

    def current_context_window_metrics(self) -> dict[str, object]:
        return {"input_tokens": 10, "max_tokens": 12000, "source": "test"}

    def handle_user_turn(
        self,
        message: str,
        stream_sink: Callable[[RuntimeStreamEvent], None] | None = None,
    ) -> TurnResponse:
        self.messages.append(message)
        if message != "tool lifecycle":
            raise AssertionError(f"unexpected message: {message}")
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
                    kind="tool_start",
                    tool_name="Write",
                    metadata={
                        "tool_id": "call_write_1",
                        "call_id": "call_write_1",
                        "name": "Write",
                        "context": "notes.txt",
                        "args_preview": "path=notes.txt",
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
            stream_sink(RuntimeStreamEvent(kind="text_delta", text="tools done"))
        return TurnResponse(assistant_message="tools done final")

    def inspect_usage(self) -> tuple[str, ...]:
        return ("session=tool-lifecycle-smoke",)

    def inspect_status(self) -> tuple[str, ...]:
        return ("session=tool-lifecycle-smoke context=test",)

    def set_view_mode(self, mode: str) -> tuple[str, ...]:
        return (f"mode={mode}",)

    def resume_session(self, session_id: str | None = None) -> tuple[str, ...]:
        return (f"resumed {session_id or 'tool-lifecycle-smoke'}",)


def test_run_node_tui_gateway_with_real_node_scripted_client_tool_lifecycle(
    tmp_path: Path,
) -> None:
    repo_root = Path(__file__).resolve().parents[2]
    dump_path = tmp_path / "node-tool-lifecycle.json"
    process = NodeTuiProcess(
        args=node_scripted_client_args(repo_root),
        env={
            **os.environ,
            "MYCLI_NODE_TUI_SCRIPT": json.dumps(["tool lifecycle"]),
            "MYCLI_NODE_TUI_STATE_DUMP": str(dump_path),
        },
        cwd=repo_root,
    )
    service = E2EToolLifecycleService(tmp_path)

    exit_code = run_node_tui_gateway(service=cast(TurnService, service), process=process)

    assert exit_code == 0
    assert service.messages == ["tool lifecycle"]
    state = json.loads(dump_path.read_text(encoding="utf-8"))
    tool_items = [item for item in state["transcript"] if item["type"] == "tool_summary"]
    assert len(tool_items) == 2
    read_item = next(item for item in tool_items if item["metadata"]["tool_id"] == "call_read_1")
    assert read_item["metadata"]["status"] == "done"
    assert read_item["metadata"]["stage"] == "executing"
    assert read_item["metadata"]["duration_s"] == 0.125
    assert read_item["metadata"]["summary"] == "Read README.md"
    assert read_item["metadata"]["success"] is True
    write_item = next(item for item in tool_items if item["metadata"]["tool_id"] == "call_write_1")
    assert write_item["metadata"]["status"] == "failed"
    assert write_item["metadata"]["duration_s"] == 0.002
    assert write_item["metadata"]["summary"] == "Tool Write could not run."
    assert write_item["metadata"]["success"] is False
    assert write_item["metadata"]["error"] == "Missing required parameter: content"
    assistant_items = [
        item for item in state["transcript"] if item["type"] in {"assistant_stream", "assistant_final"}
    ]
    assert [item["text"] for item in assistant_items] == ["tools done final"]
    assert "tools donetools done" not in assistant_items[0]["text"]


class E2EInterruptedStateService:
    def __init__(self, workspace_root: Path) -> None:
        self._config = e2e_config(
            session_id="interrupted-smoke",
            workspace_root=workspace_root,
        )
        self._session_service = E2ESessionService()
        self.messages: list[str] = []
        self.started = Event()
        self.return_interrupted = Event()

    def current_context_window_metrics(self) -> dict[str, object]:
        return {"input_tokens": 10, "max_tokens": 12000, "source": "test"}

    def handle_user_turn(
        self,
        message: str,
        stream_sink: Callable[[RuntimeStreamEvent], None] | None = None,
    ) -> TurnResponse:
        self.messages.append(message)
        if message != "interrupt me":
            raise AssertionError(f"unexpected message: {message}")
        self.started.set()
        if stream_sink is not None:
            stream_sink(RuntimeStreamEvent(kind="reasoning", text="working"))
        self.return_interrupted.wait(timeout=2.0)
        turn = TurnRecord(
            thread_id="interrupted-smoke",
            turn_id="turn_interrupted_1",
            status=TurnStatus.INTERRUPTED,
            started_at="2026-05-31T00:00:00Z",
            completed_at="2026-05-31T00:00:01Z",
            stop_reason=StopReason.INTERRUPTED,
            user_message=message,
        )
        return TurnResponse(assistant_message="Interrupt requested", turn=turn)

    def inspect_usage(self) -> tuple[str, ...]:
        return ("session=interrupted-smoke",)

    def inspect_status(self) -> tuple[str, ...]:
        return ("session=interrupted-smoke context=test",)

    def set_view_mode(self, mode: str) -> tuple[str, ...]:
        return (f"mode={mode}",)

    def resume_session(self, session_id: str | None = None) -> tuple[str, ...]:
        return (f"resumed {session_id or 'interrupted-smoke'}",)


class E2EQueuedTurnService:
    def __init__(self, workspace_root: Path) -> None:
        self._config = e2e_config(
            session_id="queued-turn-smoke",
            workspace_root=workspace_root,
        )
        self._session_service = E2ESessionService()
        self.messages: list[str] = []
        self.steering_requests: list[str] = []
        self.follow_up_requests: list[str] = []
        self.cleared_steering: tuple[str, ...] = ()
        self.cleared_follow_up: tuple[str, ...] = ()
        self.started = Event()
        self.cleared = Event()
        self._queue_lock = Lock()
        self._steering: list[str] = []
        self._follow_up: list[str] = []

    def current_context_window_metrics(self) -> dict[str, object]:
        return {"input_tokens": 10, "max_tokens": 12000, "source": "test"}

    def handle_user_turn(
        self,
        message: str,
        stream_sink: Callable[[RuntimeStreamEvent], None] | None = None,
    ) -> TurnResponse:
        self.messages.append(message)
        if message != "long task":
            raise AssertionError(f"unexpected message: {message}")
        self.started.set()
        if stream_sink is not None:
            stream_sink(RuntimeStreamEvent(kind="reasoning", text="working"))
        if not self.cleared.wait(timeout=2.0):
            return TurnResponse(
                assistant_message="Queue was not cleared.",
                turn=TurnRecord(
                    thread_id="queued-turn-smoke",
                    turn_id="turn_queue_failed_1",
                    status=TurnStatus.FAILED,
                    started_at="2026-05-31T00:00:00Z",
                    completed_at="2026-05-31T00:00:01Z",
                    stop_reason=StopReason.RUNTIME_ERROR,
                    user_message=message,
                ),
            )
        return TurnResponse(assistant_message="queued turn done")

    def queue_steering_message(self, message: str) -> tuple[tuple[str, ...], tuple[str, ...]]:
        self.steering_requests.append(message)
        with self._queue_lock:
            self._steering.append(message)
            return tuple(self._steering), tuple(self._follow_up)

    def queue_follow_up_message(self, message: str) -> tuple[tuple[str, ...], tuple[str, ...]]:
        self.follow_up_requests.append(message)
        with self._queue_lock:
            self._follow_up.append(message)
            return tuple(self._steering), tuple(self._follow_up)

    def queued_messages(self) -> tuple[tuple[str, ...], tuple[str, ...]]:
        with self._queue_lock:
            return tuple(self._steering), tuple(self._follow_up)

    def clear_queued_messages(self) -> tuple[tuple[str, ...], tuple[str, ...]]:
        with self._queue_lock:
            steering = tuple(self._steering)
            follow_up = tuple(self._follow_up)
            self._steering.clear()
            self._follow_up.clear()
        self.cleared_steering = steering
        self.cleared_follow_up = follow_up
        self.cleared.set()
        return steering, follow_up

    def inspect_usage(self) -> tuple[str, ...]:
        return ("session=queued-turn-smoke",)

    def inspect_status(self) -> tuple[str, ...]:
        return ("session=queued-turn-smoke context=test",)

    def set_view_mode(self, mode: str) -> tuple[str, ...]:
        return (f"mode={mode}",)

    def resume_session(self, session_id: str | None = None) -> tuple[str, ...]:
        return (f"resumed {session_id or 'queued-turn-smoke'}",)


class E2EFailureRecoveryService:
    def __init__(self, workspace_root: Path) -> None:
        self._config = e2e_config(
            session_id="failure-recovery-smoke",
            workspace_root=workspace_root,
        )
        self._session_service = E2EWaitingSessionService()
        self.messages: list[str] = []
        self.resolved_choices: list[str] = []
        self.clarification_responses: list[tuple[str, str]] = []

    def current_context_window_metrics(self) -> dict[str, object]:
        return {"input_tokens": 10, "max_tokens": 12000, "source": "test"}

    def handle_user_turn(
        self,
        message: str,
        stream_sink: Callable[[RuntimeStreamEvent], None] | None = None,
    ) -> TurnResponse:
        self.messages.append(message)
        if message == "fail once":
            return TurnResponse(
                assistant_message="Provider failed after retries.",
                turn=TurnRecord(
                    thread_id="failure-recovery-smoke",
                    turn_id="turn_failed_1",
                    status=TurnStatus.FAILED,
                    started_at="2026-05-31T00:00:00Z",
                    completed_at="2026-05-31T00:00:01Z",
                    stop_reason=StopReason.RUNTIME_ERROR,
                    user_message=message,
                ),
            )
        if message == "needs approval":
            decision = PendingDecision(
                tool_call=ToolCall(
                    name="Bash",
                    arguments={"command": "git push"},
                    reason="approval recovery smoke",
                    call_id="call_recovery_approval_1",
                ),
                kind=DecisionKind.NEEDS_CHOICE,
                reason="git push requires confirmation.",
                preview="git push",
                options=(DecisionAction.APPROVE_ONCE, DecisionAction.REJECT),
            )
            self._session_service.pending_decision = decision
            return TurnResponse(assistant_message="", pending_decision=decision)
        if message == "needs clarification":
            turn = TurnRecord(
                thread_id="failure-recovery-smoke",
                turn_id="turn_recovery_clarify_1",
                status=TurnStatus.WAITING_CLARIFICATION,
                started_at="2026-05-31T00:00:02Z",
                stop_reason=StopReason.CLARIFICATION_REQUIRED,
                user_message=message,
            )
            self._session_service.suspended_turn = turn
            if stream_sink is not None:
                stream_sink(
                    RuntimeStreamEvent(
                        kind="clarify_request",
                        metadata={
                            "request_id": "call_recovery_question_1",
                            "tool_id": "call_recovery_question_1",
                            "call_id": "call_recovery_question_1",
                            "tool_name": "AskUserQuestion",
                            "question": "Continue after failure?",
                            "options": [{"label": "Continue"}, {"label": "Stop"}],
                            "header": "Recovery",
                            "multi_select": False,
                        },
                    )
                )
            return TurnResponse(assistant_message="", turn=turn)
        if message == "tool lifecycle":
            if stream_sink is not None:
                stream_sink(
                    RuntimeStreamEvent(
                        kind="tool_start",
                        tool_name="Read",
                        metadata={
                            "tool_id": "call_recovery_read_1",
                            "call_id": "call_recovery_read_1",
                            "name": "Read",
                            "context": "README.md",
                            "args_preview": "path=README.md",
                        },
                    )
                )
                stream_sink(
                    RuntimeStreamEvent(
                        kind="tool_complete",
                        tool_name="Read",
                        metadata={
                            "tool_id": "call_recovery_read_1",
                            "call_id": "call_recovery_read_1",
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
                            "tool_id": "call_recovery_write_1",
                            "call_id": "call_recovery_write_1",
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
                stream_sink(RuntimeStreamEvent(kind="text_delta", text="tool recovery"))
            return TurnResponse(assistant_message="tool recovery final")
        if message == "interrupt after recovery":
            if stream_sink is not None:
                stream_sink(RuntimeStreamEvent(kind="reasoning", text="recovering"))
            return TurnResponse(
                assistant_message="Interrupt requested",
                turn=TurnRecord(
                    thread_id="failure-recovery-smoke",
                    turn_id="turn_recovery_interrupted_1",
                    status=TurnStatus.INTERRUPTED,
                    started_at="2026-05-31T00:00:03Z",
                    completed_at="2026-05-31T00:00:04Z",
                    stop_reason=StopReason.INTERRUPTED,
                    user_message=message,
                ),
            )
        raise AssertionError(f"unexpected message: {message}")

    def resolve_pending_decision(
        self,
        choice: str,
        stream_sink: Callable[[RuntimeStreamEvent], None] | None = None,
    ) -> TurnResponse:
        del stream_sink
        self.resolved_choices.append(choice)
        self._session_service.pending_decision = None
        return TurnResponse(
            assistant_message="Rejected Bash. Pending decision cleared.",
            turn=TurnRecord(
                thread_id="failure-recovery-smoke",
                turn_id="turn_recovery_rejected_1",
                status=TurnStatus.REJECTED,
                started_at="2026-05-31T00:00:01Z",
                stop_reason=StopReason.APPROVAL_REJECTED,
                user_message="needs approval",
            ),
        )

    def resolve_pending_clarification(self, request_id: str, response: str) -> TurnResponse:
        self.clarification_responses.append((request_id, response))
        self._session_service.suspended_turn = None
        return TurnResponse(assistant_message="clarification recovery final")

    def inspect_usage(self) -> tuple[str, ...]:
        return ("session=failure-recovery-smoke",)

    def inspect_status(self) -> tuple[str, ...]:
        return ("session=failure-recovery-smoke context=test",)

    def set_view_mode(self, mode: str) -> tuple[str, ...]:
        return (f"mode={mode}",)

    def resume_session(self, session_id: str | None = None) -> tuple[str, ...]:
        return (f"resumed {session_id or 'failure-recovery-smoke'}",)


class E2ELateCompletionAfterInterruptService(E2EInterruptedStateService):
    def handle_user_turn(
        self,
        message: str,
        stream_sink: Callable[[RuntimeStreamEvent], None] | None = None,
    ) -> TurnResponse:
        self.messages.append(message)
        if message != "interrupt me":
            raise AssertionError(f"unexpected message: {message}")
        self.started.set()
        if stream_sink is not None:
            stream_sink(RuntimeStreamEvent(kind="text_delta", text="late draft"))
        self.return_interrupted.wait(timeout=2.0)
        return TurnResponse(assistant_message="late normal answer")


def test_run_node_tui_gateway_with_real_node_scripted_client_interrupted_turn(
    tmp_path: Path,
) -> None:
    repo_root = Path(__file__).resolve().parents[2]
    dump_path = tmp_path / "node-interrupted-state.json"
    process = NodeTuiProcess(
        args=node_scripted_client_args(repo_root),
        env={
            **os.environ,
            "MYCLI_NODE_TUI_SCRIPT": json.dumps(
                [{"type": "turn.submit_interrupt", "message": "interrupt me"}]
            ),
            "MYCLI_NODE_TUI_STATE_DUMP": str(dump_path),
        },
        cwd=repo_root,
    )
    service = E2EInterruptedStateService(tmp_path)

    exit_code = run_node_tui_gateway(service=cast(TurnService, service), process=process)

    assert exit_code == 0
    assert service.messages == ["interrupt me"]
    assert service.started.is_set()
    state = json.loads(dump_path.read_text(encoding="utf-8"))
    assert state["turnRunning"] is False
    assert state["currentTurnId"] is None
    assert state["liveStatus"]["state"] == "interrupted"
    assert state["liveStatus"]["message"] == "Interrupt requested"
    assert state["pendingApproval"] is None
    assert state["pendingClarification"] is None


def test_run_node_tui_gateway_with_real_node_scripted_client_suppresses_late_completion(
    tmp_path: Path,
) -> None:
    repo_root = Path(__file__).resolve().parents[2]
    dump_path = tmp_path / "node-interrupt-late-completion-state.json"
    process = NodeTuiProcess(
        args=node_scripted_client_args(repo_root),
        env={
            **os.environ,
            "MYCLI_NODE_TUI_SCRIPT": json.dumps(
                [{"type": "turn.submit_interrupt", "message": "interrupt me"}]
            ),
            "MYCLI_NODE_TUI_STATE_DUMP": str(dump_path),
        },
        cwd=repo_root,
    )
    service = E2ELateCompletionAfterInterruptService(tmp_path)

    exit_code = run_node_tui_gateway(service=cast(TurnService, service), process=process)

    assert exit_code == 0
    assert service.messages == ["interrupt me"]
    assert service.started.is_set()
    state = json.loads(dump_path.read_text(encoding="utf-8"))
    assert state["turnRunning"] is False
    assert state["currentTurnId"] is None
    assert state["liveStatus"]["state"] == "interrupted"
    assert state["liveStatus"]["message"] == "Interrupt requested"
    assistant_items = [
        item for item in state["transcript"] if item["type"] in {"assistant_stream", "assistant_final"}
    ]
    assert [item["text"] for item in assistant_items] == ["late draft"]


def test_run_node_tui_gateway_with_real_node_scripted_client_running_turn_queue(
    tmp_path: Path,
) -> None:
    repo_root = Path(__file__).resolve().parents[2]
    dump_path = tmp_path / "node-running-turn-queue-state.json"
    process = NodeTuiProcess(
        args=node_scripted_client_args(repo_root),
        env={
            **os.environ,
            "MYCLI_NODE_TUI_SCRIPT": json.dumps(
                [
                    {
                        "type": "turn.submit_queue",
                        "message": "long task",
                        "steering": ["add more detail"],
                        "follow_up": ["summarize next"],
                        "clear": True,
                        "expected_state": "completed",
                    }
                ]
            ),
            "MYCLI_NODE_TUI_STATE_DUMP": str(dump_path),
        },
        cwd=repo_root,
    )
    service = E2EQueuedTurnService(tmp_path)

    exit_code = run_node_tui_gateway(service=cast(TurnService, service), process=process)

    assert exit_code == 0
    assert service.started.is_set()
    assert service.messages == ["long task"]
    assert service.steering_requests == ["add more detail"]
    assert service.follow_up_requests == ["summarize next"]
    assert service.cleared_steering == ("add more detail",)
    assert service.cleared_follow_up == ("summarize next",)
    state = json.loads(dump_path.read_text(encoding="utf-8"))
    assert state["turnRunning"] is False
    assert state["currentTurnId"] is None
    assert state["queuedInputs"] == []
    assert state["queuedPendingSteers"] == []
    assert state["queuedRejectedSteers"] == []
    assert state["queuedFollowUpInputs"] == []
    assert state["liveStatus"]["state"] == "completed"
    assistant_items = [
        item for item in state["transcript"] if item["type"] in {"assistant_stream", "assistant_final"}
    ]
    assert [item["text"] for item in assistant_items] == ["queued turn done"]


def test_run_node_tui_gateway_with_real_node_scripted_client_failure_recovery_matrix(
    tmp_path: Path,
) -> None:
    repo_root = Path(__file__).resolve().parents[2]
    dump_path = tmp_path / "node-failure-recovery-state.json"
    process = NodeTuiProcess(
        args=node_scripted_client_args(repo_root),
        env={
            **os.environ,
            "MYCLI_NODE_TUI_SCRIPT": json.dumps(
                [
                    "fail once",
                    "needs approval",
                    {"type": "approval.respond", "choice": "reject"},
                    "needs clarification",
                    {"type": "clarify.respond", "response": "Continue"},
                    "tool lifecycle",
                    "interrupt after recovery",
                ]
            ),
            "MYCLI_NODE_TUI_STATE_DUMP": str(dump_path),
        },
        cwd=repo_root,
    )
    service = E2EFailureRecoveryService(tmp_path)

    exit_code = run_node_tui_gateway(service=cast(TurnService, service), process=process)

    assert exit_code == 0
    assert service.messages == [
        "fail once",
        "needs approval",
        "needs clarification",
        "tool lifecycle",
        "interrupt after recovery",
    ]
    assert service.resolved_choices == ["2"]
    assert service.clarification_responses == [("call_recovery_question_1", "Continue")]
    state = json.loads(dump_path.read_text(encoding="utf-8"))
    assert state["turnRunning"] is False
    assert state["currentTurnId"] is None
    assert state["pendingApproval"] is None
    assert state["pendingClarification"] is None
    assert state["liveStatus"]["state"] == "interrupted"
    assert state["liveStatus"]["message"] == "Interrupt requested"

    errors = [item for item in state["transcript"] if item["type"] == "error"]
    assert [item["text"] for item in errors] == ["Provider failed after retries."]

    approval_items = [item for item in state["transcript"] if item["type"] == "approval"]
    assert approval_items == []

    clarification_items = [
        item for item in state["transcript"] if item["type"] == "clarification"
    ]
    assert clarification_items == []

    tool_items = [item for item in state["transcript"] if item["type"] == "tool_summary"]
    assert len(tool_items) == 2
    read_item = next(
        item for item in tool_items if item["metadata"]["tool_id"] == "call_recovery_read_1"
    )
    assert read_item["metadata"]["status"] == "done"
    write_item = next(
        item for item in tool_items if item["metadata"]["tool_id"] == "call_recovery_write_1"
    )
    assert write_item["metadata"]["status"] == "failed"
    assert write_item["metadata"]["error"] == "Missing required parameter: content"

    assistant_items = [
        item for item in state["transcript"] if item["type"] in {"assistant_stream", "assistant_final"}
    ]
    assert [item["text"] for item in assistant_items] == [
        "clarification recovery final",
        "tool recovery final",
    ]
    assert "tool recoverytool recovery" not in assistant_items[-1]["text"]


class E2EResumeTipSessionService:
    def __init__(
        self,
        *,
        pending_decision: PendingDecision | None = None,
        suspended_turn: SuspendedTurn | None = None,
    ) -> None:
        self.pending_decision = pending_decision
        self.suspended_turn = suspended_turn

    def append_command_result(self, **_kwargs: object) -> None:
        return None

    def load_pending_decision(self, session_id: str) -> object | None:
        return self.pending_decision if session_id == "branch" else None

    def load_suspended_turn(self, session_id: str) -> object | None:
        return self.suspended_turn if session_id == "branch" else None

    def load_history_items(self, _session_id: str) -> tuple[object, ...]:
        return ()

    def list_sessions(self, limit: int = 20) -> tuple[object, ...]:
        del limit
        return ()


class E2EResumeTipService:
    def __init__(
        self,
        workspace_root: Path,
        *,
        pending_decision: PendingDecision | None = None,
        suspended_turn: SuspendedTurn | None = None,
    ) -> None:
        self._config = e2e_config(
            session_id="root",
            workspace_root=workspace_root,
        )
        self._session_service = E2EResumeTipSessionService(
            pending_decision=pending_decision,
            suspended_turn=suspended_turn,
        )
        self.resumed: list[str] = []
        self.resolved_choices: list[str] = []
        self.clarification_responses: list[tuple[str, str]] = []

    def current_context_window_metrics(self) -> dict[str, object]:
        return {"input_tokens": 10, "max_tokens": 12000, "source": "test"}

    def handle_user_turn(
        self,
        message: str,
        stream_sink: Callable[[RuntimeStreamEvent], None] | None = None,
    ) -> TurnResponse:
        del message, stream_sink
        return TurnResponse(assistant_message="unexpected turn")

    def resolve_pending_decision(
        self,
        choice: str,
        stream_sink: Callable[[RuntimeStreamEvent], None] | None = None,
    ) -> TurnResponse:
        del stream_sink
        self.resolved_choices.append(choice)
        self._session_service.pending_decision = None
        return TurnResponse(assistant_message="approval resumed on branch")

    def resolve_pending_clarification(self, request_id: str, response: str) -> TurnResponse:
        self.clarification_responses.append((request_id, response))
        self._session_service.suspended_turn = None
        return TurnResponse(assistant_message="clarification resumed on branch")

    def inspect_usage(self) -> tuple[str, ...]:
        return ("session=branch",)

    def inspect_status(self) -> tuple[str, ...]:
        return ("session=branch context=test",)

    def set_view_mode(self, mode: str) -> tuple[str, ...]:
        return (f"mode={mode}",)

    def resume_session(self, session_id: str | None = None) -> tuple[str, ...]:
        requested = session_id or self._config.session_id
        self.resumed.append(requested)
        self._config.session_id = "branch"
        return ("resumed branch", "messages=3")


def test_run_node_tui_gateway_scripted_resume_tip_then_approval_response(
    tmp_path: Path,
) -> None:
    repo_root = Path(__file__).resolve().parents[2]
    dump_path = tmp_path / "node-resume-tip-approval.json"
    decision = PendingDecision(
        tool_call=ToolCall(
            name="Bash",
            arguments={"command": "git push"},
            reason="resume tip approval smoke",
            call_id="call_resume_approval_1",
        ),
        kind=DecisionKind.NEEDS_CHOICE,
        reason="git push requires confirmation.",
        preview="git push",
        options=(DecisionAction.APPROVE_ONCE, DecisionAction.REJECT),
    )
    process = NodeTuiProcess(
        args=node_scripted_client_args(repo_root),
        env={
            **os.environ,
            "MYCLI_NODE_TUI_SCRIPT": json.dumps(
                [
                    {"type": "session.resume", "session_id": "root"},
                    {"type": "approval.respond", "choice": "approve_once"},
                ]
            ),
            "MYCLI_NODE_TUI_STATE_DUMP": str(dump_path),
        },
        cwd=repo_root,
    )
    service = E2EResumeTipService(tmp_path, pending_decision=decision)

    exit_code = run_node_tui_gateway(service=cast(TurnService, service), process=process)

    assert exit_code == 0
    assert service.resumed == ["root"]
    assert service.resolved_choices == ["1"]
    state = json.loads(dump_path.read_text(encoding="utf-8"))
    assert state["sessionId"] == "branch"
    assert state["status"]["session_id"] == "branch"
    assert state["pendingApproval"] is None
    assert state["pendingClarification"] is None
    assert state["liveStatus"]["state"] == "completed"
    assistant_items = [
        item for item in state["transcript"] if item["type"] in {"assistant_stream", "assistant_final"}
    ]
    assert [item["text"] for item in assistant_items] == ["approval resumed on branch"]


def test_gateway_resume_projects_legacy_and_persistent_approval_shapes(
    tmp_path: Path,
) -> None:
    legacy = PendingDecision(
        tool_call=ToolCall(
            name="Bash",
            arguments={"command": "git push"},
            reason="legacy approval",
            call_id="call_legacy_1",
        ),
        kind=DecisionKind.NEEDS_CHOICE,
        reason="git push requires confirmation.",
        preview="git push",
        options=(DecisionAction.APPROVE_ONCE, DecisionAction.REJECT),
    )
    persistent = PendingDecision(
        tool_call=ToolCall(
            name="Shell",
            arguments={"command": "python -m pytest -q"},
            reason="persistent approval",
            call_id="call_persistent_1",
        ),
        kind=DecisionKind.NEEDS_CHOICE,
        reason="Unknown command requires approval.",
        preview="python -m pytest -q",
        command_pattern="python -m pytest",
        options=(
            DecisionAction.APPROVE_ONCE,
            DecisionAction.REJECT,
            DecisionAction.ALLOW_SESSION,
            DecisionAction.ALWAYS_ALLOW,
        ),
        proposed_execpolicy_pattern=("python", "-m", "x" * 200),
    )

    for decision, expected_choices in (
        (legacy, ["approve_once", "reject"]),
        (
            persistent,
            ["approve_once", "reject", "allow_session", "always_allow"],
        ),
    ):
        events: list[tuple[str, dict[str, object]]] = []
        service = E2EResumeTipService(tmp_path, pending_decision=decision)
        gateway = NodeTuiGateway(
            service=cast(Any, service),
            emit=lambda method, params: events.append((method, params)),
        )

        response = gateway.handle_request(
            RpcRequest(
                id=f"resume-{decision.tool_call.call_id}",
                method="session.resume",
                params={"session_id": "root"},
            )
        )

        assert response.error is None
        approval = next(params for method, params in events if method == "approval.request")
        options = cast(list[dict[str, object]], approval["options"])
        assert [option["choice"] for option in options] == expected_choices
        assert "proposed_execpolicy_pattern" not in approval
        assert "command_pattern" not in approval
        if decision is legacy:
            assert "persistent_rule_preview" not in approval
        else:
            preview = str(approval["persistent_rule_preview"])
            assert len(preview) == 160
            assert preview.endswith("...")


def test_run_node_tui_gateway_scripted_resume_tip_then_clarification_response(
    tmp_path: Path,
) -> None:
    repo_root = Path(__file__).resolve().parents[2]
    dump_path = tmp_path / "node-resume-tip-clarification.json"
    suspended = SuspendedTurn(
        user_message="choose next slice",
        conversation=(),
        suspend_reason=StopReason.CLARIFICATION_REQUIRED,
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
    )
    process = NodeTuiProcess(
        args=node_scripted_client_args(repo_root),
        env={
            **os.environ,
            "MYCLI_NODE_TUI_SCRIPT": json.dumps(
                [
                    {"type": "session.resume", "session_id": "root"},
                    {"type": "clarify.respond", "response": "Runtime"},
                ]
            ),
            "MYCLI_NODE_TUI_STATE_DUMP": str(dump_path),
        },
        cwd=repo_root,
    )
    service = E2EResumeTipService(tmp_path, suspended_turn=suspended)

    exit_code = run_node_tui_gateway(service=cast(TurnService, service), process=process)

    assert exit_code == 0
    assert service.resumed == ["root"]
    assert service.clarification_responses == [("call_resume_question_1", "Runtime")]
    state = json.loads(dump_path.read_text(encoding="utf-8"))
    assert state["sessionId"] == "branch"
    assert state["status"]["session_id"] == "branch"
    assert state["pendingApproval"] is None
    assert state["pendingClarification"] is None
    assert state["liveStatus"]["state"] == "completed"
    assistant_items = [
        item for item in state["transcript"] if item["type"] in {"assistant_stream", "assistant_final"}
    ]
    assert [item["text"] for item in assistant_items] == ["clarification resumed on branch"]


def test_gateway_queue_pop_and_interrupt_preserve_pending_steering(
    tmp_path: Path,
) -> None:
    class NoModelRequestsAdapter:
        def next_turn(self, *, items: object, tools: object) -> ModelTurnResult:
            del items, tools
            raise AssertionError("queue management must not request the model")

    config = AgentConfig(
        workspace_root=tmp_path,
        session_id="gateway-queue-pop",
    )
    runtime = AgentRuntime(
        model_adapter=NoModelRequestsAdapter(),
        tool_registry=ToolRegistry.from_tools([]),
        config=config,
        home_dir=tmp_path / "home",
    )
    service = TurnService(
        runtime=runtime,
        config=config,
        home_dir=tmp_path / "home",
    )
    service.queue_drain_blocked = lambda: True  # type: ignore[method-assign]
    runtime.queue_steering_message("keep steering")
    runtime.queue_follow_up_message("first")
    runtime.queue_follow_up_message("second")
    gateway = NodeTuiGateway(service=service)

    popped = gateway.handle_request(
        RpcRequest(id="pop", method="turn.queue.pop", params={})
    )
    interrupted = gateway.handle_request(
        RpcRequest(id="interrupt", method="turn.interrupt", params={})
    )

    assert popped.result is not None
    assert popped.result["item"]["message"] == "second"
    assert runtime.queued_messages() == (("keep steering",), ("first",))
    assert interrupted.result == {"interrupted": False}
    assert runtime.queued_messages() == (("keep steering",), ("first",))
    gateway.close()


def test_gateway_active_turn_retry_is_idempotent_with_real_runtime(tmp_path: Path) -> None:
    class BlockingAdapter:
        def __init__(self) -> None:
            self.started = Event()
            self.release = Event()

        def next_turn(self, *, items: object, tools: object) -> ModelTurnResult:
            del items, tools
            self.started.set()
            assert self.release.wait(timeout=2.0)
            return ModelTurnResult(
                items=(
                    RuntimeItem(
                        role="assistant",
                        blocks=(RuntimeBlock(type="text", text="done"),),
                    ),
                ),
                done=True,
            )

    adapter = BlockingAdapter()
    config = AgentConfig(workspace_root=tmp_path, session_id="queue-retry")
    runtime = AgentRuntime(
        model_adapter=adapter,
        tool_registry=ToolRegistry.from_tools([]),
        config=config,
        home_dir=tmp_path / "home",
    )
    service = TurnService(runtime=runtime, config=config, home_dir=tmp_path / "home")
    gateway = NodeTuiGateway(service=service)
    try:
        submitted = gateway.handle_request(
            RpcRequest(
                id="submit",
                method="turn.submit",
                params={"message": "start", "client_turn_id": "client-start"},
            )
        )
        assert adapter.started.wait(timeout=2.0)
        assert submitted.result is not None
        turn_id = str(submitted.result["turn_id"])
        params = {
            "message": "inspect",
            "client_turn_id": "client-steer",
            "expected_turn_id": turn_id,
        }

        first = gateway.handle_request(
            RpcRequest(id="steer-1", method="turn.steer", params=params)
        )
        retry = gateway.handle_request(
            RpcRequest(id="steer-2", method="turn.steer", params=params)
        )

        assert first.result is not None
        assert retry.result is not None
        assert first.result["disposition"] == "accepted"
        assert retry.result["disposition"] == "duplicate"
        assert runtime.queue_snapshot().pending_steers == ()
    finally:
        service.queue_drain_blocked = lambda: True  # type: ignore[method-assign]
        adapter.release.set()
        gateway.wait_for_current_turn(timeout=2.0)
        gateway.close()


def test_runtime_restart_normalizes_historical_pending_steer(tmp_path: Path) -> None:
    class NoModelRequestsAdapter:
        def next_turn(self, *, items: object, tools: object) -> ModelTurnResult:
            del items, tools
            raise AssertionError("restart recovery must not request the model")

    config = AgentConfig(workspace_root=tmp_path, session_id="queue-restart")
    first = AgentRuntime(
        model_adapter=NoModelRequestsAdapter(),
        tool_registry=ToolRegistry.from_tools([]),
        config=config,
        home_dir=tmp_path / "home",
    )
    first.queue_steering_input(
        "inspect",
        client_turn_id="client-steer",
        expected_turn_id="turn-gone",
        active_turn_id="turn-gone",
        steerable=True,
    )

    restored = AgentRuntime(
        model_adapter=NoModelRequestsAdapter(),
        tool_registry=ToolRegistry.from_tools([]),
        config=config,
        home_dir=tmp_path / "home",
    )

    assert restored.queue_snapshot().pending_steers == ()
    assert [item.text for item in restored.queue_snapshot().rejected_steers] == [
        "inspect"
    ]


def test_gateway_resume_projects_only_destination_session_queue(tmp_path: Path) -> None:
    class NoModelRequestsAdapter:
        def next_turn(self, *, items: object, tools: object) -> ModelTurnResult:
            del items, tools
            raise AssertionError("resume projection must not request the model")

    home_dir = tmp_path / "home"
    first_config = AgentConfig(workspace_root=tmp_path, session_id="queue-first")
    runtime = AgentRuntime(
        model_adapter=NoModelRequestsAdapter(),
        tool_registry=ToolRegistry.from_tools([]),
        config=first_config,
        home_dir=home_dir,
    )
    runtime._session_service.save_conversation(Conversation(session_id="queue-first"))
    runtime.queue_follow_up_input("first only", client_turn_id="client-first")
    second_config = replace(first_config, session_id="queue-second")
    runtime.rebind_session(second_config)
    runtime._session_service.save_conversation(Conversation(session_id="queue-second"))
    runtime.queue_follow_up_input("second only", client_turn_id="client-second")
    service = TurnService(runtime=runtime, config=second_config, home_dir=home_dir)
    service.queue_drain_blocked = lambda: True  # type: ignore[method-assign]
    events: list[tuple[str, dict[str, object]]] = []
    gateway = NodeTuiGateway(
        service=service,
        emit=lambda method, params: events.append((method, params)),
    )
    try:
        before = gateway._status_payload()
        assert before["queue_items"]["follow_ups"][0]["message"] == "second only"

        response = gateway.handle_request(
            RpcRequest(
                id="resume",
                method="session.resume",
                params={"session_id": "queue-first"},
            )
        )

        assert response.result is not None
        assert response.result["session_id"] == "queue-first"
        status = gateway._status_payload()
        assert [item["message"] for item in status["queue_items"]["follow_ups"]] == [
            "first only"
        ]
        assert "second only" not in json.dumps(status)
        direct_methods = [method for method, _params in events if method != "runtime.event"]
        assert direct_methods.index("session.changed") < direct_methods.index("status.changed")
    finally:
        gateway.close()
