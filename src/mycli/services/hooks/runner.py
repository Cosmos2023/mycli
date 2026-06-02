from __future__ import annotations

from dataclasses import dataclass
import json
import os
from pathlib import Path
import subprocess
from typing import Any, Callable

from mycli.services.hooks.allowlist import HookAllowlistStatus
from mycli.services.hooks.config import (
    ConfiguredHookSpec,
    HookEnvPolicy,
    HookWorkingDirectory,
)
from mycli.services.hooks.types import HookAction, HookContext, HookResult

MAX_HOOK_OUTPUT_CHARS = 2000
MAX_HOOK_MESSAGE_CHARS = 200
MAX_MODIFIED_ARGS = 20

_SAFE_ENV_KEYS = ("HOME", "PATH", "SHELL", "TMPDIR", "USER")
_MINIMAL_PATH = "/usr/bin:/bin:/usr/sbin:/sbin"


@dataclass(slots=True, frozen=True)
class ConfiguredHookRunSummary:
    hook_id: str
    hook_name: str
    hook_point: str
    status: str
    action: str | None
    duration_ms: int
    exit_code: int | None = None
    stdout_chars: int = 0
    stderr_chars: int = 0
    message: str = ""

    def safe_payload(self) -> dict[str, object]:
        payload: dict[str, object] = {
            "hook_id": self.hook_id,
            "hook_name": self.hook_name,
            "hook_point": self.hook_point,
            "status": self.status,
            "duration_ms": self.duration_ms,
            "stdout_chars": self.stdout_chars,
            "stderr_chars": self.stderr_chars,
        }
        if self.action is not None:
            payload["action"] = self.action
        if self.exit_code is not None:
            payload["exit_code"] = self.exit_code
        if self.message:
            payload["message"] = _safe_message(self.message)
        return payload


@dataclass(slots=True)
class ConfiguredHookCallback:
    spec: ConfiguredHookSpec
    workspace_root: Path
    monotonic: Any
    trace_sink: Any | None = None
    allowlist_status: Callable[[ConfiguredHookSpec], HookAllowlistStatus] | None = None

    def __call__(self, ctx: HookContext) -> HookResult:
        if not self.spec.enabled or not self.spec.matches_tool(ctx.tool_name):
            return HookResult(action=HookAction.ALLOW)
        started_at = float(self.monotonic())
        allowlist_status = (
            self.allowlist_status(self.spec)
            if self.allowlist_status is not None
            else HookAllowlistStatus(allowed=True, reason="not_configured", digest="")
        )
        if not allowlist_status.allowed:
            summary = ConfiguredHookRunSummary(
                hook_id=self.spec.hook_id,
                hook_name=self.spec.name,
                hook_point=self.spec.hook_point.value,
                status="error",
                action=HookAction.ERROR.value,
                duration_ms=_duration_ms(self.monotonic, started_at),
                message=f"not allowlisted: {allowlist_status.reason}",
            )
            _emit_trace(self.trace_sink, ctx, summary)
            return HookResult(action=HookAction.ERROR, message="configured hook not allowlisted")
        try:
            completed = subprocess.run(
                list(self.spec.command),
                input=json.dumps(_hook_payload(ctx), ensure_ascii=False),
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                timeout=self.spec.timeout_seconds,
                cwd=str(_working_directory(self.spec, self.workspace_root)),
                env=_hook_env(self.spec),
                check=False,
            )
        except subprocess.TimeoutExpired:
            duration_ms = _duration_ms(self.monotonic, started_at)
            summary = ConfiguredHookRunSummary(
                hook_id=self.spec.hook_id,
                hook_name=self.spec.name,
                hook_point=self.spec.hook_point.value,
                status="error",
                action=HookAction.ERROR.value,
                duration_ms=duration_ms,
                message="timeout",
            )
            _emit_trace(self.trace_sink, ctx, summary)
            return HookResult(action=HookAction.ERROR, message="configured hook timed out")
        except OSError as exc:
            duration_ms = _duration_ms(self.monotonic, started_at)
            summary = ConfiguredHookRunSummary(
                hook_id=self.spec.hook_id,
                hook_name=self.spec.name,
                hook_point=self.spec.hook_point.value,
                status="error",
                action=HookAction.ERROR.value,
                duration_ms=duration_ms,
                message=exc.__class__.__name__,
            )
            _emit_trace(self.trace_sink, ctx, summary)
            return HookResult(action=HookAction.ERROR, message="configured hook failed")

        duration_ms = _duration_ms(self.monotonic, started_at)
        stdout = _bounded_text(completed.stdout)
        stderr = _bounded_text(completed.stderr)
        result, summary = _result_from_completed_process(
            spec=self.spec,
            stdout=stdout,
            stderr=stderr,
            exit_code=completed.returncode,
            duration_ms=duration_ms,
        )
        _emit_trace(self.trace_sink, ctx, summary)
        return result


