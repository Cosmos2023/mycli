from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from mycli.services.observability.metrics import MetricsSnapshot

AlertSeverity = Literal["info", "warning", "critical"]


@dataclass(slots=True, frozen=True)
class Alert:
    rule: str
    severity: AlertSeverity
    message: str
    observed: float | int
    threshold: float | int

    def to_dict(self) -> dict[str, object]:
        return {
            "rule": self.rule,
            "severity": self.severity,
            "message": self.message,
            "observed": self.observed,
            "threshold": self.threshold,
        }


@dataclass(slots=True, frozen=True)
class AlertEvaluator:
    cache_hit_drop_threshold: float = 0.25
    consecutive_l4_threshold: int = 3
    ptl_rate_threshold: float = 0.25

    def evaluate(self, snapshot: MetricsSnapshot) -> tuple[Alert, ...]:
        alerts: list[Alert] = []
        cache_drop = snapshot.cache_hit_rate_drop
        if cache_drop >= self.cache_hit_drop_threshold:
            alerts.append(
                Alert(
                    rule="cache_hit_drop",
                    severity="warning",
                    message="cache hit rate dropped below recent peak",
                    observed=cache_drop,
                    threshold=self.cache_hit_drop_threshold,
                )
            )
        if snapshot.consecutive_l4 >= self.consecutive_l4_threshold:
            alerts.append(
                Alert(
                    rule="consecutive_l4",
                    severity="critical",
                    message="consecutive L4 compactions exceeded threshold",
                    observed=snapshot.consecutive_l4,
                    threshold=self.consecutive_l4_threshold,
                )
            )
        if snapshot.ptl_rate >= self.ptl_rate_threshold and snapshot.ptl_events > 0:
            alerts.append(
                Alert(
                    rule="ptl_rate",
                    severity="warning",
                    message="PTL trigger rate exceeded threshold",
                    observed=snapshot.ptl_rate,
                    threshold=self.ptl_rate_threshold,
                )
            )
        return tuple(alerts)
