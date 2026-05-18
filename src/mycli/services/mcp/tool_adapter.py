from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from mycli.domain.tooling.calls import ToolCall
from mycli.domain.tooling.contributed_tools import (
    ToolContributionDescriptor,
    ToolContributionLifecycleState,
    ToolContributionRegistration,
    ToolContributionScope,
    ToolContributionSource,
)
from mycli.domain.tooling.exposure import ToolRouteKey
from mycli.services.mcp.client import McpClient, McpToolDescriptor
from mycli.tools.base import ToolResult, ToolSpec


@dataclass(slots=True)
class _McpSchemaTool:
    client: McpClient
    descriptor: McpToolDescriptor
    spec: ToolSpec

    def execute(self, arguments: dict[str, Any]) -> ToolResult:
        result = self.client.call_tool(self.descriptor.name, arguments)
        return ToolResult(
            success=not result.is_error,
            summary=result.text or "MCP tool returned no content.",
            raw_payload={
                "server": self.descriptor.server_name,
                "tool": self.descriptor.name,
                "content": list(result.content),
                "is_error": result.is_error,
            },
            error=result.text if result.is_error else None,
        )

    def run(self, call: ToolCall) -> ToolResult:
        return self.execute(call.arguments)


class McpToolAdapter:
    def __init__(self, clients: dict[str, McpClient]) -> None:
        self._clients = dict(clients)
        self._descriptors_by_route: dict[str, McpToolDescriptor] = {}

    def list_tool_stubs(self) -> tuple[ToolContributionRegistration, ...]:
        registrations: list[ToolContributionRegistration] = []
        for server_name, client in sorted(self._clients.items()):
            if not client.config.enabled:
                continue
            for descriptor in client.list_tools():
                self._descriptors_by_route[descriptor.route_name] = descriptor
                registrations.append(self._registration(client=client, descriptor=descriptor, hydrate=False))
        return tuple(registrations)

    def load_tool_schema(self, route_name: str) -> ToolSpec:
        descriptor = self._descriptors_by_route.get(route_name)
        if descriptor is None:
            descriptor = self._find_descriptor(route_name)
        return self._spec_for(descriptor, hydrate=True)

    def registrations_with_full_schema(self) -> tuple[ToolContributionRegistration, ...]:
        return tuple(
            self._registration(client=self._clients[descriptor.server_name], descriptor=descriptor, hydrate=True)
            for descriptor in sorted(self._descriptors_by_route.values(), key=lambda item: item.route_name)
        )

    def _find_descriptor(self, route_name: str) -> McpToolDescriptor:
        for server_name, client in sorted(self._clients.items()):
            if not client.config.enabled:
                continue
            for descriptor in client.list_tools():
                self._descriptors_by_route[descriptor.route_name] = descriptor
                if descriptor.route_name == route_name:
                    return descriptor
        raise ValueError(f"Unknown MCP tool route: {route_name}")

    def _registration(
        self,
        *,
        client: McpClient,
        descriptor: McpToolDescriptor,
        hydrate: bool,
    ) -> ToolContributionRegistration:
        spec = self._spec_for(descriptor, hydrate=hydrate)
        tool = _McpSchemaTool(client=client, descriptor=descriptor, spec=spec)
        return ToolContributionRegistration(
            descriptor=ToolContributionDescriptor(
                tool_id=f"mcp:{descriptor.server_name}:{descriptor.name}",
                display_name=descriptor.route_name,
                description=descriptor.description,
                route_key=ToolRouteKey(namespace=descriptor.route_namespace, name=descriptor.name),
                source=ToolContributionSource.PROVIDER,
                scope=ToolContributionScope.THREAD,
                lifecycle_state=ToolContributionLifecycleState.DECLARED,
                spec=spec,
                origin_metadata={
                    "server": descriptor.server_name,
                    "tool": descriptor.name,
                    "deferred_schema": not hydrate,
                },
            ),
            tool=tool,
        )

    def _spec_for(self, descriptor: McpToolDescriptor, *, hydrate: bool) -> ToolSpec:
        return ToolSpec(
            name=descriptor.route_name,
            description=descriptor.description or f"MCP tool {descriptor.route_name}",
            parameters=descriptor.tool_parameters() if hydrate else (),
        )
