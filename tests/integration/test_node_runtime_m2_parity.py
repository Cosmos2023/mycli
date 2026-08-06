from __future__ import annotations

import json
import sqlite3
import subprocess
from pathlib import Path
from typing import Any, cast

from mycli.application.runtime.model import RuntimeModelState
from mycli.application.runtime.request import RequestShapeBuilder
from mycli.domain.conversation import Conversation, Message
from mycli.domain.model_events import ModelEvent, ModelEventType
from mycli.domain.providers import ProtocolId, ProviderId
from mycli.domain.runtime import AgentConfig, InstructionContract, ReasoningEffort, RequestShape
from mycli.domain.runtime.session_history import HistoryItem, TurnRollout
from mycli.infrastructure.providers.chat import DefaultChatProviderAdapter
from mycli.infrastructure.sqlite_session_store import SQLiteSessionStore
from mycli.llms.adapters.base import ModelAdapter
from mycli.llms.adapters.responses_adapter import ResponsesModelAdapter
from mycli.llms.clients.openai_chat import OpenAIChatClient
from mycli.services.tracing import TraceService
from mycli.state.session_serialization import deserialize_message, serialize_message
from mycli.state.session_service import SessionService
from mycli.utils.workspace_logger import WorkspaceLogService

ROOT = Path(__file__).parents[2]
FIXTURE_ROOT = ROOT / "tests" / "fixtures" / "node_runtime_m2"
NODE_HELPER = ROOT / "packages" / "storage" / "test" / "support" / "parity-helper.ts"


def test_request_projection_matches_shared_corpus() -> None:
    fixture = _load_fixture("request_projection.json")

    for scenario in fixture["cases"]:
        input_payload = scenario["input"]
        config_payload = input_payload["config"]
        reasoning_value = config_payload["reasoningEffort"]
        reasoning_enabled = reasoning_value != "none"
        config = AgentConfig(
            workspace_root=Path("/workspace"),
            provider=ProviderId(config_payload["provider"]),
            protocol=ProtocolId(config_payload["protocol"]),
            model=config_payload["model"],
            reasoning_effort=ReasoningEffort(reasoning_value if reasoning_enabled else "medium"),
            thinking_enabled=reasoning_enabled,
            thinking_effort=(
                ReasoningEffort(reasoning_value) if reasoning_enabled else None
            ),
        )
        history = tuple(
            Message(role=item["role"], content=item["content"])
            for item in input_payload["history"]
        )
        shape = RequestShapeBuilder().build(
            config=config,
            contract=InstructionContract(
                base_instructions=input_payload["instructions"],
                conversation_messages=history,
                current_user_request=input_payload["userText"],
            ),
            tools=(),
        )
        actual = {
            "provider": shape.provider,
            "protocol": shape.protocol,
            "model": shape.model,
            "reasoningEffort": _python_reasoning_effort(config),
            "instructions": shape.stable_system,
            "messages": _canonical_request_messages(shape, config.protocol),
            "tools": [],
        }
        assert actual == scenario["expected"], scenario["name"]


def _canonical_request_messages(
    shape: RequestShape,
    protocol: ProtocolId,
) -> list[dict[str, str]]:
    if protocol is ProtocolId.RESPONSES:
        messages: list[dict[str, str]] = []
        for item in shape.provider_runtime_items:
            text_parts: list[str] = []
            for block in item.blocks:
                if block.type != "text" or block.text is None:
                    raise AssertionError(
                        f"unexpected Responses request block type: {block.type}"
                    )
                text_parts.append(block.text)
            messages.append({"role": item.role, "content": "".join(text_parts)})
        return messages

    provider_messages = list(shape.provider_messages)
    if shape.stable_system:
        if not provider_messages:
            raise AssertionError("Chat request omitted its non-empty system message")
        system_message = provider_messages.pop(0)
        if system_message.role != "system" or system_message.content != shape.stable_system:
            raise AssertionError("Chat request system message diverged from stable instructions")
    return [
        {"role": message.role, "content": message.content}
        for message in provider_messages
    ]


