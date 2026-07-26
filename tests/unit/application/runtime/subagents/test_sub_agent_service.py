from __future__ import annotations

from pathlib import Path
import threading

from mycli.application.runtime.subagents.service import SubAgentService
from mycli.domain.runtime import BaselineFragment, ContextBaseline, HistoryItem, HistoryItemType
from mycli.domain.runtime.tracing import RuntimeTraceEvent
from mycli.domain.subagents import SubAgentContextSnapshot, SubAgentProfile, SubAgentResult
from mycli.domain.tooling.calls import ToolCall


class FakeLoop:
    def __init__(self, result: SubAgentResult) -> None:
        self.result = result
        self.calls: list[dict[str, object]] = []
        self.pending_messages: list[tuple[str, ...]] = []

    def run(self, **kwargs):
        self.calls.append(kwargs)
        pending_message_provider = kwargs.get("pending_message_provider")
        if callable(pending_message_provider):
            self.pending_messages.append(pending_message_provider())
        transcript = kwargs.get("transcript")
        if transcript is not None:
            transcript.record_user_text("fake child transcript")
        return self.result


class InlineBackgroundExecutor:
    def submit(self, fn, *args, **kwargs):
        class DoneFuture:
            def result(self, timeout=None):
                del timeout
                return fn(*args, **kwargs)

        return DoneFuture()


class HoldingBackgroundExecutor:
    def __init__(self) -> None:
        self.submitted: list[tuple[object, tuple[object, ...], dict[str, object]]] = []

    def submit(self, fn, *args, **kwargs):
        self.submitted.append((fn, args, kwargs))

        class PendingFuture:
            def result(self, timeout=None):
                del timeout
                raise TimeoutError("still running")

        return PendingFuture()


class DeferredBackgroundExecutor:
    def __init__(self) -> None:
        self.submitted: list[tuple[object, tuple[object, ...], dict[str, object]]] = []

    def submit(self, fn, *args, **kwargs):
        self.submitted.append((fn, args, kwargs))

        class PendingFuture:
            def result(self, timeout=None):
                del timeout
                raise TimeoutError("still running")

        return PendingFuture()

    def run_next(self) -> None:
        fn, args, kwargs = self.submitted.pop(0)
        fn(*args, **kwargs)


class ExplodingLoop:
    def __init__(self, exc: Exception) -> None:
        self.exc = exc

    def run(self, **kwargs):
        raise self.exc


class BlockingInterruptibleLoop:
    def __init__(self) -> None:
        self.started = threading.Event()
        self.interrupted = threading.Event()

    def run(self, **kwargs):
        token = kwargs["interrupt_token"]
        self.started.set()
        token.wait(5.0)
        if token.interrupted:
            self.interrupted.set()
            token.raise_if_interrupted()
        raise AssertionError("sub-agent was not interrupted")


class CompletionRaceLoop:
    def __init__(self) -> None:
        self.calls: list[dict[str, object]] = []
        self.pending_messages: list[tuple[str, ...]] = []
        self.on_first_completion = lambda: None

    def run(self, **kwargs):
        self.calls.append(kwargs)
        provider = kwargs.get("pending_message_provider")
        self.pending_messages.append(provider() if callable(provider) else ())
        transcript = kwargs.get("transcript")
        if transcript is not None:
            transcript.record_final(
                status="completed",
                report=f"answer {len(self.calls)}",
                tool_calls=0,
            )
        if len(self.calls) == 1:
            self.on_first_completion()
        return SubAgentResult(
            status="completed",
            report=f"answer {len(self.calls)}",
            child_session_id="ignored",
            tool_calls=0,
        )


class ObservedLock:
    def __init__(self) -> None:
        self.enter_count = 0

    def __enter__(self):
        self.enter_count += 1
        return self

    def __exit__(self, exc_type, exc, traceback):
        return False


class FakeHistorySessionService:
    def __init__(self) -> None:
        self.items: dict[str, tuple[HistoryItem, ...]] = {}
        self.appended: list[tuple[str, tuple[HistoryItem, ...]]] = []
        self.subagent_snapshots: list[dict[str, object]] = []

    def load_history_items(self, session_id: str) -> tuple[HistoryItem, ...]:
        return self.items.get(session_id, ())

    def append_history_items(self, session_id: str, items: tuple[HistoryItem, ...]) -> None:
        self.appended.append((session_id, items))
        self.items[session_id] = (*self.items.get(session_id, ()), *items)

    def write_subagent_snapshot(self, **kwargs: object) -> None:
        self.subagent_snapshots.append(kwargs)


