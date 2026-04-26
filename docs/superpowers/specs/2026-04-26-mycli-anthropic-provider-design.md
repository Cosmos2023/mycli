# mycli Anthropic Provider Design

Date: 2026-04-26
Status: approved for implementation planning

## Goal

Add a first-class Anthropic provider that uses Anthropic's native Messages API and
can run mycli's coding-agent loop with text, native tool calls, tool results, and
thinking output.

This provider must not be implemented as an OpenAI-compatible chat-completions
shim. Anthropic Messages has different message, system prompt, tool, and thinking
semantics, so mycli should model it explicitly.

## Non-Goals

- Do not add MCP host support in this change.
- Do not redesign the whole internal runtime protocol.
- Do not replace the existing OpenAI, Qwen, DeepSeek, Responses, or
  chat-completions paths.
- Do not commit local API keys, raw model logs, or user config.

## Provider And Protocol Model

Add:

- `ProviderId.ANTHROPIC = "anthropic"`
- `ProtocolId.ANTHROPIC_MESSAGES = "anthropic_messages"`

Add `src/mycli/infrastructure/providers/anthropic.py` with:

- `ANTHROPIC_PROFILE`
- default protocol `anthropic_messages`
- default base URL `https://api.anthropic.com`
- default model `claude-sonnet-4-6`, selected as the initial balance of speed,
  intelligence, and extended thinking support
- optional high-capability override `claude-opus-4-7` for complex agentic coding
  tasks
- unsupported protocol hints for Responses and chat-completions when appropriate

Update provider registry inference so Anthropic hosts resolve to
`ProviderId.ANTHROPIC`.

## Dependency Decision

Use the official `anthropic` Python SDK.

Rationale:

- Anthropic Messages differs materially from OpenAI Responses and Chat
  Completions.
- The SDK reduces wire-level maintenance around message creation, typed errors,
  streaming evolution, and future Anthropic API additions.
- The provider adapter boundary still keeps Anthropic-specific behavior isolated
  under infrastructure code.

## Runtime Integration

The new provider should fit the existing runtime boundary:

```text
AgentRuntime
  -> ModelAdapter
  -> ModelTurnResult
  -> RuntimeItem / RuntimeBlock
```

The Anthropic adapter should produce `ModelTurnResult` directly or via
`ModelEvent` plus `TurnEventAggregator`. The main turn loop should not need
Anthropic-specific branching beyond selecting the correct adapter for
`ProtocolId.ANTHROPIC_MESSAGES`.

## Message Mapping

Anthropic Messages does not use OpenAI-style `system` or `developer` message
roles in the `messages` array.

Mapping rules:

- `system` and `developer` content from mycli is merged into Anthropic's top-level
  `system` field.
- `user` messages become Anthropic user messages with text content blocks.
- assistant text becomes Anthropic assistant text blocks.
- assistant tool-call blocks become Anthropic assistant `tool_use` blocks when
  replaying prior turns.
- tool-result blocks become Anthropic user `tool_result` blocks associated with
  the original `tool_use_id`.

The adapter must preserve provider IDs and call IDs where available so session
history remains replayable.

## Tool Mapping

mycli `ModelToolDefinition` values map to Anthropic `tools` entries:

- `name` -> `name`
- `description` -> `description`
- parameters -> `input_schema`

Anthropic `tool_use` content blocks map to:

- `RuntimeBlock(type="tool_call")`
- `tool_name` from the Anthropic tool name
- `tool_arguments` from the Anthropic input object
- `call_id` from the Anthropic tool-use id
- `source="native"`
- metadata containing Anthropic provider details

Tool results map back to Anthropic as user `tool_result` blocks.

## Thinking Mapping

The existing config surface remains:

- `thinking_enabled`
- `thinking_effort`
- legacy `reasoning_effort` fallback

When `thinking_enabled=false`, the Anthropic request should omit thinking config.

When `thinking_enabled=true`, the adapter should send Anthropic thinking config:

```text
thinking = {"type": "enabled", "budget_tokens": <mapped budget>}
```

Initial effort-to-budget mapping:

- `low`: small budget suitable for simple tool routing
- `medium`: default budget
- `high`: larger budget for coding tasks
- `xhigh`: largest supported local budget, capped below `max_output_tokens`

The implementation plan must choose exact budget values and define behavior when
`max_output_tokens` is too low for the requested thinking budget. The preferred
failure mode is a clear configuration error rather than silent invalid requests.

Anthropic thinking output maps to:

- `RuntimeBlock(type="reasoning")`
- metadata containing `{"anthropic": ...}`
- visible console progress using the existing provider reasoning exposure path,
  generalized beyond the current DeepSeek-specific helper if needed

## Error Handling And Logging

The Anthropic client should wrap SDK exceptions into `ModelResponseError`.

Required behavior:

- classify provider HTTP/status failures as provider errors
- classify connection/timeouts as retryable where consistent with existing
  provider clients
- log request and response payloads through `WorkspaceLogService`
- record provider as `anthropic`
- record protocol as `anthropic_messages`
- rely on `.gitignore` to keep raw model logs out of version control

## Configuration Examples

Project config:

```toml
provider = "anthropic"
protocol = "anthropic_messages"
model = "claude-sonnet-4-6"
api_key = "..."
thinking_enabled = true
thinking_effort = "medium"
```

Environment overrides should follow the existing names:

- `MYCLI_PROVIDER=anthropic`
- `MYCLI_PROTOCOL=anthropic_messages`
- `MYCLI_MODEL=...`
- `MYCLI_API_KEY=...`
- `MYCLI_THINKING_ENABLED=true`
- `MYCLI_THINKING_EFFORT=medium`

## Testing Plan

Config and registry tests:

- explicit `provider="anthropic"` defaults to `anthropic_messages`
- Anthropic base URLs infer `ProviderId.ANTHROPIC`
- invalid provider/protocol combinations fail clearly
- Anthropic defaults include base URL and model

Adapter tests:

- system and developer messages merge into top-level system
- text messages serialize to Anthropic Messages format
- tool definitions become Anthropic `tools`
- Anthropic `tool_use` maps to native `RuntimeBlock(type="tool_call")`
- prior tool results serialize as user `tool_result` blocks
- thinking blocks map to reasoning runtime blocks
- usage and response IDs are preserved when available

Runtime selection tests:

- `build_turn_service` selects Anthropic adapter for
  `ProtocolId.ANTHROPIC_MESSAGES`
- Anthropic provider can complete a tool-call round trip with a fake client

Verification commands:

```bash
uv run mypy src
uv run ruff check src tests
uv run pytest -q
```

## Sources

- Anthropic Models overview:
  `https://platform.claude.com/docs/en/about-claude/models/overview`
- Anthropic Messages examples:
  `https://docs.anthropic.com/en/api/messages-examples`
- Anthropic tool use:
  `https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/implement-tool-use`
- Anthropic extended thinking:
  `https://docs.anthropic.com/en/docs/build-with-claude/extended-thinking`

## Open Questions For Implementation Planning

- Exact thinking budget values must be chosen to fit mycli's
  `max_output_tokens` defaults.
- Streaming can be added in the first implementation only if it stays small;
  non-streaming create is acceptable for the first provider cut because the
  existing runtime can consume complete `ModelTurnResult` objects.
