from __future__ import annotations

from pathlib import Path

from mycli.application.runtime.agent_runtime import AgentRuntime
from mycli.domain.conversation import Conversation, Message
from mycli.domain.providers import ProtocolId, ProviderId
from mycli.domain.runtime import (
    AgentConfig,
    ModelTurnResult,
    ProviderMessageShape,
    ProviderProjectionLane,
    ProviderProjectionShape,
    ProviderRuntimeItemShape,
    RequestShape,
    RuntimeBlock,
    RuntimeItem,
    RuntimeStreamEvent,
    StopReason,
)
from mycli.domain.tooling.calls import ToolCall
from mycli.llms.adapters.base import ModelAction, ModelAdapter, ModelMessage, ModelToolDefinition
from mycli.llms import ModelResponseError
from mycli.services.context.compaction import CompactPhase, CompactReason
from mycli.tools.registry import ToolRegistry


class DoneAdapter(ModelAdapter):
    def next_action(
        self,
        *,
        messages: list[ModelMessage],
        tools: list[ModelToolDefinition],
    ) -> ModelAction:
        return ModelAction(assistant_message="done", done=True)


class RuntimeItemSummarizerAdapter:
    def __init__(self) -> None:
        self.seen_items: list[list[RuntimeItem]] = []

    def next_action(
        self,
        *,
        messages: list[ModelMessage],
        tools: list[ModelToolDefinition],
    ) -> ModelAction:
        del messages, tools
        return ModelAction(assistant_message="unused", done=True)

    def next_turn(
        self,
        *,
        items: list[RuntimeItem],
        tools: list[ModelToolDefinition],
    ) -> ModelTurnResult:
        del tools
        self.seen_items.append(items)
        return ModelTurnResult(
            items=(
                RuntimeItem(
                    role="assistant",
                    blocks=(RuntimeBlock(type="text", text="summary"),),
                ),
            ),
            done=True,
        )


class SummarizingDoneAdapter(ModelAdapter):
    def __init__(self) -> None:
        self.summarizer_prompts: list[str] = []
        self.main_requests: list[list[ModelMessage]] = []

    def next_action(
        self,
        *,
        messages: list[ModelMessage],
        tools: list[ModelToolDefinition],
    ) -> ModelAction:
        if not tools and messages and "Summarize this conversation" in messages[0].content:
            self.summarizer_prompts.append(messages[0].content)
            return ModelAction(
                assistant_message="## 1. Primary Request\nFull-context L4 summary.",
                done=True,
            )

        self.main_requests.append(messages)
        return ModelAction(assistant_message="done", done=True)


class SummarizingToolThenDoneAdapter(ModelAdapter):
    def __init__(self) -> None:
        self.summarizer_prompts: list[str] = []
        self.main_requests: list[list[ModelMessage]] = []

    def next_action(
        self,
        *,
        messages: list[ModelMessage],
        tools: list[ModelToolDefinition],
    ) -> ModelAction:
        if not tools and messages and "Summarize this conversation" in messages[0].content:
            self.summarizer_prompts.append(messages[0].content)
            return ModelAction(
                assistant_message="## 1. Primary Request\nFull-context L4 summary.",
                done=True,
            )

        self.main_requests.append(messages)
        if len(self.main_requests) == 1:
            return ModelAction(
                progress_message="Inspecting after compaction",
                tool_call=ToolCall(
                    call_id="call_ls_after_compaction",
                    name="LS",
                    arguments={"path": "."},
                    reason="verify compacted turn can continue",
                ),
                done=False,
            )
        return ModelAction(assistant_message="done", done=True)