class FakeTraceService:
    def __init__(self) -> None:
        self.events: list[tuple[str, RuntimeTraceEvent]] = []

    def append(self, session_id: str, event: RuntimeTraceEvent) -> None:
        self.events.append((session_id, event))


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


def test_service_passes_transcript_recorder_to_child_loop() -> None:
    loop = FakeLoop(
        SubAgentResult(
            status="completed",
            report="Found README.md.",
            child_session_id="ignored",
            tool_calls=1,
        )
    )
    session_service = FakeHistorySessionService()
    service = SubAgentService(
        session_id="demo",
        turn_id_provider=lambda: "turn_1",
        parent_tool_names=lambda: ("Read",),
        child_loop=loop,
        session_service=session_service,
    )

    result = service.run_task(
        description="Find docs",
        agent_type="explore",
        allowed_tools=("Read",),
    )

    assert result.status == "completed"
    assert loop.calls[0]["transcript"] is not None
    assert session_service.appended


def test_cancel_background_subagent_interrupts_running_child_loop() -> None:
    loop = BlockingInterruptibleLoop()
    service = SubAgentService(
        session_id="demo",
        turn_id_provider=lambda: "turn_1",
        parent_tool_names=lambda: ("Read",),
        child_loop=loop,
    )

    started = service.run_task(
        description="Wait",
        agent_type="explore",
        allowed_tools=("Read",),
        mode="background",
    )
    assert loop.started.wait(timeout=1.0)

    cancelled = service.cancel_background_job(started.child_session_id)

    assert cancelled[0].state == "cancelled"
    assert loop.interrupted.wait(timeout=0.5)


def test_service_writes_subagent_snapshot_when_session_service_supports_it() -> None:
    loop = FakeLoop(
        SubAgentResult(
            status="completed",
            report="Found README.md.",
            child_session_id="ignored",
            tool_calls=1,
            context_diagnostics={"tool_count": 1},
        )
    )
    session_service = FakeHistorySessionService()
    service = SubAgentService(
        session_id="parent-session",
        turn_id_provider=lambda: "turn_1",
        parent_tool_names=lambda: ("Read",),
        child_loop=loop,
        session_service=session_service,
    )

    result = service.run_task(
        description="Find docs",
        agent_type="explore",
        allowed_tools=("Read",),
    )

    assert len(session_service.subagent_snapshots) == 1
    snapshot = session_service.subagent_snapshots[0]
    assert snapshot["parent_session_id"] == "parent-session"
    assert snapshot["child_session_id"] == result.child_session_id
    assert snapshot["parent_turn_id"] == "turn_1"
    assert snapshot["agent_type"] == "explore"
    assert snapshot["status"] == "completed"
    assert snapshot["mode"] == "sync"
    assert snapshot["description"] == "Find docs"
    assert result.report.startswith("<sub-agent-report")
    assert snapshot["report"] == "Found README.md."
    assert snapshot["tool_calls"] == 1
    assert snapshot["error"] is None
    assert snapshot["context_diagnostics"] == {"tool_count": 1}


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


def test_service_uses_injected_profile_lookup() -> None:
    loop = FakeLoop(
        SubAgentResult(
            status="completed",
            report="Configured profile ran.",
            child_session_id="ignored",
            tool_calls=1,
        )
    )
    profile = SubAgentProfile(
        name="analyst",
        system_prompt="Analyze safely.",
        default_tools=("Read", "Grep"),
        denied_tools=("Bash",),
    )
    service = SubAgentService(
        session_id="demo",
        turn_id_provider=lambda: "turn_1",
        parent_tool_names=lambda: ("Read", "Grep", "Bash"),
        child_loop=loop,
        profile_lookup=lambda profile_id: profile if profile_id == "analyst" else None,
    )

    result = service.run_task(
        description="Analyze docs",
        agent_type="analyst",
        allowed_tools=("Read", "Grep", "Bash"),
    )

    assert result.status == "completed"
    assert loop.calls[0]["profile"].name == "analyst"
    assert loop.calls[0]["tool_names"] == ("Read", "Grep")


