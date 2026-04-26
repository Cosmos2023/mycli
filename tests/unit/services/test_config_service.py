from pathlib import Path

import pytest

from mycli.domain.providers import ProtocolId, ProviderId
from mycli.services.config_service import resolve_config


def test_resolve_config_prefers_cli_over_env_and_files(tmp_path: Path) -> None:
    home_dir = tmp_path / "home"
    workspace = tmp_path / "workspace"
    home_dir.mkdir()
    workspace.mkdir()
    (home_dir / ".config").mkdir()
    (home_dir / ".config" / "mycli").mkdir()
    (workspace / ".mycli").mkdir()

    (home_dir / ".config" / "mycli" / "config.toml").write_text(
        'model = "user-model"\nmax_steps = 9\napi_key = "user-token"\nmax_prompt_tokens = 6000\n',
        encoding="utf-8",
    )
    (workspace / ".mycli" / "config.toml").write_text(
        (
            'model = "project-model"\n'
            'max_steps = 7\n'
            'api_key = "project-token"\n'
            'max_prompt_tokens = 5000\n'
            'compression_threshold_tokens = 3200\n'
        ),
        encoding="utf-8",
    )

    config = resolve_config(
        cli_args={"model": "cli-model", "session": "cli-session"},
        env={
            "MYCLI_MODEL": "env-model",
            "MYCLI_BASE_URL": "https://example.invalid/v1",
            "MYCLI_API_KEY": "test-token",
            "MYCLI_MAX_OUTPUT_TOKENS": "1500",
        },
        cwd=workspace,
        home=home_dir,
    )

    assert config.model == "cli-model"
    assert config.session_id == "cli-session"
    assert config.max_steps == 7
    assert config.api_base_url == "https://example.invalid/v1"
    assert config.api_key == "test-token"
    assert config.max_prompt_tokens == 5000
    assert config.compression_threshold_tokens == 3200
    assert config.max_output_tokens == 1500


def test_resolve_config_reads_api_key_from_project_file_when_env_missing(tmp_path: Path) -> None:
    home_dir = tmp_path / "home"
    workspace = tmp_path / "workspace"
    home_dir.mkdir()
    workspace.mkdir()
    (home_dir / ".config").mkdir()
    (home_dir / ".config" / "mycli").mkdir()
    (workspace / ".mycli").mkdir()

    (home_dir / ".config" / "mycli" / "config.toml").write_text(
        'api_key = "user-token"\n',
        encoding="utf-8",
    )
    (workspace / ".mycli" / "config.toml").write_text(
        'api_key = "project-token"\n',
        encoding="utf-8",
    )

    config = resolve_config(
        cli_args={"session": "demo"},
        env={},
        cwd=workspace,
        home=home_dir,
    )

    assert config.api_key == "project-token"


def test_resolve_config_defaults_protocol_to_responses(tmp_path: Path) -> None:
    home_dir = tmp_path / "home"
    workspace = tmp_path / "workspace"
    home_dir.mkdir()
    workspace.mkdir()

    config = resolve_config(
        cli_args={"session": "demo"},
        env={},
        cwd=workspace,
        home=home_dir,
    )

    assert config.protocol == "responses"
    assert config.reasoning_effort == "medium"


def test_resolve_config_reads_reasoning_effort_from_env(tmp_path: Path) -> None:
    home_dir = tmp_path / "home"
    workspace = tmp_path / "workspace"
    home_dir.mkdir()
    workspace.mkdir()

    config = resolve_config(
        cli_args={"session": "demo"},
        env={"MYCLI_REASONING_EFFORT": "high"},
        cwd=workspace,
        home=home_dir,
    )

    assert config.reasoning_effort == "high"


def test_resolve_config_enables_thinking_when_explicit_toggle_is_true(tmp_path: Path) -> None:
    home_dir = tmp_path / "home"
    workspace = tmp_path / "workspace"
    home_dir.mkdir()
    workspace.mkdir()

    config = resolve_config(
        cli_args={"session": "demo"},
        env={
            "MYCLI_THINKING_ENABLED": "true",
            "MYCLI_THINKING_EFFORT": "high",
        },
        cwd=workspace,
        home=home_dir,
    )

    assert config.thinking_enabled is True
    assert config.thinking_effort == "high"


def test_resolve_config_maps_legacy_reasoning_effort_to_thinking_effort(
    tmp_path: Path,
) -> None:
    home_dir = tmp_path / "home"
    workspace = tmp_path / "workspace"
    home_dir.mkdir()
    workspace.mkdir()

    config = resolve_config(
        cli_args={"session": "demo"},
        env={"MYCLI_REASONING_EFFORT": "medium"},
        cwd=workspace,
        home=home_dir,
    )

    assert config.thinking_enabled is True
    assert config.thinking_effort == "medium"


def test_resolve_config_rejects_thinking_effort_when_thinking_disabled(
    tmp_path: Path,
) -> None:
    home_dir = tmp_path / "home"
    workspace = tmp_path / "workspace"
    home_dir.mkdir()
    workspace.mkdir()

    with pytest.raises(ValueError, match="thinking_effort requires thinking_enabled=true"):
        resolve_config(
            cli_args={"session": "demo"},
            env={
                "MYCLI_THINKING_ENABLED": "false",
                "MYCLI_THINKING_EFFORT": "high",
            },
            cwd=workspace,
            home=home_dir,
        )


