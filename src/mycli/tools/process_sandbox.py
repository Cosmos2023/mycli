from __future__ import annotations

from collections import deque
from dataclasses import dataclass
import glob
import json
from pathlib import Path
import re
import subprocess
import sys
from typing import Callable, TypeAlias

from mycli.domain.runtime import SandboxMode, SandboxProfile, ShellBackendProfile


MACOS_SEATBELT_EXECUTABLE = Path("/usr/bin/sandbox-exec")
LINUX_BUBBLEWRAP_EXECUTABLES = (Path("/usr/bin/bwrap"), Path("/bin/bwrap"))
WINDOWS_SANDBOX_PROTOCOL_VERSION = 1
WINDOWS_SANDBOX_HELPER_NAME = "mycli-windows-sandbox.exe"
WINDOWS_SANDBOX_HANDSHAKE_TIMEOUT_SECONDS = 2.0
WINDOWS_SANDBOX_HANDSHAKE_MAX_CHARS = 8_192
WINDOWS_SANDBOX_SETUP_TIMEOUT_SECONDS = 300.0
WINDOWS_SANDBOX_SETUP_REQUIRED = "windows_sandbox_setup_required"
MAX_DENIED_GLOB_MATCHES = 8_192
PROTECTED_METADATA_NAMES = (".git", ".agents", ".codex")

WindowsSandboxHelperStatus: TypeAlias = Callable[[Path], tuple[bool, str | None]]
WindowsSandboxHelperSetup: TypeAlias = Callable[[Path], tuple[bool, str | None]]


class ProcessSandboxUnavailable(RuntimeError):
    pass


@dataclass(frozen=True, slots=True)
class SandboxedProcessLaunch:
    argv: tuple[str, ...]
    backend: ShellBackendProfile


class MacOSSeatbeltProcessSandbox:
    def __init__(
        self,
        *,
        executable: Path = MACOS_SEATBELT_EXECUTABLE,
        executable_exists: Callable[[Path], bool] | None = None,
    ) -> None:
        self._executable = executable
        self._executable_exists = executable_exists or _is_executable

    def prepare(
        self,
        argv: tuple[str, ...],
        *,
        sandbox: SandboxProfile,
    ) -> SandboxedProcessLaunch:
        if not self._executable_exists(self._executable):
            raise ProcessSandboxUnavailable(
                f"macOS sandbox executable is unavailable: {self._executable}"
            )

        profile, definitions = _seatbelt_profile(sandbox)
        wrapped = [str(self._executable), "-p", profile]
        wrapped.extend(f"-D{key}={value}" for key, value in definitions)
        wrapped.append("--")
        wrapped.extend(argv)
        return SandboxedProcessLaunch(
            argv=tuple(wrapped),
            backend=ShellBackendProfile(isolation="macos_seatbelt"),
        )


