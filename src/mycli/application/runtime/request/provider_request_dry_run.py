from __future__ import annotations

from collections import Counter
from dataclasses import dataclass
from typing import Any

from mycli.application.runtime.request.cache_shape_diagnostics import (
    CacheShapeDiagnostics,
)
from mycli.application.runtime.request.provider_payload_snapshot import (
    ProviderPayloadSnapshot,
)
from mycli.domain.runtime import RequestShape


@dataclass(slots=True, frozen=True)
class ProviderRequestDryRunComparison:
    provider_lane: str
    previous_cache_boundary_hash: str
    current_cache_boundary_hash: str
    cache_boundary_hash_stable: bool
    previous_prompt_cache_key_hash: str | None
    current_prompt_cache_key_hash: str | None
    prompt_cache_key_hash_stable: bool
    first_changed_cache_class: str | None
    previous_snapshot: ProviderPayloadSnapshot
    current_snapshot: ProviderPayloadSnapshot
    recovery_counts: dict[str, int] | None = None
    latest_recovery: dict[str, object] | None = None

    def to_dict(self) -> dict[str, object]:
        payload: dict[str, object] = {
            "provider_lane": self.provider_lane,
            "previous_cache_boundary_hash": self.previous_cache_boundary_hash,
            "current_cache_boundary_hash": self.current_cache_boundary_hash,
            "cache_boundary_hash_stable": self.cache_boundary_hash_stable,
            "previous_prompt_cache_key_hash": self.previous_prompt_cache_key_hash,
            "current_prompt_cache_key_hash": self.current_prompt_cache_key_hash,
            "prompt_cache_key_hash_stable": self.prompt_cache_key_hash_stable,
            "first_changed_cache_class": self.first_changed_cache_class,
            "previous_snapshot": self.previous_snapshot.to_dict(),
            "current_snapshot": self.current_snapshot.to_dict(),
        }
        if self.recovery_counts is not None:
            payload["recovery_counts"] = _bounded_recovery_counts(self.recovery_counts)
        if self.latest_recovery is not None:
            payload["latest_recovery"] = _bounded_latest_recovery(self.latest_recovery)
        return payload


class ProviderRequestDryRun:
    @staticmethod
    def compare(
        *,
        previous: RequestShape,
        current: RequestShape,
        recovery_counts: dict[str, int] | None = None,
        latest_recovery: dict[str, object] | None = None,
    ) -> ProviderRequestDryRunComparison:
        diagnostic = CacheShapeDiagnostics().build(
            previous=previous,
            current=current,
        )
        previous_snapshot = ProviderPayloadSnapshot.from_request_shape(previous)
        current_snapshot = ProviderPayloadSnapshot.from_request_shape(current)
        return ProviderRequestDryRunComparison(
            provider_lane=current_snapshot.lane,
            previous_cache_boundary_hash=previous.cacheable_prefix_hash(),
            current_cache_boundary_hash=current.cacheable_prefix_hash(),
            cache_boundary_hash_stable=(
                previous.cacheable_prefix_hash() == current.cacheable_prefix_hash()
            ),
            previous_prompt_cache_key_hash=previous_snapshot.prompt_cache_key_hash,
            current_prompt_cache_key_hash=current_snapshot.prompt_cache_key_hash,
            prompt_cache_key_hash_stable=(
                previous_snapshot.prompt_cache_key_hash
                == current_snapshot.prompt_cache_key_hash
            ),
            first_changed_cache_class=diagnostic.first_changed_cache_class,
            previous_snapshot=previous_snapshot,
            current_snapshot=current_snapshot,
            recovery_counts=recovery_counts,
            latest_recovery=latest_recovery,
        )


