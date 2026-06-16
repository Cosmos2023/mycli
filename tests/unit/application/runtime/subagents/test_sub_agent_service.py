from __future__ import annotations

from mycli.application.runtime.subagents.service import SubAgentService
from mycli.domain.runtime import BaselineFragment, ContextBaseline, HistoryItem, HistoryItemType
from mycli.domain.runtime.tracing import RuntimeTraceEvent
from mycli.domain.subagents import SubAgentContextSnapshot, SubAgentProfile, SubAgentResult


class FakeLoop:
    def __init__(self, result: SubAgentResult) -> None:
        self.result = result
        self.calls: list[dict[str, object]] = []

    def run(self, **kwargs):
        self.calls.append(kwargs)
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


class ExplodingLoop:
    def __init__(self, exc: Exception) -> None:
        self.exc = exc

    def run(self, **kwargs):
        raise self.exc


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
    assert snapshot.tool_names == ("Read", "Grep")
    assert snapshot.baseline_fragments == ("Use pathlib. Do not leak parent transcript.",)
    assert snapshot.diagnostics["baseline_fragment_count"] == 1
    assert snapshot.diagnostics["tool_names"] == ["Read", "Grep"]
    assert snapshot.diagnostics["baseline_content_hash"]
    assert result.context_diagnostics["tool_count"] == 2
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
