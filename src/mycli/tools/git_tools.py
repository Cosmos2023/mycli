from __future__ import annotations

import os
from pathlib import Path
import subprocess
from typing import Any

from mycli.domain.runtime import SandboxProfile
from mycli.domain.tooling.calls import ToolCall
from mycli.tools.base import ToolEffectProfile, ToolParameter, ToolResult, ToolSpec
from mycli.tools.model_output import git_model_output
from mycli.tools.path_utils import classify_filesystem_error, resolve_workspace_path
from mycli.tools.process_sandbox import (
    ProcessSandboxUnavailable,
    prepare_sandboxed_argv,
)


TEXT_LIMIT = 12_000
TEXT_HEAD_CHARS = 7_000
TEXT_TAIL_CHARS = 5_000
DEFAULT_LOG_LIMIT = 10
MAX_LOG_LIMIT = 50


class GitStatusTool:
    name = "GitStatus"
    spec = ToolSpec(
        name="GitStatus",
        description="Inspect the current git branch and dirty worktree status without mutating the repository.",
        parameters=(),
        risk_level="low",
        supports_parallel_tool_calls=True,
        model_output_adapter=git_model_output,
    )

    def __init__(self, workspace_root: Path) -> None:
        self._workspace_root = workspace_root

    def effect_profile(self) -> ToolEffectProfile:
        return ToolEffectProfile(filesystem="read", process=True)

    def execute(self, arguments: dict[str, Any]) -> ToolResult:
        result = _run_git(
            self._workspace_root,
            ["status", "--short", "--branch"],
            sandbox=_sandbox_profile(arguments),
        )
        if not result["success"]:
            return _failure("Failed to read git status", result)
        stdout = str(result["stdout"])
        header, entries = _parse_status(stdout)
        payload = {
            **result,
            "branch": header.get("branch"),
            "upstream": header.get("upstream"),
            "ahead": header.get("ahead", 0),
            "behind": header.get("behind", 0),
            "dirty": bool(entries),
            "entries": entries,
            "entry_count": len(entries),
        }
        branch = payload["branch"] or "unknown"
        dirty_text = f"{len(entries)} changed path(s)" if entries else "clean"
        return ToolResult(
            success=True,
            summary=f"Git status on {branch}: {dirty_text}",
            raw_payload=payload,
        )

    def run(self, call: ToolCall) -> ToolResult:
        return self.execute(call.arguments)


class GitDiffTool:
    name = "GitDiff"
    spec = ToolSpec(
        name="GitDiff",
        description="Show a bounded git diff and stat for the workspace. Read-only; supports staged and path filters.",
        parameters=(
            ToolParameter(name="path", type="string", required=False),
            ToolParameter(name="staged", type="boolean", required=False),
            ToolParameter(name="context_lines", type="integer", required=False),
        ),
        risk_level="low",
        supports_parallel_tool_calls=True,
        model_output_adapter=git_model_output,
    )

    def __init__(self, workspace_root: Path) -> None:
        self._workspace_root = workspace_root

    def effect_profile(self) -> ToolEffectProfile:
        return ToolEffectProfile(filesystem="read", process=True)

    def execute(self, arguments: dict[str, Any]) -> ToolResult:
        sandbox = _sandbox_profile(arguments)
        path_result = _pathspec(self._workspace_root, arguments.get("path"))
        if isinstance(path_result, ToolResult):
            return path_result
        context_lines = _bounded_int(arguments.get("context_lines"), default=3, minimum=0, maximum=20)
        base_args = ["diff", f"--unified={context_lines}"]
        if arguments.get("staged") is True:
            base_args.append("--cached")
        if path_result is not None:
            base_args.extend(["--", path_result])
        diff_result = _run_git(self._workspace_root, base_args, sandbox=sandbox)
        if not diff_result["success"]:
            return _failure("Failed to read git diff", diff_result)

        stat_args = ["diff", "--stat"]
        shortstat_args = ["diff", "--shortstat"]
        if arguments.get("staged") is True:
            stat_args.append("--cached")
            shortstat_args.append("--cached")
        if path_result is not None:
            stat_args.extend(["--", path_result])
            shortstat_args.extend(["--", path_result])
        stat_result = _run_git(self._workspace_root, stat_args, sandbox=sandbox)
        shortstat_result = _run_git(
            self._workspace_root,
            shortstat_args,
            sandbox=sandbox,
        )

        diff_text, diff_meta = _bounded_text(str(diff_result["stdout"]))
        payload = {
            **diff_result,
            "diff": diff_text,
            "stat": str(stat_result.get("stdout", "")),
            "shortstat": str(shortstat_result.get("stdout", "")),
            "path": path_result,
            "staged": arguments.get("staged") is True,
            "truncated": diff_meta["truncated"],
            "diff_chars": diff_meta["original_chars"],
            "truncated_chars": diff_meta["truncated_chars"],
        }
        changed = bool(payload["diff"] or payload["stat"])
        target = path_result or "workspace"
        return ToolResult(
            success=True,
            summary=f"Git diff for {target}: {'changes found' if changed else 'no changes'}",
            raw_payload=payload,
        )

    def run(self, call: ToolCall) -> ToolResult:
        return self.execute(call.arguments)