class ThinkingAwareSummarizingAdapter(ModelAdapter):
    def __init__(self) -> None:
        self.current_thinking: tuple[bool, object] | None = None
        self.current_model = "deepseek-v4-flash"
        self.current_max_output_tokens = 8192
        self.summarizer_requests: list[
            tuple[tuple[bool, object] | None, int, str, int]
        ] = []
        self.main_requests: list[tuple[tuple[bool, object] | None, int, str, int]] = []

    def set_thinking_config(self, *, enabled: bool, effort: object) -> None:
        self.current_thinking = (enabled, effort)

    def set_model(self, model: str) -> None:
        self.current_model = model

    def set_max_output_tokens(self, value: int) -> None:
        self.current_max_output_tokens = value

    def reset_max_output_tokens(self) -> None:
        self.current_max_output_tokens = 8192

    def next_action(
        self,
        *,
        messages: list[ModelMessage],
        tools: list[ModelToolDefinition],
    ) -> ModelAction:
        if not tools and messages and "Summarize this conversation" in messages[0].content:
            self.summarizer_requests.append(
                (
                    self.current_thinking,
                    len(tools),
                    self.current_model,
                    self.current_max_output_tokens,
                )
            )
            return ModelAction(
                assistant_message="## 1. Primary Request\nFull-context L4 summary.",
                done=True,
            )

        self.main_requests.append(
            (
                self.current_thinking,
                len(tools),
                self.current_model,
                self.current_max_output_tokens,
            )
        )
        return ModelAction(assistant_message="done", done=True)


class ContextWindowThenReactiveSummaryAdapter(ModelAdapter):
    def __init__(self) -> None:
        self.main_requests: list[list[ModelMessage]] = []
        self.summarizer_prompts: list[str] = []

    def next_action(
        self,
        *,
        messages: list[ModelMessage],
        tools: list[ModelToolDefinition],
    ) -> ModelAction:
        if not tools and messages and "Summarize this conversation" in messages[0].content:
            self.summarizer_prompts.append(messages[0].content)
            return ModelAction(
                assistant_message="## 1. Primary Request\nReactive summary.",
                done=True,
            )
        self.main_requests.append(messages)
        if len(self.main_requests) <= 2:
            raise ModelResponseError(
                "prompt is too long",
                stop_reason=StopReason.CONTEXT_WINDOW_EXCEEDED,
                failure_kind="context_window_exceeded",
            )
        return ModelAction(assistant_message="recovered", done=True)


def test_agent_runtime_compact_provider_has_summarizer_client(tmp_path: Path) -> None:
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=DoneAdapter(),
    )

    provider = runtime._compact_service._provider

    assert provider._summarizer_client is not None
    assert provider._model_name is not None


def test_agent_runtime_compact_status_prefers_provider_usage_pre_turn(
    tmp_path: Path,
) -> None:
    runtime = AgentRuntime(
        model_adapter=DoneAdapter(),
        tool_registry=ToolRegistry.from_tools([]),
        config=AgentConfig(
            workspace_root=tmp_path,
            max_prompt_tokens=100_000,
            compaction_token_limit=87_000,
        ),
        home_dir=tmp_path / "home",
    )
    runtime._latest_provider_input_tokens = 86_000
    request_shape = RequestShape(
        provider="openai",
        protocol="responses",
        model="gpt-test",
        stable_system="system",
        provider_messages=(
            ProviderMessageShape(role="user", content="token " * 90_000),
        ),
    )

    status = runtime._compact_token_status(request_shape=request_shape)
    decision = runtime._compact_trigger_policy.pre_turn(status)

    assert status.provider_input_tokens == 86_000
    assert status.estimated_request_tokens > 87_000
    assert decision.should_compact is False


def test_agent_runtime_compacts_active_history_with_canonical_service(
    tmp_path: Path,
) -> None:
    adapter = SummarizingDoneAdapter()
    runtime = AgentRuntime(
        model_adapter=adapter,
        tool_registry=ToolRegistry.from_tools([]),
        config=AgentConfig(
            workspace_root=tmp_path,
            max_prompt_tokens=100,
            compaction_token_limit=80,
            compaction_tail_turns=2,
            compaction_tail_max_tokens=2_000,
        ),
        home_dir=tmp_path / "home",
    )
    conversation = Conversation(
        session_id=runtime._config.session_id,
        messages=[
            Message(role="user", content="first request"),
            Message(role="assistant", content="first answer"),
            Message(role="user", content="second request"),
            Message(role="assistant", content="second answer"),
            Message(role="user", content="third request"),
            Message(role="assistant", content="third answer"),
        ],
    )
    runtime._latest_provider_input_tokens = 90
    decision = runtime._compact_trigger_policy.forced(
        reason=CompactReason.CONTEXT_LIMIT,
        phase=CompactPhase.PRE_TURN,
        trigger_tokens=90,
    )

    result = runtime._compact_active_history(conversation, decision=decision)

    assert [(message.role, message.content) for message in result.messages[1:]] == [
        ("user", "second request"),
        ("assistant", "second answer"),
        ("user", "third request"),
        ("assistant", "third answer"),
    ]
    assert result.messages[0].role == "user"
    assert result.messages[0].metadata["compaction"] is True
    assert runtime._latest_provider_input_tokens is None


