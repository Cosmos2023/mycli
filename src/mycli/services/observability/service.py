from __future__ import annotations

from mycli.services.observability.alerts import AlertEvaluator
from mycli.services.observability.metrics import MetricsRegistry, MetricsSnapshot


class ObservabilityService:
    def __init__(
        self,
        *,
        metrics: MetricsRegistry | None = None,
        alerts: AlertEvaluator | None = None,
    ) -> None:
        self.metrics = metrics or MetricsRegistry()
        self.alerts = alerts or AlertEvaluator()

    def snapshot(self) -> MetricsSnapshot:
        return self.metrics.snapshot()

    def stats_payload(self) -> dict[str, object]:
        snapshot = self.snapshot()
        return {
            "metrics": snapshot.to_dict(),
            "alerts": [alert.to_dict() for alert in self.alerts.evaluate(snapshot)],
        }