def _python_reasoning_effort(config: AgentConfig) -> str:
    responses_client: _FixtureResponsesClient | None = None
    if config.protocol is ProtocolId.RESPONSES:
        responses_client = _FixtureResponsesClient([])
        adapter: object = ResponsesModelAdapter(responses_client)
    else:
        adapter = object.__new__(OpenAIChatClient)
    model_state = RuntimeModelState(
        model_adapter=cast(ModelAdapter, adapter),
        config=config,
        session_service=cast(SessionService, object()),
        trace_service=cast(TraceService, object()),
        workspace_log_service=cast(WorkspaceLogService, object()),
    )
    model_state.set_reasoning_effort(config.reasoning_effort)

    if responses_client is not None:
        assert responses_client.thinking_enabled is config.thinking_enabled
        return responses_client.thinking_effort or "none"
    assert isinstance(adapter, OpenAIChatClient)
    assert adapter._thinking_enabled is config.thinking_enabled  # noqa: SLF001
    return adapter._thinking_effort or "none"  # noqa: SLF001


def test_provider_event_corpus_is_sanitized_and_complete() -> None:
    fixture = _load_fixture("provider_events.json")
    assert {case["protocol"] for case in fixture["cases"]} == {
        "responses",
        "chat_completions",
    }
    for scenario in fixture["cases"]:
        if scenario["protocol"] == "responses":
            actual = _python_responses_events(scenario["raw"])
        else:
            actual = _python_chat_events(scenario["raw"])
        assert actual == scenario["expected"], scenario["name"]
        serialized = json.dumps(scenario, ensure_ascii=False).lower()
        assert "api_key" not in serialized
        assert "authorization" not in serialized


class _FixtureResponsesClient:
    def __init__(self, events: list[dict[str, object]]) -> None:
        self._events = events
        self.thinking_enabled: bool | None = None
        self.thinking_effort: str | None = None

    def create_response(
        self,
        *,
        input_items: list[dict[str, object]],
        tools: list[dict[str, object]],
        instructions: str | None = None,
        prompt_cache_key: str | None = None,
        tool_choice: str | None = None,
    ) -> dict[str, object]:
        raise AssertionError("parity fixture must use the streaming adapter path")

    def stream_response(self, **_kwargs: object) -> list[dict[str, object]]:
        return self._events

    def set_thinking_config(self, *, enabled: bool, effort: object) -> None:
        self.thinking_enabled = enabled
        value = getattr(effort, "value", effort)
        self.thinking_effort = str(value) if enabled and value is not None else None


def _python_responses_events(raw: list[dict[str, object]]) -> list[dict[str, Any]]:
    adapter = ResponsesModelAdapter(_FixtureResponsesClient(raw))
    return _canonical_provider_events(list(adapter.stream_turn(items=[], tools=[])))


def _python_chat_events(raw: list[dict[str, object]]) -> list[dict[str, Any]]:
    client = object.__new__(OpenAIChatClient)
    client._provider_adapter = DefaultChatProviderAdapter()  # noqa: SLF001
    events = list(client._events_from_chat_stream(raw))  # noqa: SLF001
    return _canonical_model_events(events)


def _canonical_provider_events(events: list[dict[str, object]]) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for event in events:
        event_type = event.get("type")
        if event_type == "reasoning":
            result.append({"type": "reasoning_delta", "text": event.get("text")})
        elif event_type == "text_delta":
            result.append({"type": "text_delta", "text": event.get("text")})
        elif event_type == "completed":
            metadata = event.get("metadata")
            usage = metadata.get("usage") if isinstance(metadata, dict) else None
            if isinstance(usage, dict):
                projected_usage = _responses_usage(usage)
                if projected_usage:
                    result.append({"type": "usage", "usage": projected_usage})
            completed: dict[str, Any] = {"type": "completed"}
            response_id = event.get("response_id")
            if isinstance(response_id, str):
                completed["responseId"] = response_id
            result.append(completed)
        else:
            raise AssertionError(f"unexpected Responses adapter event: {event_type!r}")
    return result


def _canonical_model_events(events: list[ModelEvent]) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for event in events:
        if event.type is ModelEventType.REASONING_DELTA:
            result.append({"type": "reasoning_delta", "text": event.text})
        elif event.type is ModelEventType.MESSAGE_DELTA:
            result.append({"type": "text_delta", "text": event.text})
        elif event.type is ModelEventType.TURN_COMPLETED:
            usage = _chat_usage(event.usage)
            if usage:
                result.append({"type": "usage", "usage": usage})
            completed: dict[str, Any] = {"type": "completed"}
            if isinstance(event.response_id, str):
                completed["responseId"] = event.response_id
            result.append(completed)
        else:
            raise AssertionError(f"unexpected Chat adapter event: {event.type.value}")
    return result


