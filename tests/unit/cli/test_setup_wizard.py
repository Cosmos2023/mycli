from __future__ import annotations

import stat
import tomllib
from pathlib import Path

from mycli.cli.setup_wizard import default_user_config_path, run_setup_wizard
from mycli.domain.providers import ProviderId


def test_default_user_config_path_uses_xdg_config_home_layout(tmp_path: Path) -> None:
    assert default_user_config_path(tmp_path) == tmp_path / ".config" / "mycli" / "config.toml"


def test_run_setup_wizard_writes_provider_profile_defaults(tmp_path: Path) -> None:
    inputs = iter(["deepseek", "", "deepseek-v4-flash"])
    outputs: list[str] = []

    result = run_setup_wizard(
        home_dir=tmp_path,
        input_func=lambda _prompt: next(inputs),
        secret_input_func=lambda _prompt: "sk-test",
        output_func=outputs.append,
    )

    config_path = tmp_path / ".config" / "mycli" / "config.toml"
    payload = tomllib.loads(config_path.read_text(encoding="utf-8"))
    assert result.config_path == config_path
    assert result.provider is ProviderId.DEEPSEEK
    assert result.model == "deepseek-v4-flash"
    assert result.api_base_url == "https://api.deepseek.com"
    assert payload == {
        "provider": "deepseek",
        "protocol": "chat_completions",
        "model": "deepseek-v4-flash",
        "api_base_url": "https://api.deepseek.com",
        "api_key": "sk-test",
    }
    assert stat.S_IMODE(config_path.stat().st_mode) == 0o600
    assert any("Saved configuration" in line for line in outputs)


def test_run_setup_wizard_preserves_existing_config_tables_and_lists(tmp_path: Path) -> None:
    config_path = tmp_path / ".config" / "mycli" / "config.toml"
    config_path.parent.mkdir(parents=True)
    config_path.write_text(
        "\n".join(
            [
                'statusline_enabled = true',
                'allowed_tools = ["Read", "Grep"]',
                "",
                "[mcp_servers.filesystem]",
                'command = "mcp-server-filesystem"',
                'args = ["--root", "."]',
                "enabled = true",
                "",
            ]
        ),
        encoding="utf-8",
    )
    inputs = iter(["1", "https://api.openai.com/v1/", 'gpt-"quoted"'])

    run_setup_wizard(
        home_dir=tmp_path,
        input_func=lambda _prompt: next(inputs),
        secret_input_func=lambda _prompt: 'sk-"quoted"',
        output_func=lambda _line: None,
    )

    payload = tomllib.loads(config_path.read_text(encoding="utf-8"))
    assert payload["provider"] == "openai"
    assert payload["api_base_url"] == "https://api.openai.com/v1"
    assert payload["model"] == 'gpt-"quoted"'
    assert payload["api_key"] == 'sk-"quoted"'
    assert payload["statusline_enabled"] is True
    assert payload["allowed_tools"] == ["Read", "Grep"]
    assert payload["mcp_servers"]["filesystem"] == {
        "command": "mcp-server-filesystem",
        "args": ["--root", "."],
        "enabled": True,
    }


def test_run_setup_wizard_reprompts_invalid_provider_and_empty_secret(tmp_path: Path) -> None:
    inputs = iter(["bad-provider", "5", "", "compatible-model"])
    secrets = iter(["", "sk-compatible"])
    outputs: list[str] = []

    result = run_setup_wizard(
        home_dir=tmp_path,
        input_func=lambda _prompt: next(inputs),
        secret_input_func=lambda _prompt: next(secrets),
        output_func=outputs.append,
    )

    payload = tomllib.loads(result.config_path.read_text(encoding="utf-8"))
    assert result.provider is ProviderId.COMPATIBLE
    assert payload["provider"] == "compatible"
    assert payload["api_key"] == "sk-compatible"
    assert any("Unsupported provider" in line for line in outputs)
