from mycli.domain.conversation import Message
from mycli.domain.runtime import HistoryItem, HistoryItemType, RuntimeBlock
from mycli.domain.tooling.calls import ToolCall
from mycli.services.context.context_manager import ContextManager


def test_context_manager_prefers_live_conversation_over_stale_history_for_provider_replay() -> None:
    manager = ContextManager()
    stale_history = (
        HistoryItem(
            id="hist_user_1",
            thread_id="demo",
            turn_id="turn_1",
            type=HistoryItemType.USER_MESSAGE,
            text="inspect repo",
        ),
        HistoryItem(
            id="hist_assistant_1",
            thread_id="demo",
            turn_id="turn_1",
            type=HistoryItemType.ASSISTANT_MESSAGE,
            text="I will inspect.",
        ),
    )
    live_tool_call = Message(
        role="assistant",
        content="",
        tool_calls=(
            ToolCall(
                name="Glob",
                arguments={"pattern": "**/*.py"},
                reason="inspect python files",
                call_id="call_glob_1",
            ),
        ),
        blocks=(
            RuntimeBlock(
                type="tool_call",
                tool_name="Glob",
                tool_arguments={"pattern": "**/*.py"},
                call_id="call_glob_1",
            ),
        ),
    )
    live_tool_result = Message(
        role="tool",
        content="src/mycli/__init__.py",
        tool_call_id="call_glob_1",
        blocks=(
            RuntimeBlock(
                type="tool_result",
                text="src/mycli/__init__.py",
                call_id="call_glob_1",
            ),
        ),
    )
    live_conversation = (
        Message(role="user", content="inspect repo"),
        Message(role="assistant", content="I will inspect."),
        live_tool_call,
        live_tool_result,
    )

    provider_replay = manager.provider_replay_messages(
        conversation=live_conversation,
        history_items=stale_history,
    )

    assert provider_replay == live_conversation


def test_context_manager_prepends_replayable_baseline_updates_to_live_provider_replay() -> None:
    manager = ContextManager()
    environment = HistoryItem(
        id="hist_environment_1",
        thread_id="demo",
        turn_id="turn_1",
        type=HistoryItemType.CONTEXT_BASELINE_UPDATE,
        text="Runtime environment:\n- shell: restricted",
        metadata={
            "context_kind": "environment_context",
            "replayable": True,
            "model_visible": True,
        },
    )
    stale_user = HistoryItem(
        id="hist_user_1",
        thread_id="demo",
        turn_id="turn_1",
        type=HistoryItemType.USER_MESSAGE,
        text="old request",
    )
    live_conversation = (
        Message(role="user", content="new request"),
        Message(role="assistant", content="new answer"),
    )

    provider_replay = manager.provider_replay_messages(
        conversation=live_conversation,
        history_items=(environment, stale_user),
    )

    assert [message.content for message in provider_replay] == [
        "Runtime environment:\n- shell: restricted",
        "new request",
        "new answer",
    ]


def test_context_manager_reconstructs_block_aware_messages_from_history_items() -> None:
    manager = ContextManager()

    messages = manager.messages_from_history(
        (
            HistoryItem(
                id="hist_user_1",
                thread_id="demo",
                turn_id="turn_1",
                type=HistoryItemType.USER_MESSAGE,
                text="inspect repo",
            ),
            HistoryItem(
                id="hist_reasoning_1",
                thread_id="demo",
                turn_id="turn_1",
                type=HistoryItemType.REASONING,
                text="Inspect pyproject first.",
                metadata={"provider_id": "rs_1"},
            ),
            HistoryItem(
                id="hist_tool_call_1",
                thread_id="demo",
                turn_id="turn_1",
                type=HistoryItemType.TOOL_CALL,
                text="Reading: pyproject.toml",
                tool_name="read_file",
                call_id="call_read_1",
                metadata={"arguments": {"path": "pyproject.toml"}, "provider_id": "fc_1"},
            ),
            HistoryItem(
                id="hist_tool_result_1",
                thread_id="demo",
                turn_id="turn_1",
                type=HistoryItemType.TOOL_RESULT,
                text="Read pyproject.toml",
                tool_name="read_file",
                call_id="call_read_1",
                metadata={
                    "transcript_content": "Read pyproject.toml\nFile path: pyproject.toml",
                    "provider_id": "tr_1",
                    "success": True,
                },
            ),
            HistoryItem(
                id="hist_assistant_1",
                thread_id="demo",
                turn_id="turn_1",
                type=HistoryItemType.ASSISTANT_MESSAGE,
                text="Repository summary complete.",
                metadata={"provider_id": "msg_1"},
            ),
        )
    )

    assert [message.role for message in messages] == ["user", "assistant", "tool", "assistant"]
    assert messages[1].content == ""
    assert messages[1].tool_calls[0].name == "read_file"
    assert messages[1].blocks[0].type == "tool_call"
    assert messages[1].blocks[0].tool_arguments == {"path": "pyproject.toml"}
    assert messages[2].blocks[0].type == "tool_result"
    assert messages[2].blocks[0].provider_id == "tr_1"
    assert messages[3].blocks[0].type == "text"


