from __future__ import annotations

from pathlib import Path

from mycli.cli.autocomplete import path_completion_candidates
from mycli.cli.main import build_turn_service
from mycli.domain.providers import ProtocolId, ProviderId
from mycli.llms.adapters.anthropic_messages_adapter import (
    AnthropicMessagesModelAdapter,
)
from mycli.llms.adapters.native_tool_adapter import NativeToolModelAdapter
from mycli.infrastructure.providers.deepseek import DeepSeekChatProviderAdapter
from mycli.infrastructure.providers.openai import OpenAIChatProviderAdapter
from mycli.infrastructure.providers.qwen import QwenChatProviderAdapter


def test_path_completion_candidates_complete_workspace_paths(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    (workspace / "README.md").write_text("hi", encoding="utf-8")
    (workspace / "src").mkdir()
    (workspace / "src" / "main.py").write_text("print('hi')", encoding="utf-8")

    assert path_completion_candidates(workspace, "@R") == ("@README.md",)
    assert path_completion_candidates(workspace, "@src/") == ("@src/main.py",)


def test_path_completion_candidates_reject_outside_workspace(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    (tmp_path / "secret.txt").write_text("no", encoding="utf-8")

    assert path_completion_candidates(workspace, "@../") == ()


def test_build_turn_service_uses_native_adapter_when_protocol_is_chat_completions(
    tmp_path: Path,
) -> None:
    home_dir = tmp_path / "home"
    workspace = tmp_path / "workspace"
    home_dir.mkdir()
    workspace.mkdir()

    service = build_turn_service(
        cli_args={"session": "demo"},
        cwd=workspace,
        home=home_dir,
        env={
            "MYCLI_API_KEY": "test-key",
            "MYCLI_PROTOCOL": "chat_completions",
        },
    )

    assert isinstance(service._runtime._model_adapter, NativeToolModelAdapter)


def test_build_turn_service_uses_chat_completions_for_deepseek(
    tmp_path: Path,
) -> None:
    home_dir = tmp_path / "home"
    workspace = tmp_path / "workspace"
    home_dir.mkdir()
    workspace.mkdir()

    service = build_turn_service(
        cli_args={"session": "deepseek-demo"},
        cwd=workspace,
        home=home_dir,
        env={
            "MYCLI_API_KEY": "test-key",
            "MYCLI_PROVIDER": "deepseek",
            "MYCLI_MODEL": "deepseek-v4-flash",
        },
    )

    assert service._config.provider is ProviderId.DEEPSEEK
    assert service._config.protocol is ProtocolId.CHAT_COMPLETIONS
    assert isinstance(service._runtime._model_adapter, NativeToolModelAdapter)
    assert isinstance(
        service._runtime._model_adapter._provider_adapter,
        DeepSeekChatProviderAdapter,
    )


def test_build_turn_service_uses_openai_chat_provider_adapter(
    tmp_path: Path,
) -> None:
    home_dir = tmp_path / "home"
    workspace = tmp_path / "workspace"
    home_dir.mkdir()
    workspace.mkdir()

    service = build_turn_service(
        cli_args={"session": "openai-chat-demo"},
        cwd=workspace,
        home=home_dir,
        env={
            "MYCLI_API_KEY": "test-key",
            "MYCLI_PROVIDER": "openai",
            "MYCLI_PROTOCOL": "chat_completions",
        },
    )

    assert service._config.provider is ProviderId.OPENAI
    assert service._config.protocol is ProtocolId.CHAT_COMPLETIONS
    assert isinstance(service._runtime._model_adapter, NativeToolModelAdapter)
    assert isinstance(
        service._runtime._model_adapter._provider_adapter,
        OpenAIChatProviderAdapter,
    )


def test_build_turn_service_uses_chat_completions_for_qwen(
    tmp_path: Path,
) -> None:
    home_dir = tmp_path / "home"
    workspace = tmp_path / "workspace"
    home_dir.mkdir()
    workspace.mkdir()

    service = build_turn_service(
        cli_args={"session": "qwen-demo"},
        cwd=workspace,
        home=home_dir,
        env={
            "MYCLI_API_KEY": "test-key",
            "MYCLI_PROVIDER": "qwen",
        },
    )

    assert service._config.provider is ProviderId.QWEN
    assert service._config.protocol is ProtocolId.CHAT_COMPLETIONS
    assert service._config.model == "qwen3.6-plus"
    assert isinstance(service._runtime._model_adapter, NativeToolModelAdapter)
    assert isinstance(
        service._runtime._model_adapter._provider_adapter,
        QwenChatProviderAdapter,
    )


def test_build_turn_service_uses_qwen_chat_provider_adapter(
    tmp_path: Path,
) -> None:
    home_dir = tmp_path / "home"
    workspace = tmp_path / "workspace"
    home_dir.mkdir()
    workspace.mkdir()

    service = build_turn_service(
        cli_args={"session": "qwen-chat-demo"},
        cwd=workspace,
        home=home_dir,
        env={
            "MYCLI_API_KEY": "test-key",
            "MYCLI_PROVIDER": "qwen",
            "MYCLI_PROTOCOL": "chat_completions",
        },
    )

    assert service._config.provider is ProviderId.QWEN
    assert service._config.protocol is ProtocolId.CHAT_COMPLETIONS
    assert isinstance(service._runtime._model_adapter, NativeToolModelAdapter)
    assert isinstance(
        service._runtime._model_adapter._provider_adapter,
        QwenChatProviderAdapter,
    )


def test_build_turn_service_uses_anthropic_messages_adapter(
    tmp_path: Path,
) -> None:
    home_dir = tmp_path / "home"
    workspace = tmp_path / "workspace"
    home_dir.mkdir()
    workspace.mkdir()

    service = build_turn_service(
        cli_args={"session": "anthropic-demo"},
        cwd=workspace,
        home=home_dir,
        env={
            "MYCLI_API_KEY": "test-key",
            "MYCLI_PROVIDER": "anthropic",
        },
    )

    assert service._config.provider is ProviderId.ANTHROPIC
    assert service._config.protocol is ProtocolId.ANTHROPIC_MESSAGES
    assert service._config.model == "claude-sonnet-4-6"
    assert isinstance(service._runtime._model_adapter, AnthropicMessagesModelAdapter)
