from __future__ import annotations

import pytest

from mycli.domain.model_events import ModelEvent, ModelEventType, ToolExecutionSource


def test_model_event_supports_unified_tool_sources_for_native_mcp_and_skill() -> None:
    native_event = ModelEvent.tool_call_requested(
        tool_name="read_file",
        tool_arguments={"path": "README.md"},
        call_id="call_native_1",
        source=ToolExecutionSource.NATIVE,
    )
    mcp_event = ModelEvent.tool_call_requested(
        tool_name="fetch_docs",
        tool_arguments={"topic": "responses"},
        call_id="call_mcp_1",
        source=ToolExecutionSource.MCP,
    )
    skill_event = ModelEvent.tool_call_requested(
        tool_name="writing-plans",
        tool_arguments={"topic": "protocol"},
        call_id="call_skill_1",
        source=ToolExecutionSource.SKILL,
    )

    assert native_event.source is ToolExecutionSource.NATIVE
    assert mcp_event.source is ToolExecutionSource.MCP
    assert skill_event.source is ToolExecutionSource.SKILL


def test_model_event_requires_tool_fields_for_tool_call_requested() -> None:
    with pytest.raises(ValueError, match="tool_name"):
        ModelEvent(type=ModelEventType.TOOL_CALL_REQUESTED, call_id="call_missing_name")

    with pytest.raises(ValueError, match="call_id"):
        ModelEvent(type=ModelEventType.TOOL_CALL_REQUESTED, tool_name="read_file")


def test_runtime_block_tracks_unified_tool_source() -> None:
    from mycli.domain.runtime.blocks import RuntimeBlock

    block = RuntimeBlock(
        type="tool_call",
        tool_name="fetch_docs",
        tool_arguments={"topic": "mcp"},
        call_id="call_mcp_1",
        source="mcp",
    )

    assert block.source == "mcp"
