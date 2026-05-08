from __future__ import annotations

from collections.abc import MutableMapping
from typing import Any

import structlog

from mycli.services.observability.alerts import Alert, AlertEvaluator
from mycli.services.observability.metrics import MetricsRegistry, MetricsSnapshot


def _render_to_log_kwargs(
    _logger: Any,
    _method_name: str,
    event_dict: MutableMapping[str, Any],
) -> dict[str, Any]:
    event = str(event_dict.pop("event", event_dict.get("mycli_event", "")))
    event_dict["event"] = event
    return {"msg": event, "extra": event_dict}


structlog.configure(
    processors=[
        structlog.stdlib.add_logger_name,
        structlog.stdlib.add_log_level,
        structlog.processors.TimeStamper(fmt="iso", utc=True),
        _render_to_log_kwargs,
    ],
    wrapper_class=structlog.stdlib.BoundLogger,
    logger_factory=structlog.stdlib.LoggerFactory(),
    cache_logger_on_first_use=True,
)


class ObservabilityService:
    def __init__(
        self,
        *,
        metrics: MetricsRegistry | None = None,
        alerts: AlertEvaluator | None = None,
        logger_name: str = "mycli.observability",
    ) -> None:
        self.metrics = metrics or MetricsRegistry()
        self.alerts = alerts or AlertEvaluator()
        self._logger = structlog.get_logger(logger_name)

    def snapshot(self) -> MetricsSnapshot:
        return self.metrics.snapshot()

    def evaluate_alerts(self) -> tuple[Alert, ...]:
        return self.alerts.evaluate(self.snapshot())

    def stats_payload(self) -> dict[str, object]:
        snapshot = self.snapshot()
        return {
            "metrics": snapshot.to_dict(),
            "alerts": [alert.to_dict() for alert in self.alerts.evaluate(snapshot)],
        }

    def log_event(
        self,
        event: str,
        *,
        level: int | str = "info",
        message: str | None = None,
        session_id: str | None = None,
        turn_id: str | None = None,
        **fields: Any,
    ) -> None:
        snapshot = self.snapshot()
        extra = {
            "mycli_event": event,
            "cache_hit_rate": snapshot.cache_hit_rate,
            "compaction_ratio": snapshot.compaction_ratio,
            "budget_curve": snapshot.budget_curve,
            "alerts": [alert.to_dict() for alert in self.alerts.evaluate(snapshot)],
            **fields,
        }
        if session_id is not None:
            extra["session_id"] = session_id
        if turn_id is not None:
            extra["turn_id"] = turn_id
        method_name = logging_level_name(level)
        log_method = getattr(self._logger, method_name)
        log_method(message or event, **extra)


def logging_level_name(level: int | str) -> str:
    if isinstance(level, str):
        lowered = level.lower()
        if lowered in {"debug", "info", "warning", "error", "critical"}:
            return lowered
        return "info"
    if level >= 50:
        return "critical"
    if level >= 40:
        return "error"
    if level >= 30:
        return "warning"
    if level >= 10:
        return "debug" if level < 20 else "info"
    return "debug"
