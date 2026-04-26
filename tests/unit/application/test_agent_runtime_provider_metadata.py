from __future__ import annotations

from pathlib import Path

from mycli.application.runtime.agent_runtime import AgentRuntime
from mycli.domain.runtime import ModelTurnResult, RuntimeBlock, RuntimeItem


class MetadataToolThenDoneAdapter:
    def __init__(self) -> None:
        self.calls = 0
        self.seen_items: list[list[RuntimeItem]] = []

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
                                call_id="call_read_file_1",
                                metadata={
                                    "deepseek": {
                                        "reasoning_content": (
                                            "I need to inspect the requested file."
                                        )
                                    }
                                },
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
    adapter = MetadataToolThenDoneAdapter()
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
