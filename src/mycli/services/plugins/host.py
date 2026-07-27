from __future__ import annotations

from dataclasses import dataclass
import json
import os
from pathlib import Path
import subprocess
import sys
from typing import Any

from mycli.domain.runtime import SandboxProfile
from mycli.domain.tooling.calls import ToolEvidence, ToolResult
from mycli.domain.tooling.output import (
    ToolImageContent,
    ToolJsonContent,
    ToolModelOutput,
    ToolOutputBudgetClass,
    ToolOutputContent,
    ToolOutputTruncation,
    ToolTextContent,
)
from mycli.services.hooks import HookAction, HookResult
from mycli.services.plugins.commands import PluginCommandResult
from mycli.services.plugins.manifest import PluginCandidate
from mycli.tools.process_sandbox import (
    ProcessSandboxUnavailable,
    prepare_sandboxed_argv,
)


PLUGIN_HOST_TIMEOUT_SECONDS = 10
PLUGIN_HOST_OUTPUT_LIMIT = 1_000_000


class PluginHostError(RuntimeError):
    def __init__(self, error_type: str) -> None:
        self.error_type = error_type
        super().__init__(error_type)


@dataclass(frozen=True, slots=True)
class PluginRegistration:
    kind: str
    token: str
    name: str
    schema: dict[str, Any]
    metadata: dict[str, Any]
    hook_point: str | None = None


@dataclass(frozen=True, slots=True)
class PluginProcessHost:
    candidate: PluginCandidate
    workspace_root: Path
    env: dict[str, str]
    sandbox: SandboxProfile | None = None

    def describe(self) -> tuple[PluginRegistration, ...]:
        response = self._request({"action": "describe"})
        raw_registrations = response.get("registrations")
        if not isinstance(raw_registrations, list):
            raise PluginHostError("InvalidPluginHostResponse")
        registrations: list[PluginRegistration] = []
        for item in raw_registrations:
            if not isinstance(item, dict):
                raise PluginHostError("InvalidPluginHostResponse")
            kind = item.get("kind")
            token = item.get("token")
            name = item.get("name")
            if not isinstance(kind, str) or not kind:
                raise PluginHostError("InvalidPluginHostResponse")
            if not isinstance(token, str) or not token:
                raise PluginHostError("InvalidPluginHostResponse")
            if not isinstance(name, str) or not name:
                raise PluginHostError("InvalidPluginHostResponse")
            schema = item.get("schema")
            metadata = item.get("metadata")
            hook_point = item.get("hook_point")
            registrations.append(
                PluginRegistration(
                    kind=kind,
                    token=token,
                    name=name,
                    schema=dict(schema) if isinstance(schema, dict) else {},
                    metadata=dict(metadata) if isinstance(metadata, dict) else {},
                    hook_point=hook_point if isinstance(hook_point, str) else None,
                )
            )
        return tuple(registrations)

    def invoke(self, token: str, payload: dict[str, Any]) -> object:
        response = self._request(
            {
                "action": "invoke",
                "token": token,
                "payload": payload,
            }
        )
        return _decode_result(response.get("result"))

    def _request(self, operation: dict[str, Any]) -> dict[str, Any]:
        request = {
            "plugin_id": self.candidate.plugin_id,
            "source": self.candidate.source.value,
            "module_path": str(self.candidate.module_path.resolve()),
            **operation,
        }
        try:
            launch = prepare_sandboxed_argv(
                (sys.executable, "-m", "mycli.services.plugins.worker"),
                sandbox=self.sandbox,
            )
            completed = subprocess.run(
                list(launch.argv),
                input=json.dumps(request, separators=(",", ":")),
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                text=True,
                timeout=PLUGIN_HOST_TIMEOUT_SECONDS,
                cwd=self.workspace_root,
                env=_worker_env(self.env),
                check=False,
            )
        except subprocess.TimeoutExpired as exc:
            raise PluginHostError("PluginHostTimeout") from exc
        except ProcessSandboxUnavailable as exc:
            raise PluginHostError("ProcessSandboxUnavailable") from exc
        except OSError as exc:
            raise PluginHostError(exc.__class__.__name__) from exc
        if completed.returncode != 0 or len(completed.stdout) > PLUGIN_HOST_OUTPUT_LIMIT:
            raise PluginHostError("PluginHostFailed")
        try:
            response = json.loads(completed.stdout)
        except (json.JSONDecodeError, UnicodeError) as exc:
            raise PluginHostError("InvalidPluginHostResponse") from exc
        if not isinstance(response, dict):
            raise PluginHostError("InvalidPluginHostResponse")
        if response.get("ok") is not True:
            error_type = response.get("error_type")
            raise PluginHostError(
                error_type if isinstance(error_type, str) and error_type else "PluginHostFailed"
            )
        return response