def _responses_usage(usage: dict[str, object]) -> dict[str, object]:
    allowed = {"input_tokens", "output_tokens", "total_tokens", "input_tokens_details"}
    unexpected = set(usage) - allowed
    if unexpected:
        raise AssertionError(f"unexpected Responses usage fields: {sorted(unexpected)}")
    projected = {
        key: usage[key]
        for key in ("input_tokens", "output_tokens", "total_tokens")
        if isinstance(usage.get(key), (int, float))
    }
    details = usage.get("input_tokens_details")
    if isinstance(details, dict):
        unexpected_details = set(details) - {"cached_tokens"}
        if unexpected_details:
            raise AssertionError(
                f"unexpected Responses usage detail fields: {sorted(unexpected_details)}"
            )
        if isinstance(details.get("cached_tokens"), (int, float)):
            projected["cached_tokens"] = details["cached_tokens"]
    return projected


def _chat_usage(usage: dict[str, object] | None) -> dict[str, object]:
    if usage is None:
        return {}
    allowed = {"prompt_tokens", "completion_tokens", "total_tokens", "prompt_tokens_details"}
    unexpected = set(usage) - allowed
    if unexpected:
        raise AssertionError(f"unexpected Chat usage fields: {sorted(unexpected)}")
    projected = {
        target: usage[source]
        for source, target in (
            ("prompt_tokens", "input_tokens"),
            ("completion_tokens", "output_tokens"),
            ("total_tokens", "total_tokens"),
        )
        if isinstance(usage.get(source), (int, float))
    }
    details = usage.get("prompt_tokens_details")
    if isinstance(details, dict):
        unexpected_details = set(details) - {"cached_tokens"}
        if unexpected_details:
            raise AssertionError(
                f"unexpected Chat usage detail fields: {sorted(unexpected_details)}"
            )
        if isinstance(details.get("cached_tokens"), (int, float)):
            projected["cached_tokens"] = details["cached_tokens"]
    return projected


def test_python_and_node_read_each_others_sqlite_records(tmp_path: Path) -> None:
    fixture = _load_fixture("session_records.json")
    expected = _expected_records(fixture)

    python_db = tmp_path / "python-sessions.db"
    _write_python_sessions(python_db, fixture)
    assert _read_python_sessions(python_db, fixture) == expected
    assert _run_node_helper("read", python_db) == expected
    assert _runtime_turn_rows(python_db) == []

    node_db = tmp_path / "node-sessions.db"
    assert _run_node_helper("write", node_db) == expected
    runtime_turns = _runtime_turn_rows(node_db)
    assert runtime_turns == [
        {
            "session_id": scenario["session_id"],
            "client_turn_id": scenario["client_turn_id"],
            "turn_id": scenario["turn_id"],
            "request_fingerprint": scenario["request_fingerprint"],
            "status": scenario["status"],
            "error_code": scenario["error_code"],
        }
        for scenario in fixture["sessions"]
    ]
    assert _read_python_sessions(node_db, fixture) == expected
    assert _runtime_turn_rows(node_db) == runtime_turns


def _load_fixture(name: str) -> dict[str, Any]:
    return cast(
        dict[str, Any],
        json.loads((FIXTURE_ROOT / name).read_text(encoding="utf-8")),
    )


def _run_node_helper(action: str, db_path: Path) -> list[dict[str, Any]]:
    result = subprocess.run(
        ["node", "--import", "tsx", str(NODE_HELPER), action, str(db_path)],
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
    )
    return cast(list[dict[str, Any]], json.loads(result.stdout))


def _runtime_turn_rows(db_path: Path) -> list[dict[str, Any]]:
    with sqlite3.connect(db_path) as connection:
        connection.row_factory = sqlite3.Row
        rows = connection.execute(
            """
            SELECT session_id, client_turn_id, turn_id, request_fingerprint, status, error_code
            FROM runtime_turns
            ORDER BY session_id
            """
        ).fetchall()
    return [dict(row) for row in rows]