def test_context_manager_ignores_tui_only_plan_update_history() -> None:
    messages = ContextManager().messages_from_history(
        (
            HistoryItem(
                id="plan-1",
                thread_id="demo",
                turn_id="turn-1",
                type=HistoryItemType.PLAN_UPDATE,
                text="Updated Plan",
                metadata={"model_visible": False, "items": []},
            ),
        )
    )

    assert messages == ()


def test_context_manager_ignores_tui_only_command_result_history() -> None:
    messages = ContextManager().messages_from_history(
        (
            HistoryItem(
                id="user-1",
                thread_id="demo",
                turn_id="turn-1",
                type=HistoryItemType.USER_MESSAGE,
                text="inspect tools",
            ),
            HistoryItem(
                id="command-1",
                thread_id="demo",
                turn_id="command-1",
                type=HistoryItemType.COMMAND_RESULT,
                text="Tools - 1 available",
                metadata={
                    "model_visible": False,
                    "display": {"title": "Tools should stay out of context"},
                },
            ),
            HistoryItem(
                id="assistant-1",
                thread_id="demo",
                turn_id="turn-1",
                type=HistoryItemType.ASSISTANT_MESSAGE,
                text="Inspection complete.",
            ),
        )
    )

    assert [(message.role, message.content) for message in messages] == [
        ("user", "inspect tools"),
        ("assistant", "Inspection complete."),
    ]


def test_context_manager_replays_context_baseline_updates_as_user_messages() -> None:
    manager = ContextManager()

    messages = manager.messages_from_history(
        (
            HistoryItem(
                id="hist_environment_1",
                thread_id="demo",
                turn_id="turn_1",
                type=HistoryItemType.CONTEXT_BASELINE_UPDATE,
                text="Runtime environment:\n- workspace_root: /repo",
                metadata={
                    "context_kind": "environment_context",
                    "cache_class": "dynamic",
                    "source": "runtime",
                    "replayable": True,
                },
            ),
            HistoryItem(
                id="hist_user_1",
                thread_id="demo",
                turn_id="turn_1",
                type=HistoryItemType.USER_MESSAGE,
                text="inspect repo",
            ),
        )
    )

    assert [message.role for message in messages] == ["user", "user"]
    assert messages[0].content == "Runtime environment:\n- workspace_root: /repo"
    assert messages[0].metadata["context_kind"] == "environment_context"
    assert messages[0].blocks == (
        RuntimeBlock(
            type="text",
            text="Runtime environment:\n- workspace_root: /repo",
            metadata={
                "context_kind": "environment_context",
                "cache_class": "dynamic",
                "source": "runtime",
                "replayable": True,
            },
        ),
    )


