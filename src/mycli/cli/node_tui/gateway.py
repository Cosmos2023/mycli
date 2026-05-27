from __future__ import annotations

from collections.abc import Callable
from pathlib import Path
from threading import Lock, Thread

from mycli.application.turn_service import TurnService
from mycli.cli.autocomplete import path_completion_candidates
from mycli.cli.node_tui.protocol import (
    JsonRpcError,
    RpcRequest,
    RpcResponse,
    decode_message,
    encode_message,
    error_response,
    notification,
    result_response,
)
from mycli.cli.repl import build_command_handler, handle_slash_command
from mycli.cli.tui.completion import slash_command_candidates
from mycli.domain.runtime import RuntimeStreamEvent, TurnResponse

PROTOCOL_VERSION = 1


def run_node_tui_gateway(*, service: TurnService, process: object) -> int:
    process.start()

    def emit(method: str, params: dict[str, object]) -> None:
        process.write_line(encode_message(notification(method, params)))

    gateway = NodeTuiGateway(service=service, emit=emit)
    emit("runtime.ready", gateway._status_payload())
    try:
        while True:
            line = process.read_line()
            if not line:
                gateway.wait_for_current_turn(timeout=None)
                return process.wait()
            try:
                message = decode_message(line)
            except JsonRpcError as exc:
                emit("gateway.error", {"code": exc.code, "message": exc.message})
                continue
            if not isinstance(message, RpcRequest):
                emit(
                    "gateway.error",
                    {"code": "invalid_request", "message": "Expected request."},
                )
                continue
            response = gateway.handle_request(message)
            process.write_line(encode_message(response))
            if message.method == "shutdown":
                gateway.wait_for_current_turn(timeout=None)
                return process.wait()
    finally:
        process.terminate()


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
        self._turn_lock = Lock()
        self._turn_thread: Thread | None = None
        self._turn_running = False
        self._interrupt_requested = False

    def handle_request(self, request: RpcRequest) -> RpcResponse:
        try:
            if request.method == "session.bootstrap":
                return result_response(request.id, self._handle_bootstrap(request.params))
            if request.method == "turn.submit":
                return self._handle_turn_submit(request)
            if request.method == "turn.interrupt":
                return result_response(request.id, self._handle_turn_interrupt())
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

    def wait_for_current_turn(self, timeout: float | None = None) -> None:
        thread = self._turn_thread
        if thread is not None:
            thread.join(timeout=timeout)

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

    def _handle_turn_submit(self, request: RpcRequest) -> RpcResponse:
        message = _required_str(request.params, "message").strip()
        if not message:
            return error_response(request.id, code="invalid_params", message="message is required.")
        client_turn_id = _optional_str(request.params.get("client_turn_id")) or str(request.id)
        with self._turn_lock:
            if self._turn_running:
                return error_response(
                    request.id,
                    code="turn_in_progress",
                    message="A turn is already running.",
                )
            self._turn_running = True
            self._interrupt_requested = False
            self._turn_thread = Thread(
                target=self._run_turn_worker,
                kwargs={"message": message, "client_turn_id": client_turn_id},
                daemon=True,
            )
            self._turn_thread.start()
        return result_response(request.id, {"accepted": True, "client_turn_id": client_turn_id})

    def _handle_turn_interrupt(self) -> dict[str, object]:
        with self._turn_lock:
            running = self._turn_running
            if running:
                self._interrupt_requested = True
        if running and self._emit is not None:
            self._emit("turn.interrupted", {"requested": True})
        return {"interrupted": running}

    def _run_turn_worker(self, *, message: str, client_turn_id: str) -> None:
        self._emit_event("turn.started", {"client_turn_id": client_turn_id})
        try:
            response = self.service.handle_user_turn(
                message,
                stream_sink=lambda event: self._forward_stream_event(client_turn_id, event),
            )
        except Exception as exc:
            self._emit_event(
                "turn.failed",
                {"client_turn_id": client_turn_id, "message": str(exc)},
            )
        else:
            self._emit_event(
                "turn.completed",
                self._turn_completed_payload(client_turn_id=client_turn_id, response=response),
            )
        finally:
            with self._turn_lock:
                self._turn_running = False
            self._emit_event("status.changed", self._status_payload())

    def _forward_stream_event(self, client_turn_id: str, event: RuntimeStreamEvent) -> None:
        self._emit_event(
            "turn.event",
            {
                "client_turn_id": client_turn_id,
                "phase": _phase_for_stream_event(event),
                "kind": event.kind,
                "text": event.text,
                "tool_name": event.tool_name,
                "metadata": event.metadata,
            },
        )

    def _turn_completed_payload(
        self,
        *,
        client_turn_id: str,
        response: TurnResponse,
    ) -> dict[str, object]:
        return {
            "client_turn_id": client_turn_id,
            "assistant_message": response.assistant_message,
            "activity_events": [
                {
                    "kind": item.kind,
                    "message": item.message,
                    "tool_name": item.tool_name,
                    "path": item.path,
                    "query": item.query,
                    "preview": item.preview,
                }
                for item in response.activity_events
            ],
            "progress_updates": list(response.progress_updates),
            "plan_steps": list(response.plan_steps),
            "pending_decision": response.pending_decision is not None,
            "usage": {},
        }

    def _emit_event(self, method: str, params: dict[str, object]) -> None:
        if self._emit is not None:
            self._emit(method, params)

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


def _phase_for_stream_event(event: RuntimeStreamEvent) -> str:
    if event.kind == "reasoning":
        return "reasoning"
    if event.kind == "text_delta":
        return "assistant_delta"
    if event.kind == "tool_call":
        return "tool_call"
    if event.kind == "heartbeat":
        return "heartbeat"
    if event.kind == "completed":
        return "model_completed"
    return event.kind