def test_service_builds_bounded_fork_context_without_parent_transcript_leak() -> None:
    loop = FakeLoop(
        SubAgentResult(
            status="completed",
            report="Configured profile ran.",
            child_session_id="ignored",
            tool_calls=1,
        )
    )
    baseline = ContextBaseline(
        thread_id="demo",
        fragments=(
            BaselineFragment(
                id="developer:1",
                kind="workspace_instructions",
                title="Workspace instructions",
                content="Use pathlib. Do not leak parent transcript.",
                source="context_file",
            ),
        ),
    )
    service = SubAgentService(
        session_id="demo",
        turn_id_provider=lambda: "turn_1",
        parent_tool_names=lambda: ("Read", "Grep", "Bash"),
        child_loop=loop,
        context_baseline_provider=lambda: baseline,
        memory_fence_provider=lambda: "Parent memory: prefers direct reports.",
        session_summary_provider=lambda: "Parent summary: subagent P1 slice.",
    )

    result = service.run_task(
        description="Analyze docs",
        agent_type="explore",
        allowed_tools=("Read", "Grep", "Bash"),
    )

    snapshot = loop.calls[0]["context_snapshot"]
    assert isinstance(snapshot, SubAgentContextSnapshot)
    assert snapshot.tool_names == ("Read",)
    assert snapshot.baseline_fragments == ("Use pathlib. Do not leak parent transcript.",)
    assert snapshot.diagnostics["baseline_fragment_count"] == 1
    assert snapshot.diagnostics["tool_names"] == ["Read"]
    assert snapshot.diagnostics["baseline_content_hash"]
    assert result.context_diagnostics["tool_count"] == 1
    assert "Parent memory" not in result.report


def test_service_traces_fork_context_diagnostics_without_raw_content() -> None:
    loop = FakeLoop(
        SubAgentResult(
            status="completed",
            report="done",
            child_session_id="ignored",
            tool_calls=0,
        )
    )
    trace = FakeTraceService()
    baseline = ContextBaseline(
        thread_id="demo",
        fragments=(
            BaselineFragment(
                id="developer:1",
                kind="workspace_instructions",
                title="Workspace",
                content="SECRET_PARENT_CONTEXT_SHOULD_NOT_BE_IN_TRACE",
            ),
        ),
    )
    service = SubAgentService(
        session_id="demo",
        turn_id_provider=lambda: "turn_1",
        parent_tool_names=lambda: ("Read",),
        child_loop=loop,
        context_baseline_provider=lambda: baseline,
        trace_service=trace,
    )

    service.run_task(
        description="Inspect repo",
        agent_type="explore",
        allowed_tools=("Read",),
    )

    assert trace.events[0][0] == "demo"
    event = trace.events[0][1]
    assert event.kind == "subagent_context_fork"
    assert event.turn_id == "turn_1"
    assert event.payload["baseline_fragment_count"] == 1
    assert event.payload["tool_names"] == ["Read"]
    assert "SECRET_PARENT_CONTEXT" not in str(event.payload)


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


def test_background_task_returns_running_then_records_completion() -> None:
    session_service = FakeHistorySessionService()
    service = SubAgentService(
        session_id="demo",
        turn_id_provider=lambda: "turn_1",
        parent_tool_names=lambda: ("Read",),
        child_loop=FakeLoop(
            SubAgentResult(
                status="completed",
                report="done",
                child_session_id="ignored",
                tool_calls=1,
            )
        ),
        background_executor=InlineBackgroundExecutor(),
        session_service=session_service,
    )

    result = service.run_task(
        description="Inspect repo",
        agent_type="explore",
        allowed_tools=("Read",),
        mode="background",
    )

    assert result.status == "running"
    assert result.tool_calls == 0
    summaries = service.recent_runs()
    assert summaries[0].status == "completed"
    assert summaries[0].mode == "background"
    assert [snapshot["status"] for snapshot in session_service.subagent_snapshots] == [
        "running",
        "completed",
    ]
    assert session_service.subagent_snapshots[-1]["report"] == "done"


def test_send_message_queues_input_for_running_background_child() -> None:
    executor = DeferredBackgroundExecutor()
    loop = FakeLoop(
        SubAgentResult(
            status="completed",
            report="done",
            child_session_id="ignored",
            tool_calls=0,
        )
    )
    service = SubAgentService(
        session_id="demo",
        turn_id_provider=lambda: "turn_1",
        parent_tool_names=lambda: ("Read",),
        child_loop=loop,
        background_executor=executor,
        session_service=FakeHistorySessionService(),
    )
    started = service.run_task(
        description="Inspect repo",
        agent_type="explore",
        allowed_tools=("Read",),
        mode="background",
    )

    delivery = service.send_message(started.child_session_id, "Focus on failing tests.")
    executor.run_next()

    assert delivery.accepted is True
    assert delivery.delivery == "queued"
    assert delivery.child_session_id == started.child_session_id
    assert loop.pending_messages == [("Focus on failing tests.",)]