class ProviderRequestDryRunRenderer:
    """Renders provider-free dry-run diagnostics without provider payload bodies."""

    def render(
        self,
        comparison: ProviderRequestDryRunComparison,
        *,
        runtime_diagnostics: dict[str, object] | None = None,
    ) -> dict[str, object]:
        previous = comparison.previous_snapshot
        current = comparison.current_snapshot
        payload: dict[str, object] = {
            "provider_lane": comparison.provider_lane,
            "cache_boundary_hash_stable": comparison.cache_boundary_hash_stable,
            "prompt_cache_key_hash_stable": comparison.prompt_cache_key_hash_stable,
            "previous_cache_boundary_hash": comparison.previous_cache_boundary_hash,
            "current_cache_boundary_hash": comparison.current_cache_boundary_hash,
            "previous_prompt_cache_key_hash": comparison.previous_prompt_cache_key_hash,
            "current_prompt_cache_key_hash": comparison.current_prompt_cache_key_hash,
            "first_changed_cache_class": comparison.first_changed_cache_class,
            "wire_hint_state": _wire_hint_state(current.request_option_hints),
            "wire_hint_state_previous": _wire_hint_state(previous.request_option_hints),
            "snapshot_counts": {
                "previous": _snapshot_counts(previous),
                "current": _snapshot_counts(current),
            },
            "prompt_cache_key_preview": current.prompt_cache_key_preview,
            "recovery_counts": _bounded_recovery_counts(comparison.recovery_counts),
            "latest_recovery": _bounded_latest_recovery(comparison.latest_recovery),
        }
        if runtime_diagnostics is not None:
            payload["runtime_diagnostics"] = RuntimeDryRunDiagnostics().render(
                runtime_diagnostics
            )
        return payload


class RuntimeDryRunDiagnostics:
    """Builds bounded local runtime diagnostics for provider-free dry-run output."""

    def render(self, diagnostics: dict[str, object]) -> dict[str, object]:
        policy = _runtime_policy_summary(diagnostics.get("runtime_policy_events"))
        return {
            "exposed_tools": _exposed_tools_summary(diagnostics.get("exposed_tools")),
            "policy_decisions": policy,
            "sandbox_lane": _sandbox_lane_summary(diagnostics.get("runtime_policy_events")),
            "approval_lane": _approval_lane_summary(policy),
            "tool_lifecycle": _tool_lifecycle_summary(
                diagnostics.get("tool_lifecycle_events")
            ),
            "session_continuity": _session_continuity_summary(
                diagnostics.get("session_continuity_events")
            ),
        }


def _wire_hint_state(hints: dict[str, bool]) -> str:
    if any(hints.values()):
        return "enabled_and_emitted"
    return "disabled_by_policy"


def _snapshot_counts(snapshot: ProviderPayloadSnapshot) -> dict[str, object]:
    return {
        "message_count": snapshot.message_count,
        "runtime_item_count": snapshot.runtime_item_count,
        "sanitized_provider_private_field_count": (
            snapshot.sanitized_provider_private_field_count
        ),
        "anthropic_cache_control_block_count": (
            snapshot.anthropic_cache_control_block_count
        ),
        "request_option_hints": dict(snapshot.request_option_hints),
    }


def _exposed_tools_summary(value: object) -> dict[str, object]:
    names = sorted(
        {
            item.strip()
            for item in _string_items(value)
            if item.strip() and _is_safe_diagnostic_token(item.strip())
        }
    )
    return {
        "count": len(names),
        "names": names,
    }


def _runtime_policy_summary(value: object) -> dict[str, object]:
    decisions: Counter[str] = Counter()
    policies: Counter[str] = Counter()
    risk_levels: Counter[str] = Counter()
    argument_summaries = 0

    for event in _dict_items(value):
        decision = _safe_diagnostic_token(event.get("decision"))
        decisions[decision] += 1
        policy = _safe_diagnostic_token(event.get("policy"))
        policies[policy] += 1
        risk = _safe_diagnostic_token(event.get("risk_level"))
        risk_levels[risk] += 1
        if _has_argument_summary(event):
            argument_summaries += 1

    return {
        "allowed": decisions.get("allowed", 0),
        "denied": decisions.get("denied", 0),
        "needs_approval": decisions.get("needs_approval", 0),
        "decisions": _counter_dict(decisions),
        "policies": _counter_dict(policies),
        "risk_levels": _counter_dict(risk_levels),
        "argument_summaries": argument_summaries,
    }


def _sandbox_lane_summary(value: object) -> dict[str, object]:
    filesystem: Counter[str] = Counter()
    network: Counter[str] = Counter()
    shell: Counter[str] = Counter()
    for event in _dict_items(value):
        sandbox = event.get("sandbox")
        if not isinstance(sandbox, dict):
            continue
        filesystem[_safe_diagnostic_token(sandbox.get("filesystem"))] += 1
        network[_safe_diagnostic_token(sandbox.get("network"))] += 1
        shell[_safe_diagnostic_token(sandbox.get("shell"))] += 1
    return {
        "filesystem": _counter_dict(filesystem),
        "network": _counter_dict(network),
        "shell": _counter_dict(shell),
    }


