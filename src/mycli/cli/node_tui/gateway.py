from __future__ import annotations

from collections.abc import Callable
import inspect
from pathlib import Path
from threading import Lock, Thread
import time
from typing import Any, Protocol, TypedDict, cast

from mycli.application.turn_service import TurnService
from mycli.cli.autocomplete import path_completion_candidates
from mycli.config.auth_store import AuthStore
from mycli.config.settings import default_user_config_path
from mycli.config.shell_settings import load_shell_settings, save_shell_settings
from mycli.cli.node_tui.protocol import (
    JsonRpcError,
    RpcMessage,
    RpcRequest,
    RpcResponse,
    decode_message,
    encode_message,
    error_response,
    notification,
    result_response,
)
from mycli.cli.repl import canonical_slash_command, build_command_handler, handle_slash_command
from mycli.cli.slash_commands import slash_command_candidates
from mycli.cli.startup_marks import startup_mark
from mycli.domain.runtime import (
    DecisionAction,
    PendingDecision,
    RuntimeEventEnvelope,
    RuntimeInterruptToken,
    ShellLifecycleEvent,
    RuntimeStreamEvent,
    StopReason,
    SuspendedTurn,
    TurnRecord,
    TurnResponse,
    TurnStatus,
)
from mycli.domain.runtime.gateway_contract import (
    SUPPORTED_GATEWAY_EVENT_STREAMS,
    SUPPORTED_GATEWAY_RPC_METHODS,
)
from mycli.domain.runtime.session_history import HistoryItem, HistoryItemType
from mycli.domain.conversation import Conversation, Message
from mycli.domain.providers import ProviderId, parse_provider
from mycli.infrastructure.providers import profile_for_provider

