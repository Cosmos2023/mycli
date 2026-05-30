from __future__ import annotations

from collections.abc import Callable
from pathlib import Path
from threading import Lock, Thread
from typing import Protocol

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
from mycli.cli.tui.marks import startup_mark
from mycli.domain.runtime import DecisionAction, PendingDecision, RuntimeStreamEvent, TurnResponse
from mycli.domain.runtime.session_history import HistoryItem, HistoryItemType

PROTOCOL_VERSION = 1
COMMAND_OVERLAYS = {"/help", "/status", "/usage", "/context", "/sessions", "/release-notes"}
SUPPORTED_RPC_METHODS = frozenset(
    {
        "approval.respond",
        "command.run",
        "completion.path",
        "completion.slash",
        "decision.resolve",
        "extension.manifest",
        "session.bootstrap",
        "session.list",
        "session.resume",
        "shutdown",
        "status.inspect",
        "trace.export",
        "transcript.load",
        "turn.interrupt",
        "turn.submit",
    }
)
DECISION_CHOICE_MAP = {
    "approve_once": "1",
    "reject": "2",
    "allow_session": "3",
}
DECISION_OPTION_LABELS = {
    DecisionAction.APPROVE_ONCE: "Allow once",
    DecisionAction.REJECT: "Reject",
    DecisionAction.ALLOW_SESSION: "Allow for session",
}


def supported_rpc_methods() -> frozenset[str]:
    return SUPPORTED_RPC_METHODS


class NodeTuiProcessLike(Protocol):
    def start(self) -> None: ...

    def write_line(self, line: str) -> None: ...

    def read_line(self) -> str: ...

    def wait(self) -> int: ...

    def terminate(self) -> None: ...


