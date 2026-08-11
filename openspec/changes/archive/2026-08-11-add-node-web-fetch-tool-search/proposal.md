## Why

The Node runtime cannot yet retrieve bounded public web content, and it exposes every integration tool schema eagerly even when a turn does not need those tools. This limits useful research workflows while wasting provider context on potentially large MCP and plugin catalogs.

## What Changes

- Add a built-in `web_fetch` tool that retrieves public HTTP(S) resources with strict URL, DNS, redirect, timeout, response-size, and output-size controls.
- Add a built-in `tool_search` tool that searches deferred MCP and plugin tools by metadata and makes selected schemas available only to later provider steps in the same turn.
- Persist tool-search results before changing the provider-visible tool set, and restore that set from durable turn history during continuation or restart.
- Keep core built-in tools, skills, and subagent coordination tools directly visible; defer only eligible integration tools.
- Add manifest, runtime, provider-loop, security, persistence, and integration tests for both capabilities.

## Capabilities

### New Capabilities

- `node-web-fetch`: Secure, bounded retrieval and model-readable extraction of public web resources.
- `node-tool-search`: Deferred integration-tool discovery and durable, turn-local schema activation.

### Modified Capabilities

None.

## Impact

- Affects the Node tool package, tool manifests, integration composition, runtime provider loop, and durable tool-result metadata.
- Reduces the default provider tool-schema footprint when MCP or plugin catalogs are configured.
- Adds outbound network behavior guarded by public-address validation and existing runtime cancellation semantics.
- Does not remove or modify the Python implementation and introduces no breaking CLI command changes.
