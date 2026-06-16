from __future__ import annotations

from collections.abc import Callable
from pathlib import Path
from threading import Lock, Thread
import time
from typing import Any, Protocol, cast

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
from mycli.domain.runtime import (
    DecisionAction,
    PendingDecision,
    RuntimeEventEnvelope,
    RuntimeStreamEvent,
    SuspendedTurn,
    TurnResponse,
    TurnStatus,
)
from mycli.domain.runtime.gateway_contract import (
    SUPPORTED_GATEWAY_EVENT_STREAMS,
    SUPPORTED_GATEWAY_RPC_METHODS,
)
from mycli.domain.runtime.session_history import HistoryItem, HistoryItemType

PROTOCOL_VERSION = 1
COMMAND_OVERLAYS = {
    "/help",
    "/status",
    "/usage",
    "/context",
    "/permissions",
    "/changes",
    "/sessions",
    "/session-maintenance",
    "/session-maintenance --apply-empty",
    "/session-maintenance --apply-orphans",
    "/session-maintenance --apply-vacuum",
    "/release-notes",
}
MESSAGE_COMPLETE_TEXT_LIMIT = 16_000
PROPOSED_PLAN_OPEN_TAG = "<proposed_plan>"
PROPOSED_PLAN_CLOSE_TAG = "</proposed_plan>"
SUPPORTED_RPC_METHODS = SUPPORTED_GATEWAY_RPC_METHODS
SUPPORTED_EVENT_STREAMS = SUPPORTED_GATEWAY_EVENT_STREAMS
DECISION_CHOICE_MAP = {
    "approve_once": "1",
    "reject": "2",
    "allow_session": "3",
}
DECISION_CURRENT_ALIAS = "decision_current"
DECISION_OPTION_LABELS = {
    DecisionAction.APPROVE_ONCE: "Allow once",
    DecisionAction.REJECT: "Reject",
    DecisionAction.ALLOW_SESSION: "Allow for session",
}


def supported_rpc_methods() -> frozenset[str]:
    return SUPPORTED_RPC_METHODS


def supported_event_streams() -> frozenset[str]:
    return SUPPORTED_EVENT_STREAMS


class NodeTuiProcessLike(Protocol):
    def start(self) -> None: ...

    def write_line(self, line: str) -> None: ...

    def read_line(self) -> str: ...

    def wait(self) -> int: ...

    def terminate(self) -> None: ...


class NodeTuiServiceLike(Protocol):
    _config: Any
    _session_service: Any

    def handle_user_turn(
        self,
        message: str,
        stream_sink: Callable[[RuntimeStreamEvent], None] | None = None,
    ) -> TurnResponse: ...

    def resolve_pending_decision(self, choice: str) -> TurnResponse: ...

    def resolve_pending_clarification(self, request_id: str, response: str) -> TurnResponse: ...

    def current_context_window_metrics(self) -> dict[str, object]: ...

    def extension_manifest(self) -> dict[str, object]: ...

    def export_trace_jsonl(self, tail: int = 50) -> tuple[str, ...]: ...

    def resume_session(self, session_id: str | None = None) -> tuple[str, ...]: ...

    def record_turn_interrupt_request(self, *, client_turn_id: str | None = None) -> None: ...

    def queue_steering_message(self, message: str) -> tuple[tuple[str, ...], tuple[str, ...]]: ...

    def queue_follow_up_message(self, message: str) -> tuple[tuple[str, ...], tuple[str, ...]]: ...

    def queued_messages(self) -> tuple[tuple[str, ...], tuple[str, ...]]: ...

    def clear_queued_messages(self) -> tuple[tuple[str, ...], tuple[str, ...]]: ...


def run_node_tui_gateway(*, service: TurnService, process: NodeTuiProcessLike) -> int:
    process.start()
    pipe_closed = False

    def emit(method: str, params: dict[str, object]) -> None:
        nonlocal pipe_closed
        if pipe_closed:
            return
        try:
            process.write_line(encode_message(notification(method, params)))
        except BrokenPipeError:
            pipe_closed = True

    gateway = NodeTuiGateway(service=cast(NodeTuiServiceLike, service), emit=emit)
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
                    {"code": "invalid_params", "message": "Expected request."},
                )
                continue
            response = gateway.handle_request(message)
            try:
                process.write_line(encode_message(response))
            except BrokenPipeError:
                gateway.wait_for_current_turn(timeout=None)
                return process.wait()
            if message.method == "shutdown":
                gateway.wait_for_current_turn(timeout=None)
                return process.wait()
    except KeyboardInterrupt:
        return 130
    finally:
        process.terminate()


