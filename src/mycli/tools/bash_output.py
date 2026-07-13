from __future__ import annotations

from mycli.tools.base import ToolSpec
from mycli.tools.shell_output import ShellOutputTool


class BashOutputTool(ShellOutputTool):
    name = "BashOutput"
    spec = ToolSpec(
        name="BashOutput",
        description="Compatibility alias for the ShellOutput tool.",
        parameters=ShellOutputTool.spec.parameters,
        risk_level="low",
    )
