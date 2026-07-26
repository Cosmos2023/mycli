# Global Streamable HTTP MCP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Load global MCP configuration and support stateful Streamable HTTP MCP servers.

**Architecture:** Merge parsed global and workspace server tables at the configuration boundary. Extend the existing HTTP JSON-RPC transport with MCP session state, initialized notification delivery, and JSON/SSE decoding without changing tool routing.

**Tech Stack:** Python 3.13, `tomllib`, `urllib.request`, pytest

---

### Task 1: Global configuration precedence

**Files:**
- Modify: `src/mycli/services/mcp/client.py`
- Modify: `src/mycli/cli/bootstrap.py`
- Modify: `src/mycli/services/mcp/management.py`
- Modify: `src/mycli/services/mcp/diagnostics.py`
- Modify: `src/mycli/services/diagnostics/doctor.py`
- Test: `tests/unit/services/test_mcp_client.py`
- Test: `tests/unit/cli/test_main.py`

- [x] Add failing tests for global-only configuration, workspace override, and `type = "streamable_http"`.
- [x] Run the focused tests and confirm the new assertions fail.
- [x] Merge global then workspace configuration and thread `home_dir` through runtime and diagnostics callers.
- [x] Run the focused tests and confirm they pass.

### Task 2: Streamable HTTP session lifecycle

**Files:**
- Modify: `src/mycli/services/mcp/client.py`
- Test: `tests/unit/services/test_mcp_client.py`

- [x] Add a local HTTP test server that returns `Mcp-Session-Id` and requires it on subsequent calls.
- [x] Assert the client sends `notifications/initialized`, handles empty `202`, and decodes JSON/SSE responses.
- [x] Run the focused tests and confirm the protocol tests fail.
- [x] Implement session header retention, initialized notification delivery, and response decoding.
- [x] Run the focused tests and confirm they pass.

### Task 3: Configure and verify the 12306 server

**Files:**
- Create or update: `~/.mycli/mcp_servers.toml`
- Modify: `README.md`

- [x] Preserve existing global server entries and add the `12306` Streamable HTTP server.
- [x] Document global precedence and Streamable HTTP syntax.
- [x] Run MCP unit tests, CLI tests, Ruff, mypy, and `mycli mcp list`.
- [x] Confirm the live endpoint reports eight discovered tools.
