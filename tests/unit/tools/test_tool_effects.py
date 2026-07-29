from __future__ import annotations

from pathlib import Path

from mycli.tools.base import ToolEffectProfile, tool_effects_for_tool
from mycli.tools.bash import BashTool
from mycli.tools.edit import EditTool
from mycli.tools.ls import LSTool
from mycli.tools.read import ReadTool
from mycli.tools.write import WriteTool


def test_local_tools_report_expected_effect_profiles(tmp_path: Path) -> None:
    assert tool_effects_for_tool(ReadTool(tmp_path)) == ToolEffectProfile(filesystem="read")
    assert tool_effects_for_tool(LSTool(tmp_path)) == ToolEffectProfile(filesystem="read")

    assert tool_effects_for_tool(EditTool(tmp_path)) == ToolEffectProfile(filesystem="write")
    assert tool_effects_for_tool(WriteTool(tmp_path)) == ToolEffectProfile(filesystem="write")

    assert tool_effects_for_tool(BashTool(tmp_path)) == ToolEffectProfile(
        filesystem="unknown",
        process=True,
    )
