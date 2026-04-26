from pathlib import Path

from mycli.cli.main import build_turn_service, handle_slash_command, run_repl
from mycli.domain.providers import ProtocolId, ProviderId
from mycli.infrastructure.models.native_tool_adapter import NativeToolModelAdapter
from mycli.infrastructure.models.responses_adapter import ResponsesModelAdapter
from mycli.infrastructure.providers.deepseek import DeepSeekChatProviderAdapter
from mycli.infrastructure.providers.openai import OpenAIChatProviderAdapter
from mycli.infrastructure.providers.qwen import QwenChatProviderAdapter


def test_help_lists_approval_and_memory_controls() -> None:
    output = handle_slash_command("/help")
    assert "/memory" in output
    assert "/confirm" not in output
    assert "/reject" not in output


def test_run_repl_prints_help_and_stops_on_quit() -> None:
    outputs: list[str] = []
    scripted_inputs = iter(["/help", "/quit"])

    run_repl(
        turn_handler=lambda _message: "unused",
        input_func=lambda _prompt: next(scripted_inputs),
        output_func=outputs.append,
    )

    assert any("/memory" in line for line in outputs)
    assert outputs[-1] == "Bye."


def test_run_repl_routes_numeric_decision_when_pending() -> None:
    outputs: list[str] = []
    scripted_inputs = iter(["3", "/quit"])

    run_repl(
        turn_handler=lambda _message: "unused",
        decision_handler=lambda choice: [f"[decision] {choice}", "Applied pending action"],
        pending_decision_provider=lambda: True,
        input_func=lambda _prompt: next(scripted_inputs),
        output_func=outputs.append,
        session_id="demo",
    )

    assert "[decision] 3" in outputs
    assert "Applied pending action" in outputs


def test_run_repl_reprompts_when_non_numeric_input_arrives_during_pending_decision() -> None:
    outputs: list[str] = []
    scripted_inputs = iter(["hello", "/quit"])

    run_repl(
        turn_handler=lambda _message: "unused",
        decision_handler=lambda choice: [f"[decision] {choice}"],
        pending_decision_provider=lambda: True,
        input_func=lambda _prompt: next(scripted_inputs),
        output_func=outputs.append,
        session_id="demo",
    )

    assert outputs[0] == "There is a pending risky action. Choose one of the available options."


def test_run_repl_exits_cleanly_on_keyboard_interrupt() -> None:
    outputs: list[str] = []

    def raise_keyboard_interrupt(_prompt: str) -> str:
        raise KeyboardInterrupt

    run_repl(
        turn_handler=lambda _message: "unused",
        input_func=raise_keyboard_interrupt,
        output_func=outputs.append,
    )

    assert outputs[-1] == "Bye."


def test_run_repl_routes_non_help_slash_commands_to_command_handler() -> None:
    outputs: list[str] = []
    scripted_inputs = iter(["/plan", "/quit"])

    run_repl(
        turn_handler=lambda _message: "unused",
        command_handler=lambda command: ["[plan] demo"] if command == "/plan" else ["[unknown]"],
        input_func=lambda _prompt: next(scripted_inputs),
        output_func=outputs.append,
    )

    assert "[plan] demo" in outputs


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


def test_build_turn_service_uses_responses_for_qwen(
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
    assert service._config.protocol is ProtocolId.RESPONSES
    assert service._config.model == "qwen3.6-plus"
    assert isinstance(service._runtime._model_adapter, ResponsesModelAdapter)


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
