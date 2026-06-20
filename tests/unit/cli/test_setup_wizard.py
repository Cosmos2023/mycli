from __future__ import annotations

import stat
import tomllib
from pathlib import Path

from mycli.config.auth_store import AuthStore
import mycli.cli.setup_wizard as setup_wizard
from mycli.cli.setup_wizard import default_user_config_path, run_setup_wizard
from mycli.domain.providers import ProviderId
from mycli.tools.ripgrep_prepare import RipgrepPrepareResult


def test_setup_wizard_repo_root_points_at_current_worktree() -> None:
    repo_root = Path(setup_wizard.__file__).resolve().parents[3]

    assert (repo_root / "tui" / "mycli-shell" / "src" / "setup.ts").is_file()


def test_default_user_config_path_uses_mycli_home_layout(tmp_path: Path) -> None:
    assert default_user_config_path(tmp_path) == tmp_path / ".mycli" / "config.toml"


def test_run_setup_wizard_writes_provider_profile_defaults(monkeypatch, tmp_path: Path) -> None:
    inputs = iter(["", "deepseek", "", "deepseek-v4-flash"])
    secret_prompts: list[str] = []
    outputs: list[str] = []
    prepared_roots: list[Path] = []

    def fake_prepare_user_ripgrep(*, dest_root: Path, **_kwargs: object) -> RipgrepPrepareResult:
        prepared_roots.append(dest_root)
        return RipgrepPrepareResult(path=dest_root / "macos-aarch64" / "rg", installed=True)

    monkeypatch.setattr(setup_wizard, "prepare_user_ripgrep", fake_prepare_user_ripgrep)

    result = run_setup_wizard(
        home_dir=tmp_path,
        input_func=lambda _prompt: next(inputs),
        secret_input_func=lambda prompt: secret_prompts.append(prompt) or "sk-test",
        output_func=outputs.append,
    )

    config_path = tmp_path / ".mycli" / "config.toml"
    config_text = config_path.read_text(encoding="utf-8")
    payload = tomllib.loads(config_path.read_text(encoding="utf-8"))
    assert result.config_path == config_path
    assert result.provider is ProviderId.DEEPSEEK
    assert result.model == "deepseek-v4-flash"
    assert result.api_base_url == "https://api.deepseek.com"
    assert payload == {
        "model": {
            "provider": "deepseek",
            "protocol": "chat_completions",
            "name": "deepseek-v4-flash",
            "api_base_url": "https://api.deepseek.com",
        },
        "request": {
            "cache_control_enabled": False,
            "prompt_cache_key_enabled": False,
        },
    }
    assert config_text.startswith("[model]\n")
    assert "\n[request]\n" in config_text
    assert AuthStore.from_home(tmp_path).get_api_key("deepseek") == "sk-test"
    assert stat.S_IMODE(config_path.stat().st_mode) == 0o600
    assert any("Saved configuration" in line for line in outputs)
    assert "Select authentication method:" in outputs
    assert "  1. Use an API key" in outputs
    assert "Select provider to configure:" in outputs
    assert any("DeepSeek • unconfigured" in line for line in outputs)
    assert "Login to DeepSeek" in outputs
    assert "Enter API key:" in outputs
    assert secret_prompts == ["API key: "]
    assert outputs.count("────────────────────────────────────────") >= 6
    assert prepared_roots == [tmp_path / ".mycli" / "vendor" / "ripgrep"]
    assert any("Prepared ripgrep" in line for line in outputs)


def test_run_setup_wizard_preserves_existing_config_tables_and_lists(
    monkeypatch,
    tmp_path: Path,
) -> None:
    config_path = tmp_path / ".mycli" / "config.toml"
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
    inputs = iter(["1", "1", "https://api.openai.com/v1/", 'gpt-"quoted"'])
    monkeypatch.setattr(
        setup_wizard,
        "prepare_user_ripgrep",
        lambda **_kwargs: RipgrepPrepareResult(path=tmp_path / "rg", installed=False),
    )

    run_setup_wizard(
        home_dir=tmp_path,
        input_func=lambda _prompt: next(inputs),
        secret_input_func=lambda _prompt: 'sk-"quoted"',
        output_func=lambda _line: None,
    )

    payload = tomllib.loads(config_path.read_text(encoding="utf-8"))
    assert payload["model"]["provider"] == "openai"
    assert payload["model"]["api_base_url"] == "https://api.openai.com/v1"
    assert payload["model"]["name"] == 'gpt-"quoted"'
    assert "api_key" not in payload
    assert AuthStore.from_home(tmp_path).get_api_key("openai") == 'sk-"quoted"'
    assert payload["tui"]["statusline_enabled"] is True
    assert payload["allowed_tools"] == ["Read", "Grep"]
    assert payload["mcp_servers"]["filesystem"] == {
        "command": "mcp-server-filesystem",
        "args": ["--root", "."],
        "enabled": True,
    }


