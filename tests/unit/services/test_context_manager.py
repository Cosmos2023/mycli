from mycli.domain.conversation import Message
from mycli.domain.runtime import HistoryItem, HistoryItemType, RuntimeBlock
from mycli.domain.tools import ToolCall
from mycli.domain.tools import ToolEvidence
from mycli.tools.base import ToolResult
from mycli.services.context.context_manager import ContextManager


def test_context_manager_summarizes_older_messages() -> None:
    manager = ContextManager()

    context = manager.build(
        conversation=(
            Message(role="user", content="first question"),
            Message(role="assistant", content="first answer"),
            Message(role="user", content="second question"),
        ),
        recent_message_count=1,
    )

    assert len(context.messages) == 1
    assert context.summary is not None
    assert "first question" in context.summary


def test_context_manager_excludes_reasoning_blocks_from_older_summary() -> None:
    manager = ContextManager()

    context = manager.build(
        conversation=(
            Message(
                role="assistant",
                content="Private reasoning that should not become summary text.",
                blocks=(
                    RuntimeBlock(
                        type="reasoning",
                        text="Private reasoning that should not become summary text.",
                    ),
                ),
            ),
            Message(role="assistant", content="Public answer."),
        ),
        recent_message_count=1,
    )

    assert context.summary is None


def test_context_manager_keeps_provider_replay_append_only_while_recent_context_slides() -> None:
    manager = ContextManager()
    conversation = (
        Message(role="user", content="first question"),
        Message(
            role="assistant",
            content="Private reasoning.",
            blocks=(RuntimeBlock(type="reasoning", text="Private reasoning."),),
        ),
        Message(role="assistant", content="first answer"),
        Message(role="user", content="second question"),
    )

    managed = manager.build(conversation=conversation, recent_message_count=1)
    provider_replay = manager.provider_replay_messages(
        conversation=conversation,
        history_items=(),
    )

    assert managed.messages == (conversation[-1],)
    assert managed.summary == "- user: first question\n- assistant: first answer"
    assert provider_replay == conversation


def test_context_manager_expands_recent_messages_to_avoid_orphaned_tool_results() -> None:
    manager = ContextManager()
    tool_call_message = Message(
        role="assistant",
        content="",
        tool_calls=(
            ToolCall(
                name="list_directory",
                arguments={"path": "."},
                reason="inspect root",
                call_id="call_list_1",
            ),
        ),
        blocks=(
            RuntimeBlock(
                type="tool_call",
                tool_name="list_directory",
                tool_arguments={"path": "."},
                call_id="call_list_1",
            ),
        ),
    )
    tool_result_message = Message(
        role="tool",
        content="README.md, src, tests",
        tool_call_id="call_list_1",
        blocks=(RuntimeBlock(type="tool_result", text="README.md, src, tests", call_id="call_list_1"),),
    )

    context = manager.build(
        conversation=(
            Message(role="user", content="inspect"),
            Message(role="assistant", content="I will inspect."),
            tool_call_message,
            tool_result_message,
            Message(role="assistant", content="Next step."),
        ),
        recent_message_count=2,
    )

    assert context.messages == (
        tool_call_message,
        tool_result_message,
        Message(role="assistant", content="Next step."),
    )
    assert context.summary is not None
    assert "inspect" in context.summary


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


def test_context_manager_trims_tool_result_output() -> None:
    manager = ContextManager()

    rendered = manager.render_tool_result(
        ToolResult(success=True, summary="x" * 40),
        max_chars=12,
    )

    assert rendered == "xxxxxxxxx..."


def test_context_manager_renders_search_match_details_from_payload() -> None:
    manager = ContextManager()

    rendered = manager.render_tool_result(
        ToolResult(
            success=True,
            summary="Found 2 matches for search_text",
            raw_payload={
                "query": "SearchTextTool",
                "path": "src",
                "glob": "*.py",
                "case_sensitive": False,
                "max_matches": 25,
                "matches": [
                    {
                        "path": "src/mycli/tools/search_text.py",
                        "line_number": 12,
                        "line": "class SearchTextTool:",
                    },
                    {
                        "path": "tests/unit/tools/test_read_only_tools.py",
                        "line_number": 30,
                        "line": "def test_search_text_supports_case_sensitive_matching(...):",
                    },
                ]
            },
        ),
        max_chars=400,
    )

    assert "Search query: SearchTextTool" in rendered
    assert "Search scope: path=src glob=*.py case_sensitive=False max_matches=25" in rendered
    assert "src/mycli/tools/search_text.py:12" in rendered
    assert "class SearchTextTool:" in rendered