def test_resolve_config_rejects_unknown_reasoning_effort(tmp_path: Path) -> None:
    home_dir = tmp_path / "home"
    workspace = tmp_path / "workspace"
    home_dir.mkdir()
    workspace.mkdir()

    with pytest.raises(
        ValueError,
        match="Unsupported reasoning effort 'turbo'",
    ):
        resolve_config(
            cli_args={"session": "demo"},
            env={"MYCLI_REASONING_EFFORT": "turbo"},
            cwd=workspace,
            home=home_dir,
        )


def test_resolve_config_prefers_env_protocol_over_project_and_user_config(tmp_path: Path) -> None:
    home_dir = tmp_path / "home"
    workspace = tmp_path / "workspace"
    home_dir.mkdir()
    workspace.mkdir()
    (home_dir / ".config").mkdir()
    (home_dir / ".config" / "mycli").mkdir()
    (workspace / ".mycli").mkdir()

    (home_dir / ".config" / "mycli" / "config.toml").write_text(
        'protocol = "legacy_chat"\n',
        encoding="utf-8",
    )
    (workspace / ".mycli" / "config.toml").write_text(
        'protocol = "legacy_chat"\n',
        encoding="utf-8",
    )

    config = resolve_config(
        cli_args={"session": "demo"},
        env={"MYCLI_PROTOCOL": "responses"},
        cwd=workspace,
        home=home_dir,
    )

    assert config.protocol == "responses"


def test_resolve_config_rejects_unknown_protocol_value(tmp_path: Path) -> None:
    home_dir = tmp_path / "home"
    workspace = tmp_path / "workspace"
    home_dir.mkdir()
    workspace.mkdir()

    with pytest.raises(
        ValueError,
        match="Unsupported protocol 'experimental'",
    ):
        resolve_config(
            cli_args={"session": "demo"},
            env={"MYCLI_PROTOCOL": "experimental"},
            cwd=workspace,
            home=home_dir,
        )


def test_resolve_config_infers_deepseek_provider_and_defaults_to_chat_completions(
    tmp_path: Path,
) -> None:
    home_dir = tmp_path / "home"
    workspace = tmp_path / "workspace"
    home_dir.mkdir()
    workspace.mkdir()

    config = resolve_config(
        cli_args={"session": "demo"},
        env={
            "MYCLI_API_KEY": "test-key",
            "MYCLI_BASE_URL": "https://api.deepseek.com",
        },
        cwd=workspace,
        home=home_dir,
    )

    assert config.provider is ProviderId.DEEPSEEK
    assert config.protocol is ProtocolId.CHAT_COMPLETIONS
    assert config.api_base_url == "https://api.deepseek.com"


def test_resolve_config_prefers_explicit_provider_over_base_url_inference(
    tmp_path: Path,
) -> None:
    home_dir = tmp_path / "home"
    workspace = tmp_path / "workspace"
    home_dir.mkdir()
    workspace.mkdir()

    config = resolve_config(
        cli_args={"session": "demo"},
        env={
            "MYCLI_API_KEY": "test-key",
            "MYCLI_PROVIDER": "openai",
            "MYCLI_BASE_URL": "https://api.deepseek.com",
        },
        cwd=workspace,
        home=home_dir,
    )

    assert config.provider is ProviderId.OPENAI
    assert config.protocol is ProtocolId.RESPONSES


def test_resolve_config_accepts_chat_completions_protocol(tmp_path: Path) -> None:
    home_dir = tmp_path / "home"
    workspace = tmp_path / "workspace"
    home_dir.mkdir()
    workspace.mkdir()

    config = resolve_config(
        cli_args={"session": "demo"},
        env={
            "MYCLI_API_KEY": "test-key",
            "MYCLI_PROTOCOL": "chat_completions",
        },
        cwd=workspace,
        home=home_dir,
    )

    assert config.protocol is ProtocolId.CHAT_COMPLETIONS


def test_resolve_config_rejects_legacy_chat_protocol(tmp_path: Path) -> None:
    home_dir = tmp_path / "home"
    workspace = tmp_path / "workspace"
    home_dir.mkdir()
    workspace.mkdir()

    with pytest.raises(ValueError, match="Use 'chat_completions' instead"):
        resolve_config(
            cli_args={"session": "demo"},
            env={
                "MYCLI_API_KEY": "test-key",
                "MYCLI_PROTOCOL": "legacy_chat",
            },
            cwd=workspace,
            home=home_dir,
        )


def test_resolve_config_rejects_deepseek_with_responses_protocol(
    tmp_path: Path,
) -> None:
    home_dir = tmp_path / "home"
    workspace = tmp_path / "workspace"
    home_dir.mkdir()
    workspace.mkdir()

    with pytest.raises(
        ValueError,
        match="Provider 'deepseek' does not support protocol 'responses'",
    ):
        resolve_config(
            cli_args={"session": "demo"},
            env={
                "MYCLI_API_KEY": "test-key",
                "MYCLI_PROVIDER": "deepseek",
                "MYCLI_PROTOCOL": "responses",
            },
            cwd=workspace,
            home=home_dir,
        )