def test_run_setup_wizard_rewrites_config_with_grouped_qwen_cache_defaults(
    monkeypatch,
    tmp_path: Path,
) -> None:
    config_path = tmp_path / ".mycli" / "config.toml"
    config_path.parent.mkdir(parents=True)
    config_path.write_text(
        "\n".join(
            [
                'provider = "deepseek"',
                'protocol = "chat_completions"',
                'model = "deepseek-v4-flash"',
                'api_base_url = "https://api.deepseek.com"',
                "memory_enabled = true",
                "memory_extraction_interval_turns = -1",
                "cache_control_enabled = false",
                "prompt_cache_key_enabled = false",
                "",
                "[compaction_l4_trigger_ratios_by_model]",
                "deepseek-v4-flash = 0.9",
                "",
            ]
        ),
        encoding="utf-8",
    )
    inputs = iter(["1", "qwen", "", "qwen3.6-plus"])
    monkeypatch.setattr(
        setup_wizard,
        "prepare_user_ripgrep",
        lambda **_kwargs: RipgrepPrepareResult(path=tmp_path / "rg", installed=False),
    )

    run_setup_wizard(
        home_dir=tmp_path,
        input_func=lambda _prompt: next(inputs),
        secret_input_func=lambda _prompt: "sk-qwen",
        output_func=lambda _line: None,
    )

    text = config_path.read_text(encoding="utf-8")
    payload = tomllib.loads(text)
    assert payload["model"]["provider"] == "qwen"
    assert payload["model"]["protocol"] == "chat_completions"
    assert payload["request"]["cache_control_enabled"] is True
    assert payload["request"]["prompt_cache_key_enabled"] is False
    assert payload["memory"]["extraction_interval_turns"] == -1
    assert payload["compaction_l4_trigger_ratios_by_model"] == {
        "deepseek-v4-flash": 0.9
    }
    assert text.index("[model]") < text.index("[request]")
    assert text.index("[request]") < text.index("[memory]")
    assert "\n[compaction_l4_trigger_ratios_by_model]\n" in text


def test_run_setup_wizard_handles_interrupted_ripgrep_prepare(
    monkeypatch,
    tmp_path: Path,
) -> None:
    inputs = iter(["1", "deepseek", "", "deepseek-v4-flash"])
    outputs: list[str] = []

    def interrupted_prepare_user_ripgrep(**_kwargs: object) -> RipgrepPrepareResult:
        raise KeyboardInterrupt

    monkeypatch.setattr(setup_wizard, "prepare_user_ripgrep", interrupted_prepare_user_ripgrep)

    result = run_setup_wizard(
        home_dir=tmp_path,
        input_func=lambda _prompt: next(inputs),
        secret_input_func=lambda _prompt: "sk-test",
        output_func=outputs.append,
    )

    assert result.config_path.exists()
    assert AuthStore.from_home(tmp_path).get_api_key("deepseek") == "sk-test"
    assert any("Ripgrep preparation interrupted" in line for line in outputs)


def test_run_setup_wizard_reprompts_invalid_provider_and_empty_secret(
    monkeypatch,
    tmp_path: Path,
) -> None:
    inputs = iter(["bad-method", "1", "bad-provider", "6", "", "compatible-model"])
    secrets = iter(["", "sk-compatible"])
    outputs: list[str] = []
    monkeypatch.setattr(
        setup_wizard,
        "prepare_user_ripgrep",
        lambda **_kwargs: RipgrepPrepareResult(path=tmp_path / "rg", installed=False),
    )

    result = run_setup_wizard(
        home_dir=tmp_path,
        input_func=lambda _prompt: next(inputs),
        secret_input_func=lambda _prompt: next(secrets),
        output_func=outputs.append,
    )

    payload = tomllib.loads(result.config_path.read_text(encoding="utf-8"))
    assert result.provider is ProviderId.COMPATIBLE
    assert payload["model"]["provider"] == "compatible"
    assert AuthStore.from_home(tmp_path).get_api_key("compatible") == "sk-compatible"
    assert any("Unsupported authentication method" in line for line in outputs)
    assert any("Unsupported provider" in line for line in outputs)


def test_run_setup_wizard_marks_stored_api_key_provider_as_configured(
    monkeypatch,
    tmp_path: Path,
) -> None:
    AuthStore.from_home(tmp_path).set_api_key("openai", "sk-existing")
    inputs = iter(["api key", "openai", "", "gpt-5"])
    outputs: list[str] = []
    monkeypatch.setattr(
        setup_wizard,
        "prepare_user_ripgrep",
        lambda **_kwargs: RipgrepPrepareResult(path=tmp_path / "rg", installed=False),
    )

    run_setup_wizard(
        home_dir=tmp_path,
        input_func=lambda _prompt: next(inputs),
        secret_input_func=lambda _prompt: "sk-updated",
        output_func=outputs.append,
    )

    assert any("OpenAI ✓ configured" in line for line in outputs)
    assert AuthStore.from_home(tmp_path).get_api_key("openai") == "sk-updated"
