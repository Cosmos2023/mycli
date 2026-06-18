from __future__ import annotations

from dataclasses import dataclass
import hashlib
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
from mycli.services.hooks.types import HookPoint

MAX_HOOK_OUTPUT_CHARS = 2000
MAX_HOOK_MESSAGE_CHARS = 200
MAX_MODIFIED_ARGS = 20

_SAFE_ENV_KEYS = ("HOME", "PATH", "SHELL", "TMPDIR", "USER")
_MINIMAL_PATH = "/usr/bin:/bin:/usr/sbin:/sbin"


@dataclass(slots=True, frozen=True)
class ConfiguredHookRunSummary:
    execution_id: str
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
            "execution_id": self.execution_id,
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
        source = ctx.metadata.get("source")
        if not self.spec.enabled or not self.spec.matches(
            tool_name=ctx.tool_name,
            source=str(source) if isinstance(source, str) else None,
        ):
            return HookResult(action=HookAction.ALLOW)
        started_at = float(self.monotonic())
        allowlist_status = (
            self.allowlist_status(self.spec)
            if self.allowlist_status is not None
            else HookAllowlistStatus(allowed=True, reason="not_configured", digest="")
        )
        if not allowlist_status.allowed:
            summary = ConfiguredHookRunSummary(
                execution_id=_execution_id(self.spec, ctx),
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
                execution_id=_execution_id(self.spec, ctx),
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
                execution_id=_execution_id(self.spec, ctx),
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
            execution_id=_execution_id(self.spec, ctx),
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
    execution_id: str,
    stdout: str,
    stderr: str,
    exit_code: int,
    duration_ms: int,
) -> tuple[HookResult, ConfiguredHookRunSummary]:
    if exit_code == 2 and spec.hook_point in _BLOCKING_EXIT_CODE_HOOK_POINTS:
        message = _safe_message(stderr or stdout or "blocked by configured hook")
        summary = ConfiguredHookRunSummary(
            execution_id=execution_id,
            hook_id=spec.hook_id,
            hook_name=spec.name,
            hook_point=spec.hook_point.value,
            status="ok",
            action=HookAction.DENY.value,
            duration_ms=duration_ms,
            exit_code=exit_code,
            stdout_chars=len(stdout),
            stderr_chars=len(stderr),
            message=message,
        )
        return HookResult(action=HookAction.DENY, message=message), summary
    if exit_code != 0:
        summary = ConfiguredHookRunSummary(
            execution_id=execution_id,
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
    stripped_stdout = stdout.strip()
    try:
        payload = json.loads(stripped_stdout) if stripped_stdout else {}
    except json.JSONDecodeError:
        if (
            spec.hook_point in _PLAIN_TEXT_ADDITIONAL_CONTEXT_HOOK_POINTS
            and not _looks_like_json(stripped_stdout)
        ):
            context = _safe_context(stripped_stdout)
            summary = ConfiguredHookRunSummary(
                execution_id=execution_id,
                hook_id=spec.hook_id,
                hook_name=spec.name,
                hook_point=spec.hook_point.value,
                status="ok",
                action=HookAction.ALLOW.value,
                duration_ms=duration_ms,
                exit_code=exit_code,
                stdout_chars=len(stdout),
                stderr_chars=len(stderr),
            )
            return (
                HookResult(
                    action=HookAction.ALLOW,
                    additional_contexts=(context,) if context else (),
                ),
                summary,
            )
        summary = ConfiguredHookRunSummary(
            execution_id=execution_id,
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
        return _invalid_action_result(
            spec=spec,
            execution_id=execution_id,
            duration_ms=duration_ms,
            stdout=stdout,
            stderr=stderr,
        )
    hook_specific = payload.get("hookSpecificOutput")
    codex_permission_deny = (
        isinstance(hook_specific, dict)
        and hook_specific.get("permissionDecision") == "deny"
    )
    codex_block = (
        payload.get("decision") == "block"
        or payload.get("continue") is False
        or codex_permission_deny
    )
    if codex_block:
        action = HookAction.DENY
    else:
        raw_action = payload.get("action", HookAction.ALLOW.value)
        try:
            action = HookAction(str(raw_action))
        except ValueError:
            return _invalid_action_result(
                spec=spec,
                execution_id=execution_id,
                duration_ms=duration_ms,
                stdout=stdout,
                stderr=stderr,
            )
    message = str(
        payload.get("message")
        or payload.get("reason")
        or payload.get("stopReason")
        or (
            hook_specific.get("permissionDecisionReason")
            if isinstance(hook_specific, dict)
            else None
        )
        or ""
    )
    modified_args = _modified_args(payload.get("modified_args")) if action is HookAction.MODIFY else None
    additional_contexts = _additional_contexts(payload.get("additional_contexts"))
    additional_contexts = (
        *additional_contexts,
        *_codex_additional_contexts(hook_specific, hook_point=spec.hook_point),
    )
    summary = ConfiguredHookRunSummary(
        execution_id=execution_id,
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
    return (
        HookResult(
            action=action,
            message=_safe_message(message),
            modified_args=modified_args,
            additional_contexts=additional_contexts,
        ),
        summary,
    )


def _invalid_action_result(
    *,
    spec: ConfiguredHookSpec,
    execution_id: str,
    duration_ms: int,
    stdout: str,
    stderr: str,
) -> tuple[HookResult, ConfiguredHookRunSummary]:
    summary = ConfiguredHookRunSummary(
        execution_id=execution_id,
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


def _additional_contexts(value: object) -> tuple[str, ...]:
    if isinstance(value, str):
        normalized = _safe_context(value)
        return (normalized,) if normalized else ()
    if not isinstance(value, list):
        return ()
    contexts: list[str] = []
    for item in value:
        if not isinstance(item, str):
            continue
        normalized = _safe_context(item)
        if normalized:
            contexts.append(normalized)
    return tuple(contexts)


_BLOCKING_EXIT_CODE_HOOK_POINTS = frozenset(
    {
        HookPoint.PRE_TOOL_USE,
        HookPoint.POST_TOOL_USE,
        HookPoint.USER_PROMPT_SUBMIT,
        HookPoint.STOP,
    }
)
_PLAIN_TEXT_ADDITIONAL_CONTEXT_HOOK_POINTS = frozenset(
    {
        HookPoint.SESSION_START,
        HookPoint.USER_PROMPT_SUBMIT,
    }
)


def _codex_additional_contexts(value: object, *, hook_point: HookPoint) -> tuple[str, ...]:
    if hook_point not in _ADDITIONAL_CONTEXT_HOOK_POINTS:
        return ()
    if not isinstance(value, dict):
        return ()
    return _additional_contexts(value.get("additionalContext"))


_ADDITIONAL_CONTEXT_HOOK_POINTS = frozenset(
    {
        HookPoint.POST_TOOL_USE,
        HookPoint.SESSION_START,
        HookPoint.USER_PROMPT_SUBMIT,
    }
)


def _hook_payload(ctx: HookContext) -> dict[str, object]:
    metadata_keys = sorted(str(key) for key in ctx.metadata)
    payload: dict[str, object] = {
        "hook_event_name": _codex_event_name(ctx.hook_point),
        "hook_point": ctx.hook_point.value,
        "tool_name": ctx.tool_name,
        "session_id": ctx.session_id,
        "metadata_keys": metadata_keys,
    }
    if ctx.tool_name is not None:
        payload["tool_input"] = dict(ctx.tool_args or {})
    prompt = ctx.metadata.get("prompt")
    if isinstance(prompt, str):
        payload["prompt"] = prompt
    source = ctx.metadata.get("source")
    if isinstance(source, str):
        payload["source"] = source
    return payload


def _codex_event_name(hook_point: HookPoint) -> str:
    return {
        HookPoint.PRE_TOOL_USE: "PreToolUse",
        HookPoint.POST_TOOL_USE: "PostToolUse",
        HookPoint.SESSION_START: "SessionStart",
        HookPoint.USER_PROMPT_SUBMIT: "UserPromptSubmit",
        HookPoint.STOP: "Stop",
    }.get(hook_point, hook_point.value)


def _execution_id(spec: ConfiguredHookSpec, ctx: HookContext) -> str:
    parts = (
        spec.source.value,
        spec.hook_id,
        spec.hook_point.value,
        str(ctx.session_id or ""),
        str(ctx.metadata.get("turn_id") or ""),
        str(ctx.tool_name or ""),
    )
    digest = hashlib.sha256("\0".join(parts).encode("utf-8")).hexdigest()[:16]
    return f"hookexec_{digest}"


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


def _safe_context(message: str) -> str:
    normalized = message.strip()
    lowered = normalized.lower()
    if any(part in lowered for part in ("api_key", "apikey", "token", "secret", "password", "bearer ")):
        return "redacted"
    return normalized[:MAX_HOOK_OUTPUT_CHARS]


def _looks_like_json(value: str) -> bool:
    stripped = value.lstrip()
    return stripped.startswith("{") or stripped.startswith("[")


def _emit_trace(trace_sink: Any | None, ctx: HookContext, summary: ConfiguredHookRunSummary) -> None:
    if trace_sink is None:
        return
    trace_sink(ctx, summary)
