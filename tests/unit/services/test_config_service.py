from pathlib import Path
from uuid import UUID
import json

import pytest

from mycli.config.auth_store import AuthStore
from mycli.domain.runtime import CollaborationMode, ProviderCachePolicyCapability, ViewMode
from mycli.domain.providers import ProtocolId, ProviderId
from mycli.config.settings import resolve_config
from mycli.infrastructure.providers import resolve_provider_cache_policy_capability


def test_resolve_config_prefers_cli_over_env_and_files(tmp_path: Path) -> None:
    home_dir = tmp_path / "home"
    workspace = tmp_path / "workspace"
    home_dir.mkdir()
    workspace.mkdir()
    (home_dir / ".mycli").mkdir()
    (workspace / ".mycli").mkdir()

    (home_dir / ".mycli" / "config.toml").write_text(
        'model = "user-model"\napi_key = "user-token"\nmax_prompt_tokens = 6000\n',
        encoding="utf-8",
    )
    (workspace / ".mycli" / "config.toml").write_text(
        (
            'model = "project-model"\n'
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
    assert config.api_base_url == "https://example.invalid/v1"
    assert config.api_key == "test-token"
    assert config.max_prompt_tokens == 6000
    assert config.compression_threshold_tokens == 3200
    assert config.max_output_tokens == 1500


def test_resolve_config_prefers_home_mycli_config_over_workspace_config(
    tmp_path: Path,
) -> None:
    home_dir = tmp_path / "home"
    workspace = tmp_path / "workspace"
    home_dir.mkdir()
    workspace.mkdir()
    (home_dir / ".mycli").mkdir()
    (workspace / ".mycli").mkdir()

    (home_dir / ".mycli" / "config.toml").write_text(
        "\n".join(
            [
                'provider = "deepseek"',
                'protocol = "chat_completions"',
                'model = "home-model"',
                "max_prompt_tokens = 6100",
            ]
        ),
        encoding="utf-8",
    )
    (workspace / ".mycli" / "config.toml").write_text(
        "\n".join(
            [
                'provider = "openai"',
                'protocol = "responses"',
                'model = "workspace-model"',
                "max_prompt_tokens = 5000",
            ]
        ),
        encoding="utf-8",
    )
    AuthStore.from_home(home_dir).set_api_key("deepseek", "sk-auth-store")

    config = resolve_config(
        cli_args={"session": "demo"},
        env={},
        cwd=workspace,
        home=home_dir,
    )

    assert config.provider is ProviderId.DEEPSEEK
    assert config.protocol is ProtocolId.CHAT_COMPLETIONS
    assert config.model == "home-model"
    assert config.max_prompt_tokens == 6100
    assert config.api_key == "sk-auth-store"


def test_resolve_config_reads_sectioned_user_config(tmp_path: Path) -> None:
    home_dir = tmp_path / "home"
    workspace = tmp_path / "workspace"
    home_dir.mkdir()
    workspace.mkdir()
    (home_dir / ".mycli").mkdir()
    (home_dir / ".mycli" / "config.toml").write_text(
        "\n".join(
            [
                "[model]",
                'provider = "qwen"',
                'protocol = "chat_completions"',
                'name = "qwen3.6-plus"',
                'api_base_url = "https://dashscope.aliyuncs.com/compatible-mode/v1"',
                "",
                "[request]",
                "max_prompt_tokens = 64000",
                "cache_control_enabled = true",
                "prompt_cache_key_enabled = false",
                "",
                "[memory]",
                "enabled = true",
                "extraction_interval_turns = -1",
                "",
                "[context]",
                "recent_message_count = 9",
                "",
                "[tui]",
                'view_mode = "focus"',
                "statusline_enabled = false",
            ]
        ),
        encoding="utf-8",
    )
    AuthStore.from_home(home_dir).set_api_key("qwen", "sk-auth-store")

    config = resolve_config(
        cli_args={"session": "demo"},
        env={},
        cwd=workspace,
        home=home_dir,
    )

    assert config.provider is ProviderId.QWEN
    assert config.protocol is ProtocolId.CHAT_COMPLETIONS
    assert config.model == "qwen3.6-plus"
    assert config.api_base_url == "https://dashscope.aliyuncs.com/compatible-mode/v1"
    assert config.api_key == "sk-auth-store"
    assert config.max_prompt_tokens == 64_000
    assert config.memory_enabled is True
    assert config.memory_extraction_interval_turns == -1
    assert config.recent_message_count == 9
    assert config.view_mode is ViewMode.FOCUS
    assert config.statusline_enabled is False
    assert config.cache_policy_capability == ProviderCachePolicyCapability(
        prompt_cache_key_enabled=False,
        cache_control_enabled=True,
        provider_family="qwen",
        cache_strategy="cache_control",
    )


def test_resolve_config_loads_memory_extraction_interval(tmp_path: Path) -> None:
    home_dir = tmp_path / "home"
    workspace = tmp_path / "workspace"
    home_dir.mkdir()
    workspace.mkdir()
    (workspace / ".mycli").mkdir()
    (workspace / ".mycli" / "config.toml").write_text(
        "memory_extraction_interval_turns = 8\n",
        encoding="utf-8",
    )

    config = resolve_config(cli_args={}, env={}, cwd=workspace, home=home_dir)

    assert config.memory_extraction_interval_turns == 8


def test_resolve_config_clamps_memory_extraction_interval_to_one(
    tmp_path: Path,
) -> None:
    home_dir = tmp_path / "home"
    workspace = tmp_path / "workspace"
    home_dir.mkdir()
    workspace.mkdir()

    config = resolve_config(
        cli_args={},
        env={"MYCLI_MEMORY_EXTRACTION_INTERVAL_TURNS": "0"},
        cwd=workspace,
        home=home_dir,
    )

    assert config.memory_extraction_interval_turns == 1


def test_resolve_config_allows_disabling_memory_extraction_interval(
    tmp_path: Path,
) -> None:
    home_dir = tmp_path / "home"
    workspace = tmp_path / "workspace"
    home_dir.mkdir()
    workspace.mkdir()

    config = resolve_config(
        cli_args={},
        env={"MYCLI_MEMORY_EXTRACTION_INTERVAL_TURNS": "-1"},
        cwd=workspace,
        home=home_dir,
    )

    assert config.memory_extraction_interval_turns == -1


def test_resolve_config_loads_shell_environment_policy(tmp_path: Path) -> None:
    home_dir = tmp_path / "home"
    workspace = tmp_path / "workspace"
    home_dir.mkdir()
    workspace.mkdir()
    (workspace / ".mycli").mkdir()
    (workspace / ".mycli" / "config.toml").write_text(
        "\n".join(
            [
                "[shell_environment_policy]",
                'inherit = "all"',
                "ignore_default_excludes = false",
                'exclude = ["CUSTOM_*"]',
                'include_only = ["PATH", "CI"]',
                "",
                "[shell_environment_policy.set]",
                'CI = "false"',
            ]
        ),
        encoding="utf-8",
    )

    config = resolve_config(
        cli_args={"session": "demo"},
        env={},
        cwd=workspace,
        home=home_dir,
    )

    policy = config.shell_environment_policy
    assert policy is not None
    assert policy.inherit == "all"
    assert policy.ignore_default_excludes is False
    assert policy.exclude == ("CUSTOM_*",)
    assert policy.include_only == ("PATH", "CI")
    assert dict(policy.set or {}) == {"CI": "false"}


def test_resolve_config_loads_sandbox_profile_paths(tmp_path: Path) -> None:
    home_dir = tmp_path / "home"
    workspace = tmp_path / "workspace"
    home_dir.mkdir()
    workspace.mkdir()
    (workspace / ".mycli").mkdir()
    (workspace / ".mycli" / "config.toml").write_text(
        "\n".join(
            [
                'sandbox_writable_roots = ["build-cache"]',
                'sandbox_denied_read_roots = [".secrets"]',
                'sandbox_denied_read_globs = ["**/*.pem"]',
            ]
        ),
        encoding="utf-8",
    )

    config = resolve_config(
        cli_args={"session": "demo"},
        env={},
        cwd=workspace,
        home=home_dir,
    )

    assert config.sandbox_writable_roots == ((workspace / "build-cache").resolve(),)
    assert config.sandbox_denied_read_roots == ((workspace / ".secrets").resolve(),)
    assert config.sandbox_denied_read_globs == ("**/*.pem",)


def test_resolve_config_loads_sandbox_mode(tmp_path: Path) -> None:
    home_dir = tmp_path / "home"
    workspace = tmp_path / "workspace"
    home_dir.mkdir()
    workspace.mkdir()
    (workspace / ".mycli").mkdir()
    (workspace / ".mycli" / "config.toml").write_text(
        'sandbox_mode = "read-only"',
        encoding="utf-8",
    )

    config = resolve_config(
        cli_args={"session": "demo"},
        env={},
        cwd=workspace,
        home=home_dir,
    )

    assert config.sandbox_mode.value == "read-only"


def test_resolve_config_merges_user_and_project_sandbox_profile(
    tmp_path: Path,
) -> None:
    home_dir = tmp_path / "home"
    workspace = tmp_path / "workspace"
    home_dir.mkdir()
    workspace.mkdir()
    (home_dir / ".mycli").mkdir()
    (workspace / ".mycli").mkdir()
    (home_dir / ".mycli" / "config.toml").write_text(
        "\n".join(
            [
                f'sandbox_writable_roots = ["{home_dir / "mycli-cache"}"]',
                f'sandbox_denied_read_roots = ["{home_dir / "private"}"]',
                'sandbox_denied_read_globs = ["**/*.key"]',
            ]
        ),
        encoding="utf-8",
    )
    (workspace / ".mycli" / "config.toml").write_text(
        "\n".join(
            [
                'sandbox_writable_roots = ["scratch"]',
                'sandbox_denied_read_roots = [".secrets"]',
                'sandbox_denied_read_globs = ["**/*.pem"]',
            ]
        ),
        encoding="utf-8",
    )

    config = resolve_config(
        cli_args={"session": "demo"},
        env={},
        cwd=workspace,
        home=home_dir,
    )

    assert config.sandbox_writable_roots == (
        (home_dir / "mycli-cache").resolve(),
        (workspace / "scratch").resolve(),
    )
    assert config.sandbox_denied_read_roots == (
        (home_dir / "private").resolve(),
        (workspace / ".secrets").resolve(),
    )
    assert config.sandbox_denied_read_globs == ("**/*.key", "**/*.pem")


def test_resolve_config_loads_shell_environment_inherit_from_env(tmp_path: Path) -> None:
    home_dir = tmp_path / "home"
    workspace = tmp_path / "workspace"
    home_dir.mkdir()
    workspace.mkdir()

    config = resolve_config(
        cli_args={"session": "demo"},
        env={"MYCLI_SHELL_ENV_INHERIT": "none"},
        cwd=workspace,
        home=home_dir,
    )

    assert config.shell_environment_policy is not None
    assert config.shell_environment_policy.inherit == "none"


def test_resolve_config_accepts_codex_responses_provider(tmp_path: Path) -> None:
    home_dir = tmp_path / "home"
    workspace = tmp_path / "workspace"
    home_dir.mkdir()
    workspace.mkdir()
    (workspace / ".mycli").mkdir()
    (workspace / ".mycli" / "config.toml").write_text(
        "\n".join(
            [
                'provider = "codex"',
                'api_base_url = "https://codex-gateway.example.invalid/v1"',
                'model = "gpt-5.4"',
            ]
        ),
        encoding="utf-8",
    )
    AuthStore.from_home(home_dir).set_api_key("codex", "sk-codex")

    config = resolve_config(
        cli_args={"session": "demo"},
        env={},
        cwd=workspace,
        home=home_dir,
    )

    assert config.provider is ProviderId.CODEX
    assert config.protocol is ProtocolId.RESPONSES
    assert config.model == "gpt-5.4"
    assert config.api_base_url == "https://codex-gateway.example.invalid/v1"
    assert config.api_key == "sk-codex"
    assert config.cache_policy_capability is None
    assert resolve_provider_cache_policy_capability(
        provider=config.provider,
        base_url=config.api_base_url,
    ) == ProviderCachePolicyCapability(
        prompt_cache_key_enabled=True,
        cache_control_enabled=False,
        provider_family="codex",
        cache_strategy="prompt_cache_key",
    )


def test_resolve_config_generates_new_session_when_cli_session_is_omitted(
    tmp_path: Path,
) -> None:
    home_dir = tmp_path / "home"
    workspace = tmp_path / "workspace"
    home_dir.mkdir()
    workspace.mkdir()

    config = resolve_config(
        cli_args={},
        env={},
        cwd=workspace,
        home=home_dir,
    )

    assert config.session_id != "default"
    assert str(UUID(config.session_id)) == config.session_id


def test_resolve_config_keeps_explicit_cli_session(tmp_path: Path) -> None:
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

    assert config.session_id == "demo"


def test_resolve_config_reads_compaction_l4_settings(tmp_path: Path) -> None:
    home_dir = tmp_path / "home"
    workspace = tmp_path / "workspace"
    home_dir.mkdir()
    workspace.mkdir()
    (workspace / ".mycli").mkdir()
    (workspace / ".mycli" / "config.toml").write_text(
        "\n".join(
            [
                "compaction_l4_trigger_ratio = 0.82",
                "compaction_l4_min_savings_ratio = 0.2",
                "compaction_l4_input_cost_per_1k = 0.003",
                "compaction_l4_output_cost_per_1k = 0.015",
                "compaction_l4_carry_cost_per_1k = 0.001",
                "compaction_l4_expected_summary_tokens = 300",
                "compaction_l4_carry_turns = 4",
                'compaction_l4_summarizer_model = "summary-model"',
                "compaction_l4_buffer_tokens = 9000",
            ]
        ),
        encoding="utf-8",
    )

    config = resolve_config(
        cli_args={"session": "demo"},
        env={},
        cwd=workspace,
        home=home_dir,
    )

    assert config.compaction_l4_trigger_ratio == 0.82
    assert config.compaction_l4_min_savings_ratio == 0.2
    assert config.compaction_l4_input_cost_per_1k == 0.003
    assert config.compaction_l4_output_cost_per_1k == 0.015
    assert config.compaction_l4_carry_cost_per_1k == 0.001
    assert config.compaction_l4_expected_summary_tokens == 300
    assert config.compaction_l4_carry_turns == 4
    assert config.compaction_l4_summarizer_model == "summary-model"
    assert config.compaction_l4_buffer_tokens == 9000


def test_resolve_config_reads_usage_price_settings(tmp_path: Path) -> None:
    home_dir = tmp_path / "home"
    workspace = tmp_path / "workspace"
    home_dir.mkdir()
    workspace.mkdir()
    (workspace / ".mycli").mkdir()
    (workspace / ".mycli" / "config.toml").write_text(
        "\n".join(
            [
                "usage_input_cost_per_1k = 0.001",
                "usage_output_cost_per_1k = 0.002",
                "usage_cache_read_cost_per_1k = 0.0001",
                "usage_cache_write_cost_per_1k = 0.0002",
            ]
        ),
        encoding="utf-8",
    )

    config = resolve_config(
        cli_args={"session": "demo"},
        env={},
        cwd=workspace,
        home=home_dir,
    )

    assert config.usage_input_cost_per_1k == 0.001
    assert config.usage_output_cost_per_1k == 0.002
    assert config.usage_cache_read_cost_per_1k == 0.0001
    assert config.usage_cache_write_cost_per_1k == 0.0002


def test_resolve_config_reads_provider_cache_policy_overrides(tmp_path: Path) -> None:
    home_dir = tmp_path / "home"
    workspace = tmp_path / "workspace"
    home_dir.mkdir()
    workspace.mkdir()
    (workspace / ".mycli").mkdir()
    (workspace / ".mycli" / "config.toml").write_text(
        "\n".join(
            [
                'provider = "compatible"',
                'protocol = "chat_completions"',
                "prompt_cache_key_enabled = false",
                "cache_control_enabled = false",
            ]
        ),
        encoding="utf-8",
    )

    config = resolve_config(
        cli_args={"session": "demo"},
        env={},
        cwd=workspace,
        home=home_dir,
    )

    assert config.cache_policy_capability == ProviderCachePolicyCapability(
        prompt_cache_key_enabled=False,
        cache_control_enabled=False,
        provider_family="compatible",
        cache_strategy="prompt_cache_key",
    )


def test_resolve_config_env_cache_policy_overrides_project_file(
    tmp_path: Path,
) -> None:
    home_dir = tmp_path / "home"
    workspace = tmp_path / "workspace"
    home_dir.mkdir()
    workspace.mkdir()
    (workspace / ".mycli").mkdir()
    (workspace / ".mycli" / "config.toml").write_text(
        "\n".join(
            [
                'provider = "compatible"',
                'protocol = "chat_completions"',
                "prompt_cache_key_enabled = false",
            ]
        ),
        encoding="utf-8",
    )

    config = resolve_config(
        cli_args={"session": "demo"},
        env={"MYCLI_PROMPT_CACHE_KEY_ENABLED": "true"},
        cwd=workspace,
        home=home_dir,
    )

    assert config.cache_policy_capability == ProviderCachePolicyCapability(
        prompt_cache_key_enabled=True,
        cache_control_enabled=False,
        provider_family="compatible",
        cache_strategy="prompt_cache_key",
    )


def test_config_service_reads_recovery_settings(tmp_path: Path) -> None:
    home_dir = tmp_path / "home"
    workspace = tmp_path / "workspace"
    home_dir.mkdir()
    workspace.mkdir()
    config_path = workspace / ".mycli" / "config.toml"
    config_path.parent.mkdir()
    config_path.write_text(
        "\n".join(
            [
                'provider = "openai"',
                'model = "primary-model"',
                'fallback_model = "fallback-model"',
                "transport_retry_limit = 4",
                "output_limit_escalation_max_tokens = 32768",
                "output_recovery_retry_limit = 2",
                "heartbeat_enabled = false",
                "heartbeat_interval_seconds = 12.5",
            ]
        ),
        encoding="utf-8",
    )

    config = resolve_config(
        cli_args={"session": "demo"},
        env={},
        cwd=workspace,
        home=home_dir,
    )

    assert config.fallback_model == "fallback-model"
    assert config.transport_retry_limit == 4
    assert config.output_limit_escalation_max_tokens == 32_768
    assert config.output_recovery_retry_limit == 2
    assert config.heartbeat_enabled is False
    assert config.heartbeat_interval_seconds == 12.5


def test_config_service_reads_cli_view_settings(tmp_path: Path) -> None:
    home_dir = tmp_path / "home"
    workspace = tmp_path / "workspace"
    home_dir.mkdir()
    workspace.mkdir()
    config_path = workspace / ".mycli" / "config.toml"
    config_path.parent.mkdir()
    config_path.write_text(
        "\n".join(
            [
                'provider = "openai"',
                'model = "primary-model"',
                'view_mode = "focus"',
                "statusline_enabled = false",
            ]
        ),
        encoding="utf-8",
    )

    config = resolve_config(
        cli_args={"session": "demo"},
        env={},
        cwd=workspace,
        home=home_dir,
    )

    assert config.view_mode is ViewMode.FOCUS
    assert config.statusline_enabled is False


def test_config_service_reads_collaboration_mode(tmp_path: Path) -> None:
    home_dir = tmp_path / "home"
    workspace = tmp_path / "workspace"
    home_dir.mkdir()
    workspace.mkdir()
    config_path = workspace / ".mycli" / "config.toml"
    config_path.parent.mkdir()
    config_path.write_text('collaboration_mode = "plan"\n', encoding="utf-8")

    config = resolve_config(
        cli_args={"session": "demo"},
        env={},
        cwd=workspace,
        home=home_dir,
    )

    assert config.collaboration_mode is CollaborationMode.PLAN


def test_config_service_rejects_unknown_collaboration_mode(tmp_path: Path) -> None:
    home_dir = tmp_path / "home"
    workspace = tmp_path / "workspace"
    home_dir.mkdir()
    workspace.mkdir()

    with pytest.raises(ValueError, match="Unsupported collaboration_mode"):
        resolve_config(
            cli_args={"session": "demo"},
            env={"MYCLI_COLLABORATION_MODE": "execute"},
            cwd=workspace,
            home=home_dir,
        )


def test_config_service_reads_tui_startup_mark(tmp_path: Path) -> None:
    home_dir = tmp_path / "home"
    workspace = tmp_path / "workspace"
    home_dir.mkdir()
    workspace.mkdir()
    config_path = workspace / ".mycli" / "config.toml"
    config_path.parent.mkdir()
    config_path.write_text('tui_startup_mark = "rabbit"\n', encoding="utf-8")

    config = resolve_config(
        cli_args={"session": "demo"},
        env={},
        cwd=workspace,
        home=home_dir,
    )

    assert config.tui_startup_mark == "rabbit"


def test_config_service_rejects_unknown_view_mode(tmp_path: Path) -> None:
    home_dir = tmp_path / "home"
    workspace = tmp_path / "workspace"
    home_dir.mkdir()
    workspace.mkdir()

    with pytest.raises(ValueError, match="Unsupported view_mode"):
        resolve_config(
            cli_args={"session": "demo"},
            env={"MYCLI_VIEW_MODE": "cinema"},
            cwd=workspace,
            home=home_dir,
        )


def test_resolve_config_reads_legacy_api_key_from_config_when_auth_store_missing(tmp_path: Path) -> None:
    home_dir = tmp_path / "home"
    workspace = tmp_path / "workspace"
    home_dir.mkdir()
    workspace.mkdir()
    (home_dir / ".mycli").mkdir()
    (workspace / ".mycli").mkdir()

    (home_dir / ".mycli" / "config.toml").write_text(
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

    assert config.api_key == "user-token"


def test_resolve_config_reads_api_key_from_auth_store_for_provider(tmp_path: Path) -> None:
    home_dir = tmp_path / "home"
    workspace = tmp_path / "workspace"
    home_dir.mkdir()
    workspace.mkdir()
    (home_dir / ".mycli").mkdir(parents=True)
    (home_dir / ".mycli" / "config.toml").write_text(
        "\n".join(
            [
                'provider = "deepseek"',
                'protocol = "chat_completions"',
                'model = "deepseek-chat"',
            ]
        ),
        encoding="utf-8",
    )
    AuthStore.from_home(home_dir).set_api_key("deepseek", "sk-auth-store")

    config = resolve_config(
        cli_args={"session": "demo"},
        env={},
        cwd=workspace,
        home=home_dir,
    )

    assert config.provider is ProviderId.DEEPSEEK
    assert config.api_key == "sk-auth-store"


def test_resolve_config_prefers_auth_store_over_legacy_config_api_key(tmp_path: Path) -> None:
    home_dir = tmp_path / "home"
    workspace = tmp_path / "workspace"
    home_dir.mkdir()
    workspace.mkdir()
    (home_dir / ".mycli").mkdir()
    (home_dir / ".mycli" / "config.toml").write_text(
        "\n".join(
            [
                'provider = "deepseek"',
                'protocol = "chat_completions"',
                'api_key = "home-token"',
            ]
        ),
        encoding="utf-8",
    )
    (workspace / ".mycli").mkdir()
    (workspace / ".mycli" / "config.toml").write_text(
        "\n".join(
            [
                'provider = "deepseek"',
                'protocol = "chat_completions"',
                'api_key = "project-token"',
            ]
        ),
        encoding="utf-8",
    )
    AuthStore.from_home(home_dir).set_api_key("deepseek", "sk-auth-store")

    config = resolve_config(
        cli_args={"session": "demo"},
        env={},
        cwd=workspace,
        home=home_dir,
    )

    assert config.api_key == "sk-auth-store"


def test_resolve_config_falls_back_to_legacy_xdg_user_config(tmp_path: Path) -> None:
    home_dir = tmp_path / "home"
    workspace = tmp_path / "workspace"
    home_dir.mkdir()
    workspace.mkdir()
    legacy_config_dir = home_dir / ".config" / "mycli"
    legacy_config_dir.mkdir(parents=True)
    (legacy_config_dir / "config.toml").write_text(
        "\n".join(
            [
                'provider = "deepseek"',
                'protocol = "chat_completions"',
                'model = "legacy-model"',
                "max_prompt_tokens = 7300",
            ]
        ),
        encoding="utf-8",
    )
    AuthStore.from_home(home_dir).set_api_key("deepseek", "sk-auth-store")

    config = resolve_config(
        cli_args={"session": "demo"},
        env={},
        cwd=workspace,
        home=home_dir,
    )

    assert config.provider is ProviderId.DEEPSEEK
    assert config.model == "legacy-model"
    assert config.max_prompt_tokens == 7300
    assert config.api_key == "sk-auth-store"


def test_resolve_config_ignores_invalid_auth_store_json(tmp_path: Path) -> None:
    home_dir = tmp_path / "home"
    workspace = tmp_path / "workspace"
    home_dir.mkdir()
    workspace.mkdir()
    auth_path = home_dir / ".mycli" / "auth.json"
    auth_path.parent.mkdir(parents=True)
    auth_path.write_text("{invalid", encoding="utf-8")

    config = resolve_config(
        cli_args={"session": "demo"},
        env={},
        cwd=workspace,
        home=home_dir,
    )

    assert config.api_key is None


def test_resolve_config_ignores_non_api_key_auth_store_credential(tmp_path: Path) -> None:
    home_dir = tmp_path / "home"
    workspace = tmp_path / "workspace"
    home_dir.mkdir()
    workspace.mkdir()
    auth_path = home_dir / ".mycli" / "auth.json"
    auth_path.parent.mkdir(parents=True)
    auth_path.write_text(
        json.dumps({"openai": {"type": "oauth", "access": "token"}}),
        encoding="utf-8",
    )

    config = resolve_config(
        cli_args={"session": "demo"},
        env={},
        cwd=workspace,
        home=home_dir,
    )

    assert config.api_key is None


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
        'protocol = "chat_completions"\n',
        encoding="utf-8",
    )
    (workspace / ".mycli" / "config.toml").write_text(
        'protocol = "chat_completions"\n',
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


def test_resolve_config_uses_deepseek_defaults_for_explicit_provider(
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
            "MYCLI_PROVIDER": "deepseek",
        },
        cwd=workspace,
        home=home_dir,
    )

    assert config.provider is ProviderId.DEEPSEEK
    assert config.protocol is ProtocolId.CHAT_COMPLETIONS
    assert config.model == "deepseek-chat"
    assert config.api_base_url == "https://api.deepseek.com"


def test_resolve_config_infers_anthropic_provider_and_defaults_to_messages(
    tmp_path: Path,
) -> None:
    home_dir = tmp_path / "home"
    workspace = tmp_path / "workspace"
    home_dir.mkdir()
    workspace.mkdir()

    config = resolve_config(
        cli_args={"session": "anthropic-demo"},
        env={
            "MYCLI_API_KEY": "test-key",
            "MYCLI_BASE_URL": "https://api.anthropic.com",
        },
        cwd=workspace,
        home=home_dir,
    )

    assert config.provider is ProviderId.ANTHROPIC
    assert config.protocol is ProtocolId.ANTHROPIC_MESSAGES
    assert config.model == "claude-sonnet-4-6"
    assert config.api_base_url == "https://api.anthropic.com"


def test_resolve_config_uses_anthropic_defaults_for_explicit_provider(
    tmp_path: Path,
) -> None:
    home_dir = tmp_path / "home"
    workspace = tmp_path / "workspace"
    home_dir.mkdir()
    workspace.mkdir()

    config = resolve_config(
        cli_args={"session": "anthropic-demo"},
        env={
            "MYCLI_API_KEY": "test-key",
            "MYCLI_PROVIDER": "anthropic",
        },
        cwd=workspace,
        home=home_dir,
    )

    assert config.provider is ProviderId.ANTHROPIC
    assert config.protocol is ProtocolId.ANTHROPIC_MESSAGES
    assert config.model == "claude-sonnet-4-6"
    assert config.api_base_url == "https://api.anthropic.com"


def test_resolve_config_disables_ignored_cache_control_for_deepseek_anthropic_endpoint(
    tmp_path: Path,
) -> None:
    home_dir = tmp_path / "home"
    workspace = tmp_path / "workspace"
    home_dir.mkdir()
    workspace.mkdir()

    config = resolve_config(
        cli_args={"session": "deepseek-anthropic-demo"},
        env={
            "MYCLI_API_KEY": "test-key",
            "MYCLI_PROVIDER": "anthropic",
            "MYCLI_PROTOCOL": "anthropic_messages",
            "MYCLI_BASE_URL": "https://api.deepseek.com/anthropic",
            "MYCLI_MODEL": "deepseek-v4-flash",
        },
        cwd=workspace,
        home=home_dir,
    )

    assert config.provider is ProviderId.ANTHROPIC
    assert config.protocol is ProtocolId.ANTHROPIC_MESSAGES
    assert config.api_base_url == "https://api.deepseek.com/anthropic"
    assert config.cache_policy_capability == ProviderCachePolicyCapability(
        prompt_cache_key_enabled=False,
        cache_control_enabled=False,
        wire_hints_supported=False,
        provider_family="deepseek",
        cache_strategy="automatic_prefix_cache",
    )


def test_resolve_config_infers_qwen_provider_and_defaults_to_chat_completions(
    tmp_path: Path,
) -> None:
    home_dir = tmp_path / "home"
    workspace = tmp_path / "workspace"
    home_dir.mkdir()
    workspace.mkdir()

    config = resolve_config(
        cli_args={"session": "qwen-demo"},
        env={
            "MYCLI_API_KEY": "test-key",
            "MYCLI_BASE_URL": "https://dashscope.aliyuncs.com/compatible-mode/v1",
        },
        cwd=workspace,
        home=home_dir,
    )

    assert config.provider is ProviderId.QWEN
    assert config.protocol is ProtocolId.CHAT_COMPLETIONS
    assert config.model == "qwen3.6-plus"
    assert config.api_base_url == "https://dashscope.aliyuncs.com/compatible-mode/v1"


def test_resolve_config_uses_qwen_defaults_for_explicit_provider(
    tmp_path: Path,
) -> None:
    home_dir = tmp_path / "home"
    workspace = tmp_path / "workspace"
    home_dir.mkdir()
    workspace.mkdir()

    config = resolve_config(
        cli_args={"session": "qwen-demo"},
        env={
            "MYCLI_API_KEY": "test-key",
            "MYCLI_PROVIDER": "qwen",
        },
        cwd=workspace,
        home=home_dir,
    )

    assert config.provider is ProviderId.QWEN
    assert config.protocol is ProtocolId.CHAT_COMPLETIONS
    assert config.model == "qwen3.6-plus"
    assert config.api_base_url == "https://dashscope.aliyuncs.com/compatible-mode/v1"


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


def test_resolve_config_rejects_anthropic_with_responses_protocol(
    tmp_path: Path,
) -> None:
    home_dir = tmp_path / "home"
    workspace = tmp_path / "workspace"
    home_dir.mkdir()
    workspace.mkdir()

    with pytest.raises(
        ValueError,
        match="Provider 'anthropic' does not support protocol 'responses'",
    ):
        resolve_config(
            cli_args={"session": "anthropic-demo"},
            env={
                "MYCLI_API_KEY": "test-key",
                "MYCLI_PROVIDER": "anthropic",
                "MYCLI_PROTOCOL": "responses",
            },
            cwd=workspace,
            home=home_dir,
        )


def test_resolve_config_rejects_anthropic_with_chat_completions_protocol(
    tmp_path: Path,
) -> None:
    home_dir = tmp_path / "home"
    workspace = tmp_path / "workspace"
    home_dir.mkdir()
    workspace.mkdir()

    with pytest.raises(
        ValueError,
        match="Provider 'anthropic' does not support protocol 'chat_completions'",
    ):
        resolve_config(
            cli_args={"session": "anthropic-demo"},
            env={
                "MYCLI_API_KEY": "test-key",
                "MYCLI_PROVIDER": "anthropic",
                "MYCLI_PROTOCOL": "chat_completions",
            },
            cwd=workspace,
            home=home_dir,
        )