def test_send_message_rejects_blank_or_unknown_target() -> None:
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
        session_service=FakeHistorySessionService(),
    )

    blank = service.send_message("", "hello")
    unknown = service.send_message("missing-child", "hello")

    assert blank.accepted is False
    assert blank.delivery == "invalid"
    assert "child_session_id" in (blank.error or "")
    assert unknown.accepted is False
    assert unknown.delivery == "missing"


def test_send_message_resumes_terminal_child_from_structured_history() -> None:
    executor = DeferredBackgroundExecutor()
    session_service = FakeHistorySessionService()
    loop = FakeLoop(
        SubAgentResult(
            status="completed",
            report="done",
            child_session_id="ignored",
            tool_calls=1,
        )
    )
    service = SubAgentService(
        session_id="demo",
        turn_id_provider=lambda: "turn_2",
        parent_tool_names=lambda: ("Read",),
        child_loop=loop,
        background_executor=executor,
        session_service=session_service,
    )
    started = service.run_task(
        description="Inspect repo",
        agent_type="explore",
        allowed_tools=("Read",),
        mode="background",
    )
    executor.run_next()
    child_session_id = started.child_session_id
    session_service.items[child_session_id] = (
        HistoryItem(
            id="system",
            thread_id=child_session_id,
            turn_id="turn_1",
            type=HistoryItemType.USER_MESSAGE,
            text="Read only.",
            metadata={"role": "system"},
        ),
        HistoryItem(
            id="user",
            thread_id=child_session_id,
            turn_id="turn_1",
            type=HistoryItemType.USER_MESSAGE,
            text="Inspect repo",
        ),
        HistoryItem(
            id="assistant",
            thread_id=child_session_id,
            turn_id="turn_1",
            type=HistoryItemType.ASSISTANT_MESSAGE,
            text="Need README.",
        ),
        HistoryItem(
            id="call",
            thread_id=child_session_id,
            turn_id="turn_1",
            type=HistoryItemType.TOOL_CALL,
            tool_name="Read",
            call_id="call_1",
            metadata={"arguments": {"path": "README.md"}},
        ),
        HistoryItem(
            id="result",
            thread_id=child_session_id,
            turn_id="turn_1",
            type=HistoryItemType.TOOL_RESULT,
            tool_name="Read",
            call_id="call_1",
            text="mycli",
        ),
        HistoryItem(
            id="final",
            thread_id=child_session_id,
            turn_id="turn_1",
            type=HistoryItemType.ASSISTANT_MESSAGE,
            text="Found README.",
            metadata={"sub_agent_status": "completed", "tool_calls": 1},
        ),
    )

    delivery = service.send_message(child_session_id, "Now inspect tests.")
    executor.run_next()

    assert delivery.accepted is True
    assert delivery.delivery == "resumed"
    assert delivery.child_session_id == child_session_id
    resumed = loop.calls[1]
    assert resumed["child_session_id"] == child_session_id
    assert resumed["initial_messages"] == [
        {"role": "system", "content": "Read only."},
        {"role": "user", "content": "Inspect repo"},
        {
            "role": "assistant",
            "content": "Need README.",
            "tool_calls": (
                ToolCall(
                    name="Read",
                    arguments={"path": "README.md"},
                    reason="resumed child tool call",
                    call_id="call_1",
                ),
            ),
        },
        {
            "role": "tool",
            "tool_name": "Read",
            "tool_call_id": "call_1",
            "content": "mycli",
        },
        {"role": "assistant", "content": "Found README."},
    ]
    assert loop.pending_messages[-1] == ("Now inspect tests.",)
    assert service.recent_runs()[0].tool_calls == 2


