from __future__ import annotations

from pathlib import Path
import shlex
import sys


def python_shell_command(source: str) -> str:
    executable = Path(sys.executable).as_posix()
    return f"{shlex.quote(executable)} -c {shlex.quote(source)}"
