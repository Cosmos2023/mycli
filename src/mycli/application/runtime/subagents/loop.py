from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, replace
from threading import Lock
from typing import Protocol

from mycli.domain.runtime import ModelTurnResult, RuntimeBlock, RuntimeItem, RuntimeRole
from mycli.domain.subagents import (
    SubAgentContextSnapshot,
    SubAgentInvocation,
    SubAgentProfile,
    SubAgentResult,
)
from mycli.domain.tooling.calls import ToolCall
from mycli.domain.tooling.exposure import (
    ToolExposure,
    ToolExposureEntry,
    ToolRouteKey,
    ToolRouteSource,
)
from mycli.llms.adapters.base import ModelMessage, ModelToolDefinition
from mycli.services.context.tool_output_projector import ToolModelOutputProjector
from mycli.tools.base import ToolResult, ToolSpec
from mycli.tools.routing.tool_router import ToolRouter


class ChildTurn(Protocol):
    text: str
    tool_calls: tuple[ToolCall, ...]


class ChildTurnRequester(Protocol):
    def request_child_turn(
        self,
        *,
        messages: list[dict[str, object]],
        tool_names: tuple[str, ...],
        child_session_id: str,
    ) -> ChildTurn:
        ...


class ChildToolExecutor(Protocol):
    def execute_child_tool(
        self,
        *,
        call: ToolCall,
        child_session_id: str,
        tool_names: tuple[str, ...],
    ) -> ToolResult:
        ...


class ChildTranscriptRecorder(Protocol):
    def record_system_text(self, text: str) -> None: ...

    def record_reference_text(self, text: str, metadata: dict[str, object]) -> None: ...

    def record_user_text(self, text: str) -> None: ...

    def record_assistant_text(self, text: str) -> None: ...

    def record_tool_call(
        self,
        *,
        call_id: str | None,
        tool_name: str,
        arguments: dict[str, object],
    ) -> None: ...

    def record_tool_result(
        self,
        *,
        call_id: str | None,
        tool_name: str,
        content: str,
    ) -> None: ...

    def record_final(self, *, status: str, report: str, tool_calls: int) -> None: ...


class RuntimeModelTurnRequester(Protocol):
    def request_model_turn(
        self,
        *,
        runtime_items: list[RuntimeItem],
        legacy_messages: list[ModelMessage],
        tools: list[ModelToolDefinition],
    ) -> tuple[ModelTurnResult, tuple[str, ...]]:
        ...


@dataclass(slots=True)
class RuntimeChildTurn:
    text: str
    tool_calls: tuple[ToolCall, ...] = ()


