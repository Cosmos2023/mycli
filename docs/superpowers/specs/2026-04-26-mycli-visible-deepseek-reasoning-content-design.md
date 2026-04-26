# MyCLI Visible DeepSeek Reasoning Content Design

## Goal

Expose DeepSeek `reasoning_content` to users when DeepSeek returns it, while keeping the existing provider metadata replay path intact.

The feature should make DeepSeek thinking tool loops visible in the CLI, trace/log output, and session turn history. It should not convert `reasoning_content` into normal assistant answer text, and it should not expose mycli's own internal runtime policy or planning decisions as if they were provider reasoning.

## Decisions

- DeepSeek `reasoning_content` exposure is enabled by default.
- CLI output shows the complete `reasoning_content` without truncation.
- Trace/log/session records preserve the complete content.
- Only provider-returned DeepSeek `reasoning_content` is exposed.
- The existing metadata replay path remains the source of truth for follow-up DeepSeek tool-result requests.

## Architecture

The current implementation already stores DeepSeek `reasoning_content` under tool-call block metadata:

```text
RuntimeBlock.metadata["deepseek"]["reasoning_content"]
```

That metadata must continue to flow through conversation history and into the next chat-completions request. The new behavior should add a display layer on top of this, not replace it.

The recommended boundary is `AgentRuntime._consume_assistant_blocks()`. When the runtime sees an assistant `tool_call` block with DeepSeek metadata, it should emit a visible reasoning item before executing the tool:

```text
[activity] Thinking: <reasoning_content>
[activity] Reading: mission.txt
[activity] Done reading: mission.txt
```

This keeps provider-specific extraction inside the DeepSeek provider adapter, metadata preservation inside model/runtime blocks, and user-facing display inside the runtime consumption path.

## Components

### DeepSeek Metadata Reader

Add a small helper near runtime block consumption that safely reads:

```python
block.metadata["deepseek"]["reasoning_content"]
```

It should return a non-empty string only when the metadata shape is valid. Invalid, missing, or empty metadata should be ignored without failing the turn.

### Visible Reasoning Emission

Before a DeepSeek-backed tool call is executed, the runtime should append:

- `progress_updates`: raw `reasoning_content`
- `activity_events`: `ActivityEvent(kind="thinking", message=f"Thinking: {reasoning_content}")`
- `turn_items`: `TurnItem(type=TurnItemType.REASONING, text=f"Thinking: {reasoning_content}", metadata={...})`
- workspace log event: an info-level provider reasoning event that stores the full content in structured context

The turn item metadata should include enough source information to distinguish exposed provider reasoning from normal runtime policy or Responses reasoning summary, for example:

```python
{
    "provider_id": block.provider_id,
    "provider": "deepseek",
    "source": "provider_reasoning_content",
    "deepseek": {"reasoning_content": reasoning_content},
}
```

### Deduplication

Reasoning should be emitted once per tool-call block. If a future provider sends the same `reasoning_content` on multiple distinct tool calls, each distinct tool call may display its own reasoning. The first implementation does not need cross-turn deduplication.

## Data Flow

1. DeepSeek chat response includes `reasoning_content` alongside a tool call.
2. `DeepSeekChatProviderAdapter.extract_message_metadata()` stores it as provider metadata.
3. `OpenAIChatClient` attaches metadata to the tool-call event payload.
4. `TurnEventAggregator` copies event metadata into the assistant tool-call `RuntimeBlock`.
5. `AgentRuntime._consume_assistant_blocks()` detects DeepSeek `reasoning_content` and emits visible thinking before executing the tool.
6. `_record_assistant_tool_call()` still records the tool-call block metadata into conversation history.
7. `NativeToolModelAdapter` replays metadata into the next DeepSeek request as `reasoning_content`.

`TurnItemType.REASONING` gives session/history persistence, `_append_turn_item()` gives trace persistence, and the explicit workspace log event gives log persistence.

## Error Handling

- Missing metadata: no visible reasoning is emitted.
- Malformed metadata: ignored safely.
- Empty or whitespace-only `reasoning_content`: ignored.
- Tool execution failure after reasoning display: keep the reasoning item in the turn history because it accurately reflects what the provider returned before the tool failed.

## Testing

Add focused tests for:

- Runtime emits `progress_updates`, `ActivityEvent(kind="thinking")`, and `TurnItemType.REASONING` when a tool-call block has DeepSeek `reasoning_content`.
- Runtime writes an info-level workspace log event with the complete `reasoning_content`.
- Runtime preserves the existing metadata replay behavior after exposing reasoning.
- Runtime ignores malformed or missing DeepSeek metadata.
- CLI rendering shows the complete reasoning content in activity output.

Regression coverage should include the existing DeepSeek replay tests so exposing reasoning does not break tool-loop continuation.

## Documentation

Update the README DeepSeek section:

- Remove the statement that `reasoning_content` is not displayed.
- State that DeepSeek `reasoning_content` is displayed by default.
- State that it remains provider metadata and is replayed for DeepSeek tool loops.
- Note that CLI output is complete and not truncated.

## Out of Scope

- Adding a config flag to hide or truncate reasoning content.
- Exposing non-DeepSeek provider-private metadata.
- Changing OpenAI Responses reasoning-summary behavior.
- Treating `reasoning_content` as assistant answer text.
- Summarizing or compressing reasoning content differently from existing turn item/session behavior.

## Acceptance Criteria

- A live DeepSeek tool call that returns `reasoning_content` shows a full `[activity] Thinking: ...` line before tool execution.
- The same turn still executes the requested mycli tool and completes normally.
- The next DeepSeek request still receives `reasoning_content` for tool-loop replay.
- The full test suite remains green except for any pre-existing mypy baseline issues outside this change.