def test_agent_runtime_mid_turn_compact_preserves_current_tool_suffix(
    tmp_path: Path,
) -> None:
    adapter = SummarizingDoneAdapter()
    runtime = AgentRuntime(
        model_adapter=adapter,
        tool_registry=ToolRegistry.from_tools([]),
        config=AgentConfig(
            workspace_root=tmp_path,
            compaction_token_limit=80,
            compaction_tail_turns=2,
            compaction_tail_max_tokens=2_000,
        ),
        home_dir=tmp_path / "home",
    )
    current_call = ToolCall(
        name="Read",
        arguments={"file_path": "README.md"},
        reason="inspect",
        call_id="call_current",
    )
    current_suffix = [
        Message(role="user", content="current request"),
        Message(role="assistant", content="", tool_calls=(current_call,)),
        Message(role="tool", content="current result", tool_call_id="call_current"),
    ]
    conversation = Conversation(
        session_id=runtime._config.session_id,
        messages=[
            Message(role="user", content="first request"),
            Message(role="assistant", content="first answer"),
            Message(role="user", content="second request"),
            Message(role="assistant", content="second answer"),
            Message(role="user", content="third request"),
            Message(role="assistant", content="third answer"),
            *current_suffix,
        ],
    )
    decision = runtime._compact_trigger_policy.forced(
        reason=CompactReason.MID_TURN_LIMIT,
        phase=CompactPhase.MID_TURN,
        trigger_tokens=90,
    )

    result = runtime._compact_active_history(conversation, decision=decision)

    assert result.messages[-3:] == current_suffix
    assert result.messages[-1].tool_call_id == "call_current"


def test_agent_runtime_manual_compact_does_not_append_slash_message(
    tmp_path: Path,
) -> None:
    runtime = AgentRuntime(
        model_adapter=SummarizingDoneAdapter(),
        tool_registry=ToolRegistry.from_tools([]),
        config=AgentConfig(workspace_root=tmp_path, compaction_token_limit=80),
        home_dir=tmp_path / "home",
    )
    conversation = Conversation(
        session_id=runtime._config.session_id,
        messages=[
            Message(role="user", content="first request"),
            Message(role="assistant", content="first answer"),
            Message(role="user", content="second request"),
            Message(role="assistant", content="second answer"),
            Message(role="user", content="third request"),
            Message(role="assistant", content="third answer"),
        ],
    )
    runtime._session_service.save_conversation(conversation)
    history_before = runtime._session_service.load_history_items(runtime._config.session_id)

    result = runtime.compact_session()

    active = runtime._session_service.load_conversation(runtime._config.session_id)
    assert result["status"] == "compressed"
    assert active.messages[0].metadata["compaction"] is True
    assert all(message.content != "/compact" for message in active.messages)
    assert runtime._session_service.load_history_items(runtime._config.session_id) == history_before


def test_agent_runtime_compact_model_falls_back_to_main_model(
    tmp_path: Path,
) -> None:
    runtime = AgentRuntime(
        model_adapter=DoneAdapter(),
        tool_registry=ToolRegistry.from_tools([]),
        config=AgentConfig(workspace_root=tmp_path, model="main-model"),
        home_dir=tmp_path / "home",
    )

    provider = runtime._compact_service._provider

    assert provider._model_name == "main-model"


def test_agent_runtime_compact_uses_configured_summarizer_model(
    tmp_path: Path,
) -> None:
    runtime = AgentRuntime(
        model_adapter=DoneAdapter(),
        tool_registry=ToolRegistry.from_tools([]),
        config=AgentConfig(
            workspace_root=tmp_path,
            model="main-model",
            compaction_l4_summarizer_model="summary-model",
        ),
        home_dir=tmp_path / "home",
    )

    provider = runtime._compact_service._provider

    assert provider._model_name == "summary-model"


def test_agent_runtime_compact_provider_sends_runtime_items(
    tmp_path: Path,
) -> None:
    adapter = RuntimeItemSummarizerAdapter()
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=adapter,
    )

    output = runtime._compact_service._provider.compact(
        (Message(role="user", content="summarize this"),)
    )

    assert output[0].content == "summary"
    assert adapter.seen_items
    assert adapter.seen_items[0]
    assert "Summarize this conversation" in (adapter.seen_items[0][0].blocks[0].text or "")


