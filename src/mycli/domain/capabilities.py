from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any


class CapabilityActivationSource(StrEnum):
    EXPLICIT_MENTION = "explicit_mention"
    TRIGGER_HINT = "trigger_hint"


class CapabilityActivationDependencyStatus(StrEnum):
    READY = "ready"
    MISSING_ENV = "missing_env"
    MISSING_WORKSPACE_RESOURCE = "missing_workspace_resource"


@dataclass(slots=True, frozen=True)
class CapabilityActivation:
    name: str
    description: str
    instructions: str
    source: CapabilityActivationSource
    dependency_status: CapabilityActivationDependencyStatus
    source_path: str
    metadata: dict[str, Any] = field(default_factory=dict)
