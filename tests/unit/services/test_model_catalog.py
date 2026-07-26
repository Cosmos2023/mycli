from __future__ import annotations

import json
from pathlib import Path

import pytest

from mycli.domain.providers import ProtocolId, ProviderId
from mycli.domain.runtime import AgentConfig, ReasoningEffort
from mycli.services.model_catalog import ModelCatalogService


def _config(
    tmp_path: Path,
    *,
    provider: ProviderId = ProviderId.COMPATIBLE,
    protocol: ProtocolId = ProtocolId.RESPONSES,
    model: str = "vendor-custom-model",
    base_url: str = "https://models.example.test/v1",
    auth_ref: str | None = None,
) -> AgentConfig:
    return AgentConfig(
        workspace_root=tmp_path,
        provider=provider,
        protocol=protocol,
        model=model,
        api_base_url=base_url,
        api_key="sk-active",
        auth_ref=auth_ref,
    )


def _write_models(tmp_path: Path, models: list[dict[str, object]]) -> Path:
    path = tmp_path / ".mycli" / "models.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"models": models}), encoding="utf-8")
    return path


def test_catalog_bootstraps_authoritative_models_json_when_missing(tmp_path: Path) -> None:
    config = _config(tmp_path)

    entries = ModelCatalogService(home_dir=tmp_path).list_models(current_config=config)

    path = tmp_path / ".mycli" / "models.json"
    payload = json.loads(path.read_text(encoding="utf-8"))
    assert entries
    assert payload["models"]
    assert all("model" in item and "id" not in item for item in payload["models"])
    assert any(item["model"] == config.model for item in payload["models"])


def test_catalog_bootstrap_preserves_current_builtin_auth_ref(tmp_path: Path) -> None:
    config = _config(
        tmp_path,
        provider=ProviderId.OPENAI,
        protocol=ProtocolId.RESPONSES,
        model="gpt-5.4",
        base_url="https://api.openai.com/v1",
        auth_ref="openai-primary",
    )

    entries = ModelCatalogService(home_dir=tmp_path).list_models(current_config=config)

    assert entries[0].model == "gpt-5.4"
    assert entries[0].auth_ref == "openai-primary"
    assert entries[0].is_current is True


def test_catalog_uses_only_models_defined_in_models_json(tmp_path: Path) -> None:
    _write_models(
        tmp_path,
        [
            {
                "model": "only-this-model",
                "provider": "compatible",
                "protocol": "responses",
                "base_url": "https://models.example.test/v1",
                "auth_ref": "private-endpoint",
            }
        ],
    )

    entries = ModelCatalogService(home_dir=tmp_path).list_models(
        current_config=_config(tmp_path)
    )

    assert [entry.model for entry in entries] == ["only-this-model"]
    assert entries[0].auth_ref == "private-endpoint"


def test_catalog_rejects_non_http_model_endpoint(tmp_path: Path) -> None:
    _write_models(
        tmp_path,
        [
            {
                "model": "broken-model",
                "provider": "compatible",
                "protocol": "responses",
                "base_url": "not-a-url",
            }
        ],
    )

    with pytest.raises(ValueError, match="absolute HTTP URL"):
        ModelCatalogService(home_dir=tmp_path).list_models(
            current_config=_config(tmp_path)
        )


def test_catalog_marks_matching_current_model_first(tmp_path: Path) -> None:
    config = _config(
        tmp_path,
        provider=ProviderId.OPENAI,
        model="gpt-5.4",
        base_url="https://api.openai.com/v1",
    )

    _write_models(
        tmp_path,
        [
            {
                "model": "gpt-5",
                "provider": "openai",
                "protocol": "responses",
                "base_url": "https://api.openai.com/v1",
                "auth_ref": "openai",
            },
            {
                "model": "gpt-5.4",
                "provider": "openai",
                "protocol": "responses",
                "base_url": "https://api.openai.com/v1",
                "auth_ref": "openai",
            },
        ],
    )

    entries = ModelCatalogService(home_dir=tmp_path).list_models(current_config=config)

    assert entries[0].identity == (ProviderId.OPENAI, ProtocolId.RESPONSES, "gpt-5.4")
    assert entries[0].is_current is True
    assert sum(entry.model == "gpt-5.4" for entry in entries) == 1


def test_catalog_parses_user_endpoint_auth_and_reasoning_capabilities(tmp_path: Path) -> None:
    _write_models(
        tmp_path,
        [
            {
                "model": "gpt-custom",
                "provider": "compatible",
                "protocol": "responses",
                "base_url": "http://localhost:8080/v1/",
                "auth_ref": "local-openai",
                "name": "Local GPT",
                "description": "Local development endpoint",
                "reasoning_efforts": ["low", "medium", "high", "xhigh"],
                "default_reasoning_effort": "high",
            }
        ],
    )

    entry = ModelCatalogService(home_dir=tmp_path).list_models(
        current_config=_config(tmp_path)
    )[0]

    assert entry.model == "gpt-custom"
    assert entry.base_url == "http://localhost:8080/v1"
    assert entry.auth_ref == "local-openai"
    assert entry.display_name == "Local GPT"
    assert entry.description == "Local development endpoint"
    assert entry.supported_reasoning_efforts == (
        ReasoningEffort.LOW,
        ReasoningEffort.MEDIUM,
        ReasoningEffort.HIGH,
        ReasoningEffort.XHIGH,
    )
    assert entry.default_reasoning_effort is ReasoningEffort.HIGH


def test_catalog_sorts_non_current_models_by_provider_then_model(tmp_path: Path) -> None:
    _write_models(
        tmp_path,
        [
            {
                "model": "z-model",
                "provider": "openai",
                "protocol": "responses",
                "base_url": "https://api.openai.com/v1",
            },
            {
                "model": "a-model",
                "provider": "deepseek",
                "protocol": "chat_completions",
                "base_url": "https://api.deepseek.com",
            },
        ],
    )

    entries = ModelCatalogService(home_dir=tmp_path).list_models(
        current_config=_config(tmp_path)
    )

    ordered = [(entry.provider.value, entry.model) for entry in entries]
    assert ordered == sorted(ordered)
