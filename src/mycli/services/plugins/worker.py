from __future__ import annotations

from contextlib import redirect_stdout
from dataclasses import asdict
import importlib.util
import json
from pathlib import Path
import sys
from typing import Any, Callable

from mycli.services.hooks import HookContext, HookPoint, HookResult
from mycli.services.plugins.commands import PluginCommandResult
from mycli.domain.tooling.calls import ToolResult
from mycli.domain.tooling.output import (
    ToolImageContent,
    ToolJsonContent,
    ToolModelOutput,
    ToolTextContent,
)


class _WorkerContext:
    def __init__(self, plugin_id: str) -> None:
        self.plugin_id = plugin_id
        self.registrations: list[dict[str, Any]] = []
        self.handlers: dict[str, Callable[..., Any]] = {}

    def register_hook(
        self,
        hook_point: str | HookPoint,
        callback: Callable[..., Any],
        name: str | None = None,
    ) -> None:
        point = hook_point.value if isinstance(hook_point, HookPoint) else str(hook_point)
        hook_name = name or f"plugin:{self.plugin_id}:{getattr(callback, '__name__', 'hook')}"
        token = self._token("hook")
        self.handlers[token] = callback
        self.registrations.append(
            {
                "kind": "hook",
                "token": token,
                "name": hook_name,
                "hook_point": point,
                "schema": {},
                "metadata": {},
            }
        )

    def register_tool(
        self,
        name: str,
        schema: dict[str, Any],
        handler: Callable[[dict[str, Any]], Any],
        metadata: dict[str, Any] | None = None,
    ) -> None:
        token = self._token("tool")
        self.handlers[token] = handler
        self.registrations.append(
            {
                "kind": "tool",
                "token": token,
                "name": str(name),
                "schema": schema if isinstance(schema, dict) else {},
                "metadata": metadata if isinstance(metadata, dict) else {},
            }
        )

    def register_command(
        self,
        name: str,
        schema: dict[str, Any],
        handler: Callable[[dict[str, Any]], Any],
        metadata: dict[str, Any] | None = None,
    ) -> None:
        token = self._token("command")
        self.handlers[token] = handler
        self.registrations.append(
            {
                "kind": "command",
                "token": token,
                "name": str(name),
                "schema": schema if isinstance(schema, dict) else {},
                "metadata": metadata if isinstance(metadata, dict) else {},
            }
        )

    def _token(self, kind: str) -> str:
        return f"{kind}:{sum(1 for item in self.registrations if item['kind'] == kind)}"


def main() -> int:
    try:
        request = json.loads(sys.stdin.read())
        if not isinstance(request, dict):
            raise ValueError
        response = _handle(request)
    except Exception as exc:
        response = {"ok": False, "error_type": exc.__class__.__name__}
    sys.stdout.write(json.dumps(response, ensure_ascii=True, separators=(",", ":")))
    return 0


def _handle(request: dict[str, Any]) -> dict[str, Any]:
    plugin_id = request.get("plugin_id")
    module_path = request.get("module_path")
    if not isinstance(plugin_id, str) or not isinstance(module_path, str):
        raise ValueError
    with redirect_stdout(sys.stderr):
        context = _load_plugin(plugin_id, Path(module_path))
        action = request.get("action")
        if action == "describe":
            return {"ok": True, "registrations": context.registrations}
        if action != "invoke":
            raise ValueError
        token = request.get("token")
        payload = request.get("payload")
        if not isinstance(token, str) or not isinstance(payload, dict):
            raise ValueError
        handler = context.handlers.get(token)
        if handler is None:
            raise LookupError
        if token.startswith("hook:"):
            result = handler(_hook_context(payload))
        else:
            result = handler(dict(payload))
    return {"ok": True, "result": _encode_result(result)}


def _load_plugin(plugin_id: str, module_path: Path) -> _WorkerContext:
    module_name = f"mycli_plugin_worker_{plugin_id.replace('-', '_')}"
    spec = importlib.util.spec_from_file_location(module_name, module_path)
    if spec is None or spec.loader is None:
        raise ImportError
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    register = getattr(module, "register", None)
    if not callable(register):
        raise AttributeError
    context = _WorkerContext(plugin_id)
    register(context)
    return context


def _hook_context(payload: dict[str, Any]) -> HookContext:
    point = HookPoint(str(payload.get("hook_point")))
    tool_args = payload.get("tool_args")
    metadata = payload.get("metadata")
    return HookContext(
        hook_point=point,
        tool_name=str(payload["tool_name"]) if payload.get("tool_name") is not None else None,
        tool_args=dict(tool_args) if isinstance(tool_args, dict) else None,
        session_id=str(payload["session_id"]) if payload.get("session_id") is not None else None,
        metadata=dict(metadata) if isinstance(metadata, dict) else {},
    )


def _encode_result(result: object) -> object:
    if isinstance(result, HookResult):
        return {"result_type": "hook_result", "value": _json_safe(asdict(result))}
    if isinstance(result, PluginCommandResult):
        return {"result_type": "command_result", "value": _json_safe(asdict(result))}
    if isinstance(result, ToolResult):
        return {
            "result_type": "tool_result",
            "value": {
                "success": result.success,
                "summary": result.summary,
                "artifacts": _json_safe(result.artifacts),
                "raw_payload": _json_safe(result.raw_payload),
                "evidence": _json_safe([asdict(item) for item in result.evidence]),
                "error": result.error,
                "model_output": _encode_model_output(result.model_output),
            },
        }
    if isinstance(result, ToolModelOutput):
        return {
            "result_type": "tool_model_output",
            "value": _encode_model_output(result),
        }
    return _json_safe(result)


def _encode_model_output(output: ToolModelOutput | None) -> object:
    if output is None:
        return None
    content: list[dict[str, object]] = []
    for item in output.content:
        if isinstance(item, ToolTextContent):
            content.append({"type": "text", "text": item.text})
        elif isinstance(item, ToolImageContent):
            content.append(
                {"type": "image", "image_url": item.image_url, "detail": item.detail}
            )
        elif isinstance(item, ToolJsonContent):
            content.append({"type": "json", "value": _json_safe(item.value)})
    return {
        "content": content,
        "success": output.success,
        "contains_external_context": output.contains_external_context,
        "budget_class": output.budget_class.value,
        "truncation": _json_safe(asdict(output.truncation)) if output.truncation else None,
    }


def _json_safe(value: object) -> object:
    if value is None or isinstance(value, str | int | float | bool):
        return value
    if isinstance(value, dict):
        return {
            str(key): _json_safe(item)
            for key, item in value.items()
            if isinstance(key, str)
        }
    if isinstance(value, tuple | list):
        return [_json_safe(item) for item in value]
    if hasattr(value, "value") and isinstance(getattr(value, "value"), str):
        return getattr(value, "value")
    return str(value)


if __name__ == "__main__":
    raise SystemExit(main())
