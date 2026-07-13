from pathlib import Path
from unittest.mock import patch

from mycli.domain.runtime import ShellKind, ShellProfile
from mycli.services.write_diagnostics import WriteDiagnosticsService


def test_write_diagnostics_forwards_profile_and_direct_paths(tmp_path: Path) -> None:
    profile = ShellProfile(ShellKind.SH, Path("/bin/sh"))
    service = WriteDiagnosticsService(workspace_root=tmp_path, shell_profile=profile)

    with patch(
        "mycli.services.write_diagnostics.lint",
        return_value={"diagnostics": [], "count": 0, "truncated": False},
    ) as lint:
        service.run(("src/app.py",))

    assert lint.call_args.kwargs["paths"] == ("src/app.py",)
    assert lint.call_args.kwargs["shell_profile"] == profile
