from __future__ import annotations

from mycli.services.mcp.client import McpClient, McpResourceContent, McpResourceDescriptor


class McpResourceAdapter:
    def __init__(self, clients: dict[str, McpClient]) -> None:
        self._clients = dict(clients)

    def list_resources(self) -> tuple[McpResourceDescriptor, ...]:
        resources: list[McpResourceDescriptor] = []
        for _, client in sorted(self._clients.items()):
            if client.config.enabled:
                resources.extend(client.list_resources())
        return tuple(resources)

    def read_resource(self, *, server_name: str, uri: str) -> McpResourceContent:
        client = self._clients.get(server_name)
        if client is None:
            raise ValueError(f"Unknown MCP server: {server_name}")
        contents = client.read_resource(uri)
        if not contents:
            return McpResourceContent(server_name=server_name, uri=uri)
        return contents[0]
