from mycli.domain.runtime.tracing import RuntimeTraceEvent
from mycli.services.trace_service import TraceService


def test_trace_service_round_trips_tool_event(tmp_path) -> None:
    service = TraceService(home_dir=tmp_path)
    event = RuntimeTraceEvent(
        kind="tool_execution",
        turn_id="turn_1",
        payload={"tool_name": "search_text", "summary": "Found 2 matches"},
    )

    service.append("demo", event)
    loaded = service.load("demo")

    assert loaded[0].payload["tool_name"] == "search_text"
    assert loaded[0].turn_id == "turn_1"


def test_trace_service_loads_events_for_specific_turn(tmp_path) -> None:
    service = TraceService(home_dir=tmp_path)
    service.append(
        "demo",
        RuntimeTraceEvent(kind="tool_execution", turn_id="turn_1", payload={"tool_name": "read_file"}),
    )
    service.append(
        "demo",
        RuntimeTraceEvent(kind="tool_execution", turn_id="turn_2", payload={"tool_name": "edit_file"}),
    )

    loaded = service.load_for_turn("demo", "turn_2")

    assert len(loaded) == 1
    assert loaded[0].payload["tool_name"] == "edit_file"