PROTOCOL_VERSION = 1
COMMAND_OVERLAYS = {
    "/help",
    "/status",
    "/status usage",
    "/status context",
    "/status stats",
    "/sandbox",
    "/tools permissions",
    "/permissions",
    "/changes",
    "/session list",
    "/session maintenance",
    "/session maintenance --apply-empty",
    "/session maintenance --apply-orphans",
    "/session maintenance --apply-vacuum",
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


class _GatewayWriteTarget(Protocol):
    def write_line(self, line: str) -> None: ...


class _SerializedGatewayWriter:
    def __init__(self, process: _GatewayWriteTarget) -> None:
        self._process = process
        self._lock = Lock()
        self._pipe_closed = False

    def write(self, message: RpcMessage) -> bool:
        with self._lock:
            if self._pipe_closed:
                return False
            try:
                self._process.write_line(encode_message(message))
            except BrokenPipeError:
                self._pipe_closed = True
                return False
        return True


class NodeTuiServiceLike(Protocol):
    _config: Any
    _session_service: Any

    def handle_user_turn(
        self,
        message: str,
        image_paths: tuple[str, ...] = (),
        stream_sink: Callable[[RuntimeStreamEvent], None] | None = None,
        interrupt_token: RuntimeInterruptToken | None = None,
    ) -> TurnResponse: ...

    def resolve_pending_decision(
        self,
        choice: str,
        stream_sink: Callable[[RuntimeStreamEvent], None] | None = None,
    ) -> TurnResponse: ...

    def resolve_pending_clarification(self, request_id: str, response: str) -> TurnResponse: ...

    def current_context_window_metrics(self) -> dict[str, object]: ...

    def extension_manifest(self) -> dict[str, object]: ...

    def inspect_hooks(self) -> tuple[str, ...]: ...

    def inspect_skills(self) -> tuple[str, ...]: ...

    def inspect_extensions(self) -> tuple[str, ...]: ...

    def export_trace_jsonl(self, tail: int = 50) -> tuple[str, ...]: ...

    def resume_session(self, session_id: str | None = None) -> tuple[str, ...]: ...

    def record_turn_interrupt_request(self, *, client_turn_id: str | None = None) -> None: ...

    def queue_steering_message(
        self,
        message: str,
        *,
        image_paths: tuple[str, ...] = (),
        client_turn_id: str | None = None,
    ) -> tuple[tuple[str, ...], tuple[str, ...]]: ...

    def queue_follow_up_message(
        self,
        message: str,
        *,
        image_paths: tuple[str, ...] = (),
        client_turn_id: str | None = None,
    ) -> tuple[tuple[str, ...], tuple[str, ...]]: ...

    def queued_messages(self) -> tuple[tuple[str, ...], tuple[str, ...]]: ...

    def clear_queued_messages(self) -> tuple[tuple[str, ...], tuple[str, ...]]: ...

    def queued_input_items(self) -> object: ...

    def clear_queued_input_items(self) -> object: ...

    def register_shell_lifecycle_listener(
        self,
        listener: Callable[[ShellLifecycleEvent], None],
    ) -> Callable[[], None]: ...

    def active_background_shells(self) -> tuple[dict[str, object], ...]: ...

    def stop_background_shells(self) -> tuple[str, ...]: ...


class _HandleUserTurnKwargs(TypedDict, total=False):
    stream_sink: Callable[[RuntimeStreamEvent], None]
    interrupt_token: RuntimeInterruptToken
    image_paths: tuple[str, ...]


def run_node_tui_gateway(*, service: TurnService, process: NodeTuiProcessLike) -> int:
    process.start()
    writer = _SerializedGatewayWriter(process)

    def emit(method: str, params: dict[str, object]) -> None:
        writer.write(notification(method, params))

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
            if not writer.write(response):
                gateway.wait_for_current_turn(timeout=None)
                return process.wait()
            if message.method == "shutdown":
                gateway.wait_for_current_turn(timeout=None)
                return process.wait()
    except KeyboardInterrupt:
        return 130
    finally:
        gateway.close()
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
        self._current_interrupt_token: RuntimeInterruptToken | None = None
        self._interrupt_requested = False
        self._event_sequence = 0
        self._fallback_trust_state = "unknown"
        self._shell_unsubscribe: Callable[[], None] | None = None
        self._bind_shell_lifecycle_listener()

    def _bind_shell_lifecycle_listener(self) -> None:
        if self._shell_unsubscribe is not None:
            self._shell_unsubscribe()
            self._shell_unsubscribe = None
        register = getattr(self.service, "register_shell_lifecycle_listener", None)
        if not callable(register):
            return
        owner_session_id = str(self.service._config.session_id)

        def listener(event: ShellLifecycleEvent) -> None:
            if event.owner_session_id != owner_session_id:
                return
            if str(self.service._config.session_id) != owner_session_id:
                return
            self._emit_event(event.kind, event.to_tui_payload())

        self._shell_unsubscribe = cast(Callable[[], None], register(listener))

    def close(self) -> None:
        if self._shell_unsubscribe is None:
            return
        unsubscribe = self._shell_unsubscribe
        self._shell_unsubscribe = None
        unsubscribe()

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
            if request.method == "auth.api_key.save":
                return result_response(request.id, self._handle_auth_api_key_save(request.params))
            if request.method == "status.inspect":
                return result_response(request.id, self._status_payload())
            if request.method == "extension.manifest":
                return result_response(request.id, self.service.extension_manifest())
            if request.method == "resource.list":
                return result_response(request.id, self._handle_resource_list())
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
            if request.method == "session.tree":
                return result_response(request.id, self._handle_session_tree(request.params))
            if request.method == "settings.load":
                return result_response(request.id, self._handle_settings_load())
            if request.method == "settings.save":
                return result_response(request.id, self._handle_settings_save(request.params))
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
            "background_shells": self._active_background_shells(),
            "welcome": self._welcome_payload(),
            "auth_providers": self._auth_providers_payload(),
        }
        title = self._session_title()
        if title:
            payload["session_title"] = title
        return payload

    def _handle_auth_api_key_save(self, params: dict[str, object]) -> dict[str, object]:
        provider = parse_provider(_required_str(params, "provider_id"))
        api_key = _required_str(params, "api_key").strip()
        if not api_key:
            raise ValueError("api_key is required.")
        AuthStore.from_home(self._home_dir()).set_api_key(provider.value, api_key)
        return {
            "ok": True,
            "provider_id": provider.value,
            "message": f"Saved API key for {_provider_display_name(provider)}.",
        }

    def _auth_providers_payload(self) -> list[dict[str, object]]:
        auth_store = AuthStore.from_home(self._home_dir())
        providers: list[dict[str, object]] = []
        for provider in ProviderId:
            profile = profile_for_provider(provider)
            payload: dict[str, object] = {
                "id": provider.value,
                "name": _provider_display_name(provider),
                "configured": bool(auth_store.get_api_key(provider.value)),
            }
            if profile.default_model:
                payload["default_model"] = profile.default_model
            providers.append(payload)
        return providers

    def _handle_settings_load(self) -> dict[str, object]:
        settings = load_shell_settings(self._home_dir(), runtime_config=self.service._config)
        return {
            "settings": settings.to_payload(),
            "source": "user_config",
            "path": str(default_user_config_path(self._home_dir())),
        }

    def _handle_settings_save(self, params: dict[str, object]) -> dict[str, object]:
        raw_settings = params.get("settings")
        if not isinstance(raw_settings, dict):
            raise ValueError("settings is required.")
        settings = save_shell_settings(
            self._home_dir(),
            raw_settings,
            runtime_config=self.service._config,
        )
        setter = getattr(self.service, "set_view_mode", None)
        if callable(setter):
            setter(settings.view_mode)
        return {
            "ok": True,
            "settings": settings.to_payload(),
            "source": "user_config",
            "path": str(default_user_config_path(self._home_dir())),
            "message": "Saved TUI settings.",
        }

    def _handle_resource_list(self) -> dict[str, object]:
        resources: list[dict[str, object]] = []
        resources.extend(_resources_from_lines("hook", "/tools hooks", self.service.inspect_hooks()))
        resources.extend(_resources_from_lines("plugin", "/tools plugins", self._plugin_lines()))
        resources.extend(_resources_from_lines("skill", "/tools skills", self.service.inspect_skills()))
        resources.extend(_static_resources())
        return {"resources": resources}

    def _plugin_lines(self) -> tuple[str, ...]:
        inspect = getattr(self.service, "inspect_plugin_commands", None)
        if callable(inspect):
            return tuple(inspect())
        return tuple(self.service.inspect_extensions())

    def _home_dir(self) -> Path:
        runtime = getattr(cast(object, self.service), "_runtime", None)
        runtime_home = getattr(runtime, "_home_dir", None)
        if isinstance(runtime_home, Path):
            return runtime_home
        service_home = getattr(cast(object, self.service), "_home_dir", None)
        if isinstance(service_home, Path):
            return service_home
        return Path(self.service._config.workspace_root)

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
            "tips": ["/help", "/status context", "/status usage", "/session list"],
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
        image_paths = _local_image_paths(request.params.get("local_images"))
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
            self._current_interrupt_token = RuntimeInterruptToken(source="node_tui_gateway")
            self._interrupt_requested = False
            self._turn_thread = Thread(
                target=self._run_turn_worker,
                kwargs={
                    "message": message,
                    "client_turn_id": client_turn_id,
                    "image_paths": image_paths,
                },
                daemon=True,
            )
            self._turn_thread.start()
        return result_response(request.id, {"accepted": True, "client_turn_id": client_turn_id})

    def _handle_turn_steer(self, params: dict[str, object]) -> dict[str, object]:
        message = _required_str(params, "message").strip()
        if not message:
            raise ValueError("message is required.")
        image_paths = _local_image_paths(params.get("local_images"))
        client_turn_id = _optional_str(params.get("client_turn_id"))
        with self._turn_lock:
            running = self._turn_running
        if not running:
            return {"accepted": False, "reason": "not_running", **self._queue_payload()}
        queue = getattr(self.service, "queue_steering_message", None)
        if not callable(queue):
            return {"accepted": False, "reason": "unsupported", **self._queue_payload()}
        steering, follow_up = _call_queue_message(
            queue,
            message,
            image_paths=image_paths,
            client_turn_id=client_turn_id,
        )
        payload = self._queue_payload(steering=steering, follow_up=follow_up)
        self._emit_queue_update(payload)
        return {"accepted": True, **payload}

    def _handle_turn_follow_up(self, params: dict[str, object]) -> dict[str, object]:
        message = _required_str(params, "message").strip()
        if not message:
            raise ValueError("message is required.")
        image_paths = _local_image_paths(params.get("local_images"))
        client_turn_id = _optional_str(params.get("client_turn_id"))
        with self._turn_lock:
            running = self._turn_running
        if not running:
            return {"accepted": False, "reason": "not_running", **self._queue_payload()}
        queue = getattr(self.service, "queue_follow_up_message", None)
        if not callable(queue):
            return {"accepted": False, "reason": "unsupported", **self._queue_payload()}
        steering, follow_up = _call_queue_message(
            queue,
            message,
            image_paths=image_paths,
            client_turn_id=client_turn_id,
        )
        payload = self._queue_payload(steering=steering, follow_up=follow_up)
        self._emit_queue_update(payload)
        return {"accepted": True, **payload}

    def _handle_turn_queue_clear(self) -> dict[str, object]:
        clear_items = getattr(self.service, "clear_queued_input_items", None)
        if callable(clear_items):
            try:
                steering_items, follow_up_items = clear_items()
            except AttributeError:
                steering_items, follow_up_items = None, None
            if steering_items is not None and follow_up_items is not None:
                steering = tuple(_queued_item_text(item) for item in steering_items)
                follow_up = tuple(_queued_item_text(item) for item in follow_up_items)
                payload = self._queue_payload(
                    steering=steering,
                    follow_up=follow_up,
                    steering_items=steering_items,
                    follow_up_items=follow_up_items,
                )
            else:
                clear = getattr(self.service, "clear_queued_messages", None)
                if callable(clear):
                    steering, follow_up = clear()
                else:
                    steering, follow_up = (), ()
                payload = self._queue_payload(steering=steering, follow_up=follow_up)
        else:
            clear = getattr(self.service, "clear_queued_messages", None)
            if callable(clear):
                steering, follow_up = clear()
            else:
                steering, follow_up = (), ()
            payload = self._queue_payload(steering=steering, follow_up=follow_up)
        self._emit_queue_update(self._queue_payload(steering=(), follow_up=()))
        return payload

    def _handle_turn_interrupt(self) -> dict[str, object]:
        with self._turn_lock:
            running = self._turn_running
            client_turn_id = self._current_client_turn_id
            if running:
                self._interrupt_requested = True
                if self._current_interrupt_token is not None:
                    self._current_interrupt_token.request("interrupt")
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
        steering_items: object | None = None,
        follow_up_items: object | None = None,
    ) -> dict[str, object]:
        if steering is None or follow_up is None:
            queued = getattr(self.service, "queued_messages", None)
            if callable(queued):
                steering, follow_up = queued()
            else:
                steering, follow_up = (), ()
        if steering_items is None or follow_up_items is None:
            queued_items = getattr(self.service, "queued_input_items", None)
            if callable(queued_items):
                try:
                    steering_items, follow_up_items = queued_items()
                except AttributeError:
                    steering_items, follow_up_items = (), ()
            else:
                steering_items, follow_up_items = (), ()
        payload: dict[str, object] = {
            "steering": list(steering),
            "follow_up": list(follow_up),
        }
        serialized_steering = _queued_items_payload(steering_items)
        serialized_follow_up = _queued_items_payload(follow_up_items)
        if serialized_steering or serialized_follow_up:
            payload["steering_items"] = serialized_steering
            payload["follow_up_items"] = serialized_follow_up
        payload.update(_queue_activity_payload(payload["steering"], payload["follow_up"]))
        return payload

    def _emit_queue_update(
        self,
        payload: dict[str, object],
    ) -> None:
        if self._emit is None:
            return
        self._emit_event("turn.queue.updated", payload)

    def _record_turn_interrupt_request(self, *, client_turn_id: str | None) -> None:
        recorder = getattr(self.service, "record_turn_interrupt_request", None)
        if not callable(recorder):
            return
        try:
            recorder(client_turn_id=client_turn_id)
        except AttributeError:
            return

    def _run_turn_worker(
        self,
        *,
        message: str,
        client_turn_id: str,
        image_paths: tuple[str, ...] = (),
    ) -> None:
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
                **_handle_user_turn_kwargs(
                    handle_user_turn=self.service.handle_user_turn,
                    stream_sink=lambda event: self._forward_stream_event(client_turn_id, event),
                    interrupt_token=self._current_interrupt_token,
                    image_paths=image_paths,
                ),
            )
        except KeyboardInterrupt:
            self._emit_interrupted_turn_completed(client_turn_id=client_turn_id, message=message)
            self._emit_event(
                "turn.interrupted",
                {"requested": True, "client_turn_id": client_turn_id},
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
                self._current_interrupt_token = None
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
        self._raise_if_interrupted(client_turn_id)
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
            self._raise_if_interrupted(client_turn_id)
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
            self._raise_if_interrupted(client_turn_id)
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
            self._raise_if_interrupted(client_turn_id)
            return
        if event.kind == "subagent_update":
            self._emit_event(
                "subagent.updated",
                {"client_turn_id": client_turn_id, **event.metadata},
            )
            self._raise_if_interrupted(client_turn_id)
            return
        if event.kind == "queue_updated":
            payload: dict[str, object] = {
                "steering": _string_list(event.metadata.get("steering")),
                "follow_up": _string_list(event.metadata.get("follow_up")),
            }
            has_pending_input = event.metadata.get("has_pending_input")
            activity = event.metadata.get("activity")
            if isinstance(has_pending_input, bool):
                payload["has_pending_input"] = has_pending_input
            if isinstance(activity, dict):
                payload["activity"] = activity
            steering_items = _queued_items_payload(event.metadata.get("steering_items"))
            follow_up_items = _queued_items_payload(event.metadata.get("follow_up_items"))
            if steering_items or follow_up_items:
                payload["steering_items"] = steering_items
                payload["follow_up_items"] = follow_up_items
            if "has_pending_input" not in payload or "activity" not in payload:
                payload.update(_queue_activity_payload(payload["steering"], payload["follow_up"]))
            self._emit_event("turn.queue.updated", payload)
            self._raise_if_interrupted(client_turn_id)
            return
        if event.kind == "plan_updated":
            self._emit_event(
                "plan.updated",
                {"client_turn_id": client_turn_id, **event.metadata},
            )
            self._raise_if_interrupted(client_turn_id)
            return
        if event.kind == "reasoning":
            reasoning_payload: dict[str, object] = {
                "client_turn_id": client_turn_id,
                "text": event.text,
            }
            self._emit_event("reasoning.delta", reasoning_payload)
            self._emit_event("thinking.delta", reasoning_payload)
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
        self._raise_if_interrupted(client_turn_id)

    def _raise_if_interrupted(self, client_turn_id: str) -> None:
        with self._turn_lock:
            interrupted = (
                self._interrupt_requested
                and self._turn_running
                and self._current_client_turn_id == client_turn_id
            )
        if interrupted:
            raise KeyboardInterrupt()

    def _emit_interrupted_turn_completed(self, *, client_turn_id: str, message: str) -> None:
        response = TurnResponse(
            assistant_message="Interrupt requested",
            turn=TurnRecord(
                thread_id=self.service._config.session_id,
                turn_id=client_turn_id,
                status=TurnStatus.INTERRUPTED,
                started_at="",
                completed_at="",
                stop_reason=StopReason.INTERRUPTED,
                user_message=message,
            ),
        )
        self._emit_event(
            "turn.completed",
            self._turn_completed_payload(client_turn_id=client_turn_id, response=response),
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
        canonical_command = canonical_slash_command(command)
        command_name = canonical_command.split(maxsplit=1)[0]
        if command == "/stop":
            builtin = ""
            lines = list(self.service.stop_background_shells())
        else:
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
        mutated_mode = (
            command == "/plan"
            or command == "/mode"
            or command.startswith("/mode ")
            or command == "/sandbox"
            or command.startswith("/sandbox ")
        )
        if mutated_mode:
            self._emit_event("status.changed", self._status_payload())
        result: dict[str, object] = {
            "lines": lines,
            "mutated_session": mutated_session,
            "mutated_model": mutated_model,
            "mutated_mode": mutated_mode,
            "presentation": "overlay" if canonical_command in COMMAND_OVERLAYS else "transcript",
            "exit_requested": builtin == "quit",
        }
        if command_name in {"/changes", "/diff"}:
            result["presentation_hint"] = "file changes"
        if command == "/ps":
            result["command_kind"] = "background_shells"
            result["processes"] = self._active_background_shells()
        elif command == "/stop":
            result["command_kind"] = "shell_stop"
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
        self._emit_event(
            "approval.respond",
            {
                "client_turn_id": client_turn_id,
                "decision_id": decision_id,
                "choice": _choice_for_resolved_value(choice),
            },
        )
        try:
            response = self.service.resolve_pending_decision(
                choice,
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
                    "cwd": str(getattr(overview, "workspace_root", "")),
                    "workspace": str(getattr(overview, "workspace_root", "")),
                    "created": getattr(overview, "created_at", ""),
                    "updated": getattr(overview, "updated_at", ""),
                    "last_active": overview.last_active_at,
                    "modified": overview.last_active_at,
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
        self._bind_shell_lifecycle_listener()
        if self._emit is not None:
            self._emit("session.changed", {"session_id": self.service._config.session_id})
            self._emit_event("status.changed", self._status_payload())
            self._emit_resume_pending_state()
        return {"session_id": self.service._config.session_id, "lines": lines}

    def _handle_session_tree(self, params: dict[str, object]) -> dict[str, object]:
        limit = _positive_int(params.get("limit"), default=100)
        overviews = self.service._session_service.list_sessions(limit=limit)
        overview_by_id = {overview.session_id: overview for overview in overviews}
        conversations: dict[str, Conversation] = {}
        for overview in overviews:
            try:
                conversations[overview.session_id] = self.service._session_service.load_conversation(
                    overview.session_id
                )
            except (FileNotFoundError, ValueError, KeyError):
                conversations[overview.session_id] = Conversation(session_id=overview.session_id)

        active_session_id = self.service._config.session_id
        active_path = _conversation_active_path(conversations, active_session_id)
        active_path_set = set(active_path)
        children_by_parent: dict[str | None, list[Conversation]] = {}
        for conversation in conversations.values():
            parent_id = conversation.parent_id if conversation.parent_id in conversations else None
            children_by_parent.setdefault(parent_id, []).append(conversation)

        def sort_key(conversation: Conversation) -> tuple[str, str]:
            overview = overview_by_id.get(conversation.session_id)
            timestamp = overview.last_active_at if overview is not None else ""
            return (timestamp, conversation.session_id)

        nodes: list[dict[str, object]] = []

        def append_session(conversation: Conversation, depth: int) -> None:
            session_node_id = _session_tree_session_node_id(conversation.session_id)
            parent_node_id = (
                _session_tree_session_node_id(conversation.parent_id)
                if conversation.parent_id in conversations
                else None
            )
            overview = overview_by_id.get(conversation.session_id)
            nodes.append(
                {
                    "id": session_node_id,
                    "kind": "session",
                    "session_id": conversation.session_id,
                    "parent_id": parent_node_id,
                    "depth": depth,
                    "role": "session",
                    "summary": conversation.session_id,
                    "timestamp": overview.last_active_at if overview is not None else "",
                    "label": "",
                    "message_index": None,
                    "tool_name": "",
                    "active": conversation.session_id == active_session_id,
                    "on_active_path": conversation.session_id in active_path_set,
                    "message_count": len(conversation.messages),
                    "preview": _conversation_preview(conversation),
                }
            )
            for index, message in enumerate(conversation.messages):
                nodes.append(_conversation_message_tree_node(conversation, message, index, depth + 1))
            for child in sorted(children_by_parent.get(conversation.session_id, []), key=sort_key, reverse=True):
                append_session(child, depth + 1)

        for root in sorted(children_by_parent.get(None, []), key=sort_key, reverse=True):
            append_session(root, 0)

        return {
            "session_id": active_session_id,
            "active_path": active_path,
            "nodes": nodes,
        }

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
            "background_shells": self._active_background_shells(),
            "has_pending_input": queue_payload["has_pending_input"],
            "queue_activity": queue_payload["activity"],
            "trust": self._trust_status_payload(),
        }
        title = self._session_title()
        if title:
            payload["session_title"] = title
        return payload

    def _active_background_shells(self) -> list[dict[str, object]]:
        active = getattr(self.service, "active_background_shells", None)
        if not callable(active):
            return []
        return [dict(row) for row in active()]

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


def _local_image_paths(value: object) -> tuple[str, ...]:
    if not isinstance(value, list):
        return ()
    paths: list[str] = []
    for item in value:
        if isinstance(item, str) and item:
            paths.append(item)
            continue
        if isinstance(item, dict):
            path = item.get("path")
            if isinstance(path, str) and path:
                paths.append(path)
    return tuple(dict.fromkeys(paths))


def _queued_items_payload(value: object) -> list[dict[str, object]]:
    if not isinstance(value, list | tuple):
        return []
    items: list[dict[str, object]] = []
    for item in value:
        if hasattr(item, "to_gateway_payload"):
            payload = item.to_gateway_payload()
            if isinstance(payload, dict):
                items.append(payload)
            continue
        if isinstance(item, dict):
            message = item.get("message") or item.get("text")
            if not isinstance(message, str) or not message:
                continue
            payload = dict(item)
            payload.setdefault("message", message)
            payload.setdefault("text", message)
            local_images = _local_image_payloads(payload.get("local_images"))
            if local_images:
                payload["local_images"] = local_images
            items.append(payload)
            continue
        if isinstance(item, str) and item:
            items.append({"message": item, "text": item})
    return items


def _queue_activity_payload(
    steering: object,
    follow_up: object,
) -> dict[str, object]:
    steering_count = len(steering) if isinstance(steering, list | tuple) else 0
    follow_up_count = len(follow_up) if isinstance(follow_up, list | tuple) else 0
    has_pending_input = steering_count > 0 or follow_up_count > 0
    return {
        "has_pending_input": has_pending_input,
        "activity": {
            "kind": "pending_input" if has_pending_input else "idle",
            "has_pending_input": has_pending_input,
            "steering_count": steering_count,
            "follow_up_count": follow_up_count,
        },
    }


def _queued_item_text(item: object) -> str:
    if hasattr(item, "to_legacy_text"):
        text = item.to_legacy_text()
        return text if isinstance(text, str) else ""
    if isinstance(item, dict):
        message = item.get("message") or item.get("text")
        return message if isinstance(message, str) else ""
    return item if isinstance(item, str) else ""


def _local_image_payloads(value: object) -> list[dict[str, object]]:
    if not isinstance(value, list | tuple):
        return []
    payloads: list[dict[str, object]] = []
    for index, item in enumerate(value, start=1):
        if isinstance(item, dict):
            path = item.get("path")
            if isinstance(path, str) and path:
                placeholder = item.get("placeholder")
                payloads.append(
                    {
                        "path": path,
                        "placeholder": (
                            placeholder
                            if isinstance(placeholder, str) and placeholder
                            else f"[image #{index}]"
                        ),
                    }
                )
        elif isinstance(item, str) and item:
            payloads.append({"path": item, "placeholder": f"[image #{index}]"})
    return payloads


def _handle_user_turn_kwargs(
    *,
    handle_user_turn: Callable[..., object],
    stream_sink: Callable[[RuntimeStreamEvent], None],
    interrupt_token: RuntimeInterruptToken | None,
    image_paths: tuple[str, ...] = (),
) -> _HandleUserTurnKwargs:
    # The gateway is used directly in tests with small fake services. Keep the
    # new cancellation channel optional so old service fakes remain valid.
    kwargs: _HandleUserTurnKwargs = {"stream_sink": stream_sink}
    if interrupt_token is not None and _callable_accepts_keyword(
        handle_user_turn,
        "interrupt_token",
    ):
        kwargs["interrupt_token"] = interrupt_token
    if image_paths and _callable_accepts_keyword(handle_user_turn, "image_paths"):
        kwargs["image_paths"] = image_paths
    return kwargs


def _call_queue_message(
    queue: Callable[..., object],
    message: str,
    *,
    image_paths: tuple[str, ...],
    client_turn_id: str | None,
) -> tuple[tuple[str, ...], tuple[str, ...]]:
    kwargs: dict[str, object] = {}
    if image_paths and _callable_accepts_keyword(queue, "image_paths"):
        kwargs["image_paths"] = image_paths
    if client_turn_id is not None and _callable_accepts_keyword(queue, "client_turn_id"):
        kwargs["client_turn_id"] = client_turn_id
    result = queue(message, **kwargs)
    if (
        isinstance(result, tuple)
        and len(result) == 2
        and isinstance(result[0], tuple)
        and isinstance(result[1], tuple)
    ):
        return result
    return (), ()


def _callable_accepts_keyword(callable_obj: Callable[..., object], keyword: str) -> bool:
    try:
        signature = inspect.signature(callable_obj)
    except (TypeError, ValueError):
        return False
    return any(
        parameter.kind is inspect.Parameter.VAR_KEYWORD or name == keyword
        for name, parameter in signature.parameters.items()
    )


def _optional_str(value: object) -> str | None:
    return value if isinstance(value, str) else None


def _provider_display_name(provider: ProviderId) -> str:
    return {
        ProviderId.OPENAI: "OpenAI",
        ProviderId.CODEX: "Codex Responses",
        ProviderId.DEEPSEEK: "DeepSeek",
        ProviderId.QWEN: "Qwen",
        ProviderId.ANTHROPIC: "Anthropic",
        ProviderId.COMPATIBLE: "Compatible",
    }.get(provider, provider.value)


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


def _resources_from_lines(
    resource_type: str,
    command: str,
    lines: tuple[str, ...],
) -> list[dict[str, object]]:
    resources: list[dict[str, object]] = []
    for index, line in enumerate(lines):
        detail = _bounded_text(line, max_chars=300)
        name = _resource_name_from_line(line, fallback=f"{resource_type}-{index + 1}")
        resources.append(
            {
                "id": f"{resource_type}:{index}:{name}",
                "type": resource_type,
                "name": name,
                "source": _resource_source_from_line(line),
                "enabled": _resource_enabled_from_line(line),
                "status": _resource_status_from_line(line),
                "detail": detail,
                "command": command,
            }
        )
    return resources


def _resource_name_from_line(line: str, *, fallback: str) -> str:
    stripped = line.strip()
    if not stripped:
        return fallback
    head = stripped.split(maxsplit=1)[0]
    if ":" in head and not head.startswith("/"):
        return head.rstrip(":")
    if "=" in head:
        return head.split("=", 1)[0]
    return head[:80]


def _resource_source_from_line(line: str) -> str:
    for source in ("user", "repo", "builtin", "package", "runtime"):
        if f"source={source}" in line or line.startswith(f"{source}:"):
            return source
    return "runtime"


def _resource_enabled_from_line(line: str) -> bool | None:
    lowered = line.lower()
    if "enabled=false" in lowered or " disabled" in lowered or "allowlist=missing" in lowered:
        return False
    if "enabled=true" in lowered or " loaded" in lowered or "approved" in lowered:
        return True
    return None


def _resource_status_from_line(line: str) -> str:
    lowered = line.lower()
    if "issue" in lowered or "error" in lowered or "failed" in lowered:
        return "issue"
    if "disabled" in lowered:
        return "disabled"
    if "enabled" in lowered or "loaded" in lowered or "approved" in lowered:
        return "enabled"
    return "available"


def _static_resources() -> list[dict[str, object]]:
    return [
        {
            "id": "prompt:system",
            "type": "prompt",
            "name": "system prompts",
            "source": "builtin",
            "status": "available",
            "detail": "Prompt resources are owned by Python runtime builders.",
            "command": "/help",
        },
        {
            "id": "theme:current",
            "type": "theme",
            "name": "current theme",
            "source": "runtime",
            "status": "available",
            "detail": "Theme selection is controlled through /settings.",
            "command": "/settings",
        },
    ]


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
    payload.update(_approval_preview_payload(decision.metadata))
    return payload


def _approval_preview_payload(metadata: dict[str, object]) -> dict[str, object]:
    allowed_keys = {
        "content_preview",
        "content_line_count",
        "content_chars",
        "content_truncated",
        "diff",
        "diff_chars",
        "diff_truncated",
    }
    return {key: value for key, value in metadata.items() if key in allowed_keys}


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
    if item.tool_name and not metadata.get("tool_name"):
        metadata["tool_name"] = item.tool_name
    if item.call_id and not metadata.get("call_id"):
        metadata["call_id"] = item.call_id
    created_at = str(metadata.pop("created_at", "") or "")
    return {
        "id": item.id,
        "type": item_type,
        "text": item.text or "",
        "created_at": created_at,
        "folded": item_type == "tool_detail",
        "metadata": metadata,
    }


def _conversation_active_path(
    conversations: dict[str, Conversation],
    active_session_id: str,
) -> list[str]:
    if active_session_id not in conversations:
        return [active_session_id]
    path: list[str] = []
    seen: set[str] = set()
    current: str | None = active_session_id
    while current is not None and current in conversations and current not in seen:
        seen.add(current)
        path.append(current)
        current = conversations[current].parent_id
    return list(reversed(path))


def _session_tree_session_node_id(session_id: str) -> str:
    return f"session:{session_id}"


def _conversation_message_tree_node(
    conversation: Conversation,
    message: Message,
    index: int,
    depth: int,
) -> dict[str, object]:
    tool_name = ""
    if message.tool_calls:
        tool_name = message.tool_calls[0].name
    elif message.metadata.get("tool_name"):
        tool_name = str(message.metadata.get("tool_name"))
    summary = _message_summary(message)
    return {
        "id": f"{_session_tree_session_node_id(conversation.session_id)}:message:{index}",
        "kind": "message",
        "session_id": conversation.session_id,
        "parent_id": _session_tree_session_node_id(conversation.session_id),
        "depth": depth,
        "role": message.role,
        "summary": summary,
        "timestamp": str(message.metadata.get("created_at") or message.metadata.get("timestamp") or ""),
        "label": str(message.metadata.get("label") or ""),
        "message_index": index,
        "anchor_id": str(message.metadata.get("history_id") or ""),
        "tool_name": tool_name,
        "active": False,
        "on_active_path": True,
        "message_count": None,
        "preview": _bounded_text(message.content, max_chars=320),
    }


def _conversation_preview(conversation: Conversation) -> str:
    lines = [
        _bounded_text(message.content, max_chars=120)
        for message in conversation.messages[:3]
        if message.content.strip()
    ]
    return "\n".join(lines)


def _message_summary(message: Message) -> str:
    if message.tool_calls:
        names = ", ".join(call.name for call in message.tool_calls[:3])
        return f"tool call: {names}"
    if message.role == "tool" and message.tool_call_id:
        return f"tool result: {message.tool_call_id}"
    text = message.content.strip().replace("\n", " ")
    if text:
        return _bounded_text(text, max_chars=120)
    return message.role


def _slash_description(command: str) -> str:
    descriptions = {
        "/status": "Show runtime status",
        "/status stats": "Show aggregate stats",
        "/status usage": "Show usage for the current session",
        "/status context": "Show context-window diagnostics",
        "/session resume <session>": "Resume a saved session",
        "/session list": "List saved sessions",
        "/session maintenance": "Show session storage maintenance dry-run",
        "/session maintenance --apply-empty": "Delete empty session maintenance candidates",
        "/session maintenance --apply-orphans": "Delete orphan session child rows",
        "/session maintenance --apply-vacuum": "Run explicit SQLite vacuum for session storage",
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
