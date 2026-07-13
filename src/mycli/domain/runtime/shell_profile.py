from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path


class ShellKind(StrEnum):
    ZSH = "zsh"
    BASH = "bash"
    SH = "sh"
    POWERSHELL = "powershell"
    CMD = "cmd"


class PowerShellEdition(StrEnum):
    CORE = "core"
    DESKTOP = "desktop"


@dataclass(frozen=True, slots=True)
class ShellProfile:
    kind: ShellKind
    executable: Path
    powershell_edition: PowerShellEdition | None = None

    def __post_init__(self) -> None:
        if self.kind is ShellKind.POWERSHELL and self.powershell_edition is None:
            raise ValueError("PowerShell profile requires an edition.")
        if self.kind is not ShellKind.POWERSHELL and self.powershell_edition is not None:
            raise ValueError("PowerShell edition is only valid for PowerShell profiles.")

    def exec_argv(self, command: str) -> list[str]:
        executable = str(self.executable)
        if self.kind in {ShellKind.ZSH, ShellKind.BASH, ShellKind.SH}:
            return [executable, "-c", command]
        if self.kind is ShellKind.POWERSHELL:
            return [
                executable,
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                command,
            ]
        return [executable, "/d", "/s", "/c", command]

    @property
    def display_name(self) -> str:
        if self.kind is ShellKind.POWERSHELL:
            if self.powershell_edition is PowerShellEdition.CORE:
                return "PowerShell 7"
            return "Windows PowerShell 5.1"
        return self.kind.value


__all__ = ["PowerShellEdition", "ShellKind", "ShellProfile"]
