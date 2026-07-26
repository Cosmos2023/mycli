from __future__ import annotations

import json
from dataclasses import replace
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from mycli.config.file_permissions import harden_private_path
from mycli.domain.model_catalog import ModelCatalogEntry
from mycli.domain.providers import ProtocolId, ProviderId, parse_protocol, parse_provider
from mycli.domain.runtime import AgentConfig, ReasoningEffort
from mycli.infrastructure.providers import profile_for_provider, validate_provider_protocol

_OPENAI_EFFORTS = (
    ReasoningEffort.LOW,
    ReasoningEffort.MEDIUM,
    ReasoningEffort.HIGH,
    ReasoningEffort.XHIGH,
)
_DEEPSEEK_EFFORTS = (
    ReasoningEffort.HIGH,
    ReasoningEffort.XHIGH,
)


def _entry(
    provider: ProviderId,
    model: str,
    description: str,
    *,
    efforts: tuple[ReasoningEffort, ...] = (),
    default_effort: ReasoningEffort | None = None,
) -> ModelCatalogEntry:
    profile = profile_for_provider(provider)
    return ModelCatalogEntry(
        provider=provider,
        protocol=profile.default_protocol,
        model=model,
        display_name=model,
        description=description,
        base_url=profile.default_base_url,
        auth_ref=provider.value,
        supported_reasoning_efforts=efforts,
        default_reasoning_effort=default_effort,
        is_default=model == profile.default_model,
    )


BUILTIN_MODEL_CATALOG: tuple[ModelCatalogEntry, ...] = (
    _entry(
        ProviderId.OPENAI,
        "gpt-5",
        "OpenAI general-purpose reasoning model",
        efforts=_OPENAI_EFFORTS,
        default_effort=ReasoningEffort.MEDIUM,
    ),
    _entry(
        ProviderId.OPENAI,
        "gpt-5.4",
        "OpenAI frontier coding and reasoning model",
        efforts=_OPENAI_EFFORTS,
        default_effort=ReasoningEffort.MEDIUM,
    ),
    _entry(
        ProviderId.OPENAI,
        "gpt-5.3-codex",
        "OpenAI coding model",
        efforts=_OPENAI_EFFORTS,
        default_effort=ReasoningEffort.MEDIUM,
    ),
    _entry(
        ProviderId.CODEX,
        "gpt-5",
        "Codex general-purpose reasoning model",
        efforts=_OPENAI_EFFORTS,
        default_effort=ReasoningEffort.MEDIUM,
    ),
    _entry(
        ProviderId.CODEX,
        "gpt-5.4",
        "Codex frontier coding and reasoning model",
        efforts=_OPENAI_EFFORTS,
        default_effort=ReasoningEffort.MEDIUM,
    ),
    _entry(ProviderId.DEEPSEEK, "deepseek-chat", "DeepSeek chat model"),
    _entry(
        ProviderId.DEEPSEEK,
        "deepseek-reasoner",
        "DeepSeek reasoning model",
        efforts=_DEEPSEEK_EFFORTS,
        default_effort=ReasoningEffort.HIGH,
    ),
    _entry(
        ProviderId.DEEPSEEK,
        "deepseek-v4-flash",
        "DeepSeek fast reasoning model",
        efforts=_DEEPSEEK_EFFORTS,
        default_effort=ReasoningEffort.HIGH,
    ),
    _entry(ProviderId.QWEN, "qwen3.6-plus", "Qwen general-purpose model"),
    _entry(ProviderId.QWEN, "qwen3-coder-plus", "Qwen coding model"),
    _entry(ProviderId.ANTHROPIC, "claude-sonnet-4-6", "Anthropic Sonnet model"),
    _entry(ProviderId.ANTHROPIC, "claude-opus-4-7", "Anthropic Opus model"),
)


class ModelCatalogService:
    def __init__(self, *, home_dir: Path) -> None:
        self._path = home_dir / ".mycli" / "models.json"

    def list_models(self, *, current_config: AgentConfig) -> tuple[ModelCatalogEntry, ...]:
        if not self._path.exists():
            self._bootstrap(current_config)
        entries = self._read_entries()
        current_auth_ref = current_config.auth_ref or current_config.provider.value
        current: list[ModelCatalogEntry] = []
        remaining: list[ModelCatalogEntry] = []
        for entry in entries:
            is_current = (
                entry.provider is current_config.provider
                and entry.protocol is current_config.protocol
                and entry.model == current_config.model
                and entry.base_url.rstrip("/") == current_config.api_base_url.rstrip("/")
                and entry.auth_ref == current_auth_ref
            )
            target = replace(entry, is_current=is_current)
            (current if is_current else remaining).append(target)
        remaining.sort(key=lambda entry: (entry.provider.value, entry.model, entry.base_url))
        return *current, *remaining

    def _bootstrap(self, current_config: AgentConfig) -> None:
        entries = list(BUILTIN_MODEL_CATALOG)
        current_auth_ref = current_config.auth_ref or current_config.provider.value
        current_key = (
            current_config.provider,
            current_config.protocol,
            current_config.model,
            current_config.api_base_url.rstrip("/"),
        )
        current_index = next(
            (index for index, entry in enumerate(entries) if _entry_key(entry) == current_key),
            None,
        )
        if current_index is not None:
            entries[current_index] = replace(
                entries[current_index],
                base_url=current_config.api_base_url.rstrip("/"),
                auth_ref=current_auth_ref,
            )
        else:
            profile = profile_for_provider(current_config.provider)
            entries.append(
                ModelCatalogEntry(
                    provider=current_config.provider,
                    protocol=current_config.protocol,
                    model=current_config.model,
                    display_name=current_config.model,
                    description="Current configured model",
                    base_url=current_config.api_base_url.rstrip("/"),
                    auth_ref=current_auth_ref,
                    is_default=current_config.model == profile.default_model,
                )
            )
        payload = {"models": [_entry_to_config(entry) for entry in entries]}
        self._path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        harden_private_path(self._path.parent, mode=0o700)
        self._path.write_text(
            json.dumps(payload, indent=2, ensure_ascii=True) + "\n",
            encoding="utf-8",
        )
        harden_private_path(self._path, mode=0o600)

    def _read_entries(self) -> tuple[ModelCatalogEntry, ...]:
        try:
            payload = json.loads(self._path.read_text(encoding="utf-8"))
        except OSError as exc:
            raise ValueError(f"Could not read model registry {self._path}: {exc}") from exc
        except json.JSONDecodeError as exc:
            raise ValueError(f"Invalid JSON in model registry {self._path}: {exc}") from exc
        if not isinstance(payload, dict) or not isinstance(payload.get("models"), list):
            raise ValueError(f"Model registry {self._path} must contain a 'models' array.")
        entries: list[ModelCatalogEntry] = []
        seen: set[tuple[ProviderId, ProtocolId, str, str]] = set()
        for index, raw_entry in enumerate(payload["models"]):
            entry = _parse_entry(raw_entry, path=self._path, index=index)
            key = _entry_key(entry)
            if key in seen:
                raise ValueError(
                    f"Duplicate model registry entry at {self._path}: "
                    f"{entry.provider.value}/{entry.model} ({entry.base_url})."
                )
            seen.add(key)
            entries.append(entry)
        return tuple(entries)