def _write_python_sessions(db_path: Path, fixture: dict[str, Any]) -> None:
    store = SQLiteSessionStore(db_path)
    service = SessionService(
        home_dir=db_path.parent,
        workspace_root=Path("/workspace"),
        session_store=store,
    )
    for scenario in fixture["sessions"]:
        expected = _expected_record(scenario)
        service.save_conversation(
            Conversation(
                session_id=scenario["session_id"],
                messages=[
                    deserialize_message(item)
                    for item in expected["raw_conversation"]
                ],
            )
        )
        service.append_history_items(
            scenario["session_id"],
            tuple(HistoryItem.from_dict(item) for item in expected["history_items"]),
        )
        service.append_turn_rollout(
            scenario["session_id"],
            TurnRollout.from_dict(expected["turn_rollouts"][0]),
        )


def _read_python_sessions(
    db_path: Path,
    fixture: dict[str, Any],
) -> list[dict[str, Any]]:
    store = SQLiteSessionStore(db_path)
    service = SessionService(
        home_dir=db_path.parent,
        workspace_root=Path("/workspace"),
        session_store=store,
    )
    records: list[dict[str, Any]] = []
    for scenario in fixture["sessions"]:
        conversation = service.load_conversation(
            scenario["session_id"],
            repair_snapshot=False,
        )
        raw_conversation = [serialize_message(message) for message in conversation.messages]
        records.append(
            {
                "session_id": scenario["session_id"],
                "conversation": [
                    {"role": message.role, "content": message.content}
                    for message in conversation.messages
                ],
                "raw_conversation": raw_conversation,
                "history_items": [
                    item.to_dict() for item in service.load_history_items(scenario["session_id"])
                ],
                "turn_rollouts": [
                    rollout.to_dict()
                    for rollout in service.load_turn_rollouts(scenario["session_id"])
                ],
            }
        )
    return records


def _expected_records(fixture: dict[str, Any]) -> list[dict[str, Any]]:
    return [_expected_record(scenario) for scenario in fixture["sessions"]]


def _expected_record(scenario: dict[str, Any]) -> dict[str, Any]:
    user_message = {
        "role": "user",
        "content": scenario["user_text"],
        "tool_call_id": None,
        "response_id": None,
        "metadata": {
            "turn_id": scenario["turn_id"],
            "client_turn_id": scenario["client_turn_id"],
            "client_user_message_id": scenario["client_turn_id"],
            "source": "submit",
        },
        "blocks": [],
        "tool_calls": [],
    }
    user_history = {
        "id": f'{scenario["turn_id"]}:user:{scenario["client_turn_id"]}',
        "thread_id": scenario["thread_id"],
        "turn_id": scenario["turn_id"],
        "type": "user_message",
        "text": scenario["user_text"],
        "tool_name": None,
        "call_id": None,
        "metadata": {
            "client_turn_id": scenario["client_turn_id"],
            "client_user_message_id": scenario["client_turn_id"],
            "source": "submit",
            "image_paths": [],
        },
    }
    raw_conversation = [user_message]
    conversation = [{"role": "user", "content": scenario["user_text"]}]
    history_items = [user_history]
    continuation_state: dict[str, Any] = {}
    if scenario["status"] == "completed":
        raw_conversation.append(
            {
                "role": "assistant",
                "content": scenario["assistant_text"],
                "tool_call_id": None,
                "response_id": scenario["response_id"],
                "metadata": {"turn_id": scenario["turn_id"], "source": "node_runtime"},
                "blocks": [],
                "tool_calls": [],
            }
        )
        conversation.append({"role": "assistant", "content": scenario["assistant_text"]})
        history_items.append(
            {
                "id": f'{scenario["turn_id"]}:assistant:1',
                "thread_id": scenario["thread_id"],
                "turn_id": scenario["turn_id"],
                "type": "assistant_message",
                "text": scenario["assistant_text"],
                "tool_name": None,
                "call_id": None,
                "metadata": {
                    "source": "node_runtime",
                    "response_id": scenario["response_id"],
                },
            }
        )
        continuation_state = {
            "response_id": scenario["response_id"],
            "usage": scenario["usage"],
        }
    return {
        "session_id": scenario["session_id"],
        "conversation": conversation,
        "raw_conversation": raw_conversation,
        "history_items": history_items,
        "turn_rollouts": [
            {
                "thread_id": scenario["thread_id"],
                "turn_id": scenario["turn_id"],
                "status": scenario["status"],
                "started_at": scenario["started_at"],
                "completed_at": scenario["completed_at"],
                "stop_reason": scenario["stop_reason"],
                "events": [],
                "continuation_state": continuation_state,
            }
        ],
    }