def test_agent_runtime_request_budget_uses_wire_payload_for_chat_completions(
    tmp_path: Path,
) -> None:
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=DoneAdapter(),
    )
    wire_content = "wire " * 100
    diagnostic_mirror = "diagnostic " * 20_000
    shape = RequestShape(
        provider="deepseek",
        protocol="chat_completions",
        model="deepseek-v4-flash",
        stable_system="system",
        provider_messages=(
            ProviderMessageShape(role="system", content="system"),
            ProviderMessageShape(role="user", content=wire_content),
        ),
        provider_runtime_items=(
            ProviderRuntimeItemShape(
                role="user",
                blocks=(RuntimeBlock(type="text", text=diagnostic_mirror),),
            ),
        ),
        provider_projection=ProviderProjectionShape(
            lane=ProviderProjectionLane.CHAT_COMPLETIONS,
            message_count=2,
            runtime_item_count=1,
            cacheable_prefix_fragment_count=0,
            first_dynamic_fragment_index=None,
            first_ephemeral_fragment_index=None,
            cache_hint=None,
        ),
    )

    estimated = runtime._estimate_request_window_budget(shape)

    assert estimated.total_tokens < 1_000


def test_agent_runtime_l4_triggers_from_full_provider_request_budget(
    tmp_path: Path,
) -> None:
    adapter = SummarizingDoneAdapter()
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=adapter,
    )
    runtime.rebind_session(
        AgentConfig(
            workspace_root=tmp_path,
            provider=ProviderId.DEEPSEEK,
            protocol=ProtocolId.CHAT_COMPLETIONS,
            model="deepseek-v4-flash",
            max_prompt_tokens=10_000,
            compaction_l4_trigger_ratio=0.5,
            session_id="compaction-events",
        )
    )
    conversation = Conversation(session_id=runtime._config.session_id)
    for index in range(36):
        conversation.append(
            Message(
                role="user" if index % 2 == 0 else "assistant",
                content=f"message {index} " + ("token " * 80),
            )
        )
    conversation_budget = runtime._estimate_window_budget(conversation)
    runtime._session_service.save_conversation(conversation)

    response = runtime.handle_user_turn("finish from the current context")

    assert response.assistant_message == "done"
    assert conversation_budget.usage_ratio < runtime._config.compaction_l4_trigger_ratio
    assert len(adapter.summarizer_prompts) == 1
    assert adapter.main_requests
    rendered_main_request = "\n".join(message.content for message in adapter.main_requests[0])
    assert "Full-context L4 summary." in rendered_main_request
    assert "[user]\nfinish from the current context" not in adapter.summarizer_prompts[0]
    assert any(
        message.role == "user" and "Full-context L4 summary." in message.content
        for message in adapter.main_requests[0]
    )
    assert "Conversation summarized. All key decisions preserved" not in rendered_main_request
    persisted = runtime._session_service.load_conversation(runtime._config.session_id)
    summaries = [
        message for message in persisted.messages if message.metadata.get("compaction") is True
    ]
    assert len(summaries) == 1
    assert summaries[0].role == "user"
    assert not any(
        message.metadata.get("compaction_continuation") is True
        for message in persisted.messages
    )
    snapshot = runtime._observability_service.snapshot()
    assert snapshot.l4_last_decision == "summarize"
    assert snapshot.l4_last_source == "pre_turn"