class GitLogTool:
    name = "GitLog"
    spec = ToolSpec(
        name="GitLog",
        description="List recent git commits as structured metadata.",
        parameters=(
            ToolParameter(name="limit", type="integer", required=False),
            ToolParameter(name="ref", type="string", required=False),
        ),
        risk_level="low",
        supports_parallel_tool_calls=True,
        model_output_adapter=git_model_output,
    )

    def __init__(self, workspace_root: Path) -> None:
        self._workspace_root = workspace_root

    def effect_profile(self) -> ToolEffectProfile:
        return ToolEffectProfile(filesystem="read", process=True)

    def execute(self, arguments: dict[str, Any]) -> ToolResult:
        sandbox = _sandbox_profile(arguments)
        limit = _bounded_int(arguments.get("limit"), default=DEFAULT_LOG_LIMIT, minimum=1, maximum=MAX_LOG_LIMIT)
        ref = arguments.get("ref")
        args = [
            "log",
            f"--max-count={limit}",
            "--date=iso-strict",
            "--format=%H%x1f%h%x1f%an%x1f%ad%x1f%s",
        ]
        if isinstance(ref, str) and ref:
            args.append(ref)
        result = _run_git(self._workspace_root, args, sandbox=sandbox)
        if not result["success"]:
            return _failure("Failed to read git log", result)
        commits = _parse_log(str(result["stdout"]))
        return ToolResult(
            success=True,
            summary=f"Read {len(commits)} git commit(s)",
            raw_payload={**result, "commits": commits, "limit": limit, "ref": ref},
        )

    def run(self, call: ToolCall) -> ToolResult:
        return self.execute(call.arguments)


class GitShowTool:
    name = "GitShow"
    spec = ToolSpec(
        name="GitShow",
        description="Show bounded metadata and optional patch for a git revision. Read-only.",
        parameters=(
            ToolParameter(name="ref", type="string", required=False),
            ToolParameter(name="path", type="string", required=False),
            ToolParameter(name="include_diff", type="boolean", required=False),
        ),
        risk_level="low",
        supports_parallel_tool_calls=True,
        model_output_adapter=git_model_output,
    )

    def __init__(self, workspace_root: Path) -> None:
        self._workspace_root = workspace_root

    def effect_profile(self) -> ToolEffectProfile:
        return ToolEffectProfile(filesystem="read", process=True)

    def execute(self, arguments: dict[str, Any]) -> ToolResult:
        sandbox = _sandbox_profile(arguments)
        ref = arguments.get("ref")
        ref_text = ref if isinstance(ref, str) and ref else "HEAD"
        path_result = _pathspec(self._workspace_root, arguments.get("path"))
        if isinstance(path_result, ToolResult):
            return path_result
        include_diff = arguments.get("include_diff") is True
        args = [
            "show",
            "--date=iso-strict",
            "--format=%H%x1f%h%x1f%an%x1f%ad%x1f%s%n%B",
        ]
        if not include_diff:
            args.append("--no-patch")
        args.append(ref_text)
        if path_result is not None:
            args.extend(["--", path_result])
        result = _run_git(self._workspace_root, args, sandbox=sandbox)
        if not result["success"]:
            return _failure("Failed to show git revision", result)
        output, meta = _bounded_text(str(result["stdout"]))
        metadata = _parse_show_metadata(output)
        return ToolResult(
            success=True,
            summary=f"Git show {ref_text}",
            raw_payload={
                **result,
                "ref": ref_text,
                "path": path_result,
                "include_diff": include_diff,
                "content": output,
                "metadata": metadata,
                "truncated": meta["truncated"],
                "content_chars": meta["original_chars"],
                "truncated_chars": meta["truncated_chars"],
            },
        )

    def run(self, call: ToolCall) -> ToolResult:
        return self.execute(call.arguments)


def _run_git(
    workspace_root: Path,
    args: list[str],
    *,
    sandbox: SandboxProfile | None = None,
) -> dict[str, object]:
    command = ["git", "-C", str(workspace_root), *args]
    try:
        launch = prepare_sandboxed_argv(tuple(command), sandbox=sandbox)
        result = subprocess.run(
            list(launch.argv),
            capture_output=True,
            text=True,
            timeout=30,
            env={**os.environ, "GIT_OPTIONAL_LOCKS": "0"},
            check=False,
        )
    except FileNotFoundError as exc:
        return {
            "success": False,
            "error": str(exc),
            "error_kind": "git_unavailable",
            "command": _command_preview(args),
        }
    except subprocess.TimeoutExpired:
        return {
            "success": False,
            "error": "git command timed out after 30s",
            "error_kind": "timeout",
            "command": _command_preview(args),
        }
    except ProcessSandboxUnavailable as exc:
        return {
            "success": False,
            "error": str(exc),
            "error_kind": "sandbox_unavailable",
            "command": _command_preview(args),
        }

    error_kind = _git_error_kind(result.stderr)
    return {
        "success": result.returncode == 0,
        "exit_code": result.returncode,
        "stdout": result.stdout,
        "stderr": result.stderr,
        "error": result.stderr.strip(),
        "error_kind": error_kind,
        "command": _command_preview(args),
    }