def _result_from_completed_process(
    *,
    spec: ConfiguredHookSpec,
    stdout: str,
    stderr: str,
    exit_code: int,
    duration_ms: int,
) -> tuple[HookResult, ConfiguredHookRunSummary]:
    if exit_code != 0:
        summary = ConfiguredHookRunSummary(
            hook_id=spec.hook_id,
            hook_name=spec.name,
            hook_point=spec.hook_point.value,
            status="error",
            action=HookAction.ERROR.value,
            duration_ms=duration_ms,
            exit_code=exit_code,
            stdout_chars=len(stdout),
            stderr_chars=len(stderr),
            message=stderr or stdout or f"exit={exit_code}",
        )
        return HookResult(action=HookAction.ERROR, message="configured hook failed"), summary
    try:
        payload = json.loads(stdout) if stdout.strip() else {}
    except json.JSONDecodeError:
        summary = ConfiguredHookRunSummary(
            hook_id=spec.hook_id,
            hook_name=spec.name,
            hook_point=spec.hook_point.value,
            status="error",
            action=HookAction.ERROR.value,
            duration_ms=duration_ms,
            exit_code=exit_code,
            stdout_chars=len(stdout),
            stderr_chars=len(stderr),
            message="stdout was not JSON",
        )
        return HookResult(action=HookAction.ERROR, message="configured hook output invalid"), summary
    if not isinstance(payload, dict):
        return _invalid_action_result(spec=spec, duration_ms=duration_ms, stdout=stdout, stderr=stderr)
    raw_action = payload.get("action", HookAction.ALLOW.value)
    try:
        action = HookAction(str(raw_action))
    except ValueError:
        return _invalid_action_result(spec=spec, duration_ms=duration_ms, stdout=stdout, stderr=stderr)
    message = str(payload.get("message") or "")
    modified_args = _modified_args(payload.get("modified_args")) if action is HookAction.MODIFY else None
    summary = ConfiguredHookRunSummary(
        hook_id=spec.hook_id,
        hook_name=spec.name,
        hook_point=spec.hook_point.value,
        status="ok",
        action=action.value,
        duration_ms=duration_ms,
        exit_code=exit_code,
        stdout_chars=len(stdout),
        stderr_chars=len(stderr),
        message=message,
    )
    return HookResult(action=action, message=_safe_message(message), modified_args=modified_args), summary


def _invalid_action_result(
    *,
    spec: ConfiguredHookSpec,
    duration_ms: int,
    stdout: str,
    stderr: str,
) -> tuple[HookResult, ConfiguredHookRunSummary]:
    summary = ConfiguredHookRunSummary(
        hook_id=spec.hook_id,
        hook_name=spec.name,
        hook_point=spec.hook_point.value,
        status="error",
        action=HookAction.ERROR.value,
        duration_ms=duration_ms,
        exit_code=0,
        stdout_chars=len(stdout),
        stderr_chars=len(stderr),
        message="unsupported hook action",
    )
    return HookResult(action=HookAction.ERROR, message="configured hook output invalid"), summary


def _modified_args(value: object) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        return None
    modified: dict[str, Any] = {}
    for key, item in value.items():
        if not isinstance(key, str):
            continue
        if len(modified) >= MAX_MODIFIED_ARGS:
            break
        modified[key] = item
    return modified or None


def _hook_payload(ctx: HookContext) -> dict[str, object]:
    metadata_keys = sorted(str(key) for key in ctx.metadata)
    return {
        "hook_point": ctx.hook_point.value,
        "tool_name": ctx.tool_name,
        "session_id": ctx.session_id,
        "metadata_keys": metadata_keys,
    }


def _hook_env(spec: ConfiguredHookSpec) -> dict[str, str]:
    env = {
        "PATH": os.environ.get("PATH") or _MINIMAL_PATH,
        "MYCLI_HOOK_ID": spec.hook_id,
        "MYCLI_HOOK_POINT": spec.hook_point.value,
        "MYCLI_HOOK_SOURCE": spec.source.value,
    }
    if spec.env_policy is HookEnvPolicy.INHERIT_SAFE:
        for key in _SAFE_ENV_KEYS:
            value = os.environ.get(key)
            if value:
                env[key] = value
    return env


def _working_directory(spec: ConfiguredHookSpec, workspace_root: Path) -> Path:
    if spec.working_directory is HookWorkingDirectory.CONFIG and spec.source_path is not None:
        return spec.source_path.parent
    return workspace_root


def _duration_ms(monotonic: Any, started_at: float) -> int:
    return max(0, int(round((float(monotonic()) - started_at) * 1000)))


def _bounded_text(value: str | None) -> str:
    if not value:
        return ""
    return value[:MAX_HOOK_OUTPUT_CHARS]


def _safe_message(message: str) -> str:
    normalized = " ".join(message.split())
    lowered = normalized.lower()
    if any(part in lowered for part in ("api_key", "apikey", "token", "secret", "password", "bearer ")):
        return "redacted"
    return normalized[:MAX_HOOK_MESSAGE_CHARS]


def _emit_trace(trace_sink: Any | None, ctx: HookContext, summary: ConfiguredHookRunSummary) -> None:
    if trace_sink is None:
        return
    trace_sink(ctx, summary)
