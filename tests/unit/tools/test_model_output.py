from __future__ import annotations

from mycli.domain.tooling.calls import ToolResult
from mycli.tools.model_output import shell_model_output


def test_background_shell_model_output_includes_shell_id_and_polling_guidance() -> None:
    result = ToolResult(
        success=True,
        summary="Command exited with None",
        raw_payload={
            "background": True,
            "status": "running",
            "process_state": "running_background",
            "shell_id": "7ad20502",
            "output": "",
        },
    )

    output = shell_model_output(result).text_content()

    assert "shell_id: 7ad20502" in output
    assert "status: running" in output
    assert 'ShellOutput({"shell_id":"7ad20502"})' in output
    assert "Command exited with None" not in output
