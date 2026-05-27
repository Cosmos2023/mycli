from __future__ import annotations

from collections.abc import Callable, Mapping
from pathlib import Path
import os
import subprocess
from typing import Protocol


class CompletedProcessLike(Protocol):
    returncode: int
    stdout: str
    stderr: str


class NodeTuiProcessError(RuntimeError):
    pass


class NodeTuiProcess:
    def __init__(
        self,
        *,
        args: list[str],
        env: Mapping[str, str],
        cwd: Path,
    ) -> None:
        self._args = args
        self._env = dict(env)
        self._cwd = cwd
        self._process: subprocess.Popen[str] | None = None

    def start(self) -> None:
        self._process = subprocess.Popen(
            self._args,
            cwd=self._cwd,
            env=self._env,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=None,
            text=True,
            encoding="utf-8",
            bufsize=1,
        )

    def write_line(self, line: str) -> None:
        if self._process is None or self._process.stdin is None:
            raise NodeTuiProcessError("Node TUI process is not started.")
        self._process.stdin.write(line)
        self._process.stdin.flush()

    def read_line(self) -> str:
        if self._process is None or self._process.stdout is None:
            raise NodeTuiProcessError("Node TUI process is not started.")
        return self._process.stdout.readline()

    def wait(self) -> int:
        if self._process is None:
            return 1
        return self._process.wait()

    def terminate(self) -> None:
        if self._process is not None and self._process.poll() is None:
            self._process.terminate()


def check_node_version(
    *,
    runner: Callable[[list[str]], CompletedProcessLike] | None = None,
) -> str:
    run = runner or _run_node_version
    try:
        completed = run(["node", "--version"])
    except FileNotFoundError as exc:
        raise NodeTuiProcessError(
            "Node TUI requires Node.js >= 20. Use mycli --plain or install Node."
        ) from exc
    version = completed.stdout.strip()
    if completed.returncode != 0 or not version.startswith("v"):
        raise NodeTuiProcessError(
            "Node TUI requires Node.js >= 20. Use mycli --plain or install Node."
        )
    major = _parse_node_major(version)
    if major < 20:
        raise NodeTuiProcessError(
            "Node TUI requires Node.js >= 20. Use mycli --plain or install Node."
        )
    return version


def resolve_node_entrypoint(*, repo_root: Path, env: Mapping[str, str]) -> Path:
    override = env.get("MYCLI_NODE_TUI_ENTRYPOINT")
    if override:
        candidate = Path(override).expanduser()
    else:
        candidate = repo_root / "tui" / "node" / "src" / "index.js"
    if not candidate.is_file():
        raise NodeTuiProcessError(f"Node TUI entrypoint not found: {candidate}")
    return candidate


def build_node_command(*, repo_root: Path, env: Mapping[str, str]) -> list[str]:
    if env.get("MYCLI_NODE_TUI_SCRIPT"):
        return ["node", str(resolve_node_entrypoint(repo_root=repo_root, env=env))]
    override = env.get("MYCLI_NODE_TUI_ENTRYPOINT")
    if override:
        return ["node", str(Path(override).expanduser())]
    node_root = repo_root / "tui" / "node"
    tsx_bin = node_root / "node_modules" / ".bin" / "tsx"
    entrypoint = node_root / "src" / "index.tsx"
    if not tsx_bin.is_file():
        raise NodeTuiProcessError(
            "Node TUI dependencies are not installed. Run: npm --prefix tui/node install"
        )
    if not entrypoint.is_file():
        raise NodeTuiProcessError(f"Node TUI entrypoint not found: {entrypoint}")
    return [str(tsx_bin), str(entrypoint)]


def build_node_tui_process(
    *,
    repo_root: Path,
    env: Mapping[str, str],
) -> NodeTuiProcess:
    check_node_version()
    child_env = node_tui_child_env(base_env=os.environ, requested_env=env)
    return NodeTuiProcess(
        args=build_node_command(repo_root=repo_root, env=env),
        env=child_env,
        cwd=repo_root,
    )


def node_tui_child_env(
    *,
    base_env: Mapping[str, str],
    requested_env: Mapping[str, str],
) -> dict[str, str]:
    child_env = dict(base_env)
    child_env.update(requested_env)
    color_mode = child_env.get("MYCLI_TUI_COLOR", "auto").strip().lower()
    if color_mode in {"always", "force", "true", "1", "yes"}:
        child_env.pop("NO_COLOR", None)
        child_env["FORCE_COLOR"] = "3"
    elif color_mode in {"never", "none", "false", "0", "no"}:
        child_env.pop("FORCE_COLOR", None)
        child_env["NO_COLOR"] = "1"
    return child_env


def _run_node_version(command: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(command, check=False, capture_output=True, text=True)


def _parse_node_major(version: str) -> int:
    raw = version.removeprefix("v").split(".", maxsplit=1)[0]
    try:
        return int(raw)
    except ValueError:
        return 0