def _approval_lane_summary(policy: dict[str, object]) -> dict[str, object]:
    needs_approval = _int_metric(policy.get("needs_approval"))
    denied = _int_metric(policy.get("denied"))
    if denied:
        state = "denied"
    elif needs_approval:
        state = "needs_approval"
    else:
        state = "not_required"
    return {
        "state": state,
        "needs_approval": needs_approval,
        "denied": denied,
    }


def _tool_lifecycle_summary(value: object) -> dict[str, object]:
    phases: Counter[str] = Counter()
    statuses: Counter[str] = Counter()
    terminal = 0
    for event in _dict_items(value):
        phase = _safe_diagnostic_token(event.get("phase"))
        status = _safe_diagnostic_token(event.get("status"))
        phases[phase] += 1
        statuses[status] += 1
        if phase in {"completed", "failed", "denied", "needs_approval", "interrupted"}:
            terminal += 1
    return {
        "events": sum(phases.values()),
        "terminal": terminal,
        "phases": _counter_dict(phases),
        "statuses": _counter_dict(statuses),
    }


def _session_continuity_summary(value: object) -> dict[str, object]:
    actions: Counter[str] = Counter()
    results: Counter[str] = Counter()
    lineage_switched = 0
    for event in _dict_items(value):
        action = _safe_diagnostic_token(event.get("action"))
        actions[action] += 1
        results[_safe_diagnostic_token(event.get("result"))] += 1
        if event.get("lineage_switched") is True:
            lineage_switched += 1
    return {
        "events": sum(actions.values()),
        "resume": actions.get("resume", 0),
        "fork": actions.get("fork", 0),
        "lineage_switched": lineage_switched,
        "results": _counter_dict(results),
    }


def _dict_items(value: object) -> tuple[dict[str, object], ...]:
    if not isinstance(value, (list, tuple)):
        return ()
    return tuple(item for item in value if isinstance(item, dict))


def _string_items(value: object) -> tuple[str, ...]:
    if not isinstance(value, (list, tuple)):
        return ()
    return tuple(item for item in value if isinstance(item, str))


def _has_argument_summary(event: dict[str, Any]) -> bool:
    argument_keys = event.get("argument_keys")
    argument_count = event.get("argument_count")
    return isinstance(argument_keys, list) and isinstance(argument_count, int)


def _counter_dict(counter: Counter[str]) -> dict[str, int]:
    return {
        key: count
        for key, count in sorted(counter.items())
        if key != "unknown" and count > 0
    }


def _int_metric(value: object) -> int:
    if isinstance(value, bool):
        return 0
    if isinstance(value, int):
        return max(0, value)
    return 0


def _safe_diagnostic_token(value: object) -> str:
    if not isinstance(value, str) or not value.strip():
        return "unknown"
    normalized = value.strip()[:80]
    if not _is_safe_diagnostic_token(normalized):
        return "other"
    return normalized


def _is_safe_diagnostic_token(value: str) -> bool:
    return value.replace("_", "").replace("-", "").replace(".", "").replace(":", "").isalnum()


def _bounded_recovery_counts(value: dict[str, int] | None) -> dict[str, int]:
    if not isinstance(value, dict):
        return {}
    return {
        str(key): count
        for key, count in sorted(value.items())
        if isinstance(count, int) and not isinstance(count, bool) and count >= 0
    }


def _bounded_latest_recovery(value: dict[str, object] | None) -> dict[str, object]:
    if not isinstance(value, dict):
        return {}
    result: dict[str, object] = {}
    error_class = value.get("error_class") or value.get("recovery_error_class")
    action = value.get("action") or value.get("recovery_kind")
    will_retry = value.get("will_retry")
    if isinstance(error_class, str) and error_class:
        result["error_class"] = error_class
    if isinstance(action, str) and action:
        result["action"] = action
    if isinstance(will_retry, bool):
        result["will_retry"] = will_retry
    return result