def test_message_racing_with_background_completion_is_not_lost() -> None:
    executor = DeferredBackgroundExecutor()
    loop = CompletionRaceLoop()
    service = SubAgentService(
        session_id="demo",
        turn_id_provider=lambda: "turn_1",
        parent_tool_names=lambda: ("Read",),
        child_loop=loop,
        background_executor=executor,
        session_service=FakeHistorySessionService(),
    )
    started = service.run_task(
        description="Inspect repo",
        agent_type="explore",
        allowed_tools=("Read",),
        mode="background",
    )
    deliveries = []
    loop.on_first_completion = lambda: deliveries.append(
        service.send_message(started.child_session_id, "Check failures too.")
    )

    executor.run_next()

    assert deliveries[0].accepted is True
    assert deliveries[0].delivery == "queued"
    assert loop.pending_messages == [(), ("Check failures too.",)]
    assert service.read_output(started.child_session_id).status == "completed"


def test_background_task_projects_bounded_job_summary() -> None:
    service = SubAgentService(
        session_id="demo",
        turn_id_provider=lambda: "turn_1",
        parent_tool_names=lambda: ("Read",),
        child_loop=FakeLoop(
            SubAgentResult(
                status="completed",
                report="done with sensitive raw details",
                child_session_id="ignored",
                tool_calls=1,
            )
        ),
        background_executor=InlineBackgroundExecutor(),
    )

    service.run_task(
        description="Inspect repo and do not leak this prompt",
        agent_type="explore",
        allowed_tools=("Read",),
        mode="background",
    )

    jobs = service.background_jobs()
    assert len(jobs) == 1
    payload = jobs[0].to_diagnostic_payload()
    assert payload["owner"] == "subagent"
    assert payload["state"] == "completed"
    assert payload["owner_turn_id"] == "turn_1"
    assert "Inspect repo" not in str(payload)
    assert "sensitive raw details" not in str(payload)


def test_service_reads_completed_subagent_output() -> None:
    session_service = FakeHistorySessionService()
    service = SubAgentService(
        session_id="demo",
        turn_id_provider=lambda: "turn_1",
        parent_tool_names=lambda: ("Read",),
        child_loop=FakeLoop(
            SubAgentResult(
                status="completed",
                report="ignored",
                child_session_id="ignored",
                tool_calls=0,
            )
        ),
        background_executor=InlineBackgroundExecutor(),
        session_service=session_service,
    )
    service.run_task(
        description="Inspect repo",
        agent_type="explore",
        allowed_tools=("Read",),
        mode="background",
    )
    child_session_id = service.recent_runs()[0].child_session_id

    output = service.read_output(child_session_id)

    assert output.status == "completed"
    assert output.report == "ignored"
    assert output.tool_calls == 0
    assert output.child_session_id == child_session_id
    assert output.transcript_lines[0].startswith("explore completed")


def test_service_reads_running_subagent_output() -> None:
    service = SubAgentService(
        session_id="demo",
        turn_id_provider=lambda: "turn_1",
        parent_tool_names=lambda: ("Read",),
        child_loop=FakeLoop(
            SubAgentResult(
                status="completed",
                report="done",
                child_session_id="ignored",
                tool_calls=1,
            )
        ),
        background_executor=HoldingBackgroundExecutor(),
    )
    started = service.run_task(
        description="Inspect repo",
        agent_type="explore",
        allowed_tools=("Read",),
        mode="background",
    )

    output = service.read_output(started.child_session_id)

    assert output.status == "running"
    assert "Sub-agent explore is still running." in output.report
    assert "notified automatically" in output.report
    assert "Do not call SubagentOutput again" in output.report
    assert output.tool_calls == 0
    assert output.error is None


def test_background_task_completion_enqueues_task_notification() -> None:
    notifications: list[str] = []

    def notification_sink(message: str) -> tuple[tuple[str, ...], tuple[str, ...]]:
        notifications.append(message)
        return (message,), ()

    service = SubAgentService(
        session_id="demo",
        turn_id_provider=lambda: "turn_1",
        parent_tool_names=lambda: ("Read",),
        child_loop=FakeLoop(
            SubAgentResult(
                status="completed",
                report="done",
                child_session_id="ignored",
                tool_calls=1,
            )
        ),
        background_executor=InlineBackgroundExecutor(),
        notification_sink=notification_sink,
    )

    started = service.run_task(
        description="Inspect repo",
        agent_type="explore",
        allowed_tools=("Read",),
        mode="background",
    )

    assert started.status == "running"
    assert len(notifications) == 1
    assert notifications[0].startswith("<task-notification>")
    assert f"<task-id>{started.child_session_id}</task-id>" in notifications[0]
    assert "<agent>explore</agent>" in notifications[0]
    assert "<status>completed</status>" in notifications[0]
    assert "<result>done</result>" in notifications[0]