class LinuxBubblewrapProcessSandbox:
    def __init__(
        self,
        *,
        executable: Path | None = None,
        executable_exists: Callable[[Path], bool] | None = None,
    ) -> None:
        self._executable_exists = executable_exists or _is_executable
        self._executable = executable or next(
            (
                candidate
                for candidate in LINUX_BUBBLEWRAP_EXECUTABLES
                if self._executable_exists(candidate)
            ),
            LINUX_BUBBLEWRAP_EXECUTABLES[0],
        )

    def prepare(
        self,
        argv: tuple[str, ...],
        *,
        sandbox: SandboxProfile,
    ) -> SandboxedProcessLaunch:
        if not self._executable_exists(self._executable):
            raise ProcessSandboxUnavailable(
                "Linux Bubblewrap sandbox executable is unavailable; "
                f"checked: {', '.join(str(path) for path in LINUX_BUBBLEWRAP_EXECUTABLES)}"
            )

        cwd = sandbox.cwd.resolve()
        wrapped = [
            str(self._executable),
            "--new-session",
            "--die-with-parent",
            "--ro-bind",
            "/",
            "/",
            "--dev",
            "/dev",
        ]
        for root in sandbox.writable_roots:
            resolved = root.resolve()
            if not resolved.exists():
                continue
            wrapped.extend(("--bind", str(resolved), str(resolved)))

        for protected_path in _existing_protected_write_paths(sandbox):
            wrapped.extend(("--ro-bind", str(protected_path), str(protected_path)))

        for denied_path in _existing_denied_read_paths(sandbox):
            if denied_path.is_dir():
                wrapped.extend(("--perms", "000", "--tmpfs", str(denied_path)))
                wrapped.extend(("--remount-ro", str(denied_path)))
            else:
                wrapped.extend(("--ro-bind", "/dev/null", str(denied_path)))

        wrapped.extend(("--unshare-user", "--unshare-pid"))
        if sandbox.network == "disabled":
            wrapped.append("--unshare-net")
        wrapped.extend(("--proc", "/proc", "--chdir", str(cwd), "--"))
        wrapped.extend(argv)
        return SandboxedProcessLaunch(
            argv=tuple(wrapped),
            backend=ShellBackendProfile(isolation="linux_bubblewrap"),
        )


class WindowsRestrictedTokenProcessSandbox:
    def __init__(
        self,
        *,
        executable: Path | None = None,
        helper_status: WindowsSandboxHelperStatus | None = None,
        helper_setup: WindowsSandboxHelperSetup | None = None,
    ) -> None:
        self._executable = executable or _packaged_windows_sandbox_helper()
        self._helper_status = helper_status or _windows_sandbox_helper_status
        self._helper_setup = helper_setup or _setup_windows_sandbox_helper

    def prepare(
        self,
        argv: tuple[str, ...],
        *,
        sandbox: SandboxProfile,
    ) -> SandboxedProcessLaunch:
        available, error = self._helper_status(self._executable)
        if not available and error == WINDOWS_SANDBOX_SETUP_REQUIRED:
            setup_succeeded, setup_error = self._helper_setup(self._executable)
            if not setup_succeeded:
                raise ProcessSandboxUnavailable(
                    setup_error or "Windows sandbox setup failed"
                )
            available, error = self._helper_status(self._executable)
        if not available:
            raise ProcessSandboxUnavailable(
                error or "Windows restricted-token sandbox helper is unavailable"
            )

        request = _windows_sandbox_request(argv, sandbox=sandbox)
        return SandboxedProcessLaunch(
            argv=(
                str(self._executable),
                "--request-json",
                json.dumps(request, ensure_ascii=True, separators=(",", ":")),
            ),
            backend=ShellBackendProfile(isolation="windows_restricted_token"),
        )


def prepare_sandboxed_argv(
    argv: tuple[str, ...],
    *,
    sandbox: SandboxProfile | None,
    platform: str | None = None,
    macos_backend: MacOSSeatbeltProcessSandbox | None = None,
    linux_backend: LinuxBubblewrapProcessSandbox | None = None,
    windows_backend: WindowsRestrictedTokenProcessSandbox | None = None,
) -> SandboxedProcessLaunch:
    if sandbox is None or sandbox.mode is SandboxMode.DANGER_FULL_ACCESS:
        return SandboxedProcessLaunch(argv=argv, backend=ShellBackendProfile())

    effective_platform = platform or sys.platform
    if effective_platform == "darwin":
        return (macos_backend or MacOSSeatbeltProcessSandbox()).prepare(
            argv,
            sandbox=sandbox,
        )
    if effective_platform.startswith("linux"):
        return (linux_backend or LinuxBubblewrapProcessSandbox()).prepare(
            argv,
            sandbox=sandbox,
        )
    if effective_platform == "win32":
        return (windows_backend or WindowsRestrictedTokenProcessSandbox()).prepare(
            argv,
            sandbox=sandbox,
        )

    raise ProcessSandboxUnavailable(
        f"Process sandbox is unavailable on platform: {effective_platform}"
    )