def test_agent_runtime_emits_compaction_activity_before_continuing_model_turn(
    tmp_path: Path,
) -> None:
    adapter = SummarizingDoneAdapter()
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=adapter,
    )
    runtime.rebind_session(
        AgentConfig(
            workspace_root=tmp_path,
            provider=ProviderId.DEEPSEEK,
            protocol=ProtocolId.CHAT_COMPLETIONS,
            model="deepseek-v4-flash",
            max_prompt_tokens=10_000,
            compaction_l4_trigger_ratio=0.5,
            session_id="compaction-event-stream",
        )
    )
    conversation = Conversation(session_id=runtime._config.session_id)
    for index in range(36):
        conversation.append(
            Message(
                role="user" if index % 2 == 0 else "assistant",
                content=f"message {index} " + ("token " * 80),
            )
        )
    runtime._session_service.save_conversation(conversation)
    stream_events: list[RuntimeStreamEvent] = []

    response = runtime.handle_user_turn(
        "finish from the current context",
        stream_sink=stream_events.append,
    )

    assert response.assistant_message == "done"
    compaction_events = [
        event for event in stream_events if event.kind.startswith("compaction_")
    ]
    assert [event.kind for event in compaction_events] == [
        "compaction_started",
        "compaction_completed",
    ]
    assert compaction_events[0].metadata["source"] == "pre_turn"
    assert compaction_events[0].metadata["reason"] == "context_limit"
    assert compaction_events[0].metadata["phase"] == "pre_turn"
    assert compaction_events[1].metadata["status"] == "compressed"
    assert (
        compaction_events[1].metadata["after_tokens"]
        < compaction_events[1].metadata["before_tokens"]
    )
    assert adapter.main_requests
    rendered_main_request = "\n".join(message.content for message in adapter.main_requests[0])
    assert "Full-context L4 summary." in rendered_main_request
    assert any(event.kind == "compaction" for event in response.activity_events)


def test_agent_runtime_appends_followup_tools_to_compacted_conversation(
    tmp_path: Path,
) -> None:
    adapter = SummarizingToolThenDoneAdapter()
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=adapter,
    )
    runtime.rebind_session(
        AgentConfig(
            workspace_root=tmp_path,
            provider=ProviderId.DEEPSEEK,
            protocol=ProtocolId.CHAT_COMPLETIONS,
            model="deepseek-v4-flash",
            max_prompt_tokens=10_000,
            compaction_l4_trigger_ratio=0.5,
        )
    )
    conversation = Conversation(session_id=runtime._config.session_id)
    for index in range(36):
        conversation.append(
            Message(
                role="user" if index % 2 == 0 else "assistant",
                content=f"message {index} " + ("token " * 80),
            )
        )
    runtime._session_service.save_conversation(conversation)

    response = runtime.handle_user_turn("continue after compaction")

    assert response.assistant_message == "done"
    assert len(adapter.main_requests) == 2
    second_request_text = "\n".join(message.content for message in adapter.main_requests[1])
    assert "Full-context L4 summary." in second_request_text
    assert "message 0 token" not in second_request_text


def test_agent_runtime_compaction_does_not_rehydrate_recent_file_snapshot(
    tmp_path: Path,
) -> None:
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "target.py").write_text(
        "VALUE = 'current after compaction'\n",
        encoding="utf-8",
    )
    adapter = SummarizingDoneAdapter()
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=adapter,
    )
    runtime.rebind_session(
        AgentConfig(
            workspace_root=tmp_path,
            provider=ProviderId.DEEPSEEK,
            protocol=ProtocolId.CHAT_COMPLETIONS,
            model="deepseek-v4-flash",
            max_prompt_tokens=10_000,
            compaction_l4_trigger_ratio=0.5,
        )
    )
    conversation = Conversation(session_id=runtime._config.session_id)
    for index in range(34):
        conversation.append(
            Message(
                role="user" if index % 2 == 0 else "assistant",
                content=f"message {index} " + ("token " * 80),
            )
        )
    conversation.append(
        Message(
            role="tool",
            content="read src/target.py",
            metadata={"tool_name": "Read", "path": "src/target.py"},
        )
    )
    conversation.append(Message(role="assistant", content="noted"))
    runtime._session_service.save_conversation(conversation)

    response = runtime.handle_user_turn("finish from compacted context")

    assert response.assistant_message == "done"
    main_request_text = "\n".join(message.content for message in adapter.main_requests[-1])
    assert "[Compaction file rehydration]" not in main_request_text
    assert "VALUE = 'current after compaction'" not in main_request_text
    persisted = runtime._session_service.load_conversation(runtime._config.session_id)
    assert not any(
        "VALUE = 'current after compaction'" in message.content
        for message in persisted.messages
        if message.metadata.get("compaction") is True
    )