def test_context_manager_rejoins_assistant_text_and_tool_call_history_items() -> None:
    manager = ContextManager()

    messages = manager.messages_from_history(
        (
            HistoryItem(
                id="hist_user_1",
                thread_id="demo",
                turn_id="turn_1",
                type=HistoryItemType.USER_MESSAGE,
                text="inspect repo",
            ),
            HistoryItem(
                id="hist_assistant_1",
                thread_id="demo",
                turn_id="turn_1",
                type=HistoryItemType.ASSISTANT_MESSAGE,
                text="I will read README.",
                metadata={
                    "provider_id": "chatcmpl_1",
                    "deepseek": {"reasoning_content": "Need README."},
                },
            ),
            HistoryItem(
                id="hist_tool_call_1",
                thread_id="demo",
                turn_id="turn_1",
                type=HistoryItemType.TOOL_CALL,
                text="Reading README.",
                tool_name="read_file",
                call_id="call_read_1",
                metadata={
                    "arguments": {"path": "README.md"},
                    "provider_id": "chatcmpl_1",
                    "deepseek": {"reasoning_content": "Need README."},
                },
            ),
            HistoryItem(
                id="hist_tool_result_1",
                thread_id="demo",
                turn_id="turn_1",
                type=HistoryItemType.TOOL_RESULT,
                text="Read README.",
                tool_name="read_file",
                call_id="call_read_1",
                metadata={"transcript_content": "README contents"},
            ),
        )
    )

    assert [message.role for message in messages] == ["user", "assistant", "tool"]
    assert messages[1].content == "I will read README."
    assert messages[1].tool_calls == (
        ToolCall(
            name="read_file",
            arguments={"path": "README.md"},
            reason="model requested tool",
            call_id="call_read_1",
        ),
    )
    assert [block.type for block in messages[1].blocks] == ["text", "tool_call"]
    assert messages[1].blocks[0].metadata == {
        "provider_id": "chatcmpl_1",
        "deepseek": {"reasoning_content": "Need README."},
    }


def test_context_manager_rejoins_multi_tool_call_history_batch() -> None:
    manager = ContextManager()

    messages = manager.messages_from_history(
        (
            HistoryItem(
                id="hist_call_1",
                thread_id="demo",
                turn_id="turn_1",
                type=HistoryItemType.TOOL_CALL,
                tool_name="list_directory",
                call_id="call_list_1",
                metadata={"arguments": {"path": "src"}, "provider_id": "chatcmpl_1"},
            ),
            HistoryItem(
                id="hist_result_1",
                thread_id="demo",
                turn_id="turn_1",
                type=HistoryItemType.TOOL_RESULT,
                tool_name="list_directory",
                call_id="call_list_1",
                metadata={"transcript_content": "sample_app"},
            ),
            HistoryItem(
                id="hist_call_2",
                thread_id="demo",
                turn_id="turn_1",
                type=HistoryItemType.TOOL_CALL,
                tool_name="read_file",
                call_id="call_read_1",
                metadata={
                    "arguments": {"path": "pyproject.toml"},
                    "provider_id": "chatcmpl_1",
                },
            ),
            HistoryItem(
                id="hist_result_2",
                thread_id="demo",
                turn_id="turn_1",
                type=HistoryItemType.TOOL_RESULT,
                tool_name="read_file",
                call_id="call_read_1",
                metadata={"transcript_content": "pyproject contents"},
            ),
        )
    )

    assert [message.role for message in messages] == ["assistant", "tool", "tool"]
    assert [call.name for call in messages[0].tool_calls] == [
        "list_directory",
        "read_file",
    ]
    assert [block.type for block in messages[0].blocks] == ["tool_call", "tool_call"]
    assert [message.tool_call_id for message in messages[1:]] == [
        "call_list_1",
        "call_read_1",
    ]


def test_context_manager_does_not_batch_tool_calls_without_provider_id() -> None:
    manager = ContextManager()

    messages = manager.messages_from_history(
        (
            HistoryItem(
                id="hist_call_1",
                thread_id="demo",
                turn_id="turn_1",
                type=HistoryItemType.TOOL_CALL,
                tool_name="list_directory",
                call_id="call_list_1",
                metadata={"arguments": {"path": "src"}},
            ),
            HistoryItem(
                id="hist_result_1",
                thread_id="demo",
                turn_id="turn_1",
                type=HistoryItemType.TOOL_RESULT,
                tool_name="list_directory",
                call_id="call_list_1",
                metadata={"transcript_content": "sample_app"},
            ),
            HistoryItem(
                id="hist_call_2",
                thread_id="demo",
                turn_id="turn_1",
                type=HistoryItemType.TOOL_CALL,
                tool_name="read_file",
                call_id="call_read_1",
                metadata={"arguments": {"path": "pyproject.toml"}},
            ),
        )
    )

    assert [message.role for message in messages] == [
        "assistant",
        "tool",
        "assistant",
    ]
    assert len(messages[0].tool_calls) == 1
    assert len(messages[2].tool_calls) == 1
