from __future__ import annotations

from mycli.domain.logging import LogLevel, ModelLogContext
from mycli.domain.runtime import AgentConfig, ReasoningEffort, RuntimeTraceEvent
from mycli.llms.adapters.base import ModelAdapter
from mycli.llms.clients.openai_chat import ModelResponseError
from mycli.schemas.responses_protocol import ResponsesContinuationState
from mycli.services.tracing import TraceService
from mycli.state.session_service import SessionService
from mycli.utils.workspace_logger import WorkspaceLogService


class RuntimeModelState:
    def __init__(
        self,
        *,
        model_adapter: ModelAdapter,
        config: AgentConfig,
        session_service: SessionService,
        trace_service: TraceService,
        workspace_log_service: WorkspaceLogService,
    ) -> None:
        self._model_adapter = model_adapter
        self._config = config
        self._session_service = session_service
        self._trace_service = trace_service
        self._workspace_log_service = workspace_log_service

    def set_config(self, config: AgentConfig) -> None:
        self._config = config

    def replace_model_adapter(self, model_adapter: ModelAdapter) -> None:
        self._model_adapter = model_adapter

    def set_log_context(self, turn_id: str) -> None:
        setter = getattr(self._model_adapter, "set_log_context_provider", None)
        if not callable(setter):
            return
        setter(
            lambda: ModelLogContext(
                session_id=self._config.session_id,
                turn_id=turn_id,
            )
        )

    def set_runtime_event_recorder(self, turn_id: str) -> None:
        setter = getattr(self._model_adapter, "set_runtime_event_recorder", None)
        if not callable(setter):
            return
        setter(
            lambda kind, payload: self._trace_service.append(
                self._config.session_id,
                RuntimeTraceEvent(
                    kind=kind,
                    turn_id=turn_id,
                    payload=dict(payload),
                ),
            )
        )

    def set_reasoning_effort(self, reasoning_effort: ReasoningEffort) -> None:
        thinking_setter = getattr(self._model_adapter, "set_thinking_config", None)
        if callable(thinking_setter):
            if not self._config.thinking_enabled:
                thinking_setter(enabled=False, effort=None)
                return
            thinking_setter(enabled=True, effort=reasoning_effort)
            return
        setter = getattr(self._model_adapter, "set_reasoning_effort", None)
        if not callable(setter):
            return
        if not self._config.thinking_enabled:
            setter(None)
            return
        setter(reasoning_effort.value)

    def set_tool_choice(self, tool_choice: str | None) -> None:
        setter = getattr(self._model_adapter, "set_tool_choice", None)
        if not callable(setter):
            return
        setter(tool_choice)

    def load_continuation_state(self, *, turn_id: str) -> None:
        setter = getattr(self._model_adapter, "set_continuation_state", None)
        if not callable(setter):
            return
        state = self._session_service.load_responses_continuation_state(
            self._config.session_id
        )
        setter(state)
        self.record_continuation_state(
            turn_id=turn_id,
            kind="responses_continuation_loaded",
            state=state,
        )

    def persist_continuation_state(self, *, turn_id: str, phase: str) -> None:
        getter = getattr(self._model_adapter, "get_continuation_state", None)
        if not callable(getter):
            return
        state = getter()
        if state is not None and not isinstance(state, ResponsesContinuationState):
            raise ModelResponseError(
                "Model adapter get_continuation_state must return ResponsesContinuationState or None."
            )
        self._session_service.save_responses_continuation_state(
            self._config.session_id,
            state,
        )
        self.record_continuation_state(
            turn_id=turn_id,
            kind="responses_continuation_persisted",
            state=state,
            phase=phase,
        )

    def record_continuation_state(
        self,
        *,
        turn_id: str,
        kind: str,
        state: ResponsesContinuationState | None,
        phase: str | None = None,
    ) -> None:
        payload = {
            "phase": phase,
            "has_state": state is not None,
            "response_id": None if state is None else state.response_id,
            "eligible": None if state is None else state.eligible,
            "failure_reason": None if state is None else state.failure_reason,
            "request_input_count": 0 if state is None else len(state.request_input),
            "response_output_count": 0 if state is None else len(state.response_output),
        }
        self._trace_service.append(
            self._config.session_id,
            RuntimeTraceEvent(
                kind=kind,
                turn_id=turn_id,
                payload=payload,
            ),
        )
        self._workspace_log_service.log(
            level=LogLevel.INFO,
            event=kind,
            message="Updated Responses continuation state",
            context={
                "session_id": self._config.session_id,
                "turn_id": turn_id,
                **payload,
            },
        )