def process_sandbox_backend_profile(
    sandbox: SandboxProfile | None,
    *,
    platform: str | None = None,
) -> ShellBackendProfile:
    if sandbox is None or sandbox.mode is SandboxMode.DANGER_FULL_ACCESS:
        return ShellBackendProfile()
    effective_platform = platform or sys.platform
    if effective_platform == "darwin":
        available = _is_executable(MACOS_SEATBELT_EXECUTABLE)
        return ShellBackendProfile(
            available=available,
            isolation="macos_seatbelt" if available else "sandbox_unavailable",
        )
    if effective_platform.startswith("linux"):
        available = _find_bubblewrap_executable() is not None
        return ShellBackendProfile(
            available=available,
            isolation="linux_bubblewrap" if available else "sandbox_unavailable",
        )
    if effective_platform == "win32":
        available, _error = _windows_sandbox_helper_status(
            _packaged_windows_sandbox_helper()
        )
        return ShellBackendProfile(
            available=available,
            isolation=(
                "windows_restricted_token" if available else "sandbox_unavailable"
            ),
        )
    return ShellBackendProfile(
        available=False,
        isolation="sandbox_unavailable",
    )


def _seatbelt_profile(
    sandbox: SandboxProfile,
) -> tuple[str, tuple[tuple[str, str], ...]]:
    sections = [
        "(version 1)",
        "(deny default)",
        "(allow process-exec)",
        "(allow process-fork)",
        "(allow signal (target same-sandbox))",
        "(allow process-info* (target same-sandbox))",
        "(allow file-read*)",
        "(allow file-write-data (literal \"/dev/null\"))",
        "(allow file-read* file-write* file-ioctl (literal \"/dev/ptmx\"))",
        (
            "(allow file-read* file-write* file-ioctl "
            "(regex #\"^/dev/ttys[0-9]+\"))"
        ),
        "(allow pseudo-tty)",
        "(allow sysctl-read)",
        "(allow mach-lookup)",
        "(allow ipc-posix*)",
        "(allow user-preference-read)",
    ]
    definitions: list[tuple[str, str]] = []

    for index, root in enumerate(sandbox.writable_roots):
        key = f"WRITABLE_ROOT_{index}"
        definitions.append((key, str(root.resolve())))
        sections.append(f'(allow file-write* (subpath (param "{key}")))')

    protected_index = 0
    for root in sandbox.writable_roots:
        resolved_root = root.resolve()
        for name in PROTECTED_METADATA_NAMES:
            key = f"PROTECTED_WRITE_ROOT_{protected_index}"
            protected_index += 1
            definitions.append((key, str(resolved_root / name)))
            sections.append(f'(deny file-write* (literal (param "{key}")))')
            sections.append(f'(deny file-write* (subpath (param "{key}")))')

    for index, root in enumerate(sandbox.denied_read_roots):
        key = f"DENIED_READ_ROOT_{index}"
        definitions.append((key, str(root.resolve())))
        sections.append(f'(deny file-read* (literal (param "{key}")))')
        sections.append(f'(deny file-read* (subpath (param "{key}")))')

    for pattern in sandbox.denied_read_globs:
        regex = _seatbelt_regex_for_glob(pattern)
        if regex is None:
            continue
        escaped = regex.replace('"', '\\"')
        sections.append(f'(deny file-read* (regex #"{escaped}"))')
        sections.append(f'(deny file-write-unlink (regex #"{escaped}"))')

    if sandbox.network == "enabled":
        sections.extend(
            (
                "(allow network-outbound)",
                "(allow network-inbound)",
                "(allow system-socket)",
            )
        )

    return "\n".join(sections), tuple(definitions)


