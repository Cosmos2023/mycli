from __future__ import annotations

import json
import os
from collections.abc import Callable
from pathlib import Path
from threading import Event
from types import SimpleNamespace
from typing import cast

from mycli.application.runtime.agent_runtime import AgentRuntime
from mycli.application.turn_service import TurnService
from mycli.cli.node_tui.process import NodeTuiProcess
from mycli.cli.node_tui.gateway import run_node_tui_gateway
from mycli.domain.runtime import (
    AgentConfig,
    DecisionAction,
    DecisionKind,
    ModelTurnResult,
    PendingDecision,
    PendingClarification,
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
from mycli.tools.write import WriteTool


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


class FakeService:
    def __init__(self, workspace_root: Path) -> None:
        self._config = SimpleNamespace(
            session_id="demo",
            workspace_root=workspace_root,
            model="gpt-test",
            provider=SimpleNamespace(value="deepseek"),
            protocol=SimpleNamespace(value="chat_completions"),
            max_prompt_tokens=12000,
        )
        self._session_service = SimpleNamespace(
            load_pending_decision=lambda _session_id: None,
            load_suspended_turn=lambda _session_id: None,
            list_sessions=lambda limit=20: (),
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
    assert '"[usage] session=demo"' in output


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
        self._config = SimpleNamespace(
            session_id="typed-smoke",
            workspace_root=workspace_root,
            model="gpt-smoke",
            provider=SimpleNamespace(value="test"),
            protocol=SimpleNamespace(value="chat_completions"),
            max_prompt_tokens=12000,
            tui_startup_mark="default",
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
        args=["node", str(repo_root / "tui" / "node" / "src" / "index.js")],
        env={
            **os.environ,
            "MYCLI_NODE_TUI_SCRIPT": json.dumps(["/help", "/theme mono", "hello"]),
            "MYCLI_NODE_TUI_STATE_DUMP": str(dump_path),
        },
        cwd=repo_root,
    )
    service = E2ETypedStreamService(tmp_path)

    exit_code = run_node_tui_gateway(service=cast(TurnService, service), process=process)

    assert exit_code == 0
    assert service.messages == ["hello"]
    state = json.loads(dump_path.read_text(encoding="utf-8"))
    assert state["overlay"]["visible"] is True
    assert state["overlay"]["title"] == "/help"
    overlay_text = "\n".join(state["overlay"]["lines"])
    assert "Enter send message" in overlay_text
    assert "Approval: press 1-9" in overlay_text
    assert state["themeName"] == "mono"
    command_items = [item for item in state["transcript"] if item["type"] == "command_output"]
    assert [item["text"] for item in command_items] == ["Theme changed to mono."]
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
        self._config = SimpleNamespace(
            session_id="waiting-smoke",
            workspace_root=workspace_root,
            model="gpt-smoke",
            provider=SimpleNamespace(value="test"),
            protocol=SimpleNamespace(value="chat_completions"),
            max_prompt_tokens=12000,
            tui_startup_mark="default",
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

    def resolve_pending_decision(self, choice: str) -> TurnResponse:
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
        args=["node", str(repo_root / "tui" / "node" / "src" / "index.js")],
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
    assert len(approval_items) == 1
    assert approval_items[0]["metadata"]["decision_id"] == "call_approval_1"
    assert len(clarification_items) == 1
    assert clarification_items[0]["metadata"]["request_id"] == "call_question_1"
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
        args=["node", str(repo_root / "tui" / "node" / "src" / "index.js")],
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
        args=["node", str(repo_root / "tui" / "node" / "src" / "index.js")],
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
    assert len(approval_items) == 1
    assert approval_items[0]["metadata"]["decision_id"] == "call_write_strict_1"
    assert approval_items[0]["metadata"]["tool_name"] == "Write"
    assert approval_items[0]["metadata"]["options"] == [
        {"choice": "approve_once", "label": "Allow once"},
        {"choice": "reject", "label": "Reject"},
    ]
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
        args=["node", str(repo_root / "tui" / "node" / "src" / "index.js")],
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


class E2EToolLifecycleService:
    def __init__(self, workspace_root: Path) -> None:
        self._config = SimpleNamespace(
            session_id="tool-lifecycle-smoke",
            workspace_root=workspace_root,
            model="gpt-smoke",
            provider=SimpleNamespace(value="test"),
            protocol=SimpleNamespace(value="chat_completions"),
            max_prompt_tokens=12000,
            tui_startup_mark="default",
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
        args=["node", str(repo_root / "tui" / "node" / "src" / "index.js")],
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
        self._config = SimpleNamespace(
            session_id="interrupted-smoke",
            workspace_root=workspace_root,
            model="gpt-smoke",
            provider=SimpleNamespace(value="test"),
            protocol=SimpleNamespace(value="chat_completions"),
            max_prompt_tokens=12000,
            tui_startup_mark="default",
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


class E2EFailureRecoveryService:
    def __init__(self, workspace_root: Path) -> None:
        self._config = SimpleNamespace(
            session_id="failure-recovery-smoke",
            workspace_root=workspace_root,
            model="gpt-smoke",
            provider=SimpleNamespace(value="test"),
            protocol=SimpleNamespace(value="chat_completions"),
            max_prompt_tokens=12000,
            tui_startup_mark="default",
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

    def resolve_pending_decision(self, choice: str) -> TurnResponse:
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


def test_run_node_tui_gateway_with_real_node_scripted_client_interrupted_turn(
    tmp_path: Path,
) -> None:
    repo_root = Path(__file__).resolve().parents[2]
    dump_path = tmp_path / "node-interrupted-state.json"
    process = NodeTuiProcess(
        args=["node", str(repo_root / "tui" / "node" / "src" / "index.js")],
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


def test_run_node_tui_gateway_with_real_node_scripted_client_failure_recovery_matrix(
    tmp_path: Path,
) -> None:
    repo_root = Path(__file__).resolve().parents[2]
    dump_path = tmp_path / "node-failure-recovery-state.json"
    process = NodeTuiProcess(
        args=["node", str(repo_root / "tui" / "node" / "src" / "index.js")],
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
    assert len(approval_items) == 1
    assert approval_items[0]["metadata"]["decision_id"] == "call_recovery_approval_1"

    clarification_items = [
        item for item in state["transcript"] if item["type"] == "clarification"
    ]
    assert len(clarification_items) == 1
    assert clarification_items[0]["metadata"]["request_id"] == "call_recovery_question_1"

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
        self._config = SimpleNamespace(
            session_id="root",
            workspace_root=workspace_root,
            model="gpt-smoke",
            provider=SimpleNamespace(value="test"),
            protocol=SimpleNamespace(value="chat_completions"),
            max_prompt_tokens=12000,
            tui_startup_mark="default",
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

    def resolve_pending_decision(self, choice: str) -> TurnResponse:
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
        args=["node", str(repo_root / "tui" / "node" / "src" / "index.js")],
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
        args=["node", str(repo_root / "tui" / "node" / "src" / "index.js")],
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
