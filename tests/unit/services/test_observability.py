from __future__ import annotations

import json
import logging

from mycli.services.observability import (
    AlertEvaluator,
    JsonLogFormatter,
    MetricsRegistry,
    ObservabilityService,
    logging_level_name,
)


def test_metrics_registry_reports_cache_compaction_and_budget_curve() -> None:
    registry = MetricsRegistry()

    registry.record_cache_tokens(hit_tokens=75, miss_tokens=25)
    registry.record_compaction(before_tokens=1000, after_tokens=250, level="L4")
    registry.record_budget(total_tokens=100, max_tokens=1000)
    registry.record_budget(total_tokens=450, max_tokens=1000)

    snapshot = registry.snapshot()

    assert snapshot.cache_hit_rate == 0.75
    assert snapshot.compaction_ratio == 0.25
    assert snapshot.budget_curve == (0.1, 0.45)
    assert snapshot.compaction_levels == {"L4": 1}
    assert snapshot.to_dict()["cache_hit_rate"] == 0.75


def test_metrics_registry_records_latest_context_window_metrics() -> None:
    registry = MetricsRegistry()

    registry.record_context_window(
        {
            "total_tokens": 900,
            "max_tokens": 1000,
            "usage_ratio": 0.9,
            "remaining_tokens": 100,
            "fresh_message_count": 5,
            "fresh_tokens": 700,
            "tool_result_count": 3,
            "tool_result_tokens": 400,
            "append_only_tool_result_count": 3,
            "append_only_tool_result_tokens": 400,
            "duplicate_tool_result_count": 1,
            "duplicate_tool_result_tokens": 120,
            "evictable_tool_result_count": 2,
            "evictable_tool_result_tokens": 250,
        }
    )

    snapshot = registry.snapshot()

    assert snapshot.context_window["usage_ratio"] == 0.9
    assert snapshot.context_window["duplicate_tool_result_count"] == 1
    assert snapshot.to_dict()["context_window"]["evictable_tool_result_tokens"] == 250


def test_alert_evaluator_flags_cache_drop_consecutive_l4_and_ptl_rate() -> None:
    evaluator = AlertEvaluator(
        cache_hit_drop_threshold=0.2,
        consecutive_l4_threshold=3,
        ptl_rate_threshold=0.5,
    )
    registry = MetricsRegistry()

    registry.record_cache_tokens(hit_tokens=90, miss_tokens=10)
    registry.record_cache_tokens(hit_tokens=40, miss_tokens=60)
    registry.record_compaction(before_tokens=1000, after_tokens=300, level="L4")
    registry.record_compaction(before_tokens=1000, after_tokens=300, level="L4")
    registry.record_compaction(before_tokens=1000, after_tokens=300, level="L4")
    registry.record_ptl_event(triggered=True)
    registry.record_ptl_event(triggered=False)

    alerts = evaluator.evaluate(registry.snapshot())

    assert [alert.rule for alert in alerts] == [
        "cache_hit_drop",
        "consecutive_l4",
        "ptl_rate",
    ]
    assert alerts[0].severity == "warning"
    assert alerts[1].observed == 3
    assert alerts[2].observed == 0.5


def test_observability_service_emits_structured_log_record(caplog) -> None:  # type: ignore[no-untyped-def]
    service = ObservabilityService(logger_name="mycli.test.observability")
    service.metrics.record_cache_tokens(hit_tokens=1, miss_tokens=1)

    with caplog.at_level(logging.INFO, logger="mycli.test.observability"):
        service.log_event("metrics_snapshot", session_id="s1", turn_id="t1")

    assert len(caplog.records) == 1
    record = caplog.records[0]
    assert record.event == "metrics_snapshot"
    assert record.session_id == "s1"
    assert record.turn_id == "t1"
    assert record.cache_hit_rate == 0.5
    assert record.logger == "mycli.test.observability"
    assert record.level == "info"


def test_observability_service_accepts_numeric_logging_levels(caplog) -> None:  # type: ignore[no-untyped-def]
    service = ObservabilityService(logger_name="mycli.test.observability.numeric")

    with caplog.at_level(logging.WARNING, logger="mycli.test.observability.numeric"):
        service.log_event("alert", level=logging.WARNING)

    assert len(caplog.records) == 1
    assert caplog.records[0].levelname == "WARNING"
    assert caplog.records[0].event == "alert"


def test_logging_level_name_maps_standard_numeric_levels() -> None:
    assert logging_level_name(logging.INFO) == "info"
    assert logging_level_name(logging.WARNING) == "warning"


def test_json_log_formatter_outputs_structured_json() -> None:
    formatter = JsonLogFormatter()
    record = logging.LogRecord(
        name="mycli.test",
        level=logging.INFO,
        pathname=__file__,
        lineno=1,
        msg="hello",
        args=(),
        exc_info=None,
    )
    record.event = "demo"
    record.session_id = "s1"

    payload = json.loads(formatter.format(record))

    assert payload["level"] == "INFO"
    assert payload["logger"] == "mycli.test"
    assert payload["message"] == "hello"
    assert payload["event"] == "demo"
    assert payload["session_id"] == "s1"