def _failure(summary: str, payload: dict[str, object]) -> ToolResult:
    return ToolResult(
        success=False,
        summary=summary,
        error=str(payload.get("error") or summary),
        raw_payload=payload,
    )


def _sandbox_profile(arguments: dict[str, Any]) -> SandboxProfile | None:
    value = arguments.get("_runtime_sandbox_profile")
    return value if isinstance(value, SandboxProfile) else None


def _pathspec(workspace_root: Path, raw_path: object) -> str | ToolResult | None:
    if raw_path is None or raw_path == "":
        return None
    if not isinstance(raw_path, str):
        return ToolResult(
            success=False,
            summary="Invalid git path",
            error="Git path must be a string within the workspace.",
            raw_payload={"error_kind": "invalid_path"},
        )
    try:
        target = resolve_workspace_path(workspace_root, raw_path)
        return str(target.relative_to(workspace_root.resolve()))
    except Exception as exc:
        return ToolResult(
            success=False,
            summary="Invalid git path",
            error=str(exc),
            raw_payload={
                "path": raw_path,
                "error_kind": classify_filesystem_error(exc),
            },
        )


def _bounded_int(value: object, *, default: int, minimum: int, maximum: int) -> int:
    if not isinstance(value, int):
        return default
    return max(minimum, min(maximum, value))


def _bounded_text(value: str) -> tuple[str, dict[str, int | bool]]:
    if len(value) <= TEXT_LIMIT:
        return value, {
            "truncated": False,
            "original_chars": len(value),
            "truncated_chars": 0,
        }
    omitted = len(value) - TEXT_LIMIT
    return (
        f"{value[:TEXT_HEAD_CHARS]}\n"
        f"... [... chars omitted] ({omitted} chars) ...\n"
        f"{value[-TEXT_TAIL_CHARS:]}",
        {
            "truncated": True,
            "original_chars": len(value),
            "truncated_chars": omitted,
        },
    )


def _git_error_kind(stderr: str) -> str | None:
    lowered = stderr.lower()
    if "not a git repository" in lowered:
        return "not_git_repository"
    if "unknown revision" in lowered or "bad revision" in lowered:
        return "unknown_revision"
    if "pathspec" in lowered:
        return "pathspec_not_found"
    return "git_failed" if stderr else None


def _command_preview(args: list[str]) -> str:
    return "git " + " ".join(args[:8])


def _parse_status(stdout: str) -> tuple[dict[str, object], list[dict[str, str]]]:
    lines = [line for line in stdout.splitlines() if line]
    header: dict[str, object] = {"branch": None, "upstream": None, "ahead": 0, "behind": 0}
    entries: list[dict[str, str]] = []
    for line in lines:
        if line.startswith("## "):
            header.update(_parse_status_header(line[3:]))
            continue
        status = line[:2]
        path = line[3:] if len(line) > 3 else ""
        entries.append({"status": status, "path": path})
    return header, entries


def _parse_status_header(value: str) -> dict[str, object]:
    branch, _separator, tracking = value.partition("...")
    payload: dict[str, object] = {
        "branch": branch,
        "upstream": None,
        "ahead": 0,
        "behind": 0,
    }
    if tracking:
        upstream, _sep, details = tracking.partition(" [")
        payload["upstream"] = upstream
        details = details.rstrip("]")
        for item in details.split(", "):
            if item.startswith("ahead "):
                payload["ahead"] = _parse_int(item.removeprefix("ahead "))
            if item.startswith("behind "):
                payload["behind"] = _parse_int(item.removeprefix("behind "))
    return payload


def _parse_log(stdout: str) -> list[dict[str, str]]:
    commits: list[dict[str, str]] = []
    for line in stdout.splitlines():
        parts = line.split("\x1f", 4)
        if len(parts) != 5:
            continue
        commits.append(
            {
                "hash": parts[0],
                "short_hash": parts[1],
                "author": parts[2],
                "date": parts[3],
                "subject": parts[4],
            }
        )
    return commits


def _parse_show_metadata(output: str) -> dict[str, str]:
    first_line, _separator, body = output.partition("\n")
    parts = first_line.split("\x1f", 4)
    if len(parts) != 5:
        return {}
    return {
        "hash": parts[0],
        "short_hash": parts[1],
        "author": parts[2],
        "date": parts[3],
        "subject": parts[4],
        "body_preview": body[:1000].strip(),
    }


def _parse_int(value: str) -> int:
    try:
        return int(value)
    except ValueError:
        return 0
