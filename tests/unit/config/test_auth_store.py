from __future__ import annotations

import json
import stat
from pathlib import Path

from mycli.config.auth_store import AuthStore, default_auth_path


def test_default_auth_path_uses_home_mycli_auth_json(tmp_path: Path) -> None:
    assert default_auth_path(tmp_path) == tmp_path / ".mycli" / "auth.json"


def test_auth_store_persists_api_key_credentials_with_private_permissions(tmp_path: Path) -> None:
    auth_path = tmp_path / ".mycli" / "auth.json"
    store = AuthStore(auth_path)

    store.set_api_key("deepseek", "sk-test")

    assert store.get_api_key("deepseek") == "sk-test"
    payload = json.loads(auth_path.read_text(encoding="utf-8"))
    assert payload == {"deepseek": {"type": "api_key", "key": "sk-test"}}
    assert stat.S_IMODE(auth_path.stat().st_mode) == 0o600
    assert stat.S_IMODE(auth_path.parent.stat().st_mode) == 0o700


def test_auth_store_preserves_other_provider_credentials(tmp_path: Path) -> None:
    auth_path = tmp_path / ".mycli" / "auth.json"
    auth_path.parent.mkdir(parents=True)
    auth_path.write_text(
        json.dumps(
            {
                "openai": {"type": "api_key", "key": "sk-openai"},
                "anthropic": {"type": "oauth", "access": "token"},
            }
        ),
        encoding="utf-8",
    )
    store = AuthStore(auth_path)

    store.set_api_key("deepseek", "sk-deepseek")

    payload = json.loads(auth_path.read_text(encoding="utf-8"))
    assert payload["openai"] == {"type": "api_key", "key": "sk-openai"}
    assert payload["anthropic"] == {"type": "oauth", "access": "token"}
    assert payload["deepseek"] == {"type": "api_key", "key": "sk-deepseek"}


def test_auth_store_ignores_malformed_or_non_api_key_credentials(tmp_path: Path) -> None:
    auth_path = tmp_path / ".mycli" / "auth.json"
    auth_path.parent.mkdir(parents=True)
    auth_path.write_text(
        json.dumps(
            {
                "openai": {"type": "oauth", "access": "token"},
                "deepseek": {"type": "api_key", "key": ""},
                "qwen": {"type": "api_key", "key": 123},
            }
        ),
        encoding="utf-8",
    )
    store = AuthStore(auth_path)

    assert store.get_api_key("openai") is None
    assert store.get_api_key("deepseek") is None
    assert store.get_api_key("qwen") is None


def test_auth_store_lists_only_usable_configured_providers(tmp_path: Path) -> None:
    auth_path = tmp_path / ".mycli" / "auth.json"
    auth_path.parent.mkdir(parents=True)
    auth_path.write_text(
        json.dumps(
            {
                "openai": {"type": "api_key", "key": "sk-openai"},
                "deepseek": {"type": "api_key", "key": "  "},
                "anthropic": {"type": "oauth", "access": "token"},
                "qwen": {"type": "api_key", "key": "sk-qwen"},
            }
        ),
        encoding="utf-8",
    )

    assert AuthStore(auth_path).configured_providers() == ("openai", "qwen")
