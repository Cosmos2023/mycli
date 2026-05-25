from pathlib import Path

from mycli.cli.main import build_turn_service, handle_slash_command, main, run_repl
from mycli.domain.providers import ProtocolId, ProviderId
from mycli.domain.runtime import RuntimeStreamEvent, TurnResponse
from mycli.llms.adapters.anthropic_messages_adapter import (
    AnthropicMessagesModelAdapter,
)
from mycli.llms.adapters.native_tool_adapter import NativeToolModelAdapter
from mycli.llms.adapters.responses_adapter import ResponsesModelAdapter
from mycli.infrastructure.providers.deepseek import DeepSeekChatProviderAdapter
from mycli.infrastructure.providers.openai import OpenAIChatProviderAdapter
from mycli.infrastructure.providers.qwen import QwenChatProviderAdapter


def test_help_lists_approval_and_memory_controls() -> None:
    output = handle_slash_command("/help")
    assert "/memory" in output
    assert "/undo" in output
    assert "/resume <session>" in output
    assert "/fork [source] <new-session> [message-index]" in output
    assert "/stats" in output
    assert "/subagents" in output
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


def test_run_repl_prints_statusline_before_prompt_when_provider_exists() -> None:
    outputs: list[str] = []
    scripted_inputs = iter(["/quit"])

    run_repl(
        turn_handler=lambda _message: "unused",
        statusline_provider=lambda: ("session=demo context=unknown",),
        input_func=lambda _prompt: next(scripted_inputs),
        output_func=outputs.append,
    )

    assert outputs[0] == "[status] session=demo context=unknown"
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


def test_run_repl_routes_subagents_command_to_command_handler() -> None:
    outputs: list[str] = []
    scripted_inputs = iter(["/subagents demo:sub:turn_1:abcd1234", "/quit"])

    run_repl(
        turn_handler=lambda _message: "unused",
        command_handler=lambda command: ["[subagent] explore completed"]
        if command == "/subagents demo:sub:turn_1:abcd1234"
        else ["[unknown]"],
        input_func=lambda _prompt: next(scripted_inputs),
        output_func=outputs.append,
    )

    assert "[subagent] explore completed" in outputs


def test_main_outputs_stream_events_before_final_answer(monkeypatch, tmp_path: Path) -> None:
    outputs: list[str] = []
    scripted_inputs = iter(["hello", "/quit"])

    class FakeService:
        def __init__(self) -> None:
            self._config = type("Config", (), {"session_id": "demo"})()
            self._session_service = type(
                "Sessions",
                (),
                {"load_pending_decision": lambda _self, _session_id: None},
            )()

        def handle_user_turn(self, message: str, stream_sink=None) -> TurnResponse:
            del message
            assert stream_sink is not None
            stream_sink(RuntimeStreamEvent(kind="text_delta", text="hello"))
            stream_sink(RuntimeStreamEvent(kind="text_delta", text=" world"))
            return TurnResponse(
                assistant_message="hello world",
                streamed_chunks=("hello", " world"),
            )

        def resolve_pending_decision(self, choice: str) -> TurnResponse:
            del choice
            return TurnResponse(assistant_message="unused")

    monkeypatch.setattr("mycli.cli.main.build_turn_service", lambda *args, **kwargs: FakeService())
    assert main(
        ["--session", "demo"],
        cwd=tmp_path,
        home=tmp_path / "home",
        env={"MYCLI_API_KEY": "x"},
        input_func=lambda _prompt: next(scripted_inputs),
        output_func=outputs.append,
    ) == 0

    assert outputs.index("[stream] hello") < outputs.index("hello world")
    assert outputs.index("[stream]  world") < outputs.index("hello world")
    assert outputs.count("[stream] hello") == 1


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
    assert "enter_plan_mode" in service._runtime._tool_registry.list_names()
    assert "exit_plan_mode" in service._runtime._tool_registry.list_names()


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
