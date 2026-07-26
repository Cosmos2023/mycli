from __future__ import annotations

from dataclasses import dataclass

from mycli.domain.providers import ProtocolId, ProviderId
from mycli.domain.runtime import ReasoningEffort


@dataclass(frozen=True, slots=True)
class ModelCatalogEntry:
    provider: ProviderId
    protocol: ProtocolId
    model: str
    display_name: str
    description: str
    base_url: str
    auth_ref: str | None = None
    supported_reasoning_efforts: tuple[ReasoningEffort, ...] = ()
    default_reasoning_effort: ReasoningEffort | None = None
    is_default: bool = False
    is_current: bool = False

    @property
    def identity(self) -> tuple[ProviderId, ProtocolId, str]:
        return self.provider, self.protocol, self.model

    def to_payload(self) -> dict[str, object]:
        return {
            "provider": self.provider.value,
            "protocol": self.protocol.value,
            "model": self.model,
            "name": self.display_name,
            "description": self.description,
            "base_url": self.base_url,
            "supported_reasoning_efforts": [
                effort.value for effort in self.supported_reasoning_efforts
            ],
            "default_reasoning_effort": (
                self.default_reasoning_effort.value
                if self.default_reasoning_effort is not None
                else None
            ),
            "default": self.is_default,
            "current": self.is_current,
        }


@dataclass(frozen=True, slots=True)
class ModelSelection:
    provider: ProviderId
    protocol: ProtocolId
    model: str
    base_url: str
    reasoning_effort: ReasoningEffort | None = None

    @property
    def identity(self) -> tuple[ProviderId, ProtocolId, str]:
        return self.provider, self.protocol, self.model


__all__ = ["ModelCatalogEntry", "ModelSelection"]
