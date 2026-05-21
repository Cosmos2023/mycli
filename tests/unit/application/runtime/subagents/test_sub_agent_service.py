from __future__ import annotations

from mycli.application.runtime.subagents.service import SubAgentService
from mycli.domain.runtime import HistoryItem, HistoryItemType
from mycli.domain.subagents import SubAgentResult


class FakeLoop:
    def __init__(self, result: SubAgentResult) -> None:
        self.result = result
        self.calls: list[dict[str, object]] = []

    def run(self, **kwargs):
        self.calls.append(kwargs)
        return self.result


class FakeHistorySessionService:
    def __init__(self) -> None:
        self.items: dict[str, tuple[HistoryItem, ...]] = {}

    def load_history_items(self, session_id: str) -> tuple[HistoryItem, ...]:
        return self.items.get(session_id, ())


def test_service_resolves_scope_runs_loop_and_wraps_xml() -> None:
    loop = FakeLoop(
        SubAgentResult(
            status="completed",
            report="Found README.md.",
            child_session_id="ignored",
            tool_calls=1,
        )
    )
    service = SubAgentService(
        session_id="demo",
        turn_id_provider=lambda: "turn_1",
        parent_tool_names=lambda: ("Read", "Grep", "Task"),
        child_loop=loop,
    )

    result = service.run_task(
        description="Find docs",
        agent_type="explore",
        allowed_tools=("Read", "Task"),
    )

    assert result.status == "completed"
    assert result.child_session_id.startswith("demo:sub:turn_1:")
    assert result.report.startswith(
        '<sub-agent-report agent="explore" status="completed" tools="1"'
    )
    assert "Found README.md." in result.report
    assert loop.calls[0]["tool_names"] == ("Read",)
    assert service.recent_runs()[0].description == "Find docs"


def test_service_rejects_unknown_profile_with_xml_report() -> None:
    service = SubAgentService(
        session_id="demo",
        turn_id_provider=lambda: "turn_1",
        parent_tool_names=lambda: ("Read",),
        child_loop=FakeLoop(
            SubAgentResult(
                status="completed",
                report="unused",
                child_session_id="ignored",
                tool_calls=0,
            )
        ),
    )

    result = service.run_task(
        description="Find docs",
        agent_type="missing",
        allowed_tools=("Read",),
    )

    assert result.status == "failed"
    assert "Unknown sub-agent profile" in result.report


def test_service_truncates_long_report_body() -> None:
    service = SubAgentService(
        session_id="demo",
        turn_id_provider=lambda: "turn_1",
        parent_tool_names=lambda: ("Read",),
        child_loop=FakeLoop(
            SubAgentResult(
                status="completed",
                report="x" * 9000,
                child_session_id="ignored",
                tool_calls=0,
            )
        ),
    )

    result = service.run_task(
        description="Find docs",
        agent_type="explore",
        allowed_tools=("Read",),
    )

    assert len(result.report) < 8400
    assert "truncated" in result.report


def test_service_formats_child_transcript() -> None:
    session_service = FakeHistorySessionService()
    session_service.items["demo:sub:turn_1:abcd1234"] = (
        HistoryItem(
            id="1",
            thread_id="demo:sub:turn_1:abcd1234",
            turn_id="turn_1",
            type=HistoryItemType.USER_MESSAGE,
            metadata={"role": "system"},
            text="Read-only profile",
        ),
        HistoryItem(
            id="2",
            thread_id="demo:sub:turn_1:abcd1234",
            turn_id="turn_1",
            type=HistoryItemType.USER_MESSAGE,
            text="Inspect repo",
        ),
        HistoryItem(
            id="3",
            thread_id="demo:sub:turn_1:abcd1234",
            turn_id="turn_1",
            type=HistoryItemType.TOOL_CALL,
            tool_name="Read",
            call_id="call_1",
            metadata={"arguments": {"path": "pyproject.toml"}},
        ),
        HistoryItem(
            id="4",
            thread_id="demo:sub:turn_1:abcd1234",
            turn_id="turn_1",
            type=HistoryItemType.TOOL_RESULT,
            text="name = 'mycli'",
            tool_name="Read",
            call_id="call_1",
        ),
    )
    service = SubAgentService(
        session_id="demo",
        turn_id_provider=lambda: "turn_1",
        parent_tool_names=lambda: ("Read",),
        child_loop=FakeLoop(
            SubAgentResult(
                status="completed",
                report="ok",
                child_session_id="ignored",
                tool_calls=0,
            )
        ),
        session_service=session_service,
    )

    lines = service.inspect_transcript("demo:sub:turn_1:abcd1234")

    assert lines == (
        "demo:sub:turn_1:abcd1234",
        "  system Read-only profile",
        "  user Inspect repo",
        "  tool_call Read call_1 {'path': 'pyproject.toml'}",
        "  tool_result Read call_1 14 chars name = 'mycli'",
    )


def test_service_reports_missing_child_transcript() -> None:
    service = SubAgentService(
        session_id="demo",
        turn_id_provider=lambda: "turn_1",
        parent_tool_names=lambda: ("Read",),
        child_loop=FakeLoop(
            SubAgentResult(
                status="completed",
                report="ok",
                child_session_id="ignored",
                tool_calls=0,
            )
        ),
        session_service=FakeHistorySessionService(),
    )

    assert service.inspect_transcript("missing-child") == (
        "sub-agent transcript not found: missing-child",
    )
