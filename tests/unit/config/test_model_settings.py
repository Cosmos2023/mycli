from __future__ import annotations

import tomllib
from pathlib import Path

from mycli.config.model_settings import save_model_settings
from mycli.config.settings import default_user_config_path
from mycli.domain.providers import ProtocolId, ProviderId
from mycli.domain.runtime import AgentConfig, ReasoningEffort


def test_save_model_settings_preserves_unrelated_user_config(tmp_path: Path) -> None:
    path = default_user_config_path(tmp_path)
    path.parent.mkdir(parents=True)
    path.write_text('[tui]\ntheme = "light"\nhide_thinking = false\n', encoding="utf-8")
    config = AgentConfig(
        workspace_root=tmp_path,
        provider=ProviderId.OPENAI,
        protocol=ProtocolId.RESPONSES,
        model="gpt-5.4",
        api_base_url="https://api.openai.com/v1",
        auth_ref="openai-primary",
        reasoning_effort=ReasoningEffort.HIGH,
        thinking_effort=ReasoningEffort.HIGH,
    )

    save_model_settings(tmp_path, config)

    payload = tomllib.loads(path.read_text(encoding="utf-8"))
    assert payload["model"] == {
        "provider": "openai",
        "protocol": "responses",
        "name": "gpt-5.4",
        "api_base_url": "https://api.openai.com/v1",
        "auth_ref": "openai-primary",
        "supports_images": True,
    }
    assert payload["reasoning"]["effort"] == "high"
    assert payload["tui"] == {"theme": "light", "hide_thinking": False}


def test_save_model_settings_returns_snapshot_that_can_be_restored(tmp_path: Path) -> None:
    path = default_user_config_path(tmp_path)
    path.parent.mkdir(parents=True)
    original = b'model = "old"\n'
    path.write_bytes(original)
    config = AgentConfig(workspace_root=tmp_path, model="new")

    snapshot = save_model_settings(tmp_path, config)
    snapshot.restore()

    assert path.read_bytes() == original
