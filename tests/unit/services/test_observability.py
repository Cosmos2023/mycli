from __future__ import annotations

from mycli.services.observability import (
    AlertEvaluator,
    MetricsRegistry,
)


def test_metrics_registry_reports_cache_compaction_and_budget_curve() -> None:
    registry = MetricsRegistry()

    registry.record_cache_tokens(hit_tokens=75, miss_tokens=25)
    registry.record_compaction(before_tokens=1000, after_tokens=250, level="L4")
    registry.record_l4_decision(decision="summarize", source="pre_request")
    registry.record_budget(total_tokens=100, max_tokens=1000)
    registry.record_budget(total_tokens=450, max_tokens=1000)

    snapshot = registry.snapshot()

    assert snapshot.cache_hit_rate == 0.75
    assert snapshot.compaction_ratio == 0.25
    assert snapshot.budget_curve == (0.1, 0.45)
    assert snapshot.compaction_levels == {"L4": 1}
    assert snapshot.l4_last_decision == "summarize"
    assert snapshot.l4_last_source == "pre_request"
    assert snapshot.to_dict()["cache_hit_rate"] == 0.75
    assert snapshot.to_dict()["l4_last_decision"] == "summarize"


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
    assert snapshot.context_window["evictable_tool_result_tokens"] == 250


def test_metrics_registry_resets_window_metrics_without_clearing_cost_metrics() -> None:
    registry = MetricsRegistry()

    registry.record_cache_tokens(hit_tokens=75, miss_tokens=25)
    registry.record_budget(total_tokens=900, max_tokens=1000)
    registry.record_context_window({"total_tokens": 900, "usage_ratio": 0.9})

    registry.reset_window_metrics()

    snapshot = registry.snapshot()
    assert snapshot.cache_hit_rate == 0.75
    assert snapshot.budget_curve == ()
    assert snapshot.context_window == {}


def test_metrics_registry_resets_context_metrics_without_clearing_cache_or_ptl() -> None:
    registry = MetricsRegistry()

    registry.record_cache_tokens(hit_tokens=75, miss_tokens=25)
    registry.record_budget(total_tokens=900, max_tokens=1000)
    registry.record_context_window({"total_tokens": 900, "max_tokens": 1000, "usage_ratio": 0.9})
    registry.record_compaction(before_tokens=1200, after_tokens=300, level="L4")
    registry.record_l4_decision(decision="summarize", source="pre_request")
    registry.record_ptl_event(triggered=True)

    registry.reset_context_metrics()

    snapshot = registry.snapshot()
    assert snapshot.cache_hit_rate == 0.75
    assert snapshot.ptl_events == 1
    assert snapshot.ptl_triggered == 1
    assert snapshot.budget_curve == ()
    assert snapshot.context_window == {}
    assert snapshot.compaction_levels == {}
    assert snapshot.compaction_before_tokens == 0
    assert snapshot.compaction_after_tokens == 0
    assert snapshot.consecutive_l4 == 0
    assert snapshot.l4_last_decision is None
    assert snapshot.l4_last_source is None


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
