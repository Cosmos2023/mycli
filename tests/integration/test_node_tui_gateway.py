from __future__ import annotations

import json
import os
from collections.abc import Callable
from pathlib import Path
from types import SimpleNamespace
from typing import cast

from mycli.application.turn_service import TurnService
from mycli.cli.node_tui.process import NodeTuiProcess
from mycli.cli.node_tui.gateway import run_node_tui_gateway
from mycli.domain.runtime import RuntimeStreamEvent, TurnResponse


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
            "MYCLI_NODE_TUI_SCRIPT": json.dumps(["hello"]),
            "MYCLI_NODE_TUI_STATE_DUMP": str(dump_path),
        },
        cwd=repo_root,
    )
    service = E2ETypedStreamService(tmp_path)

    exit_code = run_node_tui_gateway(service=cast(TurnService, service), process=process)

    assert exit_code == 0
    assert service.messages == ["hello"]
    state = json.loads(dump_path.read_text(encoding="utf-8"))
    assistant_items = [
        item for item in state["transcript"] if item["type"] in {"assistant_stream", "assistant_final"}
    ]
    assert [item["text"] for item in assistant_items] == ["hello final"]
    assert "checking files" not in assistant_items[0]["text"]
    assert "hellohello" not in assistant_items[0]["text"]