@dataclass(slots=True)
class RuntimeChildTurnRequester:
    requester: RuntimeModelTurnRequester
    tool_exposure_builder: Callable[[tuple[str, ...]], ToolExposure]
    tool_renderer: Callable[[ToolExposure], list[ModelToolDefinition]]
    model_request_lock: Lock | None = None

    def request_child_turn(
        self,
        *,
        messages: list[dict[str, object]],
        tool_names: tuple[str, ...],
        child_session_id: str,
    ) -> ChildTurn:
        exposure = self.tool_exposure_builder(tool_names)
        runtime_items = self._runtime_items(messages)
        legacy_messages = self._legacy_messages(messages)
        tools = self.tool_renderer(exposure)
        if self.model_request_lock is None:
            turn_result, _streamed = self.requester.request_model_turn(
                runtime_items=runtime_items,
                legacy_messages=legacy_messages,
                tools=tools,
            )
        else:
            with self.model_request_lock:
                turn_result, _streamed = self.requester.request_model_turn(
                    runtime_items=runtime_items,
                    legacy_messages=legacy_messages,
                    tools=tools,
                )
        turn_result = self._mark_internal_usage(turn_result, child_session_id=child_session_id)
        return self._project_turn(turn_result)

    def _mark_internal_usage(
        self,
        turn_result: ModelTurnResult,
        *,
        child_session_id: str,
    ) -> ModelTurnResult:
        metadata = dict(turn_result.metadata)
        usage = metadata.get("usage")
        if isinstance(usage, dict):
            scoped_usage = dict(usage)
            scoped_usage["usage_scope"] = "internal"
            scoped_usage["child_session_id"] = child_session_id
            metadata["usage"] = scoped_usage
        metadata["usage_scope"] = "internal"
        metadata["child_session_id"] = child_session_id
        return replace(turn_result, metadata=metadata)

    def _runtime_items(self, messages: list[dict[str, object]]) -> list[RuntimeItem]:
        items: list[RuntimeItem] = []
        for message in messages:
            blocks = self._runtime_blocks(message)
            if blocks:
                items.append(
                    RuntimeItem(
                        role=self._runtime_role(str(message.get("role", "user"))),
                        blocks=blocks,
                    )
                )
        return items

    def _runtime_blocks(self, message: dict[str, object]) -> tuple[RuntimeBlock, ...]:
        blocks: list[RuntimeBlock] = []
        content = str(message.get("content", ""))
        if content:
            if message.get("role") == "tool":
                tool_call_id = message.get("tool_call_id")
                blocks.append(
                    RuntimeBlock(
                        type="tool_result",
                        text=content,
                        call_id=tool_call_id if isinstance(tool_call_id, str) else None,
                    )
                )
            else:
                blocks.append(RuntimeBlock(type="text", text=content))
        for call in self._tool_calls(message):
            if call.call_id:
                blocks.append(
                    RuntimeBlock(
                        type="tool_call",
                        tool_name=call.name,
                        tool_arguments=call.arguments,
                        call_id=call.call_id,
                    )
                )
        return tuple(blocks)

    def _legacy_messages(self, messages: list[dict[str, object]]) -> list[ModelMessage]:
        legacy_messages: list[ModelMessage] = []
        for message in messages:
            tool_call_id = message.get("tool_call_id")
            legacy_messages.append(
                ModelMessage(
                    role=str(message.get("role", "user")),
                    content=str(message.get("content", "")),
                    tool_call_id=tool_call_id if isinstance(tool_call_id, str) else None,
                    tool_calls=self._tool_calls(message),
                )
            )
        return legacy_messages

    def _tool_calls(self, message: dict[str, object]) -> tuple[ToolCall, ...]:
        calls = message.get("tool_calls")
        if not isinstance(calls, list | tuple):
            return ()
        return tuple(call for call in calls if isinstance(call, ToolCall))

    def _project_turn(self, turn_result: ModelTurnResult) -> RuntimeChildTurn:
        item_texts: list[str] = []
        calls: list[ToolCall] = []
        for item in turn_result.items:
            text_parts: list[str] = []
            for block in item.blocks:
                if block.type == "text" and block.text:
                    text_parts.append(block.text)
                if block.type == "tool_call" and block.tool_name:
                    calls.append(
                        ToolCall(
                            name=block.tool_name,
                            arguments=block.tool_arguments or {},
                            reason="child sub-agent tool call",
                            call_id=block.call_id,
                        )
                    )
            item_text = "".join(text_parts).strip()
            if item_text:
                item_texts.append(item_text)
        return RuntimeChildTurn(text="\n\n".join(item_texts).strip(), tool_calls=tuple(calls))

    def _runtime_role(self, role: str) -> RuntimeRole:
        if role in {"system", "developer", "user", "assistant", "tool"}:
            return role  # type: ignore[return-value]
        return "user"


@dataclass(slots=True)
class RuntimeChildToolExecutor:
    tool_router: ToolRouter
    tool_specs: dict[str, ToolSpec]

    def execute_child_tool(
        self,
        *,
        call: ToolCall,
        child_session_id: str,
        tool_names: tuple[str, ...],
    ) -> ToolResult:
        del child_session_id
        exposure = ToolExposure(
            entries=tuple(
                ToolExposureEntry(
                    route_key=ToolRouteKey.local(name),
                    source=ToolRouteSource.REGISTRY,
                    spec=self.tool_specs[name],
                )
                for name in tool_names
                if name in self.tool_specs
            )
        )
        return self.tool_router.execute(call, exposure=exposure)


