from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass
import ntpath
import os
from pathlib import Path
import shutil
import sys
from typing import Literal

from mycli.domain.runtime import PowerShellEdition, ShellKind, ShellProfile


@dataclass(frozen=True, slots=True)
class ShellCommandConfig:
    executable: Path
    args: tuple[str, ...] = ("-c",)


class ShellResolutionError(RuntimeError):
    pass


PathExists = Callable[[Path], bool]
WhichExecutable = Callable[[str, str | None], str | None]
UserShell = Callable[[], Path | None]

ExplicitPathStatus = Literal["not_configured", "accepted", "ignored"]


@dataclass(frozen=True, slots=True)
class ShellResolution:
    profile: ShellProfile
    explicit_path_status: ExplicitPathStatus
    explicit_path_reason: str | None = None


def detect_shell_profile(
    custom_shell_path: str | None,
    *,
    platform_name: str = sys.platform,
    env: Mapping[str, str] = os.environ,
    path_exists: PathExists = Path.is_file,
    which: WhichExecutable = lambda name, path: shutil.which(name, path=path),
    user_shell: UserShell | None = None,
) -> ShellProfile:
    return detect_shell_profile_with_diagnostics(
        custom_shell_path,
        platform_name=platform_name,
        env=env,
        path_exists=path_exists,
        which=which,
        user_shell=user_shell,
    ).profile


def detect_shell_profile_with_diagnostics(
    custom_shell_path: str | None,
    *,
    platform_name: str = sys.platform,
    env: Mapping[str, str] = os.environ,
    path_exists: PathExists = Path.is_file,
    which: WhichExecutable = lambda name, path: shutil.which(name, path=path),
    user_shell: UserShell | None = None,
) -> ShellResolution:
    explicit_status: ExplicitPathStatus = "not_configured"
    explicit_reason: str | None = None
    if custom_shell_path:
        explicit = Path(custom_shell_path).expanduser()
        if not path_exists(explicit):
            explicit_status = "ignored"
            explicit_reason = f"configured shell_path does not exist: {explicit}"
        else:
            profile = _profile_for_executable(explicit)
            if profile is not None:
                return ShellResolution(profile, "accepted")
            explicit_status = "ignored"
            explicit_reason = f"configured shell_path is not recognized: {explicit}"

    if platform_name == "win32":
        profile = _detect_windows_profile(env=env, path_exists=path_exists, which=which)
    else:
        profile = _detect_unix_profile(
            platform_name=platform_name,
            env=env,
            path_exists=path_exists,
            which=which,
            user_shell=user_shell or _account_user_shell,
        )
    return ShellResolution(profile, explicit_status, explicit_reason)


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


def _detect_windows_profile(
    *,
    env: Mapping[str, str],
    path_exists: PathExists,
    which: WhichExecutable,
) -> ShellProfile:
    environment_path = _environment_path(env)
    pwsh = which("pwsh", environment_path) or which("pwsh.exe", environment_path)
    if pwsh:
        return ShellProfile(
            ShellKind.POWERSHELL,
            Path(pwsh),
            PowerShellEdition.CORE,
        )

    program_files = _environment_value(env, "ProgramFiles") or r"C:\Program Files"
    pwsh_fallback = Path(ntpath.join(program_files, "PowerShell", "7", "pwsh.exe"))
    if path_exists(pwsh_fallback):
        return ShellProfile(
            ShellKind.POWERSHELL,
            pwsh_fallback,
            PowerShellEdition.CORE,
        )

    powershell = which("powershell", environment_path) or which(
        "powershell.exe", environment_path
    )
    if powershell:
        return ShellProfile(
            ShellKind.POWERSHELL,
            Path(powershell),
            PowerShellEdition.DESKTOP,
        )

    system_root = _environment_value(env, "SystemRoot") or r"C:\Windows"
    desktop_fallback = Path(
        ntpath.join(
            system_root,
            "System32",
            "WindowsPowerShell",
            "v1.0",
            "powershell.exe",
        )
    )
    if path_exists(desktop_fallback):
        return ShellProfile(
            ShellKind.POWERSHELL,
            desktop_fallback,
            PowerShellEdition.DESKTOP,
        )

    cmd = which("cmd", environment_path) or which("cmd.exe", environment_path)
    return ShellProfile(ShellKind.CMD, Path(cmd or "cmd.exe"))


def _detect_unix_profile(
    *,
    platform_name: str,
    env: Mapping[str, str],
    path_exists: PathExists,
    which: WhichExecutable,
    user_shell: UserShell,
) -> ShellProfile:
    account_shell = user_shell()
    if account_shell is not None and path_exists(account_shell):
        profile = _profile_for_executable(account_shell)
        if profile is not None and profile.kind in {
            ShellKind.ZSH,
            ShellKind.BASH,
            ShellKind.SH,
        }:
            return profile

    order = ("zsh", "bash", "sh") if platform_name == "darwin" else ("bash", "zsh", "sh")
    environment_path = _environment_path(env)
    for name in order:
        standard = Path("/bin") / name
        if path_exists(standard):
            return ShellProfile(ShellKind(name), standard)
        on_path = which(name, environment_path)
        if on_path:
            return ShellProfile(ShellKind(name), Path(on_path))
    return ShellProfile(ShellKind.SH, Path("/bin/sh"))


def _profile_for_executable(executable: Path) -> ShellProfile | None:
    basename = ntpath.basename(str(executable)).casefold()
    if basename.endswith(".exe"):
        basename = basename[:-4]
    if basename == "pwsh":
        return ShellProfile(
            ShellKind.POWERSHELL,
            executable,
            PowerShellEdition.CORE,
        )
    if basename == "powershell":
        return ShellProfile(
            ShellKind.POWERSHELL,
            executable,
            PowerShellEdition.DESKTOP,
        )
    if basename in {"zsh", "bash", "sh", "cmd"}:
        return ShellProfile(ShellKind(basename), executable)
    return None


def _account_user_shell() -> Path | None:
    if os.name == "nt":
        return None
    try:
        import pwd

        shell = pwd.getpwuid(os.getuid()).pw_shell
    except (ImportError, KeyError, OSError):
        return None
    return Path(shell) if shell else None