def test_agent_runtime_traces_bounded_compaction_lifecycle(
    tmp_path: Path,
) -> None:
    adapter = SummarizingDoneAdapter()
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=adapter,
    )
    runtime.rebind_session(
        AgentConfig(
            workspace_root=tmp_path,
            provider=ProviderId.DEEPSEEK,
            protocol=ProtocolId.CHAT_COMPLETIONS,
            model="deepseek-v4-flash",
            max_prompt_tokens=10_000,
            compaction_l4_trigger_ratio=0.5,
            session_id="p7b-trace",
        )
    )
    conversation = Conversation(session_id=runtime._config.session_id)
    for index in range(36):
        conversation.append(
            Message(
                role="user" if index % 2 == 0 else "assistant",
                content=f"message {index} " + ("token " * 80),
            )
        )
    runtime._session_service.save_conversation(conversation)

    response = runtime.handle_user_turn("finish from compacted context")

    assert response.assistant_message == "done"
    trace = runtime._trace_service.load(runtime._config.session_id)
    before = [event for event in trace if event.kind == "before_compact"]
    after = [event for event in trace if event.kind == "after_compact"]
    assert before
    assert after
    assert before[0].payload["source"] == "pre_turn"
    assert before[0].payload["before_message_count"] >= 36
    assert before[0].payload["usage_ratio"] > 0
    assert "message 0 token" not in str(before[0].payload)
    summarized = next(event for event in after if event.payload.get("decision") == "summarize")
    assert summarized.payload["after_message_count"] < summarized.payload["before_message_count"]
    assert summarized.payload["reason"] == "context_limit"
    assert summarized.payload["phase"] == "pre_turn"
    assert summarized.payload["removed_items"] > 0
    assert summarized.payload["retained_turns"] == 2
    assert "Full-context L4 summary" not in str(summarized.payload)


def test_agent_runtime_reactive_compacts_once_after_context_window_error(
    tmp_path: Path,
) -> None:
    adapter = ContextWindowThenReactiveSummaryAdapter()
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=adapter,
    )
    runtime.rebind_session(
        AgentConfig(
            workspace_root=tmp_path,
            provider=ProviderId.DEEPSEEK,
            protocol=ProtocolId.CHAT_COMPLETIONS,
            model="deepseek-v4-flash",
            max_prompt_tokens=100_000,
            compaction_l4_trigger_ratio=0.95,
            session_id="reactive-overflow",
        )
    )
    conversation = Conversation(session_id=runtime._config.session_id)
    for index in range(20):
        conversation.append(
            Message(
                role="user" if index % 2 == 0 else "assistant",
                content=f"message {index} " + ("token " * 50),
            )
        )
    runtime._session_service.save_conversation(conversation)

    response = runtime.handle_user_turn("recover from provider overflow")

    assert response.assistant_message == "recovered"
    assert len(adapter.summarizer_prompts) == 1
    assert len(adapter.main_requests) == 3
    retry_text = "\n".join(message.content for message in adapter.main_requests[-1])
    assert "Reactive summary." in retry_text
    snapshot = runtime._observability_service.snapshot()
    assert snapshot.l4_last_decision == "summarize"
    assert snapshot.l4_last_source == "reactive_error"


def test_agent_runtime_l4_summarizer_disables_thinking_and_tools(
    tmp_path: Path,
) -> None:
    adapter = ThinkingAwareSummarizingAdapter()
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=adapter,
    )
    runtime.rebind_session(
        AgentConfig(
            workspace_root=tmp_path,
            provider=ProviderId.DEEPSEEK,
            protocol=ProtocolId.CHAT_COMPLETIONS,
            model="deepseek-v4-flash",
            max_prompt_tokens=10_000,
            compaction_l4_trigger_ratio=0.5,
        )
    )
    conversation = Conversation(session_id=runtime._config.session_id)
    for index in range(36):
        conversation.append(
            Message(
                role="user" if index % 2 == 0 else "assistant",
                content=f"message {index} " + ("token " * 80),
            )
        )
    runtime._session_service.save_conversation(conversation)

    response = runtime.handle_user_turn("finish from the current context")

    assert response.assistant_message == "done"
    assert adapter.summarizer_requests
    assert adapter.summarizer_requests[0] == (
        (False, None),
        0,
        "deepseek-v4-flash",
        600,
    )
    assert adapter.main_requests
    main_thinking, main_tool_count, main_model, main_max_output_tokens = adapter.main_requests[0]
    assert main_thinking is not None
    assert main_thinking[0] is True
    assert main_tool_count > 0
    assert main_model == "deepseek-v4-flash"
    assert main_max_output_tokens == 8192