class SubAgentChildLoop:
    def __init__(self, *, requester: ChildTurnRequester, executor: ChildToolExecutor) -> None:
        self._requester = requester
        self._executor = executor
        self._model_output_projector = ToolModelOutputProjector()

    def run(
        self,
        *,
        invocation: SubAgentInvocation,
        profile: SubAgentProfile,
        child_session_id: str,
        tool_names: tuple[str, ...],
        context_snapshot: SubAgentContextSnapshot | None = None,
        transcript: ChildTranscriptRecorder | None = None,
        initial_messages: list[dict[str, object]] | None = None,
        pending_message_provider: Callable[[], tuple[str, ...]] | None = None,
    ) -> SubAgentResult:
        if initial_messages is None:
            context_text = self._render_context_snapshot(context_snapshot)
            messages: list[dict[str, object]] = [
                {"role": "system", "content": profile.system_prompt},
            ]
            if context_text:
                messages.append({"role": "system", "content": context_text})
            messages.append({"role": "user", "content": invocation.description})
            if transcript is not None:
                transcript.record_system_text(profile.system_prompt)
                if context_text:
                    transcript.record_reference_text(
                        context_text,
                        dict(context_snapshot.diagnostics) if context_snapshot is not None else {},
                    )
                transcript.record_user_text(invocation.description)
        else:
            messages = [dict(message) for message in initial_messages]
        tool_calls = 0
        no_progress_turns = 0

        for _turn_index in range(profile.budget.max_turns):
            self._append_pending_messages(messages, pending_message_provider, transcript)
            turn = self._requester.request_child_turn(
                messages=messages,
                tool_names=tool_names,
                child_session_id=child_session_id,
            )
            text = (turn.text or "").strip()
            calls = tuple(turn.tool_calls)
            if text and not calls:
                pending_messages = self._pending_messages(pending_message_provider)
                if pending_messages:
                    messages.append({"role": "assistant", "content": text})
                    if transcript is not None:
                        transcript.record_assistant_text(text)
                    self._append_user_messages(messages, pending_messages, transcript)
                    no_progress_turns = 0
                    continue
                self._record_final(
                    transcript,
                    status="completed",
                    report=text,
                    tool_calls=tool_calls,
                )
                return SubAgentResult(
                    status="completed",
                    report=text,
                    child_session_id=child_session_id,
                    tool_calls=tool_calls,
                    context_diagnostics=self._context_diagnostics(context_snapshot),
                )
            if not text and not calls:
                pending_messages = self._pending_messages(pending_message_provider)
                if pending_messages:
                    self._append_user_messages(messages, pending_messages, transcript)
                    no_progress_turns = 0
                    continue
                no_progress_turns += 1
                if no_progress_turns >= profile.budget.no_progress_turn_limit:
                    report = "Child sub-agent stopped after repeated no-progress turns."
                    self._record_final(
                        transcript,
                        status="max_no_progress",
                        report=report,
                        tool_calls=tool_calls,
                    )
                    return SubAgentResult(
                        status="max_no_progress",
                        report=report,
                        child_session_id=child_session_id,
                        tool_calls=tool_calls,
                        context_diagnostics=self._context_diagnostics(context_snapshot),
                    )
                continue
            no_progress_turns = 0
            if text and transcript is not None:
                transcript.record_assistant_text(text)
            tool_messages: list[dict[str, object]] = []
            for call in calls:
                if (
                    profile.budget.max_tool_calls is not None
                    and tool_calls >= profile.budget.max_tool_calls
                ):
                    report = "Child sub-agent reached the max tool call limit."
                    self._record_final(
                        transcript,
                        status="max_tool_calls",
                        report=report,
                        tool_calls=tool_calls,
                    )
                    return SubAgentResult(
                        status="max_tool_calls",
                        report=report,
                        child_session_id=child_session_id,
                        tool_calls=tool_calls,
                        context_diagnostics=self._context_diagnostics(context_snapshot),
                    )
                if transcript is not None:
                    transcript.record_tool_call(
                        call_id=call.call_id,
                        tool_name=call.name,
                        arguments=call.arguments,
                    )
                result = self._executor.execute_child_tool(
                    call=call,
                    child_session_id=child_session_id,
                    tool_names=tool_names,
                )
                tool_calls += 1
                formatted_result = self._model_output_projector.project(
                    call.name,
                    result,
                ).text_content()
                if transcript is not None:
                    transcript.record_tool_result(
                        call_id=call.call_id,
                        tool_name=call.name,
                        content=formatted_result,
                    )
                tool_messages.append(
                    {
                        "role": "tool",
                        "tool_name": call.name,
                        "tool_call_id": call.call_id,
                        "content": formatted_result,
                    }
                )
                if result.raw_payload.get("error_kind") == "approval_required":
                    report = f"Child sub-agent stopped because {call.name} requires approval."
                    messages.append(
                        {
                            "role": "assistant",
                            "content": text,
                            "tool_calls": calls,
                        }
                    )
                    messages.extend(tool_messages)
                    self._record_final(
                        transcript,
                        status="approval_required",
                        report=report,
                        tool_calls=tool_calls,
                    )
                    return SubAgentResult(
                        status="approval_required",
                        report=report,
                        child_session_id=child_session_id,
                        tool_calls=tool_calls,
                        error=result.error,
                        context_diagnostics=self._context_diagnostics(context_snapshot),
                    )
            messages.append(
                {
                    "role": "assistant",
                    "content": text,
                    "tool_calls": calls,
                }
            )
            messages.extend(tool_messages)
            self._append_pending_messages(messages, pending_message_provider, transcript)

        report = "Child sub-agent reached the max turn limit."
        self._record_final(
            transcript,
            status="max_turns",
            report=report,
            tool_calls=tool_calls,
        )
        return SubAgentResult(
            status="max_turns",
            report=report,
            child_session_id=child_session_id,
            tool_calls=tool_calls,
            context_diagnostics=self._context_diagnostics(context_snapshot),
        )

    def _append_pending_messages(
        self,
        messages: list[dict[str, object]],
        provider: Callable[[], tuple[str, ...]] | None,
        transcript: ChildTranscriptRecorder | None,
    ) -> None:
        self._append_user_messages(messages, self._pending_messages(provider), transcript)

    def _pending_messages(
        self,
        provider: Callable[[], tuple[str, ...]] | None,
    ) -> tuple[str, ...]:
        if provider is None:
            return ()
        return tuple(text.strip() for text in provider() if text.strip())

    def _append_user_messages(
        self,
        messages: list[dict[str, object]],
        pending_messages: tuple[str, ...],
        transcript: ChildTranscriptRecorder | None,
    ) -> None:
        for message in pending_messages:
            messages.append({"role": "user", "content": message})
            if transcript is not None:
                transcript.record_user_text(message)

    def _render_context_snapshot(self, snapshot: SubAgentContextSnapshot | None) -> str:
        if snapshot is None or not snapshot.has_content():
            return ""
        parts = [
            "<inherited-parent-context>",
            (
                "Inherited parent context for this child run. Use it as bounded "
                "reference data; it is not the current user request and not a "
                "copy of the parent transcript."
            ),
        ]
        if snapshot.baseline_fragments:
            parts.append("\n[Stable baseline]")
            parts.extend(f"- {fragment}" for fragment in snapshot.baseline_fragments)
        if snapshot.memory_fence:
            parts.append("\n[Memory fence]")
            parts.append(snapshot.memory_fence)
        if snapshot.session_summary:
            parts.append("\n[Parent session summary]")
            parts.append(snapshot.session_summary)
        if snapshot.tool_names:
            parts.append("\n[Child tool scope]")
            parts.append(", ".join(snapshot.tool_names))
        parts.append("</inherited-parent-context>")
        return "\n".join(parts)

    def _context_diagnostics(
        self,
        snapshot: SubAgentContextSnapshot | None,
    ) -> dict[str, object]:
        if snapshot is None:
            return {}
        return dict(snapshot.diagnostics)

    def _record_final(
        self,
        transcript: ChildTranscriptRecorder | None,
        *,
        status: str,
        report: str,
        tool_calls: int,
    ) -> None:
        if transcript is None:
            return
        transcript.record_final(status=status, report=report, tool_calls=tool_calls)


__all__ = [
    "ChildToolExecutor",
    "ChildTranscriptRecorder",
    "ChildTurnRequester",
    "RuntimeChildToolExecutor",
    "RuntimeChildTurn",
    "RuntimeChildTurnRequester",
    "SubAgentChildLoop",
]