def test_background_task_completion_writes_output_file_notification(
    tmp_path: Path,
) -> None:
    notifications: list[str] = []

    def notification_sink(message: str) -> tuple[tuple[str, ...], tuple[str, ...]]:
        notifications.append(message)
        return (message,), ()

    service = SubAgentService(
        session_id="demo",
        turn_id_provider=lambda: "turn_1",
        parent_tool_names=lambda: ("Read",),
        child_loop=FakeLoop(
            SubAgentResult(
                status="completed",
                report="done in file",
                child_session_id="ignored",
                tool_calls=1,
            )
        ),
        background_executor=InlineBackgroundExecutor(),
        notification_sink=notification_sink,
        task_output_path_provider=lambda task_id: tmp_path / task_id / "output.txt",
    )

    started = service.run_task(
        description="Inspect repo",
        agent_type="explore",
        allowed_tools=("Read",),
        mode="background",
    )
    output_file = tmp_path / started.child_session_id / "output.txt"

    assert output_file.read_text(encoding="utf-8") == "done in file"
    assert f"<output-file>{output_file}</output-file>" in notifications[0]
    assert "<task-type>local_agent</task-type>" in notifications[0]


def test_background_task_rejects_when_concurrency_cap_is_reached() -> None:
    service = SubAgentService(
        session_id="demo",
        turn_id_provider=lambda: "turn_1",
        parent_tool_names=lambda: ("Read",),
        child_loop=FakeLoop(
            SubAgentResult(
                status="completed",
                report="done",
                child_session_id="ignored",
                tool_calls=1,
            )
        ),
        background_executor=HoldingBackgroundExecutor(),
        max_concurrent_background_tasks=1,
    )

    first = service.run_task(
        description="Inspect repo",
        agent_type="explore",
        allowed_tools=("Read",),
        mode="background",
    )
    second = service.run_task(
        description="Inspect repo again",
        agent_type="explore",
        allowed_tools=("Read",),
        mode="background",
    )

    assert first.status == "running"
    assert second.status == "failed"
    assert second.error == "Background sub-agent concurrency limit reached."


def test_background_task_exception_becomes_failed_summary() -> None:
    service = SubAgentService(
        session_id="demo",
        turn_id_provider=lambda: "turn_1",
        parent_tool_names=lambda: ("Read",),
        child_loop=ExplodingLoop(RuntimeError("provider failed")),
        background_executor=InlineBackgroundExecutor(),
    )

    result = service.run_task(
        description="Inspect repo",
        agent_type="explore",
        allowed_tools=("Read",),
        mode="background",
    )

    assert result.status == "running"
    assert service.recent_runs()[0].status == "failed"
    assert service.recent_runs()[0].error == "provider failed"


def test_recent_runs_are_read_through_state_lock() -> None:
    lock = ObservedLock()
    service = SubAgentService(
        session_id="demo",
        turn_id_provider=lambda: "turn_1",
        parent_tool_names=lambda: ("Read",),
        child_loop=FakeLoop(
            SubAgentResult(
                status="completed",
                report="done",
                child_session_id="ignored",
                tool_calls=1,
            )
        ),
        run_state_lock=lock,
    )

    service.run_task(
        description="Inspect repo",
        agent_type="explore",
        allowed_tools=("Read",),
    )
    service.recent_runs()

    assert lock.enter_count >= 2


def test_shutdown_marks_unfinished_background_runs_failed() -> None:
    service = SubAgentService(
        session_id="demo",
        turn_id_provider=lambda: "turn_1",
        parent_tool_names=lambda: ("Read",),
        child_loop=FakeLoop(
            SubAgentResult(
                status="completed",
                report="done",
                child_session_id="ignored",
                tool_calls=1,
            )
        ),
        background_executor=HoldingBackgroundExecutor(),
        max_concurrent_background_tasks=1,
    )
    started = service.run_task(
        description="Inspect repo",
        agent_type="explore",
        allowed_tools=("Read",),
        mode="background",
    )

    service.shutdown(timeout_seconds=0)

    summary = service.recent_runs()[0]
    assert started.status == "running"
    assert summary.child_session_id == started.child_session_id
    assert summary.status == "failed"
    assert summary.error == "Background sub-agent shutdown timeout."


