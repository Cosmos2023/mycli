import json
from pathlib import Path

import pytest

from mycli.domain.runtime.tracing import RuntimeTraceEvent
from mycli.services.trace_service import TraceService


def test_trace_service_round_trips_tool_event(tmp_path: Path) -> None:
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
    assert (tmp_path / ".mycli" / "traces" / "demo-trace.jsonl").exists()
    assert not (tmp_path / ".mycli" / "sessions" / "demo-trace.jsonl").exists()


def test_trace_service_loads_events_for_specific_turn(tmp_path: Path) -> None:
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


def test_trace_service_exports_recent_events_as_jsonl(tmp_path: Path) -> None:
    service = TraceService(home_dir=tmp_path)
    service.append(
        "demo",
        RuntimeTraceEvent(kind="turn_item", turn_id="turn_1", payload={"index": 1}),
    )
    service.append(
        "demo",
        RuntimeTraceEvent(kind="tool_execution", turn_id="turn_2", payload={"tool_name": "Read"}),
    )

    rows = service.export_jsonl("demo", tail=1)

    assert len(rows) == 1
    exported = json.loads(rows[0])
    assert exported == {
        "kind": "tool_execution",
        "turn_id": "turn_2",
        "payload": {"tool_name": "Read"},
    }


def test_trace_service_skips_corrupt_jsonl_rows(tmp_path: Path) -> None:
    service = TraceService(home_dir=tmp_path)
    service.append(
        "demo",
        RuntimeTraceEvent(kind="tool_execution", turn_id="turn_1", payload={"tool_name": "Read"}),
    )
    path = tmp_path / ".mycli" / "traces" / "demo-trace.jsonl"
    path.write_text(
        f"{path.read_text(encoding='utf-8').rstrip()}\n"
        '{"kind":"broken"}{"kind":"also-broken"}\n',
        encoding="utf-8",
    )

    loaded = service.load("demo")

    assert len(loaded) == 1
    assert loaded[0].payload["tool_name"] == "Read"


def test_trace_service_loads_legacy_session_trace(tmp_path: Path) -> None:
    legacy_path = tmp_path / ".mycli" / "sessions" / "demo-trace.jsonl"
    legacy_path.parent.mkdir(parents=True)
    legacy_path.write_text(
        json.dumps(
            {
                "kind": "tool_execution",
                "turn_id": "turn_1",
                "payload": {"tool_name": "legacy_read"},
            }
        )
        + "\n",
        encoding="utf-8",
    )

    loaded = TraceService(home_dir=tmp_path).load("demo")

    assert len(loaded) == 1
    assert loaded[0].payload["tool_name"] == "legacy_read"


def test_trace_service_rejects_placeholder_session_id(tmp_path: Path) -> None:
    service = TraceService(home_dir=tmp_path)

    with pytest.raises(ValueError, match="invalid trace session id"):
        service.append(
            "<session>",
            RuntimeTraceEvent(kind="tool_execution", turn_id="turn_1", payload={}),
        )

    assert not (tmp_path / ".mycli" / "traces" / "<session>-trace.jsonl").exists()
    assert not (tmp_path / ".mycli" / "sessions" / "<session>-trace.jsonl").exists()


def test_trace_service_sanitizes_full_content_from_trace_payload(tmp_path: Path) -> None:
    service = TraceService(home_dir=tmp_path)
    file_content = "secret-file-content-" * 80
    transcript_content = "provider-transcript-content-" * 80

    service.append(
        "demo",
        RuntimeTraceEvent(
            kind="turn_item",
            turn_id="turn_1",
            payload={
                "type": "tool_result",
                "text": "Read big.py",
                "metadata": {
                    "raw_payload": {
                        "path": "big.py",
                        "content": file_content,
                        "stdout": "ok",
                    },
                    "transcript_content": transcript_content,
                },
            },
        ),
    )

    trace_path = tmp_path / ".mycli" / "traces" / "demo-trace.jsonl"
    persisted = trace_path.read_text(encoding="utf-8")
    loaded = service.load("demo")
    metadata = loaded[0].payload["metadata"]
    raw_payload = metadata["raw_payload"]

    assert file_content not in persisted
    assert transcript_content not in persisted
    assert raw_payload["content_chars"] == len(file_content)
    assert raw_payload["content_preview"] != file_content
    assert "content" not in raw_payload
    assert metadata["transcript_content_chars"] == len(transcript_content)
    assert "transcript_content" not in metadata


def test_trace_service_redacts_nested_secret_payloads_before_persistence(
    tmp_path: Path,
) -> None:
    service = TraceService(home_dir=tmp_path)
    bearer_secret = "secretBearer123"
    api_secret = "sk-secretvalue"
    token_secret = "plain-token-value"

    service.append(
        "demo",
        RuntimeTraceEvent(
            kind="model_request",
            turn_id="turn_1",
            payload={
                "headers": {"Authorization": f"Bearer {bearer_secret}"},
                "body": {
                    "api_key": api_secret,
                    "nested": [{"token": token_secret}],
                    "message": f"deploy --token {token_secret}",
                },
            },
        ),
    )

    persisted = (tmp_path / ".mycli" / "traces" / "demo-trace.jsonl").read_text(encoding="utf-8")
    loaded = service.load("demo")
    exported = "\n".join(service.export_jsonl("demo"))
    payload = loaded[0].payload

    assert bearer_secret not in persisted
    assert api_secret not in persisted
    assert token_secret not in persisted
    assert bearer_secret not in exported
    assert api_secret not in exported
    assert token_secret not in exported
    assert payload["headers"]["Authorization"] == "Bearer [REDACTED]"
    assert payload["body"]["api_key"] == "[REDACTED]"
    assert payload["body"]["nested"][0]["token"] == "[REDACTED]"
    assert payload["body"]["message"] == "deploy --token [REDACTED]"


def test_trace_service_redacts_secret_like_content_preview(tmp_path: Path) -> None:
    service = TraceService(home_dir=tmp_path)
    secret = "sk-previewsecret"
    content = f"first line api_key={secret}\n" + ("safe text " * 80)

    service.append(
        "demo",
        RuntimeTraceEvent(
            kind="turn_item",
            turn_id="turn_1",
            payload={"metadata": {"raw_payload": {"content": content}}},
        ),
    )

    persisted = (tmp_path / ".mycli" / "traces" / "demo-trace.jsonl").read_text(encoding="utf-8")
    loaded = service.load("demo")
    preview = loaded[0].payload["metadata"]["raw_payload"]["content_preview"]

    assert secret not in persisted
    assert secret not in preview
    assert "api_key=[REDACTED]" in preview


def test_trace_service_export_jsonl_keeps_content_redacted(tmp_path: Path) -> None:
    service = TraceService(home_dir=tmp_path)
    file_content = "secret-file-content-" * 80
    service.append(
        "demo",
        RuntimeTraceEvent(
            kind="turn_item",
            turn_id="turn_1",
            payload={"metadata": {"raw_payload": {"content": file_content}}},
        ),
    )

    exported = "\n".join(service.export_jsonl("demo"))

    assert file_content not in exported
    assert "content_chars" in exported
    assert '"content"' not in exported
