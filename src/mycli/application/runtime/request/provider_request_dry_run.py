from __future__ import annotations

from dataclasses import dataclass

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

    def to_dict(self) -> dict[str, object]:
        return {
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


class ProviderRequestDryRun:
    @staticmethod
    def compare(
        *,
        previous: RequestShape,
        current: RequestShape,
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
        )


class ProviderRequestDryRunRenderer:
    """Renders provider-free dry-run diagnostics without provider payload bodies."""

    def render(
        self,
        comparison: ProviderRequestDryRunComparison,
    ) -> dict[str, object]:
        previous = comparison.previous_snapshot
        current = comparison.current_snapshot
        return {
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
