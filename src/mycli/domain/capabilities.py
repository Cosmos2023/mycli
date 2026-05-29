from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass(slots=True, frozen=True)
class CapabilityActivation:
    capability_id: str
    source: str
    metadata: dict[str, Any] = field(default_factory=dict)


__all__ = ["CapabilityActivation"]