def _entry_key(entry: ModelCatalogEntry) -> tuple[ProviderId, ProtocolId, str, str]:
    return entry.provider, entry.protocol, entry.model, entry.base_url.rstrip("/")


def _entry_to_config(entry: ModelCatalogEntry) -> dict[str, object]:
    payload: dict[str, object] = {
        "model": entry.model,
        "provider": entry.provider.value,
        "protocol": entry.protocol.value,
        "base_url": entry.base_url,
        "auth_ref": entry.auth_ref,
    }
    if entry.display_name != entry.model:
        payload["name"] = entry.display_name
    if entry.description:
        payload["description"] = entry.description
    if entry.supported_reasoning_efforts:
        payload["reasoning_efforts"] = [
            effort.value for effort in entry.supported_reasoning_efforts
        ]
    if entry.default_reasoning_effort is not None:
        payload["default_reasoning_effort"] = entry.default_reasoning_effort.value
    return payload


def _parse_entry(raw: object, *, path: Path, index: int) -> ModelCatalogEntry:
    if not isinstance(raw, dict):
        raise ValueError(f"Model registry entry {index} in {path} must be an object.")
    model = _required_string(raw, "model", path=path, index=index)
    provider = parse_provider(_required_string(raw, "provider", path=path, index=index))
    protocol = parse_protocol(_required_string(raw, "protocol", path=path, index=index))
    validate_provider_protocol(provider=provider, protocol=protocol)
    base_url = _required_string(raw, "base_url", path=path, index=index).rstrip("/")
    parsed_url = urlparse(base_url)
    if parsed_url.scheme not in {"http", "https"} or not parsed_url.netloc:
        raise ValueError(
            f"Model registry entry {index} in {path} requires 'base_url' "
            "to be an absolute HTTP URL."
        )
    auth_ref = _optional_string(raw, "auth_ref") or provider.value
    efforts_raw = raw.get("reasoning_efforts", [])
    if not isinstance(efforts_raw, list) or not all(isinstance(item, str) for item in efforts_raw):
        raise ValueError(
            f"Model registry entry {index} in {path} has invalid 'reasoning_efforts'."
        )
    try:
        efforts = tuple(ReasoningEffort(item.strip().lower()) for item in efforts_raw)
    except ValueError as exc:
        raise ValueError(
            f"Model registry entry {index} in {path} contains an unsupported reasoning effort."
        ) from exc
    if len(set(efforts)) != len(efforts):
        raise ValueError(f"Model registry entry {index} in {path} repeats a reasoning effort.")
    default_raw = _optional_string(raw, "default_reasoning_effort")
    try:
        default_effort = ReasoningEffort(default_raw.lower()) if default_raw else None
    except ValueError as exc:
        raise ValueError(
            f"Model registry entry {index} in {path} has an unsupported default reasoning effort."
        ) from exc
    if default_effort is not None and default_effort not in efforts:
        raise ValueError(
            f"Model registry entry {index} in {path} has a default reasoning effort "
            "that is not listed in 'reasoning_efforts'."
        )
    profile = profile_for_provider(provider)
    return ModelCatalogEntry(
        provider=provider,
        protocol=protocol,
        model=model,
        display_name=_optional_string(raw, "name") or model,
        description=_optional_string(raw, "description") or "",
        base_url=base_url,
        auth_ref=auth_ref,
        supported_reasoning_efforts=efforts,
        default_reasoning_effort=default_effort,
        is_default=model == profile.default_model,
    )


def _required_string(raw: dict[str, Any], key: str, *, path: Path, index: int) -> str:
    value = _optional_string(raw, key)
    if value is None:
        raise ValueError(f"Model registry entry {index} in {path} requires '{key}'.")
    return value


def _optional_string(raw: dict[str, Any], key: str) -> str | None:
    value = raw.get(key)
    if not isinstance(value, str):
        return None
    stripped = value.strip()
    return stripped or None


__all__ = ["BUILTIN_MODEL_CATALOG", "ModelCatalogService"]