def _seatbelt_regex_for_glob(pattern: str) -> str | None:
    normalized = pattern.strip().replace("\\", "/")
    if not normalized:
        return None

    absolute = normalized.startswith("/")
    regex = "^" if absolute else "^/(.*/)?"
    chars = deque(normalized.lstrip("/") if absolute else normalized)
    saw_glob = False

    while chars:
        char = chars.popleft()
        if char == "*":
            saw_glob = True
            if chars and chars[0] == "*":
                chars.popleft()
                if chars and chars[0] == "/":
                    chars.popleft()
                    regex += "(.*/)?"
                else:
                    regex += ".*"
            else:
                regex += "[^/]*"
        elif char == "?":
            saw_glob = True
            regex += "[^/]"
        elif char == "[":
            character_class: list[str] = []
            while chars and chars[0] != "]":
                character_class.append(chars.popleft())
            if not chars:
                regex += r"\[" + "".join(re.escape(item) for item in character_class)
                continue
            chars.popleft()
            saw_glob = True
            regex += "["
            if character_class and character_class[0] == "!":
                regex += "^"
                character_class.pop(0)
            elif character_class and character_class[0] == "^":
                regex += r"\^"
                character_class.pop(0)
            regex += "".join(
                r"\\" if item == "\\" else item
                for item in character_class
            )
            regex += "]"
        else:
            regex += re.escape(char)

    if not saw_glob:
        regex += "(/.*)?"
    return regex + "$"


def _existing_denied_read_paths(sandbox: SandboxProfile) -> tuple[Path, ...]:
    paths: set[Path] = set()
    writable_roots = tuple(root.resolve() for root in sandbox.writable_roots)
    for root in sandbox.denied_read_roots:
        absolute_root = root if root.is_absolute() else sandbox.cwd / root
        _reject_writable_symlink_path(absolute_root, writable_roots)
        if absolute_root.exists():
            paths.add(absolute_root.resolve())
    for pattern in sandbox.denied_read_globs:
        normalized = pattern.strip()
        if not normalized:
            continue
        absolute_pattern = Path(normalized)
        if not absolute_pattern.is_absolute():
            absolute_pattern = sandbox.cwd / absolute_pattern
        for match in glob.iglob(
            str(absolute_pattern),
            recursive=True,
            include_hidden=True,
        ):
            path = Path(match)
            _reject_writable_symlink_path(path, writable_roots)
            if path.exists():
                paths.add(path.resolve())
                if len(paths) > MAX_DENIED_GLOB_MATCHES:
                    raise ProcessSandboxUnavailable(
                        "Linux sandbox denied-read glob expansion matched "
                        f"more than {MAX_DENIED_GLOB_MATCHES} paths"
                    )

    ordered = sorted(paths, key=lambda path: (len(path.parts), str(path)))
    masks: list[Path] = []
    for path in ordered:
        if any(path == parent or path.is_relative_to(parent) for parent in masks):
            continue
        masks.append(path)
    return tuple(masks)


def _existing_protected_write_paths(sandbox: SandboxProfile) -> tuple[Path, ...]:
    protected: set[Path] = set()
    for root in sandbox.writable_roots:
        resolved_root = root.resolve()
        for name in PROTECTED_METADATA_NAMES:
            path = resolved_root / name
            if path.is_symlink():
                raise ProcessSandboxUnavailable(
                    "Linux sandbox cannot protect writable metadata through symlink: "
                    f"{path}"
                )
            if path.exists():
                protected.add(path)
    return tuple(sorted(protected, key=str))


def _reject_writable_symlink_path(path: Path, writable_roots: tuple[Path, ...]) -> None:
    absolute_path = path.absolute()
    for root in writable_roots:
        try:
            relative = absolute_path.relative_to(root)
        except ValueError:
            continue
        current = root
        for part in relative.parts:
            current /= part
            if current.is_symlink():
                raise ProcessSandboxUnavailable(
                    "Linux sandbox cannot enforce a denied-read path that crosses "
                    f"writable symlink: {current}"
                )


