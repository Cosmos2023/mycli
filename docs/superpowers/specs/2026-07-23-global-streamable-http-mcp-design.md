# Global Streamable HTTP MCP Design

## Goal

Allow mycli to load user-wide MCP servers from `~/.mycli/mcp_servers.toml` and connect to stateful Streamable HTTP servers.

## Configuration

- Load `~/.mycli/mcp_servers.toml` first.
- Load `<workspace>/.mycli/mcp_servers.toml` second.
- A workspace server with the same name replaces the global server.
- Accept both mycli's `transport` key and the common `type` key.
- Normalize `type = "streamable_http"` to the Streamable HTTP transport.

## Transport

The HTTP transport sends JSON-RPC POST requests with JSON and SSE response support. It captures `Mcp-Session-Id` from the initialize response, sends it on later requests, and sends `notifications/initialized` before tool discovery. Existing stateless `http` configurations continue to work.

## Verification

Unit tests cover config precedence, type aliases, session headers, initialization notifications, JSON responses, and SSE responses. A live management command must discover the configured 12306 tools from the global file.
