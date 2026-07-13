from __future__ import annotations

from mycli.domain.runtime import PowerShellEdition, ShellKind, ShellProfile


def render_shell_guidance(profile: ShellProfile) -> str:
    if profile.kind is ShellKind.POWERSHELL:
        lines = [
            f"Current shell: {profile.display_name}",
            "Use PowerShell syntax, not POSIX shell syntax.",
            "Use $env:NAME for environment variables.",
        ]
        if profile.powershell_edition is PowerShellEdition.DESKTOP:
            lines.append("Do not use && or ||; run commands separately or test $?.")
        else:
            lines.append("PowerShell 7 supports && and || for conditional chaining.")
        return "\n".join(lines)

    if profile.kind is ShellKind.CMD:
        return "\n".join(
            (
                "Current shell: Command Prompt",
                "Use Command Prompt syntax, not POSIX or PowerShell syntax.",
                "Use %NAME% for environment variables.",
            )
        )

    return "\n".join(
        (
            f"Current shell: {profile.display_name}",
            f"Use {profile.kind.value}/POSIX command syntax.",
            "Use $NAME for environment variables; && and || are supported.",
        )
    )


__all__ = ["render_shell_guidance"]
