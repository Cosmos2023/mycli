from pathlib import Path
from unittest.mock import patch

from mycli.services.write_diagnostics import WriteDiagnosticsService


def test_write_diagnostics_forwards_shell_path(tmp_path: Path) -> None:
    service = WriteDiagnosticsService(
        workspace_root=tmp_path,
        shell_path="/configured/bash",
    )

    with patch(
        "mycli.services.write_diagnostics.lint",
        return_value={"diagnostics": [], "count": 0, "truncated": False},
    ) as lint:
        service.run(("src/app.py",))

    assert lint.call_args.kwargs["shell_path"] == "/configured/bash"
