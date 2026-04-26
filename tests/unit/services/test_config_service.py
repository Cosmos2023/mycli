from pathlib import Path

import pytest

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
