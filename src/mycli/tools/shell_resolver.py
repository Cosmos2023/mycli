from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass
import ntpath
import os
from pathlib import Path
import shutil
import sys


@dataclass(frozen=True, slots=True)
class ShellCommandConfig:
    executable: Path
    args: tuple[str, ...] = ("-c",)


class ShellResolutionError(RuntimeError):
    pass


PathExists = Callable[[Path], bool]
WhichExecutable = Callable[[str, str | None], str | None]


def resolve_shell(
    custom_shell_path: str | None,
    *,
    platform_name: str = sys.platform,
    env: Mapping[str, str] = os.environ,
    path_exists: PathExists = Path.exists,
    which: WhichExecutable = lambda name, path: shutil.which(name, path=path),
) -> ShellCommandConfig:
    if custom_shell_path:
        explicit = Path(custom_shell_path).expanduser()
        if path_exists(explicit):
            return ShellCommandConfig(explicit)
        raise ShellResolutionError(f"Configured shell_path does not exist: {explicit}")

    environment_path = _environment_path(env)
    if platform_name == "win32":
        candidates = _windows_git_bash_candidates(env)
        for candidate in candidates:
            if path_exists(candidate):
                return ShellCommandConfig(candidate)
        on_path = which("bash.exe", environment_path)
        if on_path:
            return ShellCommandConfig(Path(on_path))
        searched = "\n".join(f"  {candidate}" for candidate in candidates)
        raise ShellResolutionError(
            "No Bash executable was found. Install Git for Windows or set "
            "MYCLI_SHELL_PATH/shell_path.\nSearched:\n" + searched
        )

    bin_bash = Path("/bin/bash")
    if path_exists(bin_bash):
        return ShellCommandConfig(bin_bash)
    for name in ("bash", "sh"):
        on_path = which(name, environment_path)
        if on_path:
            return ShellCommandConfig(Path(on_path))
    raise ShellResolutionError(
        "No Bash-compatible shell was found. Install bash or set "
        "MYCLI_SHELL_PATH/shell_path."
    )


def _windows_git_bash_candidates(env: Mapping[str, str]) -> tuple[Path, ...]:
    roots = (
        _environment_value(env, "ProgramFiles"),
        _environment_value(env, "ProgramFiles(x86)"),
    )
    return tuple(
        Path(ntpath.join(root, "Git", "bin", "bash.exe"))
        for root in roots
        if root
    )


def _environment_path(env: Mapping[str, str]) -> str | None:
    return _environment_value(env, "PATH")


def _environment_value(env: Mapping[str, str], name: str) -> str | None:
    target = name.casefold()
    return next((value for key, value in env.items() if key.casefold() == target), None)