def run_node_tui_gateway(*, service: TurnService, process: NodeTuiProcessLike) -> int:
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
            if request.method == "transcript.load":
                return result_response(request.id, self._handle_transcript_load(request.params))
            if request.method == "decision.resolve":
                return self._handle_decision_resolve(request)
            if request.method == "approval.respond":
                return self._handle_approval_response(request)
            if request.method == "completion.slash":
                return result_response(request.id, self._handle_completion_slash(request.params))
            if request.method == "completion.path":
                return result_response(request.id, self._handle_completion_path(request.params))
            if request.method == "status.inspect":
                return result_response(request.id, self._status_payload())
            if request.method == "extension.manifest":
                return result_response(request.id, self.service.extension_manifest())
            if request.method == "trace.export":
                return result_response(request.id, self._handle_trace_export(request.params))
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
            "welcome": self._welcome_payload(),
        }

    def _welcome_payload(self) -> dict[str, object]:
        mark_name = str(getattr(self.service._config, "tui_startup_mark", "default") or "default")
        return {
            "version": "0.1.0",
            "session_id": self.service._config.session_id,
            "workspace": str(self.service._config.workspace_root),
            "model": self.service._config.model,
            "provider": (
                f"{self.service._config.provider.value}/"
                f"{self.service._config.protocol.value}"
            ),
            "context_window": self._status_payload()["context_window"],
            "startup_mark": {"name": mark_name, "text": startup_mark(mark_name)},
            "tips": ["/help", "/context", "/usage", "/sessions"],
            "release_notes_hint": "Run /release-notes",
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
            self._emit_status_update(
                client_turn_id=None,
                state="interrupted",
                kind="interrupted",
                text="Interrupted",
            )
        return {"interrupted": running}

    def _run_turn_worker(self, *, message: str, client_turn_id: str) -> None:
        self._emit_event("turn.started", {"client_turn_id": client_turn_id})
        self._emit_status_update(
            client_turn_id=client_turn_id,
            state="running",
            kind="running",
            text="Running",
        )
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
            self._emit_status_update(
                client_turn_id=client_turn_id,
                state="failed",
                kind="failed",
                text="Failed",
            )
        else:
            if response.pending_decision is not None:
                self._emit_event(
                    "approval.request",
                    _approval_request_payload(client_turn_id, response.pending_decision),
                )
            self._emit_event(
                "turn.completed",
                self._turn_completed_payload(client_turn_id=client_turn_id, response=response),
            )
            turn_state = _turn_state_for_response(response)
            self._emit_status_update(
                client_turn_id=client_turn_id,
                state=turn_state,
                kind=turn_state,
                text=_status_text_for_state(turn_state),
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
            "turn_state": _turn_state_for_response(response),
            "usage": {},
        }

    def _emit_event(self, method: str, params: dict[str, object]) -> None:
        if self._emit is not None:
            self._emit(method, params)

    def _emit_status_update(
        self,
        *,
        client_turn_id: str | None,
        state: str,
        kind: str,
        text: str,
    ) -> None:
        payload: dict[str, object] = {
            "state": state,
            "kind": kind,
            "text": text,
        }
        if client_turn_id is not None:
            payload["client_turn_id"] = client_turn_id
        self._emit_event("status.update", payload)

    def _handle_command_run(self, params: dict[str, object]) -> dict[str, object]:
        command = _required_str(params, "command").strip()
        if not command.startswith("/"):
            raise ValueError("command must start with '/'.")
        command_name = command.split(maxsplit=1)[0]
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
        result: dict[str, object] = {
            "lines": lines,
            "mutated_session": mutated_session,
            "presentation": "overlay" if command_name in COMMAND_OVERLAYS else "transcript",
            "exit_requested": builtin == "quit",
        }
        view_mode = _view_mode_from_command(command)
        if view_mode is not None:
            result["view_mode"] = view_mode
        return result

    def _handle_transcript_load(self, params: dict[str, object]) -> dict[str, object]:
        session_id = _optional_str(params.get("session_id")) or self.service._config.session_id
        limit = _positive_int(params.get("limit"), default=200)
        before = _optional_str(params.get("before"))
        items = list(self.service._session_service.load_history_items(session_id))
        if before is not None:
            before_index = next(
                (index for index, item in enumerate(items) if item.id == before),
                len(items),
            )
            items = items[:before_index]
        selected = items[-limit:]
        projected = [_project_history_item(item) for item in selected]
        next_before = selected[0].id if len(items) > len(selected) and selected else None
        return {"session_id": session_id, "items": projected, "next_before": next_before}

    def _handle_decision_resolve(self, request: RpcRequest) -> RpcResponse:
        return self._handle_approval_response(request)

    def _handle_approval_response(self, request: RpcRequest) -> RpcResponse:
        decision_id = _required_str(request.params, "decision_id")
        if decision_id != "decision_current":
            return error_response(
                request.id,
                code="decision_not_pending",
                message="No pending decision matches the provided decision_id.",
            )
        choice = _required_str(request.params, "choice")
        mapped = DECISION_CHOICE_MAP.get(choice)
        if mapped is None:
            return error_response(
                request.id,
                code="invalid_params",
                message="Unsupported decision choice.",
            )
        pending = self.service._session_service.load_pending_decision(self.service._config.session_id)
        if pending is None:
            return error_response(
                request.id,
                code="decision_not_pending",
                message="No pending decision is available.",
            )
        client_turn_id = f"approval_{request.id}"
        with self._turn_lock:
            if self._turn_running:
                return error_response(
                    request.id,
                    code="turn_in_progress",
                    message="A turn is already running.",
                )
            self._turn_running = True
            self._turn_thread = Thread(
                target=self._run_decision_worker,
                kwargs={"choice": mapped, "client_turn_id": client_turn_id},
                daemon=True,
            )
            self._turn_thread.start()
        return result_response(
            request.id,
            {"accepted": True, "decision_id": decision_id, "client_turn_id": client_turn_id},
        )

    def _run_decision_worker(self, *, choice: str, client_turn_id: str) -> None:
        self._emit_event("turn.started", {"client_turn_id": client_turn_id})
        self._emit_status_update(
            client_turn_id=client_turn_id,
            state="running",
            kind="running",
            text="Resolving approval",
        )
        try:
            response = self.service.resolve_pending_decision(choice)
        except Exception as exc:
            self._emit_event(
                "turn.failed",
                {"client_turn_id": client_turn_id, "message": str(exc)},
            )
            self._emit_status_update(
                client_turn_id=client_turn_id,
                state="failed",
                kind="failed",
                text="Failed",
            )
        else:
            self._emit_event(
                "approval.respond",
                {
                    "client_turn_id": client_turn_id,
                    "decision_id": "decision_current",
                    "choice": _choice_for_resolved_value(choice),
                },
            )
            self._emit_event(
                "turn.completed",
                self._turn_completed_payload(client_turn_id=client_turn_id, response=response),
            )
            self._emit_status_update(
                client_turn_id=client_turn_id,
                state=_turn_state_for_response(response),
                kind=_turn_state_for_response(response),
                text=_status_text_for_state(_turn_state_for_response(response)),
            )
        finally:
            with self._turn_lock:
                self._turn_running = False
            self._emit_event("status.changed", self._status_payload())

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

    def _handle_trace_export(self, params: dict[str, object]) -> dict[str, object]:
        tail = _positive_int(params.get("tail"), default=50)
        return {
            "session_id": self.service._config.session_id,
            "format": "jsonl",
            "rows": list(self.service.export_trace_jsonl(tail=tail)),
        }

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


def _positive_int(value: object, *, default: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        return default
    return value


def _view_mode_from_command(command: str) -> str | None:
    parts = command.split(maxsplit=1)
    if len(parts) == 2 and parts[0] == "/view" and parts[1] in {"default", "verbose", "focus"}:
        return parts[1]
    return None


def _approval_request_payload(
    client_turn_id: str,
    decision: PendingDecision,
) -> dict[str, object]:
    return {
        "client_turn_id": client_turn_id,
        "decision_id": "decision_current",
        "preview": decision.preview,
        "reason": decision.reason,
        "tool_name": decision.tool_call.name,
        "options": [
            {
                "choice": action.value,
                "label": DECISION_OPTION_LABELS[action],
            }
            for action in decision.options
        ],
    }


def _turn_state_for_response(response: TurnResponse) -> str:
    if response.pending_decision is not None:
        return "waiting_approval"
    return "completed"


def _status_text_for_state(state: str) -> str:
    return {
        "running": "Running",
        "waiting_approval": "Waiting approval",
        "completed": "Completed",
        "failed": "Failed",
        "interrupted": "Interrupted",
    }.get(state, state.replace("_", " ").title())


def _choice_for_resolved_value(value: str) -> str:
    for choice, mapped in DECISION_CHOICE_MAP.items():
        if mapped == value:
            return choice
    return value


def _project_history_item(item: HistoryItem) -> dict[str, object]:
    item_type = {
        HistoryItemType.USER_MESSAGE: "user",
        HistoryItemType.ASSISTANT_MESSAGE: "assistant_final",
        HistoryItemType.TOOL_CALL: "tool_summary",
        HistoryItemType.TOOL_RESULT: "tool_detail",
        HistoryItemType.APPROVAL_REQUEST: "approval",
        HistoryItemType.APPROVAL_RESOLUTION: "system_notice",
        HistoryItemType.WARNING: "warning",
        HistoryItemType.COMPACTION: "system_notice",
    }.get(item.type, "system_notice")
    metadata = dict(item.metadata)
    created_at = str(metadata.pop("created_at", "") or "")
    return {
        "id": item.id,
        "type": item_type,
        "text": item.text or "",
        "created_at": created_at,
        "folded": item_type == "tool_detail",
        "metadata": metadata,
    }


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
