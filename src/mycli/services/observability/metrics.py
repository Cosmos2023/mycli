from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(slots=True, frozen=True)
class MetricsSnapshot:
    cache_hit_tokens: int
    cache_miss_tokens: int
    cache_hit_rate_samples: tuple[float, ...]
    compaction_before_tokens: int
    compaction_after_tokens: int
    compaction_levels: dict[str, int]
    budget_curve: tuple[float, ...]
    consecutive_l4: int
    ptl_events: int
    ptl_triggered: int

    @property
    def cache_hit_rate(self) -> float:
        total = self.cache_hit_tokens + self.cache_miss_tokens
        if total <= 0:
            return 0.0
        return self.cache_hit_tokens / total

    @property
    def cache_hit_rate_drop(self) -> float:
        if len(self.cache_hit_rate_samples) < 2:
            return 0.0
        previous_peak = max(self.cache_hit_rate_samples[:-1])
        return max(0.0, previous_peak - self.cache_hit_rate_samples[-1])

    @property
    def compaction_ratio(self) -> float:
        if self.compaction_before_tokens <= 0:
            return 0.0
        return self.compaction_after_tokens / self.compaction_before_tokens

    @property
    def ptl_rate(self) -> float:
        if self.ptl_events <= 0:
            return 0.0
        return self.ptl_triggered / self.ptl_events

    def to_dict(self) -> dict[str, object]:
        return {
            "cache_hit_tokens": self.cache_hit_tokens,
            "cache_miss_tokens": self.cache_miss_tokens,
            "cache_hit_rate": self.cache_hit_rate,
            "cache_hit_rate_samples": self.cache_hit_rate_samples,
            "cache_hit_rate_drop": self.cache_hit_rate_drop,
            "compaction_before_tokens": self.compaction_before_tokens,
            "compaction_after_tokens": self.compaction_after_tokens,
            "compaction_ratio": self.compaction_ratio,
            "compaction_levels": dict(self.compaction_levels),
            "budget_curve": self.budget_curve,
            "consecutive_l4": self.consecutive_l4,
            "ptl_events": self.ptl_events,
            "ptl_triggered": self.ptl_triggered,
            "ptl_rate": self.ptl_rate,
        }


@dataclass(slots=True)
class MetricsRegistry:
    _cache_hit_tokens: int = 0
    _cache_miss_tokens: int = 0
    _cache_hit_rate_samples: list[float] = field(default_factory=list)
    _compaction_before_tokens: int = 0
    _compaction_after_tokens: int = 0
    _compaction_levels: dict[str, int] = field(default_factory=dict)
    _budget_curve: list[float] = field(default_factory=list)
    _consecutive_l4: int = 0
    _ptl_events: int = 0
    _ptl_triggered: int = 0

    def record_cache_tokens(self, *, hit_tokens: int, miss_tokens: int) -> None:
        hit = max(0, hit_tokens)
        miss = max(0, miss_tokens)
        self._cache_hit_tokens += hit
        self._cache_miss_tokens += miss
        total = hit + miss
        if total > 0:
            self._cache_hit_rate_samples.append(hit / total)

    def record_compaction(
        self,
        *,
        before_tokens: int,
        after_tokens: int,
        level: str,
    ) -> None:
        before = max(0, before_tokens)
        after = max(0, after_tokens)
        normalized_level = level.upper()
        self._compaction_before_tokens += before
        self._compaction_after_tokens += after
        self._compaction_levels[normalized_level] = (
            self._compaction_levels.get(normalized_level, 0) + 1
        )
        if normalized_level == "L4":
            self._consecutive_l4 += 1
        else:
            self._consecutive_l4 = 0

    def record_budget(self, *, total_tokens: int, max_tokens: int) -> None:
        if max_tokens <= 0:
            return
        ratio = max(0.0, total_tokens / max_tokens)
        self._budget_curve.append(ratio)

    def record_ptl_event(self, *, triggered: bool) -> None:
        self._ptl_events += 1
        if triggered:
            self._ptl_triggered += 1

    def snapshot(self) -> MetricsSnapshot:
        return MetricsSnapshot(
            cache_hit_tokens=self._cache_hit_tokens,
            cache_miss_tokens=self._cache_miss_tokens,
            cache_hit_rate_samples=tuple(self._cache_hit_rate_samples),
            compaction_before_tokens=self._compaction_before_tokens,
            compaction_after_tokens=self._compaction_after_tokens,
            compaction_levels=dict(self._compaction_levels),
            budget_curve=tuple(self._budget_curve),
            consecutive_l4=self._consecutive_l4,
            ptl_events=self._ptl_events,
            ptl_triggered=self._ptl_triggered,
        )