def test_cancel_background_jobs_marks_running_subagents_cancelled() -> None:
    notifications: list[str] = []
    session_service = FakeHistorySessionService()
    service = SubAgentService(
        session_id="demo",
        turn_id_provider=lambda: "turn_1",
        parent_tool_names=lambda: ("Read",),
        child_loop=FakeLoop(
            SubAgentResult(
                status="completed",
                report="done",
                child_session_id="ignored",
                tool_calls=1,
            )
        ),
        background_executor=HoldingBackgroundExecutor(),
        session_service=session_service,
        notification_sink=lambda message: (notifications.append(message) or (message,), ()),
    )
    started = service.run_task(
        description="Inspect repo",
        agent_type="explore",
        allowed_tools=("Read",),
        mode="background",
    )

    cancelled = service.cancel_background_jobs()

    assert [job.job_id for job in cancelled] == [f"subagent:{started.child_session_id}"]
    assert cancelled[0].state == "cancelled"
    assert service.background_jobs()[0].state == "cancelled"
    assert service.recent_runs()[0].status == "cancelled"
    output = service.read_output(started.child_session_id)
    assert output.status == "cancelled"
    assert "cancelled by user" in output.report
    assert session_service.subagent_snapshots[-1]["status"] == "cancelled"
    assert notifications
    assert "<status>cancelled</status>" in notifications[-1]


def test_cancel_background_job_only_stops_selected_subagent() -> None:
    service = SubAgentService(
        session_id="demo",
        turn_id_provider=lambda: "turn_1",
        parent_tool_names=lambda: ("Read",),
        child_loop=FakeLoop(
            SubAgentResult(
                status="completed",
                report="done",
                child_session_id="ignored",
                tool_calls=1,
            )
        ),
        background_executor=HoldingBackgroundExecutor(),
    )
    first = service.run_task(
        description="Inspect repo",
        agent_type="explore",
        allowed_tools=("Read",),
        mode="background",
    )
    second = service.run_task(
        description="Review tests",
        agent_type="review",
        allowed_tools=("Read",),
        mode="background",
    )

    cancelled = service.cancel_background_job(first.child_session_id)

    jobs = {job.job_id: job for job in service.background_jobs()}
    assert [job.job_id for job in cancelled] == [f"subagent:{first.child_session_id}"]
    assert jobs[f"subagent:{first.child_session_id}"].state == "cancelled"
    assert jobs[f"subagent:{second.child_session_id}"].state == "running"
    assert service.read_output(first.child_session_id).status == "cancelled"
    assert service.read_output(second.child_session_id).status == "running"


def test_late_background_completion_does_not_override_cancelled_subagent() -> None:
    executor = DeferredBackgroundExecutor()
    service = SubAgentService(
        session_id="demo",
        turn_id_provider=lambda: "turn_1",
        parent_tool_names=lambda: ("Read",),
        child_loop=FakeLoop(
            SubAgentResult(
                status="completed",
                report="late done",
                child_session_id="ignored",
                tool_calls=1,
            )
        ),
        background_executor=executor,
    )
    started = service.run_task(
        description="Inspect repo",
        agent_type="explore",
        allowed_tools=("Read",),
        mode="background",
    )
    service.cancel_background_jobs()

    executor.run_next()

    summary = service.recent_runs()[0]
    assert summary.child_session_id == started.child_session_id
    assert summary.status == "cancelled"
    assert service.read_output(started.child_session_id).status == "cancelled"


def test_late_background_completion_does_not_override_single_cancelled_subagent() -> None:
    executor = DeferredBackgroundExecutor()
    service = SubAgentService(
        session_id="demo",
        turn_id_provider=lambda: "turn_1",
        parent_tool_names=lambda: ("Read",),
        child_loop=FakeLoop(
            SubAgentResult(
                status="completed",
                report="late done",
                child_session_id="ignored",
                tool_calls=1,
            )
        ),
        background_executor=executor,
    )
    started = service.run_task(
        description="Inspect repo",
        agent_type="explore",
        allowed_tools=("Read",),
        mode="background",
    )
    service.cancel_background_job(started.child_session_id)

    executor.run_next()

    summary = service.recent_runs()[0]
    assert summary.child_session_id == started.child_session_id
    assert summary.status == "cancelled"
    assert service.read_output(started.child_session_id).status == "cancelled"