class NodeTuiGateway:
    def __init__(
        self,
        *,
        service: NodeTuiServiceLike,
        emit: Callable[[str, dict[str, object]], None] | None = None,
    ) -> None:
        self.service = service
        self._emit = emit
        self._command_handler = build_command_handler(cast(TurnService, service))
        self._turn_lock = Lock()
        self._turn_thread: Thread | None = None
        self._turn_running = False
        self._current_client_turn_id: str | None = None
        self._interrupt_requested = False
        self._event_sequence = 0
        self._fallback_trust_state = "unknown"

    def handle_request(self, request: RpcRequest) -> RpcResponse:
        try:
            if request.method == "session.bootstrap":
                return result_response(request.id, self._handle_bootstrap(request.params))
            if request.method == "turn.submit":
                return self._handle_turn_submit(request)
            if request.method == "turn.steer":
                return result_response(request.id, self._handle_turn_steer(request.params))
            if request.method == "turn.follow_up":
                return result_response(request.id, self._handle_turn_follow_up(request.params))
            if request.method == "turn.queue.clear":
                return result_response(request.id, self._handle_turn_queue_clear())
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
            if request.method == "clarify.respond":
                return self._handle_clarification_response(request)
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
            if request.method == "workspace.trust.status":
                return result_response(request.id, self._trust_status_payload())
            if request.method == "workspace.trust.set":
                return result_response(request.id, self._handle_workspace_trust_set(request.params))
            if request.method == "session.list":
                return result_response(request.id, self._handle_session_list())
            if request.method == "session.resume":
                return result_response(request.id, self._handle_session_resume(request.params))
            if request.method == "shutdown":
                return result_response(request.id, {"ok": True})
            return self._gateway_error_response(
                request.id,
                code="method_not_found",
                message=f"Unknown method: {request.method}",
                method=request.method,
            )
        except _GatewayError as exc:
            return self._gateway_error_response(
                request.id,
                code=exc.code,
                message=exc.message,
                method=request.method,
            )
        except ValueError as exc:
            return self._gateway_error_response(
                request.id,
                code="invalid_params",
                message=str(exc),
                method=request.method,
            )
        except Exception as exc:
            self._emit_gateway_error(
                code="internal_error",
                message="Internal gateway error.",
                detail=str(exc),
                method=request.method,
            )
            return error_response(
                request.id,
                code="internal_error",
                message="Internal gateway error.",
            )

    def _gateway_error_response(
        self,
        message_id: str | int | None,
        *,
        code: str,
        message: str,
        method: str | None = None,
        detail: str | None = None,
    ) -> RpcResponse:
        self._emit_gateway_error(code=code, message=message, detail=detail, method=method)
        return error_response(message_id, code=code, message=message)

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
        payload = {
            "protocol_version": PROTOCOL_VERSION,
            "session_id": self.service._config.session_id,
            "workspace": str(self.service._config.workspace_root),
            "model": self.service._config.model,
            "collaboration_mode": self.service._config.collaboration_mode.value,
            "reasoning_effort": str(getattr(self.service._config.reasoning_effort, "value", self.service._config.reasoning_effort)),
            "thinking_effort": (
                str(getattr(self.service._config.thinking_effort, "value", self.service._config.thinking_effort))
                if self.service._config.thinking_effort is not None
                else "off"
            ),
            "provider": (
                f"{self.service._config.provider.value}/"
                f"{self.service._config.protocol.value}"
            ),
            "status": self._status_payload(),
            "welcome": self._welcome_payload(),
        }
        title = self._session_title()
        if title:
            payload["session_title"] = title
        return payload

    def _welcome_payload(self) -> dict[str, object]:
        mark_name = str(getattr(self.service._config, "tui_startup_mark", "default") or "default")
        payload = {
            "version": "0.1.0",
            "session_id": self.service._config.session_id,
            "workspace": str(self.service._config.workspace_root),
            "model": self.service._config.model,
            "collaboration_mode": self.service._config.collaboration_mode.value,
            "reasoning_effort": str(getattr(self.service._config.reasoning_effort, "value", self.service._config.reasoning_effort)),
            "thinking_effort": (
                str(getattr(self.service._config.thinking_effort, "value", self.service._config.thinking_effort))
                if self.service._config.thinking_effort is not None
                else "off"
            ),
            "provider": (
                f"{self.service._config.provider.value}/"
                f"{self.service._config.protocol.value}"
            ),
            "context_window": self._status_payload()["context_window"],
            "startup_mark": {"name": mark_name, "text": startup_mark(mark_name)},
            "tips": ["/help", "/context", "/usage", "/sessions"],
            "release_notes_hint": "Run /release-notes",
        }
        title = self._session_title()
        if title:
            payload["session_title"] = title
        return payload

    def _handle_turn_submit(self, request: RpcRequest) -> RpcResponse:
        message = _required_str(request.params, "message").strip()
        if not message:
            return self._gateway_error_response(
                request.id,
                code="invalid_params",
                message="message is required.",
                method=request.method,
            )
        client_turn_id = _optional_str(request.params.get("client_turn_id")) or str(request.id)
        with self._turn_lock:
            if self._turn_running:
                return self._gateway_error_response(
                    request.id,
                    code="turn_in_progress",
                    message="A turn is already running.",
                    method=request.method,
                )
            self._turn_running = True
            self._current_client_turn_id = client_turn_id
            self._interrupt_requested = False
            self._turn_thread = Thread(
                target=self._run_turn_worker,
                kwargs={"message": message, "client_turn_id": client_turn_id},
                daemon=True,
            )
            self._turn_thread.start()
        return result_response(request.id, {"accepted": True, "client_turn_id": client_turn_id})

    def _handle_turn_steer(self, params: dict[str, object]) -> dict[str, object]:
        message = _required_str(params, "message").strip()
        if not message:
            raise ValueError("message is required.")
        with self._turn_lock:
            running = self._turn_running
        if not running:
            return {"accepted": False, "reason": "not_running", **self._queue_payload()}
        queue = getattr(self.service, "queue_steering_message", None)
        if not callable(queue):
            return {"accepted": False, "reason": "unsupported", **self._queue_payload()}
        steering, follow_up = queue(message)
        payload = self._queue_payload(steering=steering, follow_up=follow_up)
        self._emit_queue_update(steering=steering, follow_up=follow_up)
        return {"accepted": True, **payload}

    def _handle_turn_follow_up(self, params: dict[str, object]) -> dict[str, object]:
        message = _required_str(params, "message").strip()
        if not message:
            raise ValueError("message is required.")
        with self._turn_lock:
            running = self._turn_running
        if not running:
            return {"accepted": False, "reason": "not_running", **self._queue_payload()}
        queue = getattr(self.service, "queue_follow_up_message", None)
        if not callable(queue):
            return {"accepted": False, "reason": "unsupported", **self._queue_payload()}
        steering, follow_up = queue(message)
        payload = self._queue_payload(steering=steering, follow_up=follow_up)
        self._emit_queue_update(steering=steering, follow_up=follow_up)
        return {"accepted": True, **payload}

    def _handle_turn_queue_clear(self) -> dict[str, object]:
        clear = getattr(self.service, "clear_queued_messages", None)
        if callable(clear):
            steering, follow_up = clear()
        else:
            steering, follow_up = (), ()
        self._emit_queue_update(steering=(), follow_up=())
        return self._queue_payload(steering=steering, follow_up=follow_up)

    def _handle_turn_interrupt(self) -> dict[str, object]:
        with self._turn_lock:
            running = self._turn_running
            client_turn_id = self._current_client_turn_id
            if running:
                self._interrupt_requested = True
        if running:
            self._record_turn_interrupt_request(client_turn_id=client_turn_id)
        if running and self._emit is not None:
            self._emit_event(
                "turn.interrupted",
                {
                    "requested": True,
                    **({"client_turn_id": client_turn_id} if client_turn_id is not None else {}),
                },
            )
            self._emit_turn_status(
                client_turn_id=client_turn_id,
                state="interrupted",
                message="Interrupt requested",
            )
            self._emit_status_update(
                client_turn_id=client_turn_id,
                state="interrupted",
                kind="interrupted",
                text="Interrupted",
                message="Interrupt requested",
            )
        return {"interrupted": running}

    def _queue_payload(
        self,
        *,
        steering: tuple[str, ...] | None = None,
        follow_up: tuple[str, ...] | None = None,
    ) -> dict[str, object]:
        if steering is None or follow_up is None:
            queued = getattr(self.service, "queued_messages", None)
            if callable(queued):
                steering, follow_up = queued()
            else:
                steering, follow_up = (), ()
        return {
            "steering": list(steering),
            "follow_up": list(follow_up),
        }

    def _emit_queue_update(
        self,
        *,
        steering: tuple[str, ...],
        follow_up: tuple[str, ...],
    ) -> None:
        if self._emit is None:
            return
        self._emit_event("turn.queue.updated", self._queue_payload(steering=steering, follow_up=follow_up))

    def _record_turn_interrupt_request(self, *, client_turn_id: str | None) -> None:
        recorder = getattr(self.service, "record_turn_interrupt_request", None)
        if not callable(recorder):
            return
        try:
            recorder(client_turn_id=client_turn_id)
        except AttributeError:
            return

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
            self._emit_turn_status(
                client_turn_id=client_turn_id,
                state="failed",
                message=str(exc),
            )
            self._emit_status_update(
                client_turn_id=client_turn_id,
                state="failed",
                kind="failed",
                text="Failed",
            )
        else:
            if self._should_suppress_late_completion(client_turn_id, response):
                self._emit_late_completion_suppressed(client_turn_id, response)
                return
            if response.pending_decision is not None:
                self._emit_event(
                    "approval.request",
                    _approval_request_payload(client_turn_id, response.pending_decision),
                )
            assistant_message, proposed_plan = _split_proposed_plan(response.assistant_message)
            if proposed_plan is not None:
                self._emit_event(
                    "plan.proposed",
                    {
                        "client_turn_id": client_turn_id,
                        "text": proposed_plan,
                        "source": "assistant_message",
                    },
                )
            self._emit_event(
                "turn.completed",
                self._turn_completed_payload(
                    client_turn_id=client_turn_id,
                    response=response,
                    assistant_message=assistant_message,
                ),
            )
            turn_state = _turn_state_for_response(response)
            self._emit_turn_status(
                client_turn_id=client_turn_id,
                state=turn_state,
                message=_terminal_status_message(response, turn_state),
            )
            if turn_state == "completed":
                self._emit_final_message_complete(client_turn_id, assistant_message)
            self._emit_status_update(
                client_turn_id=client_turn_id,
                state=turn_state,
                kind=turn_state,
                text=_status_text_for_state(turn_state),
                message=_terminal_status_message(response, turn_state),
            )
        finally:
            with self._turn_lock:
                self._turn_running = False
                self._current_client_turn_id = None
            self._emit_event("status.changed", self._status_payload())

    def _should_suppress_late_completion(
        self,
        client_turn_id: str,
        response: TurnResponse,
    ) -> bool:
        if _turn_state_for_response(response) != "completed":
            return False
        with self._turn_lock:
            return (
                self._interrupt_requested
                and self._turn_running
                and self._current_client_turn_id == client_turn_id
            )

    def _emit_late_completion_suppressed(
        self,
        client_turn_id: str,
        response: TurnResponse,
    ) -> None:
        self._emit_event(
            "turn.completion_suppressed",
            {
                "client_turn_id": client_turn_id,
                "reason": "interrupt_requested",
                "suppressed_state": _turn_state_for_response(response),
            },
        )

    def _forward_stream_event(self, client_turn_id: str, event: RuntimeStreamEvent) -> None:
        if event.kind in {"tool_start", "tool_progress", "tool_complete", "tool_failed"}:
            method = {
                "tool_start": "tool.start",
                "tool_progress": "tool.progress",
                "tool_complete": "tool.complete",
                "tool_failed": "tool.failed",
            }[event.kind]
            self._emit_event(
                method,
                {"client_turn_id": client_turn_id, **event.metadata},
            )
            return
        if event.kind == "clarify_request":
            self._emit_event(
                "clarify.request",
                {"client_turn_id": client_turn_id, **event.metadata},
            )
            self._emit_turn_status(
                client_turn_id=client_turn_id,
                state="waiting_clarification",
            )
            self._emit_status_update(
                client_turn_id=client_turn_id,
                state="waiting_clarification",
                kind="waiting_clarification",
                text=_status_text_for_state("waiting_clarification"),
            )
            return
        if event.kind in {"compaction_started", "compaction_completed"}:
            method = {
                "compaction_started": "compaction.started",
                "compaction_completed": "compaction.completed",
            }[event.kind]
            self._emit_event(
                method,
                {"client_turn_id": client_turn_id, **event.metadata},
            )
            return
        if event.kind == "subagent_update":
            self._emit_event(
                "subagent.updated",
                {"client_turn_id": client_turn_id, **event.metadata},
            )
            return
        if event.kind == "queue_updated":
            self._emit_event(
                "turn.queue.updated",
                {
                    "steering": _string_list(event.metadata.get("steering")),
                    "follow_up": _string_list(event.metadata.get("follow_up")),
                },
            )
            return
        if event.kind == "plan_updated":
            self._emit_event(
                "plan.updated",
                {"client_turn_id": client_turn_id, **event.metadata},
            )
            return
        if event.kind == "reasoning":
            payload: dict[str, object] = {"client_turn_id": client_turn_id, "text": event.text}
            self._emit_event("reasoning.delta", payload)
            self._emit_event("thinking.delta", payload)
        elif event.kind == "text_delta":
            self._emit_event(
                "message.delta",
                {"client_turn_id": client_turn_id, "text": event.text},
            )
        elif event.kind == "completed":
            self._emit_event(
                "message.complete",
                {"client_turn_id": client_turn_id, **event.metadata},
            )
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
        assistant_message: str | None = None,
    ) -> dict[str, object]:
        rendered_assistant_message = (
            response.assistant_message if assistant_message is None else assistant_message
        )
        return {
            "client_turn_id": client_turn_id,
            "assistant_message": rendered_assistant_message,
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
            if method != "runtime.event":
                self._emit("runtime.event", self._runtime_event_envelope(method, params))

    def _runtime_event_envelope(self, method: str, params: dict[str, object]) -> dict[str, object]:
        self._event_sequence += 1
        return RuntimeEventEnvelope(
            sequence=self._event_sequence,
            event_type=method,
            payload=params,
            timestamp=time.time(),
        ).to_dict()

    def _emit_status_update(
        self,
        *,
        client_turn_id: str | None,
        state: str,
        kind: str,
        text: str,
        message: str | None = None,
    ) -> None:
        payload: dict[str, object] = {
            "state": state,
            "kind": kind,
            "text": text,
        }
        if client_turn_id is not None:
            payload["client_turn_id"] = client_turn_id
        if message:
            payload["message"] = message
        self._emit_event("status.update", payload)

    def _emit_turn_status(
        self,
        *,
        client_turn_id: str | None,
        state: str,
        message: str | None = None,
    ) -> None:
        self._emit_event(
            "turn.status",
            _turn_status_payload(client_turn_id=client_turn_id, state=state, message=message),
        )

    def _emit_gateway_error(
        self,
        *,
        code: str,
        message: str,
        detail: str | None = None,
        method: str | None = None,
    ) -> None:
        payload: dict[str, object] = {"code": code, "message": message}
        if detail:
            payload["detail"] = _bounded_text(detail)
        if method:
            payload["method"] = method
        self._emit_event("gateway.error", payload)

    def _emit_final_message_complete(
        self,
        client_turn_id: str,
        assistant_message: str,
    ) -> None:
        payload: dict[str, object] = {
            "client_turn_id": client_turn_id,
            "text": _bounded_message_complete_text(assistant_message),
            "final": True,
            "source": "turn_response",
        }
        if len(assistant_message) > MESSAGE_COMPLETE_TEXT_LIMIT:
            payload["truncated"] = True
            payload["original_length"] = len(assistant_message)
        self._emit_event("message.complete", payload)

    def _handle_command_run(self, params: dict[str, object]) -> dict[str, object]:
        command = _required_str(params, "command").strip()
        if not command.startswith("/"):
            raise ValueError("command must start with '/'.")
        command_name = command.split(maxsplit=1)[0]
        builtin = handle_slash_command(command)
        if builtin == "quit":
            lines = ["Bye."]
        elif builtin.startswith("Unknown command:"):
            lines = list(self._command_handler(command))
        else:
            lines = builtin.splitlines()
        mutated_session = command.startswith(("/resume", "/fork"))
        if mutated_session and self._emit is not None:
            self._emit("session.changed", {"session_id": self.service._config.session_id})
        mutated_model = command == "/model" or command.startswith("/model ")
        if mutated_model:
            self._emit_event("status.changed", self._status_payload())
        mutated_mode = command == "/plan" or command == "/mode" or command.startswith("/mode ")
        if mutated_mode:
            self._emit_event("status.changed", self._status_payload())
        result: dict[str, object] = {
            "lines": lines,
            "mutated_session": mutated_session,
            "mutated_model": mutated_model,
            "mutated_mode": mutated_mode,
            "presentation": "overlay" if command_name in COMMAND_OVERLAYS else "transcript",
            "exit_requested": builtin == "quit",
        }
        if command_name in {"/changes", "/diff"}:
            result["presentation_hint"] = "file changes"
        view_mode = _view_mode_from_command(command)
        if view_mode is not None:
            result["view_mode"] = view_mode
        collaboration_mode = _collaboration_mode_from_command(command)
        if collaboration_mode is not None:
            result["collaboration_mode"] = collaboration_mode
        return result

    def _handle_transcript_load(self, params: dict[str, object]) -> dict[str, object]:
        session_id = _optional_str(params.get("session_id")) or self.service._config.session_id
        limit = _positive_int(params.get("limit"), default=0) if "limit" in params else None
        before = _optional_str(params.get("before"))
        items = list(self.service._session_service.load_history_items(session_id))
        if before is not None:
            before_index = next(
                (index for index, item in enumerate(items) if item.id == before),
                len(items),
            )
            items = items[:before_index]
        selected = items[-limit:] if limit is not None else items
        projected = [_project_history_item(item) for item in selected]
        next_before = selected[0].id if len(items) > len(selected) and selected else None
        return {"session_id": session_id, "items": projected, "next_before": next_before}

    def _handle_decision_resolve(self, request: RpcRequest) -> RpcResponse:
        return self._handle_approval_response(request)

    def _handle_approval_response(self, request: RpcRequest) -> RpcResponse:
        decision_id = _required_str(request.params, "decision_id")
        choice = _required_str(request.params, "choice")
        mapped = DECISION_CHOICE_MAP.get(choice)
        if mapped is None:
            return self._gateway_error_response(
                request.id,
                code="invalid_params",
                message="Unsupported decision choice.",
                method=request.method,
            )
        pending = self.service._session_service.load_pending_decision(self.service._config.session_id)
        if pending is None:
            return self._gateway_error_response(
                request.id,
                code="decision_not_pending",
                message="No pending decision is available.",
                method=request.method,
            )
        active_decision_id = _decision_id_for_pending_decision(pending)
        if decision_id not in {active_decision_id, DECISION_CURRENT_ALIAS}:
            return self._gateway_error_response(
                request.id,
                code="decision_not_pending",
                message="No pending decision matches the provided decision_id.",
                method=request.method,
            )
        client_turn_id = f"approval_{request.id}"
        with self._turn_lock:
            if self._turn_running:
                return self._gateway_error_response(
                    request.id,
                    code="turn_in_progress",
                    message="A turn is already running.",
                    method=request.method,
                )
            self._turn_running = True
            self._turn_thread = Thread(
                target=self._run_decision_worker,
                kwargs={
                    "choice": mapped,
                    "client_turn_id": client_turn_id,
                    "decision_id": active_decision_id,
                },
                daemon=True,
            )
            self._turn_thread.start()
        return result_response(
            request.id,
            {
                "accepted": True,
                "decision_id": active_decision_id,
                "client_turn_id": client_turn_id,
            },
        )

    def _run_decision_worker(
        self,
        *,
        choice: str,
        client_turn_id: str,
        decision_id: str,
    ) -> None:
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
            self._emit_turn_status(
                client_turn_id=client_turn_id,
                state="failed",
                message=str(exc),
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
                    "decision_id": decision_id,
                    "choice": _choice_for_resolved_value(choice),
                },
            )
            assistant_message, proposed_plan = _split_proposed_plan(response.assistant_message)
            if proposed_plan is not None:
                self._emit_event(
                    "plan.proposed",
                    {
                        "client_turn_id": client_turn_id,
                        "text": proposed_plan,
                        "source": "assistant_message",
                    },
                )
            self._emit_event(
                "turn.completed",
                self._turn_completed_payload(
                    client_turn_id=client_turn_id,
                    response=response,
                    assistant_message=assistant_message,
                ),
            )
            turn_state = _turn_state_for_response(response)
            self._emit_turn_status(
                client_turn_id=client_turn_id,
                state=turn_state,
                message=_terminal_status_message(response, turn_state),
            )
            if turn_state == "completed":
                self._emit_final_message_complete(client_turn_id, assistant_message)
            self._emit_status_update(
                client_turn_id=client_turn_id,
                state=turn_state,
                kind=turn_state,
                text=_status_text_for_state(turn_state),
                message=_terminal_status_message(response, turn_state),
            )
        finally:
            with self._turn_lock:
                self._turn_running = False
            self._emit_event("status.changed", self._status_payload())

    def _handle_clarification_response(self, request: RpcRequest) -> RpcResponse:
        request_id = _required_str(request.params, "request_id").strip()
        if not request_id:
            return self._gateway_error_response(
                request.id,
                code="invalid_params",
                message="request_id is required.",
                method=request.method,
            )
        response = _required_str(request.params, "response").strip()
        if not response:
            return self._gateway_error_response(
                request.id,
                code="invalid_params",
                message="response is required.",
                method=request.method,
            )
        client_turn_id = f"clarify_{request.id}"
        with self._turn_lock:
            if self._turn_running:
                return self._gateway_error_response(
                    request.id,
                    code="turn_in_progress",
                    message="A turn is already running.",
                    method=request.method,
                )
            self._turn_running = True
            self._turn_thread = Thread(
                target=self._run_clarification_worker,
                kwargs={
                    "request_id": request_id,
                    "response": response,
                    "client_turn_id": client_turn_id,
                },
                daemon=True,
            )
            self._turn_thread.start()
        return result_response(
            request.id,
            {"accepted": True, "request_id": request_id, "client_turn_id": client_turn_id},
        )

    def _run_clarification_worker(
        self,
        *,
        request_id: str,
        response: str,
        client_turn_id: str,
    ) -> None:
        self._emit_event("turn.started", {"client_turn_id": client_turn_id})
        self._emit_status_update(
            client_turn_id=client_turn_id,
            state="running",
            kind="running",
            text="Resolving clarification",
        )
        try:
            turn_response = self.service.resolve_pending_clarification(request_id, response)
        except Exception as exc:
            self._emit_event(
                "turn.failed",
                {"client_turn_id": client_turn_id, "message": str(exc)},
            )
            self._emit_turn_status(
                client_turn_id=client_turn_id,
                state="failed",
                message=str(exc),
            )
            self._emit_status_update(
                client_turn_id=client_turn_id,
                state="failed",
                kind="failed",
                text="Failed",
            )
        else:
            self._emit_event(
                "clarify.respond",
                {
                    "client_turn_id": client_turn_id,
                    "request_id": request_id,
                    "response": _bounded_text(response),
                },
            )
            assistant_message, proposed_plan = _split_proposed_plan(turn_response.assistant_message)
            if proposed_plan is not None:
                self._emit_event(
                    "plan.proposed",
                    {
                        "client_turn_id": client_turn_id,
                        "text": proposed_plan,
                        "source": "assistant_message",
                    },
                )
            self._emit_event(
                "turn.completed",
                self._turn_completed_payload(
                    client_turn_id=client_turn_id,
                    response=turn_response,
                    assistant_message=assistant_message,
                ),
            )
            turn_state = _turn_state_for_response(turn_response)
            self._emit_turn_status(
                client_turn_id=client_turn_id,
                state=turn_state,
                message=_terminal_status_message(turn_response, turn_state),
            )
            if turn_state == "completed":
                self._emit_final_message_complete(client_turn_id, assistant_message)
            self._emit_status_update(
                client_turn_id=client_turn_id,
                state=turn_state,
                kind=turn_state,
                text=_status_text_for_state(turn_state),
                message=_terminal_status_message(turn_response, turn_state),
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
            self._emit_event("status.changed", self._status_payload())
            self._emit_resume_pending_state()
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
        queue_payload = self._queue_payload()
        payload = {
            "session_id": self.service._config.session_id,
            "workspace": Path(self.service._config.workspace_root).name,
            "model": self.service._config.model,
            "collaboration_mode": self.service._config.collaboration_mode.value,
            "reasoning_effort": str(getattr(self.service._config.reasoning_effort, "value", self.service._config.reasoning_effort)),
            "thinking_effort": (
                str(getattr(self.service._config.thinking_effort, "value", self.service._config.thinking_effort))
                if self.service._config.thinking_effort is not None
                else "off"
            ),
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
            "turn_running": self._turn_running,
            "queued_steering": queue_payload["steering"],
            "queued_follow_up": queue_payload["follow_up"],
            "trust": self._trust_status_payload(),
        }
        title = self._session_title()
        if title:
            payload["session_title"] = title
        return payload

    def _session_title(self) -> str | None:
        for name in ("session_title", "title"):
            value = getattr(self.service._config, name, None)
            if isinstance(value, str) and value.strip():
                return value.strip()
        provider = getattr(self.service, "session_title", None)
        if callable(provider):
            value = provider()
            if isinstance(value, str) and value.strip():
                return value.strip()
        return None

    def _trust_status_payload(self) -> dict[str, object]:
        workspace = str(self.service._config.workspace_root)
        provider = getattr(self.service, "workspace_trust_status", None)
        if callable(provider):
            raw = provider()
            if isinstance(raw, dict):
                return {
                    "state": str(raw.get("state") or "unknown"),
                    "workspace": str(raw.get("workspace") or workspace),
                    "source": str(raw.get("source") or "runtime"),
                    "enforced": bool(raw.get("enforced", False)),
                }
        return {
            "state": self._fallback_trust_state,
            "workspace": workspace,
            "source": "fallback",
            "enforced": False,
        }

    def _handle_workspace_trust_set(self, params: dict[str, object]) -> dict[str, object]:
        state = _required_str(params, "state").strip().lower()
        if state not in {"trusted", "untrusted", "unknown"}:
            raise ValueError("state must be trusted, untrusted, or unknown.")
        setter = getattr(self.service, "set_workspace_trust", None)
        if callable(setter):
            raw = setter(state=state)
            if isinstance(raw, dict):
                payload = {
                    "state": str(raw.get("state") or state),
                    "workspace": str(raw.get("workspace") or self.service._config.workspace_root),
                    "source": str(raw.get("source") or "runtime"),
                    "enforced": bool(raw.get("enforced", False)),
                }
                self._emit_event("workspace.trust.changed", payload)
                self._emit_event("status.changed", {**self._status_payload(), "trust": payload})
                return payload
        self._fallback_trust_state = state
        payload = {
            **self._trust_status_payload(),
            "requested_state": state,
            "message": "Workspace trust runtime enforcement is not available yet.",
        }
        self._emit_event("workspace.trust.changed", payload)
        return payload

    def _emit_resume_pending_state(self) -> None:
        pending = self.service._session_service.load_pending_decision(self.service._config.session_id)
        if pending is not None:
            self._emit_event(
                "approval.request",
                _approval_request_payload(self.service._config.session_id, pending),
            )
        suspended = self.service._session_service.load_suspended_turn(self.service._config.session_id)
        if isinstance(suspended, SuspendedTurn) and suspended.pending_clarification is not None:
            self._emit_event(
                "clarify.request",
                _clarify_request_payload(
                    client_turn_id=self.service._config.session_id,
                    suspended=suspended,
                ),
            )


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


def _string_list(value: object) -> list[str]:
    if not isinstance(value, list | tuple):
        return []
    return [item for item in value if isinstance(item, str)]


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


def _bounded_text(value: str, *, max_chars: int = 500) -> str:
    compact = " ".join(value.split())
    if len(compact) <= max_chars:
        return compact
    return compact[: max_chars - 3] + "..."


def _view_mode_from_command(command: str) -> str | None:
    parts = command.split(maxsplit=1)
    if len(parts) == 2 and parts[0] == "/view" and parts[1] in {"default", "verbose", "focus"}:
        return parts[1]
    return None


def _collaboration_mode_from_command(command: str) -> str | None:
    if command == "/plan":
        return "plan"
    parts = command.split(maxsplit=1)
    if len(parts) == 2 and parts[0] == "/mode" and parts[1] in {"default", "plan"}:
        return parts[1]
    return None


def _approval_request_payload(
    client_turn_id: str,
    decision: PendingDecision,
) -> dict[str, object]:
    payload: dict[str, object] = {
        "client_turn_id": client_turn_id,
        "decision_id": _decision_id_for_pending_decision(decision),
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
    payload["action"] = decision.tool_call.name
    payload["cwd"] = str(Path.cwd())
    if decision.command_pattern:
        payload["risk"] = "command"
        payload["risk_reason"] = decision.command_pattern
    else:
        payload["risk"] = decision.kind.value
        payload["risk_reason"] = decision.reason
    return payload


def _decision_id_for_pending_decision(decision: PendingDecision) -> str:
    if decision.tool_call.call_id:
        return decision.tool_call.call_id
    return DECISION_CURRENT_ALIAS


def _clarify_request_payload(
    *,
    client_turn_id: str,
    suspended: SuspendedTurn,
) -> dict[str, object]:
    pending = suspended.pending_clarification
    if pending is None:
        return {}
    return {
        "client_turn_id": client_turn_id,
        "request_id": pending.request_id,
        "tool_id": pending.tool_call.call_id or pending.request_id,
        "call_id": pending.tool_call.call_id or pending.request_id,
        "tool_name": pending.tool_call.name,
        "question": pending.question,
        "options": list(pending.options),
        "header": pending.header,
        "multi_select": pending.multi_select,
    }


def _turn_state_for_response(response: TurnResponse) -> str:
    if response.pending_decision is not None:
        return "waiting_approval"
    if response.turn is not None:
        if response.turn.status is TurnStatus.WAITING_CLARIFICATION:
            return "waiting_clarification"
        if response.turn.status is TurnStatus.REJECTED:
            return "rejected"
        if response.turn.status is TurnStatus.FAILED:
            return "failed"
        if response.turn.status is TurnStatus.INTERRUPTED:
            return "interrupted"
    return "completed"


def _status_text_for_state(state: str) -> str:
    return {
        "running": "Running",
        "waiting_approval": "Waiting approval",
        "waiting_clarification": "Waiting clarification",
        "completed": "Completed",
        "failed": "Failed",
        "interrupted": "Interrupted",
        "rejected": "Rejected",
    }.get(state, state.replace("_", " ").title())


def _terminal_status_message(response: TurnResponse, state: str) -> str | None:
    if state in {"failed", "interrupted", "rejected"} and response.assistant_message:
        return _bounded_text(response.assistant_message)
    return None


def _turn_status_payload(
    *,
    client_turn_id: str | None,
    state: str,
    message: str | None = None,
) -> dict[str, object]:
    payload: dict[str, object] = {
        "state": state,
        "kind": state,
        "text": _status_text_for_state(state),
        "terminal": state in {"completed", "failed", "interrupted", "rejected"},
    }
    if client_turn_id is not None:
        payload["client_turn_id"] = client_turn_id
    if message:
        payload["message"] = message
    return payload


def _choice_for_resolved_value(value: str) -> str:
    for choice, mapped in DECISION_CHOICE_MAP.items():
        if mapped == value:
            return choice
    return value


def _bounded_message_complete_text(value: str) -> str:
    if len(value) <= MESSAGE_COMPLETE_TEXT_LIMIT:
        return value
    return value[:MESSAGE_COMPLETE_TEXT_LIMIT]


def _split_proposed_plan(message: str) -> tuple[str, str | None]:
    """Return visible assistant text plus a Codex-style proposed plan block."""

    lines = message.splitlines(keepends=True)
    open_index = _find_exact_tag_line(lines, PROPOSED_PLAN_OPEN_TAG, start=0)
    if open_index is None:
        return message, None
    close_index = _find_exact_tag_line(lines, PROPOSED_PLAN_CLOSE_TAG, start=open_index + 1)
    if close_index is None:
        return message, None

    plan = "".join(lines[open_index + 1 : close_index]).strip()
    if not plan:
        return message, None
    visible = "".join([*lines[:open_index], *lines[close_index + 1 :]]).strip()
    return visible, plan


def _find_exact_tag_line(lines: list[str], tag: str, *, start: int) -> int | None:
    for index in range(start, len(lines)):
        if lines[index].strip() == tag:
            return index
    return None


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
        "/session-maintenance": "Show session storage maintenance dry-run",
        "/session-maintenance --apply-empty": "Delete empty session maintenance candidates",
        "/session-maintenance --apply-orphans": "Delete orphan session child rows",
        "/session-maintenance --apply-vacuum": "Run explicit SQLite vacuum for session storage",
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