def _find_bubblewrap_executable() -> Path | None:
    return next(
        (path for path in LINUX_BUBBLEWRAP_EXECUTABLES if _is_executable(path)),
        None,
    )


def _packaged_windows_sandbox_helper() -> Path:
    return Path(__file__).resolve().parents[1] / "native" / "windows" / WINDOWS_SANDBOX_HELPER_NAME


def _windows_sandbox_helper_status(executable: Path) -> tuple[bool, str | None]:
    if not executable.is_file():
        return False, f"Windows sandbox helper is unavailable: {executable}"
    try:
        completed = subprocess.run(
            [str(executable), "--handshake"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=WINDOWS_SANDBOX_HANDSHAKE_TIMEOUT_SECONDS,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        return False, f"Windows sandbox helper handshake failed: {exc.__class__.__name__}"
    if completed.returncode != 0:
        return False, "Windows sandbox helper handshake failed"
    if len(completed.stdout) > WINDOWS_SANDBOX_HANDSHAKE_MAX_CHARS:
        return False, "Windows sandbox helper handshake response is too large"
    try:
        response = json.loads(completed.stdout)
    except (json.JSONDecodeError, TypeError):
        return False, "Windows sandbox helper handshake returned invalid JSON"
    if not isinstance(response, dict):
        return False, "Windows sandbox helper handshake returned an invalid response"
    received_version = response.get("protocol_version")
    if received_version != WINDOWS_SANDBOX_PROTOCOL_VERSION:
        return (
            False,
            "Windows sandbox helper protocol mismatch: "
            f"expected {WINDOWS_SANDBOX_PROTOCOL_VERSION}, received {received_version!r}",
        )
    if response.get("name") != "mycli-windows-sandbox":
        return False, "Windows sandbox helper identity mismatch"
    if response.get("setup_complete") is False:
        return False, WINDOWS_SANDBOX_SETUP_REQUIRED
    if response.get("sandbox_ready") is not True:
        return False, "Windows sandbox helper is not ready to enforce restricted-token isolation"
    return True, None


def _setup_windows_sandbox_helper(executable: Path) -> tuple[bool, str | None]:
    try:
        completed = subprocess.run(
            [str(executable), "--ensure-setup"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=WINDOWS_SANDBOX_SETUP_TIMEOUT_SECONDS,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        return False, f"Windows sandbox setup failed: {exc.__class__.__name__}"
    if completed.returncode != 0:
        return False, "Windows sandbox setup was cancelled or failed"
    return True, None


def _windows_sandbox_request(
    argv: tuple[str, ...],
    *,
    sandbox: SandboxProfile,
) -> dict[str, object]:
    cwd = sandbox.cwd.resolve()
    return {
        "protocol_version": WINDOWS_SANDBOX_PROTOCOL_VERSION,
        "command": {"argv": list(argv)},
        "cwd": str(cwd),
        "workspace_roots": [str(root.resolve()) for root in sandbox.workspace_roots],
        "writable_roots": [str(root.resolve()) for root in sandbox.writable_roots],
        "denied_read_roots": [
            str((root if root.is_absolute() else cwd / root).resolve())
            for root in sandbox.denied_read_roots
        ],
        "denied_read_globs": list(sandbox.denied_read_globs),
        "filesystem": sandbox.filesystem,
        "network": sandbox.network,
        "mode": sandbox.mode.value,
    }


def _is_executable(path: Path) -> bool:
    return path.is_file() and path.stat().st_mode & 0o111 != 0


__all__ = [
    "LinuxBubblewrapProcessSandbox",
    "MacOSSeatbeltProcessSandbox",
    "ProcessSandboxUnavailable",
    "SandboxedProcessLaunch",
    "WINDOWS_SANDBOX_PROTOCOL_VERSION",
    "WindowsRestrictedTokenProcessSandbox",
    "prepare_sandboxed_argv",
    "process_sandbox_backend_profile",
]