def test_context_manager_prefers_evidence_over_payload_previews() -> None:
    manager = ContextManager()

    rendered = manager.render_tool_result(
        ToolResult(
            success=True,
            summary="Found 1 match for hello",
            raw_payload={
                "query": "hello",
                "matches": [
                    {"path": "README.md", "line_number": 99, "line": "legacy payload"},
                ],
            },
            evidence=(
                ToolEvidence(
                    kind="search_match",
                    title='Match 1 for "hello"',
                    path="README.md",
                    line_start=1,
                    line_end=1,
                    snippet="hello world",
                ),
            ),
        ),
        max_chars=400,
    )

    assert "Evidence:" in rendered
    assert "[search_match] README.md:1" in rendered
    assert "snippet: hello world" in rendered
    assert "legacy payload" not in rendered


def test_context_manager_trims_evidence_snippet_but_keeps_location() -> None:
    manager = ContextManager()

    rendered = manager.render_tool_result(
        ToolResult(
            success=True,
            summary="Read README.md",
            evidence=(
                ToolEvidence(
                    kind="file_excerpt",
                    title="Excerpt from README.md",
                    path="README.md",
                    line_start=20,
                    line_end=40,
                    snippet="x" * 300,
                ),
            ),
        ),
        max_chars=160,
    )

    assert "[file_excerpt] README.md:20-40" in rendered
    assert "snippet:" in rendered
    assert rendered.endswith("...")


def test_context_manager_keeps_small_file_excerpt_content_under_larger_budget() -> None:
    manager = ContextManager()
    snippet = "alpha beta gamma " * 20

    rendered = manager.render_tool_result(
        ToolResult(
            success=True,
            summary="Read README.md",
            evidence=(
                ToolEvidence(
                    kind="file_excerpt",
                    title="Excerpt from README.md",
                    path="README.md",
                    line_start=1,
                    line_end=20,
                    snippet=snippet,
                ),
            ),
        ),
    )

    assert "[file_excerpt] README.md:1-20" in rendered
    assert f"snippet: {snippet.strip()}" in rendered


def test_context_manager_adds_guidance_for_large_file_excerpt() -> None:
    manager = ContextManager()

    rendered = manager.render_tool_result(
        ToolResult(
            success=True,
            summary="Read README.md",
            evidence=(
                ToolEvidence(
                    kind="file_excerpt",
                    title="Excerpt from README.md",
                    path="README.md",
                    line_start=1,
                    line_end=500,
                    snippet="x" * 5000,
                ),
            ),
        ),
    )

    assert "[file_excerpt] README.md:1-500" in rendered
    assert "Read with offset/limit" in rendered


def test_context_manager_renders_file_content_preview_from_payload() -> None:
    manager = ContextManager()

    rendered = manager.render_tool_result(
        ToolResult(
            success=True,
            summary="Read src/mycli/tools/search_text.py",
            raw_payload={
                "path": "src/mycli/tools/search_text.py",
                "content": "from __future__ import annotations\n\nclass SearchTextTool:\n    ...\n",
            },
        ),
        max_chars=400,
    )

    assert "File path: src/mycli/tools/search_text.py" in rendered
    assert "SearchTextTool" in rendered
    assert "Read src/mycli/tools/search_text.py" in rendered


def test_context_manager_marks_readme_as_supporting_context() -> None:
    manager = ContextManager()

    rendered = manager.render_tool_result(
        ToolResult(
            success=True,
            summary="Read README.md",
            raw_payload={
                "path": "README.md",
                "content": "# demo\nentrypoint maybe src/mycli/cli/main.py\n",
            },
        ),
        max_chars=500,
    )

    assert "README is supporting context" in rendered
    assert "source or config files" in rendered


def test_context_manager_renders_diff_preview_from_payload() -> None:
    manager = ContextManager()

    rendered = manager.render_tool_result(
        ToolResult(
            success=True,
            summary="Updated src/mycli/tools/search_text.py",
            raw_payload={
                "path": "src/mycli/tools/search_text.py",
                "diff": (
                    "--- src/mycli/tools/search_text.py\n"
                    "+++ src/mycli/tools/search_text.py\n"
                    "@@ -1,2 +1,2 @@\n"
                    "-class SearchTextTool:\n"
                    "+class BetterSearchTextTool:\n"
                ),
            },
        ),
        max_chars=800,
    )

    assert "Diff preview:" in rendered
    assert "@@ -1,2 +1,2 @@" in rendered
    assert "-class SearchTextTool:" in rendered
    assert "+class BetterSearchTextTool:" in rendered


def test_context_manager_renders_shell_output_preview_from_payload() -> None:
    manager = ContextManager()

    rendered = manager.render_tool_result(
        ToolResult(
            success=True,
            summary="Command exited with 0",
            raw_payload={
                "stdout": "/Users/cosmos/Desktop/mycli\nREADME.md\nsrc\n",
                "stderr": "",
            },
        ),
        max_chars=400,
    )

    assert "Stdout preview:" in rendered
    assert "/Users/cosmos/Desktop/mycli" in rendered
    assert "README.md src" in rendered