def hook_context_payload(
    *,
    hook_point: str,
    tool_name: str | None,
    tool_args: dict[str, Any] | None,
    session_id: str | None,
    metadata: dict[str, Any],
) -> dict[str, Any]:
    return {
        "hook_point": hook_point,
        "tool_name": tool_name,
        "tool_args": tool_args,
        "session_id": session_id,
        "metadata": metadata,
    }


def _decode_result(value: object) -> object:
    if not isinstance(value, dict) or "result_type" not in value:
        return value
    result_type = value.get("result_type")
    payload = value.get("value")
    if result_type == "hook_result" and isinstance(payload, dict):
        try:
            action = HookAction(str(payload.get("action", HookAction.ERROR.value)))
        except ValueError:
            action = HookAction.ERROR
        modified_args = payload.get("modified_args")
        contexts = payload.get("additional_contexts")
        return HookResult(
            action=action,
            message=str(payload.get("message") or ""),
            modified_args=dict(modified_args) if isinstance(modified_args, dict) else None,
            additional_contexts=tuple(
                item for item in contexts if isinstance(item, str)
            )
            if isinstance(contexts, list)
            else (),
        )
    if result_type == "command_result" and isinstance(payload, dict):
        metadata = payload.get("metadata")
        return PluginCommandResult(
            ok=bool(payload.get("ok")),
            summary=str(payload.get("summary") or ""),
            content=str(payload.get("content") or ""),
            metadata=dict(metadata) if isinstance(metadata, dict) else {},
            error=str(payload.get("error") or ""),
        )
    if result_type == "tool_result" and isinstance(payload, dict):
        artifacts = payload.get("artifacts")
        raw_payload = payload.get("raw_payload")
        evidence = payload.get("evidence")
        return ToolResult(
            success=bool(payload.get("success")),
            summary=str(payload.get("summary") or ""),
            artifacts=dict(artifacts) if isinstance(artifacts, dict) else {},
            raw_payload=dict(raw_payload) if isinstance(raw_payload, dict) else {},
            evidence=tuple(
                _decode_evidence(item) for item in evidence if isinstance(item, dict)
            )
            if isinstance(evidence, list)
            else (),
            error=str(payload["error"]) if payload.get("error") is not None else None,
            model_output=_decode_model_output(payload.get("model_output")),
        )
    if result_type == "tool_model_output":
        return _decode_model_output(payload)
    return payload


def _decode_evidence(value: dict[str, Any]) -> ToolEvidence:
    metadata = value.get("metadata")
    return ToolEvidence(
        kind=str(value.get("kind") or "plugin"),
        title=str(value.get("title") or "Plugin evidence"),
        path=str(value["path"]) if value.get("path") is not None else None,
        line_start=int(value["line_start"]) if isinstance(value.get("line_start"), int) else None,
        line_end=int(value["line_end"]) if isinstance(value.get("line_end"), int) else None,
        snippet=str(value["snippet"]) if value.get("snippet") is not None else None,
        metadata=dict(metadata) if isinstance(metadata, dict) else {},
    )


def _decode_model_output(value: object) -> ToolModelOutput | None:
    if not isinstance(value, dict):
        return None
    raw_content = value.get("content")
    content: list[ToolOutputContent] = []
    if isinstance(raw_content, list):
        for item in raw_content:
            if not isinstance(item, dict):
                continue
            item_type = item.get("type")
            if item_type == "text":
                content.append(ToolTextContent(text=str(item.get("text") or "")))
            elif item_type == "image" and isinstance(item.get("image_url"), str):
                detail = item.get("detail")
                content.append(
                    ToolImageContent(
                        image_url=item["image_url"],
                        detail=detail if detail in {"auto", "low", "high", "original"} else None,
                    )
                )
            elif item_type == "json":
                content.append(ToolJsonContent(value=item.get("value")))
    budget_class = value.get("budget_class")
    try:
        budget = ToolOutputBudgetClass(str(budget_class or "default"))
    except ValueError:
        budget = ToolOutputBudgetClass.DEFAULT
    truncation = value.get("truncation")
    decoded_truncation = (
        ToolOutputTruncation(
            original_chars=int(truncation.get("original_chars", 0)),
            retained_chars=int(truncation.get("retained_chars", 0)),
            omitted_chars=int(truncation.get("omitted_chars", 0)),
        )
        if isinstance(truncation, dict)
        else None
    )
    success = value.get("success")
    return ToolModelOutput(
        content=tuple(content),
        success=success if isinstance(success, bool) else None,
        contains_external_context=bool(value.get("contains_external_context")),
        budget_class=budget,
        truncation=decoded_truncation,
    )


def _worker_env(configured: dict[str, str]) -> dict[str, str]:
    env = dict(configured)
    for key in ("PATH", "SystemRoot", "WINDIR", "TEMP", "TMP"):
        if key not in env and key in os.environ:
            env[key] = os.environ[key]
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    return env


__all__ = [
    "PluginHostError",
    "PluginProcessHost",
    "PluginRegistration",
    "hook_context_payload",
]
