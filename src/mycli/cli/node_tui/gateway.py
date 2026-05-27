from __future__ import annotations

from collections.abc import Callable
from pathlib import Path

from mycli.application.turn_service import TurnService
from mycli.cli.autocomplete import path_completion_candidates
from mycli.cli.node_tui.protocol import (
    RpcRequest,
    RpcResponse,
    error_response,
    result_response,
)
from mycli.cli.repl import build_command_handler, handle_slash_command
from mycli.cli.tui.completion import slash_command_candidates

PROTOCOL_VERSION = 1


class NodeTuiGateway:
    def __init__(
        self,
        *,
        service: TurnService,
        emit: Callable[[str, dict[str, object]], None] | None = None,
    ) -> None:
        self.service = service
        self._emit = emit
        self._command_handler = build_command_handler(service)

    def handle_request(self, request: RpcRequest) -> RpcResponse:
        try:
            if request.method == "session.bootstrap":
                return result_response(request.id, self._handle_bootstrap(request.params))
            if request.method == "command.run":
                return result_response(request.id, self._handle_command_run(request.params))
            if request.method == "completion.slash":
                return result_response(request.id, self._handle_completion_slash(request.params))
            if request.method == "completion.path":
                return result_response(request.id, self._handle_completion_path(request.params))
            if request.method == "status.inspect":
                return result_response(request.id, self._status_payload())
            if request.method == "session.list":
                return result_response(request.id, self._handle_session_list())
            if request.method == "session.resume":
                return result_response(request.id, self._handle_session_resume(request.params))
            if request.method == "shutdown":
                return result_response(request.id, {"ok": True})
            return error_response(
                request.id,
                code="method_not_found",
                message=f"Unknown method: {request.method}",
            )
        except _GatewayError as exc:
            return error_response(request.id, code=exc.code, message=exc.message)
        except ValueError as exc:
            return error_response(request.id, code="invalid_params", message=str(exc))

    def _handle_bootstrap(self, params: dict[str, object]) -> dict[str, object]:
        version = params.get("protocol_version")
        if version != PROTOCOL_VERSION:
            raise _GatewayError(
                code="incompatible_protocol",
                message=f"Unsupported Node TUI protocol version: {version}",
            )
        return {
            "protocol_version": PROTOCOL_VERSION,
            "session_id": self.service._config.session_id,
            "workspace": str(self.service._config.workspace_root),
            "model": self.service._config.model,
            "provider": (
                f"{self.service._config.provider.value}/"
                f"{self.service._config.protocol.value}"
            ),
            "status": self._status_payload(),
        }

    def _handle_command_run(self, params: dict[str, object]) -> dict[str, object]:
        command = _required_str(params, "command").strip()
        if not command.startswith("/"):
            raise ValueError("command must start with '/'.")
        builtin = handle_slash_command(command)
        if builtin == "quit":
            lines = ["Bye."]
        elif builtin.startswith("Unknown command:"):
            lines = [line for line in self._command_handler(command)]
        else:
            lines = builtin.splitlines()
        mutated_session = command.startswith(("/resume", "/fork"))
        if mutated_session and self._emit is not None:
            self._emit("session.changed", {"session_id": self.service._config.session_id})
        return {"lines": lines, "mutated_session": mutated_session}

    def _handle_completion_slash(self, params: dict[str, object]) -> dict[str, object]:
        prefix = _optional_str(params.get("prefix")) or "/"
        return {
            "items": [
                {"value": command, "description": _slash_description(command)}
                for command in slash_command_candidates()
                if command.startswith(prefix)
            ]
        }

    def _handle_completion_path(self, params: dict[str, object]) -> dict[str, object]:
        prefix = _optional_str(params.get("prefix")) or "@"
        items: list[dict[str, object]] = []
        for value in path_completion_candidates(self.service._config.workspace_root, prefix):
            kind = "directory" if value.endswith("/") else "file"
            items.append({"value": value, "kind": kind})
        return {"items": items}

    def _handle_session_list(self) -> dict[str, object]:
        overviews = self.service._session_service.list_sessions(limit=20)
        return {
            "sessions": [
                {
                    "id": overview.session_id,
                    "last_active": overview.last_active_at,
                    "message_count": overview.message_count,
                    "current": overview.session_id == self.service._config.session_id,
                }
                for overview in overviews
            ]
        }

    def _handle_session_resume(self, params: dict[str, object]) -> dict[str, object]:
        session_id = _required_str(params, "session_id").strip()
        if not session_id:
            raise ValueError("session_id is required.")
        lines = [f"[session] {line}" for line in self.service.resume_session(session_id)]
        if self._emit is not None:
            self._emit("session.changed", {"session_id": self.service._config.session_id})
        return {"session_id": self.service._config.session_id, "lines": lines}

    def _status_payload(self) -> dict[str, object]:
        context_window = self.service.current_context_window_metrics()
        pending = self.service._session_service.load_pending_decision(self.service._config.session_id)
        suspended = self.service._session_service.load_suspended_turn(self.service._config.session_id)
        return {
            "session_id": self.service._config.session_id,
            "workspace": Path(self.service._config.workspace_root).name,
            "model": self.service._config.model,
            "provider": (
                f"{self.service._config.provider.value}/"
                f"{self.service._config.protocol.value}"
            ),
            "context_window": {
                "used_tokens": _int_metric(
                    context_window.get("input_tokens") or context_window.get("total_tokens")
                ),
                "max_tokens": _int_metric(context_window.get("max_tokens"))
                or self.service._config.max_prompt_tokens,
                "source": str(context_window.get("source") or "estimate"),
            },
            "pending_decision": pending is not None,
            "suspended_turn": suspended is not None,
        }


class _GatewayError(ValueError):
    def __init__(self, *, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def _required_str(params: dict[str, object], key: str) -> str:
    value = params.get(key)
    if not isinstance(value, str):
        raise ValueError(f"{key} is required.")
    return value


def _optional_str(value: object) -> str | None:
    return value if isinstance(value, str) else None


def _int_metric(value: object) -> int:
    if isinstance(value, bool):
        return 0
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    return 0


def _slash_description(command: str) -> str:
    descriptions = {
        "/status": "Show runtime status",
        "/stats": "Show aggregate stats",
        "/usage": "Show usage for the current session",
        "/context": "Show context-window diagnostics",
        "/resume <session>": "Resume a saved session",
        "/sessions": "List saved sessions",
        "/quit": "Exit mycli",
    }
    return descriptions.get(command, "")
