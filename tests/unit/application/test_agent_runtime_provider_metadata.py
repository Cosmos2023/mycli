from __future__ import annotations

from pathlib import Path

from mycli.application.runtime.agent_runtime import AgentRuntime
from mycli.domain.runtime import ModelTurnResult, RuntimeBlock, RuntimeItem


class MetadataToolThenDoneAdapter:
    def __init__(
        self,
        *,
        metadata: dict[str, object] | None = None,
        tool_call_id: str = "call_read_file_1",
    ) -> None:
        self.calls = 0
        self.seen_items: list[list[RuntimeItem]] = []
        self.metadata = {} if metadata is None else dict(metadata)
        self.tool_call_id = tool_call_id

    def next_turn(self, *, items, tools):
        del tools
        self.seen_items.append(items)
        self.calls += 1
        if self.calls == 1:
            return ModelTurnResult(
                items=(
                    RuntimeItem(
                        role="assistant",
                        blocks=(
                            RuntimeBlock(
                                type="tool_call",
                                tool_name="read_file",
                                tool_arguments={"path": "mission.txt"},
                                call_id=self.tool_call_id,
                                metadata=dict(self.metadata),
                            ),
                        ),
                    ),
                ),
                done=False,
            )
        return ModelTurnResult(
            items=(
                RuntimeItem(
                    role="assistant",
                    blocks=(RuntimeBlock(type="text", text="Read complete"),),
                ),
            ),
            done=True,
        )


def test_agent_runtime_preserves_tool_call_metadata_for_next_turn(
    tmp_path: Path,
) -> None:
    (tmp_path / "mission.txt").write_text("mission accomplished\n", encoding="utf-8")
    adapter = MetadataToolThenDoneAdapter(
        metadata={
            "deepseek": {
                "reasoning_content": "I need to inspect the requested file."
            }
        }
    )
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=adapter,
    )

    response = runtime.handle_user_turn("read mission.txt")

    assert response.assistant_message == "Read complete"
    assistant_item = next(
        item
        for item in adapter.seen_items[1]
        if item.role == "assistant"
        and any(block.type == "tool_call" for block in item.blocks)
    )
    tool_block = next(
        block for block in assistant_item.blocks if block.type == "tool_call"
    )
    assert tool_block.metadata["deepseek"] == {
        "reasoning_content": "I need to inspect the requested file."
    }


def test_agent_runtime_exposes_deepseek_reasoning_content_for_tool_call(
    tmp_path: Path,
) -> None:
    reasoning_content = (
        "The user asked for mission.txt, so I need to read that exact file before answering."
    )
    (tmp_path / "mission.txt").write_text("mission accomplished\n", encoding="utf-8")
    adapter = MetadataToolThenDoneAdapter(
        metadata={"deepseek": {"reasoning_content": reasoning_content}},
    )
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=adapter,
    )

    response = runtime.handle_user_turn("read mission.txt")

    assert reasoning_content in response.progress_updates
    assert any(
        event.kind == "thinking" and event.message == f"Thinking: {reasoning_content}"
        for event in response.activity_events
    )
    assert response.turn is not None
    reasoning_item = next(
        item
        for item in response.turn.items
        if item.type.value == "reasoning"
        and item.metadata.get("source") == "provider_reasoning_content"
    )
    assert reasoning_item.text == f"Thinking: {reasoning_content}"
    assert reasoning_item.metadata == {
        "provider_id": None,
        "provider": "deepseek",
        "source": "provider_reasoning_content",
        "deepseek": {"reasoning_content": reasoning_content},
    }

    app_log = (tmp_path / "log" / "app.log").read_text(encoding="utf-8")
    assert "provider_reasoning_content" in app_log
    assert reasoning_content in app_log


def test_agent_runtime_ignores_malformed_deepseek_reasoning_metadata(
    tmp_path: Path,
) -> None:
    (tmp_path / "mission.txt").write_text("mission accomplished\n", encoding="utf-8")
    adapter = MetadataToolThenDoneAdapter(
        metadata={"deepseek": {"reasoning_content": "   "}},
    )
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=adapter,
    )

    response = runtime.handle_user_turn("read mission.txt")

    assert response.assistant_message == "Read complete"
    assert not any(
        event.kind == "thinking" and event.message == "Thinking:    "
        for event in response.activity_events
    )
    assert response.turn is not None
    assert not any(
        item.type.value == "reasoning"
        and item.metadata.get("source") == "provider_reasoning_content"
        for item in response.turn.items
    )
