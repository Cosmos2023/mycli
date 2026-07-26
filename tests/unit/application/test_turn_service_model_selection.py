from __future__ import annotations

import json
import tomllib
from pathlib import Path

import pytest

from mycli.application.runtime.agent_runtime import AgentRuntime
from mycli.application.turn_service import ModelSelectionError, TurnService
from mycli.config.auth_store import AuthStore
from mycli.config.settings import default_user_config_path
from mycli.domain.model_catalog import ModelSelection
from mycli.domain.providers import ProtocolId, ProviderId
from mycli.domain.runtime import ReasoningEffort
from mycli.schemas.responses_protocol import ResponsesContinuationState


class Adapter:
    def next_action(self, *, messages, tools):
        del messages, tools
        raise AssertionError("not used")


def _service(tmp_path: Path) -> tuple[TurnService, AgentRuntime, list[object]]:
    home = tmp_path / "home"
    old_adapter = Adapter()
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=home,
        model_adapter=old_adapter,
    )
    built: list[object] = []

    def build(config):
        adapter = Adapter()
        built.append((config, adapter))
        return adapter

    service = TurnService(
        config=runtime._config,
        home_dir=home,
        runtime=runtime,
        model_adapter_factory=build,
    )
    return service, runtime, built


def _write_model_registry(
    home: Path,
    *,
    model: str,
    provider: str,
    protocol: str,
    base_url: str,
    auth_ref: str,
    reasoning_efforts: list[str] | None = None,
) -> None:
    path = home / ".mycli" / "models.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(
            {
                "models": [
                    {
                        "model": model,
                        "provider": provider,
                        "protocol": protocol,
                        "base_url": base_url,
                        "auth_ref": auth_ref,
                        "reasoning_efforts": reasoning_efforts or [],
                        "default_reasoning_effort": (
                            reasoning_efforts[0] if reasoning_efforts else None
                        ),
                    }
                ]
            }
        ),
        encoding="utf-8",
    )


def test_select_model_updates_provider_adapter_runtime_and_default_config(tmp_path: Path) -> None:
    service, runtime, built = _service(tmp_path)
    home = tmp_path / "home"
    AuthStore.from_home(home).set_api_key("openai-primary", "sk-openai")
    _write_model_registry(
        home,
        model="gpt-5.4",
        provider="openai",
        protocol="responses",
        base_url="https://gateway.example.test/v1",
        auth_ref="openai-primary",
        reasoning_efforts=["high"],
    )

    selected = service.select_model(
        ModelSelection(
            provider=ProviderId.OPENAI,
            protocol=ProtocolId.RESPONSES,
            model="gpt-5.4",
            base_url="https://gateway.example.test/v1",
            reasoning_effort=ReasoningEffort.HIGH,
        )
    )

    assert selected.model == "gpt-5.4"
    assert service._config.provider is ProviderId.OPENAI
    assert service._config.reasoning_effort is ReasoningEffort.HIGH
    assert service._config.api_key == "sk-openai"
    assert service._config.auth_ref == "openai-primary"
    new_adapter = built[0][1]
    assert runtime._model_adapter is new_adapter
    assert runtime._model_turn_requester._model_adapter is new_adapter
    assert runtime._model_state._model_adapter is new_adapter
    payload = tomllib.loads(
        default_user_config_path(tmp_path / "home").read_text(encoding="utf-8")
    )
    assert payload["model"]["name"] == "gpt-5.4"
    assert payload["model"]["auth_ref"] == "openai-primary"
    assert payload["reasoning"]["effort"] == "high"


def test_select_model_rejects_effort_not_supported_by_model(tmp_path: Path) -> None:
    service, runtime, _built = _service(tmp_path)
    AuthStore.from_home(tmp_path / "home").set_api_key("deepseek", "sk-deepseek")
    before = runtime._config

    with pytest.raises(ModelSelectionError, match="does not support reasoning effort"):
        service.select_model(
            ModelSelection(
                provider=ProviderId.DEEPSEEK,
                protocol=ProtocolId.CHAT_COMPLETIONS,
                model="deepseek-chat",
                base_url="https://api.deepseek.com",
                reasoning_effort=ReasoningEffort.XHIGH,
            )
        )

    assert runtime._config == before


def test_select_model_restores_file_and_runtime_when_rebind_fails(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service, runtime, _built = _service(tmp_path)
    home = tmp_path / "home"
    AuthStore.from_home(home).set_api_key("openai", "sk-openai")
    path = default_user_config_path(home)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text('[tui]\ntheme = "light"\n', encoding="utf-8")
    original_bytes = path.read_bytes()
    old_adapter = runtime._model_adapter
    old_config = runtime._config
    real_rebind = runtime.rebind_session
    calls = 0

    def fail_once(config):
        nonlocal calls
        calls += 1
        if calls == 1:
            raise RuntimeError("rebind failed")
        return real_rebind(config)

    monkeypatch.setattr(runtime, "rebind_session", fail_once)

    with pytest.raises(ModelSelectionError, match="rebind failed"):
        service.select_model(
            ModelSelection(
                provider=ProviderId.OPENAI,
                protocol=ProtocolId.RESPONSES,
                model="gpt-5.4",
                base_url="https://api.openai.com/v1",
                reasoning_effort=ReasoningEffort.MEDIUM,
            )
        )

    assert path.read_bytes() == original_bytes
    assert service._config == old_config
    assert runtime._config == old_config
    assert runtime._model_adapter is old_adapter
    assert runtime._model_turn_requester._model_adapter is old_adapter
    assert runtime._model_state._model_adapter is old_adapter


def test_direct_model_command_uses_the_same_atomic_selection_path(tmp_path: Path) -> None:
    service, runtime, built = _service(tmp_path)
    AuthStore.from_home(tmp_path / "home").set_api_key("openai", "sk-openai")

    lines = service.set_model_settings(model="gpt-5.4", thinking_effort="high")

    assert lines == ("model=gpt-5.4", "thinking_effort=high")
    assert runtime._model_adapter is built[0][1]
    assert service._config.reasoning_effort is ReasoningEffort.HIGH


def test_select_model_clears_previous_responses_continuation(tmp_path: Path) -> None:
    service, runtime, _built = _service(tmp_path)
    AuthStore.from_home(tmp_path / "home").set_api_key("openai", "sk-openai")
    runtime._session_service.save_responses_continuation_state(
        runtime._config.session_id,
        ResponsesContinuationState(
            response_id="resp_old_model",
            request_signature="old-signature",
        ),
    )

    service.select_model(
        ModelSelection(
            provider=ProviderId.OPENAI,
            protocol=ProtocolId.RESPONSES,
            model="gpt-5.4",
            base_url="https://api.openai.com/v1",
            reasoning_effort=ReasoningEffort.MEDIUM,
        )
    )

    assert runtime._session_service.load_responses_continuation_state(
        runtime._config.session_id
    ) is None
