from __future__ import annotations

from collections.abc import Mapping
from threading import Event, Thread
from time import monotonic
from typing import Any

from mycli.domain.conversation import Conversation
from mycli.domain.runtime import PlanState, RuntimeInterruptToken
from mycli.services.mcp import McpClient, McpServerConfig, McpToolAdapter, McpToolContributionProvider


class FakeTransport:
    def __init__(self, responses: Mapping[str, Any]) -> None:
        self.responses = dict(responses)

    def request(self, payload: dict[str, Any], *, timeout_seconds: float) -> dict[str, Any]:
        del timeout_seconds
        return dict(self.responses[str(payload["method"])])


class BlockingToolListTransport:
    def __init__(self) -> None:
        self.started = Event()

    def request(
        self,
        payload: dict[str, Any],
        *,
        timeout_seconds: float,
        interrupt_token: RuntimeInterruptToken | None = None,
    ) -> dict[str, Any]:
        del timeout_seconds
        if payload["method"] == "initialize":
            return {"protocolVersion": "2025-03-26"}
        self.started.set()
        assert interrupt_token is not None
        interrupt_token.wait(2)
        interrupt_token.raise_if_interrupted()
        return {"tools": []}


class BlockingInitializedNotificationTransport:
    def __init__(self) -> None:
        self.started = Event()

    def request(
        self,
        payload: dict[str, Any],
        *,
        timeout_seconds: float,
        interrupt_token: RuntimeInterruptToken | None = None,
    ) -> dict[str, Any]:
        del timeout_seconds, interrupt_token
        if payload["method"] == "initialize":
            return {"protocolVersion": "2025-03-26"}
        return {"tools": []}

    def notify(
        self,
        payload: dict[str, Any],
        *,
        timeout_seconds: float,
        interrupt_token: RuntimeInterruptToken | None = None,
    ) -> None:
        del payload, timeout_seconds
        self.started.set()
        if interrupt_token is None:
            Event().wait(2)
            return
        interrupt_token.wait(2)
        interrupt_token.raise_if_interrupted()


def test_mcp_tool_contribution_provider_returns_hydrated_thread_tools() -> None:
    client = McpClient(
        McpServerConfig(name="fs", transport="stdio", command="mcp"),
        transport=FakeTransport(
            {
                "initialize": {"protocolVersion": "2025-03-26"},
                "tools/list": {
                    "tools": [
                        {
                            "name": "search",
                            "description": "Search files",
                            "inputSchema": {
                                "type": "object",
                                "properties": {"query": {"type": "string"}},
                                "required": ["query"],
                            },
                        }
                    ]
                },
            }
        ),
    )
    provider = McpToolContributionProvider(McpToolAdapter({"fs": client}))

    registrations = provider.provide(
        user_message="search docs",
        conversation=Conversation(session_id="demo"),
        plan_state=PlanState(),
    )

    assert registrations[0].descriptor.route_name == "mcp_fs_search"
    assert registrations[0].descriptor.spec.parameters[0].name == "query"


def test_mcp_tool_contribution_discovery_forwards_turn_interrupt() -> None:
    transport = BlockingToolListTransport()
    client = McpClient(
        McpServerConfig(name="fs", transport="stdio", command="mcp"),
        transport=transport,
    )
    provider = McpToolContributionProvider(McpToolAdapter({"fs": client}))
    token = RuntimeInterruptToken(source="test")
    failures: list[BaseException] = []

    def discover() -> None:
        try:
            provider.provide(
                user_message="search docs",
                conversation=Conversation(session_id="demo"),
                plan_state=PlanState(),
                interrupt_token=token,
            )
        except BaseException as exc:
            failures.append(exc)

    worker = Thread(target=discover, daemon=True)
    worker.start()
    assert transport.started.wait(0.5)

    interrupted_at = monotonic()
    token.request_nonblocking("user_interrupt")
    worker.join(timeout=0.3)

    assert not worker.is_alive()
    assert monotonic() - interrupted_at < 0.3
    assert len(failures) == 1
    assert isinstance(failures[0], KeyboardInterrupt)


def test_mcp_initialization_notification_forwards_turn_interrupt() -> None:
    transport = BlockingInitializedNotificationTransport()
    client = McpClient(
        McpServerConfig(name="fs", transport="stdio", command="mcp"),
        transport=transport,
    )
    token = RuntimeInterruptToken(source="test")
    failures: list[BaseException] = []

    def discover() -> None:
        try:
            client.list_tools(interrupt_token=token)
        except BaseException as exc:
            failures.append(exc)

    worker = Thread(target=discover, daemon=True)
    worker.start()
    assert transport.started.wait(0.5)

    token.request_nonblocking("user_interrupt")
    worker.join(timeout=0.3)

    assert not worker.is_alive()
    assert len(failures) == 1
    assert isinstance(failures[0], KeyboardInterrupt)
