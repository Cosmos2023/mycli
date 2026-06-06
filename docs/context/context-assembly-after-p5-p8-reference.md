# Context Assembly After P5-P8

本文档说明 Prefix Cache Context Assembly P5-P8 完成后，`mycli` 的上下文最终长什么样：

- 内部落库的 canonical timeline / structured history 是什么。
- 每个 turn 如何从落库状态重新组装模型上下文。
- Responses / Anthropic / OpenAI-compatible / DeepSeek 分别发给模型什么。
- compact 后 summary + rehydration + tail 如何继续工作。

本文是具体示例文档。设计原则见：

- [mycli-context-assembly-reference.md](./mycli-context-assembly-reference.md)
- [prefix-cache-request-shape-design.md](./prefix-cache-request-shape-design.md)
- [.trellis/spec/backend/context-management-contract.md](../.trellis/spec/backend/context-management-contract.md)

## 1. 总体效果

P5-P8 完成后，`mycli` 不再把上下文理解为“每轮临时拼一坨 prompt”。实际链路是：

```text
session store / canonical state
  -> ExecutionContext
  -> TurnContextSection[]
  -> InstructionContract
  -> RequestShape
  -> provider runtime items / messages
  -> provider adapter wire payload
```

核心顺序固定：

```text
stable prefix:
  system instructions
  stable tool schema
  stable workspace context
  stable skill/tool exposure

dynamic context:
  conversation replay
  compact summary / rehydration
  selected memory
  selected plan
  environment facts

ephemeral tail:
  runtime reminder
  hook/plugin current-turn hint
  current user input  # 最后
```

对 prefix-cache 来说，前面的 stable prefix 尽量不变；当前用户输入和 runtime reminder 每轮变化，但它们在尾部，不污染 stable prefix hash。

## 2. 落库形态

`mycli` 当前有两层持久化形态：

1. `HistoryItem` / `TurnRecord`：用户、assistant、tool call/result 的结构化 transcript。
2. `ContextBaseline` / `BaselineFragment`：可在 resume 后重建的 persistent selected context，例如 workspace、memory、plan、rehydration。

代码中的 canonical contract 是 `CanonicalTimelineItem`：

```python
CanonicalTimelineItem(
    role="developer",
    kind="plan",
    content="Active objective: finish P8 recovery diagnostics",
    source="plan",
    durability="persistent",
    scope="transcript",
    cache_class="dynamic",
    metadata={"replayable": True},
    provider_state={},
)
```

它落到 session store 时，通常会变成 `HistoryItem` 或 `BaselineFragment`。

### 2.1 HistoryItem 示例

用户输入、assistant 输出、tool 调用和 tool 结果进入 structured history：

```json
[
  {
    "id": "turn_001:item:1",
    "thread_id": "session_abc",
    "turn_id": "turn_001",
    "type": "user_message",
    "text": "实现 P8 recovery diagnostics",
    "tool_name": null,
    "call_id": null,
    "metadata": {}
  },
  {
    "id": "turn_001:item:2",
    "thread_id": "session_abc",
    "turn_id": "turn_001",
    "type": "assistant_message",
    "text": "我会先检查 recovery policy 和 doctor diagnostics。",
    "tool_name": null,
    "call_id": null,
    "metadata": {
      "provider_state": {
        "codex_reasoning_items": [
          {
            "id": "rs_123",
            "type": "reasoning",
            "encrypted_content": "<opaque encrypted reasoning>",
            "summary": [],
            "_issuer_kind": "openai_responses"
          }
        ]
      }
    }
  },
  {
    "id": "turn_001:item:3",
    "thread_id": "session_abc",
    "turn_id": "turn_001",
    "type": "tool_call",
    "text": null,
    "tool_name": "exec_command",
    "call_id": "call_read_recovery",
    "metadata": {
      "arguments": {"cmd": "sed -n '1,220p' src/mycli/application/runtime/recovery.py"}
    }
  },
  {
    "id": "turn_001:item:4",
    "thread_id": "session_abc",
    "turn_id": "turn_001",
    "type": "tool_result",
    "text": "class RecoveryPolicy: ...",
    "tool_name": null,
    "call_id": "call_read_recovery",
    "metadata": {"success": true}
  }
]
```

注意：

- `provider_state` 可以落库，但不会被压成普通 prompt 文本。
- Responses adapter 只会在同 issuer 时 replay `codex_reasoning_items`。
- Chat / Anthropic / DeepSeek 默认不会把 Responses encrypted reasoning 发给模型。

### 2.2 ContextBaseline 示例

可 replay 的 selected context 会进入 baseline。`RuntimeEventLedger` 会剥离 wire-only keys：

```json
{
  "thread_id": "session_abc",
  "fragments": [
    {
      "id": "contextual:1",
      "kind": "workspace_instructions",
      "title": "Workspace instructions",
      "content": "<workspace-context>遵守 AGENTS.md ...</workspace-context>",
      "source": "context_file:AGENTS.md",
      "metadata": {
        "cache_class": "static",
        "durability": "persistent",
        "scope": "transcript",
        "model_visible": true,
        "replayable": true
      }
    },
    {
      "id": "contextual:2",
      "kind": "plan",
      "title": "Current plan",
      "content": "Active plan:\n- implement recovery\n- update doctor\n- run smoke",
      "source": "plan",
      "metadata": {
        "cache_class": "dynamic",
        "durability": "persistent",
        "scope": "transcript",
        "model_visible": true,
        "replayable": true
      }
    }
  ]
}
```

不会进入 baseline 的东西：

```json
{
  "prompt_cache_key": "mycli:openai:responses:...",
  "cache_control": {"type": "ephemeral"},
  "request_id": "req_123",
  "trace_id": "trace_456",
  "provider_state": {"codex_reasoning_items": "..."}
}
```

这些是 wire-only / trace-only / provider-private，不能成为普通 contextual prompt。

## 3. Turn 内组装

一个用户 turn 不等于一次 request。一个 turn 可能包含多次 request：

```text
turn_002
  user input
  request #1
  assistant tool_call
  tool_result
  request #2
  assistant final
```

每次 request 都从当前 `ExecutionContext` 重新组装：

```python
turn_context = TurnContextAssembler().assemble(
    user_message="继续实现 P8 doctor diagnostics",
    context=execution_context,
    workspace_instructions=loaded_context_file.content,
)

contract = InstructionContractAssembler().assemble(
    turn_context=turn_context,
    base_instructions=build_system_prompt() + "\n\n" + build_react_prompt(),
    conversation_messages=execution_context.conversation_messages,
)

shape = RequestShapeBuilder().build(
    config=agent_config,
    contract=contract,
    tools=tool_definitions,
    cache_policy_capability=resolved_provider_capability,
)
```

`RequestShape.fragments` 的逻辑顺序是：

```json
[
  {"id": "stable:system", "stability": "stable", "cache_class": "static"},
  {"id": "stable:tool_schema", "stability": "stable", "cache_class": "static"},
  {"id": "stable:workspace_instructions", "stability": "stable", "cache_class": "static"},
  {"id": "stable:skill_catalog", "stability": "stable", "cache_class": "static"},
  {"id": "stable:tool_exposure", "stability": "stable", "cache_class": "static"},
  {"id": "replay:conversation", "stability": "replay", "cache_class": "dynamic"},
  {"id": "dynamic:environment_context", "stability": "replay", "cache_class": "dynamic"},
  {"id": "dynamic:compaction_rehydration", "stability": "replay", "cache_class": "dynamic"},
  {"id": "dynamic:memory", "stability": "replay", "cache_class": "dynamic"},
  {"id": "dynamic:plan", "stability": "replay", "cache_class": "dynamic"},
  {"id": "volatile:runtime_reminders", "stability": "volatile", "cache_class": "ephemeral"},
  {"id": "intent:current", "stability": "volatile", "cache_class": "ephemeral"}
]
```

`cacheable_prefix_hash` 只覆盖开头连续 stable fragments。修改 `intent:current` 不应改变它。

## 4. OpenAI Responses 组装

OpenAI Responses 是最接近 canonical runtime items 的 lane。

Provider profile：

```python
provider = "openai"
protocol = "responses"
capability = ProviderCachePolicyCapability(
    prompt_cache_key_enabled=True,
    cache_control_enabled=False,
)
```

### 4.1 Runtime items

`RequestShapePayloadFormatter.runtime_items(shape)` 产出：

```python
[
    RuntimeItem(
        role="system",
        blocks=[RuntimeBlock(type="text", text="<base system + ReAct>")],
        metadata={
            "provider_request_policy": {
                "prompt_cache_key": "mycli:openai:responses:<stable-prefix-hash>",
                "wire_only_hints": ("prompt_cache_key",)
            }
        },
    ),
    RuntimeItem(
        role="developer",
        blocks=[RuntimeBlock(type="text", text="<developer/tool exposure>")],
    ),
    RuntimeItem(
        role="user",
        blocks=[RuntimeBlock(type="text", text="<workspace context>")],
    ),
    RuntimeItem(
        role="assistant",
        blocks=[RuntimeBlock(type="text", text="I'll inspect recovery.py")],
        metadata={
            "provider_state": {
                "codex_reasoning_items": [
                    {
                        "id": "rs_123",
                        "type": "reasoning",
                        "encrypted_content": "<opaque>",
                        "summary": [],
                        "_issuer_kind": "openai_responses"
                    }
                ],
                "codex_message_items": [
                    {
                        "id": "msg_456",
                        "type": "message",
                        "role": "assistant",
                        "content": [{"type": "output_text", "text": "I'll inspect recovery.py"}],
                        "status": "completed",
                        "_issuer_kind": "openai_responses"
                    }
                ]
            }
        },
    ),
    RuntimeItem(
        role="tool",
        blocks=[RuntimeBlock(type="tool_result", call_id="call_read", text="class RecoveryPolicy...")],
    ),
    RuntimeItem(
        role="user",
        blocks=[RuntimeBlock(type="text", text="<dynamic memory/plan/rehydration>")],
    ),
    RuntimeItem(
        role="user",
        blocks=[RuntimeBlock(type="text", text="<runtime reminders>")],
    ),
    RuntimeItem(
        role="user",
        blocks=[RuntimeBlock(type="text", text="继续实现 P8 doctor diagnostics")],
    ),
]
```

### 4.2 Responses wire payload

`ResponsesInputSerializer` 会把 runtime items 投影成 Responses `input`：

```json
{
  "model": "gpt-5",
  "input": [
    {
      "role": "system",
      "content": [{"type": "input_text", "text": "<base system + ReAct>"}]
    },
    {
      "role": "developer",
      "content": [{"type": "input_text", "text": "<developer/tool exposure>"}]
    },
    {
      "role": "user",
      "content": [{"type": "input_text", "text": "<workspace context>"}]
    },
    {
      "id": "rs_123",
      "type": "reasoning",
      "encrypted_content": "<opaque>",
      "summary": [],
      "status": "completed"
    },
    {
      "id": "msg_456",
      "type": "message",
      "role": "assistant",
      "content": [{"type": "output_text", "text": "I'll inspect recovery.py"}],
      "status": "completed"
    },
    {
      "role": "assistant",
      "content": [{"type": "input_text", "text": "I'll inspect recovery.py"}]
    },
    {
      "type": "function_call_output",
      "call_id": "call_read",
      "output": "class RecoveryPolicy..."
    },
    {
      "role": "user",
      "content": [{"type": "input_text", "text": "<dynamic memory/plan/rehydration>"}]
    },
    {
      "role": "user",
      "content": [{"type": "input_text", "text": "<runtime reminders>"}]
    },
    {
      "role": "user",
      "content": [{"type": "input_text", "text": "继续实现 P8 doctor diagnostics"}]
    }
  ],
  "tools": [
    {"name": "exec_command", "description": "...", "parameters": []}
  ],
  "max_output_tokens": 4096,
  "reasoning": {"effort": "high"},
  "prompt_cache_key": "mycli:openai:responses:<stable-prefix-hash>"
}
```

Rules:

- `prompt_cache_key` 是 request-level wire option，不进 canonical content。
- same issuer 的 `codex_reasoning_items` 可以回放。
- foreign issuer 的 encrypted reasoning 会被过滤。
- provider 返回 `invalid_encrypted_content` 时，recovery 会清 continuation/replay state，禁用 encrypted replay，并 retry once。

## 5. Anthropic Messages 组装

Anthropic 使用同一份 runtime items，但 adapter 投影为 `system + messages`。

Provider profile：

```python
provider = "anthropic"
protocol = "anthropic_messages"
capability = ProviderCachePolicyCapability(
    prompt_cache_key_enabled=False,
    cache_control_enabled=True,
)
```

### 5.1 Runtime items

`RequestShapeBuilder` 会在 runtime item metadata 上带下 provider policy 和
cache class；Anthropic adapter 最终在 wire copy 上应用 `system_and_3`：

```python
[
    RuntimeItem(
        role="system",
        blocks=[RuntimeBlock(type="text", text="<base system + ReAct>")],
        metadata={
            "provider_request_policy": {
                "anthropic_cache_control_breakpoints": (
                    "system_static",
                    "dynamic_boundary",
                    "long_context_1",
                    "long_context_2",
                ),
                "wire_only_hints": ("cache_control",)
            },
            "anthropic_cache_control_breakpoint": "system_static"
        },
    ),
    RuntimeItem(
        role="developer",
        blocks=[RuntimeBlock(type="text", text="<tool exposure>")],
    ),
    RuntimeItem(
        role="user",
        blocks=[RuntimeBlock(type="text", text="<workspace context>")],
        metadata={"cache_class": "static"},
    ),
    RuntimeItem(role="assistant", blocks=[RuntimeBlock(type="text", text="I'll inspect recovery.py")]),
    RuntimeItem(role="tool", blocks=[RuntimeBlock(type="tool_result", call_id="toolu_1", text="...")]),
    RuntimeItem(
        role="user",
        blocks=[RuntimeBlock(type="text", text="<dynamic memory/plan/rehydration>")],
        metadata={
            "cache_class": "dynamic",
            "anthropic_cache_control_breakpoint": "dynamic_boundary",
        },
    ),
    RuntimeItem(
        role="user",
        blocks=[RuntimeBlock(type="text", text="<runtime reminders>")],
        metadata={"cache_class": "ephemeral"},
    ),
    RuntimeItem(
        role="user",
        blocks=[RuntimeBlock(type="text", text="继续实现 P8 doctor diagnostics")],
        metadata={"cache_class": "ephemeral"},
    ),
]
```

### 5.2 Anthropic wire payload

`AnthropicMessagesModelAdapter._serialize_items()` 输出：

```json
{
  "model": "claude-sonnet-4-6",
  "system": [
    {
      "type": "text",
      "text": "<base system + ReAct>"
    },
    {
      "type": "text",
      "text": "<tool exposure>",
      "cache_control": {"type": "ephemeral"}
    }
  ],
  "messages": [
    {
      "role": "user",
      "content": [{"type": "text", "text": "<workspace context>"}]
    },
    {
      "role": "assistant",
      "content": [{"type": "text", "text": "I'll inspect recovery.py"}]
    },
    {
      "role": "user",
      "content": [
        {
          "type": "tool_result",
          "tool_use_id": "toolu_1",
          "content": "...",
          "cache_control": {"type": "ephemeral"}
        }
      ]
    },
    {
      "role": "user",
      "content": [
        {
          "type": "text",
          "text": "<dynamic memory/plan/rehydration>",
          "cache_control": {"type": "ephemeral"}
        }
      ]
    },
    {
      "role": "user",
      "content": [{"type": "text", "text": "<runtime reminders>"}]
    },
    {
      "role": "user",
      "content": [
        {
          "type": "text",
          "text": "继续实现 P8 doctor diagnostics",
          "cache_control": {"type": "ephemeral"}
        }
      ]
    }
  ],
  "tools": [
    {
      "name": "exec_command",
      "description": "...",
      "input_schema": {
        "type": "object",
        "properties": {},
        "required": [],
        "additionalProperties": false
      }
    }
  ]
}
```

Rules:

- `developer` 在 Anthropic lane 中折叠进 `system`。
- Anthropic cache policy 是 `system_and_3`：system 最后一个 block 加一个
  `cache_control`，再给最近三个非 system message 的最后一个 cacheable block
  加 `cache_control`。
- DeepSeek 的 Anthropic-compatible endpoint 默认禁用 `cache_control`：transport
  仍走 Anthropic Messages，但 cache 命中来自 DeepSeek 自动 prefix cache，不把
  被上游忽略的 marker 当作有效 wire hint。
- `cache_control` 只加在 wire copy 上，不写回 runtime item / history / baseline。
- Responses encrypted reasoning 不会变成 Anthropic thinking。
- Anthropic 返回的 `thinking` block 会保存为 runtime `reasoning` block，metadata 里带 `anthropic`，只有 Anthropic adapter 可按 Anthropic 规则 replay。

## 6. OpenAI-compatible Chat 组装

OpenAI-compatible Chat 使用 `chat_completions` lane。它从同一份 canonical context 降级成 `messages[]`。

Provider profile 默认：

```python
provider = "compatible"
protocol = "chat_completions"
capability = ProviderCachePolicyCapability(
    prompt_cache_key_enabled=True,
    cache_control_enabled=False,
)
```

### 6.1 Provider messages

`RequestShapePayloadFormatter.legacy_messages(shape)` 产出：

```python
[
    ModelMessage(role="system", content="<base system + ReAct>", metadata={
        "provider_request_policy": {
            "prompt_cache_key": "mycli:compatible:chat_completions:<stable-prefix-hash>",
            "wire_only_hints": ("prompt_cache_key",)
        }
    }),
    ModelMessage(role="user", content="<stable workspace/tool/skill context>"),
    ModelMessage(role="user", content="实现 P8 recovery diagnostics"),
    ModelMessage(role="assistant", content="I'll inspect recovery.py", metadata={
        "provider_state": {"codex_reasoning_items": ["..."]},
        "anthropic": {"type": "thinking", "thinking": "..."}
    }),
    ModelMessage(role="tool", content="class RecoveryPolicy...", tool_call_id="call_read"),
    ModelMessage(role="user", content="<dynamic memory/plan/rehydration>"),
    ModelMessage(role="user", content="<runtime reminders>"),
    ModelMessage(role="user", content="继续实现 P8 doctor diagnostics"),
]
```

### 6.2 Chat wire payload

`OpenAIChatClient` 会取出 first message metadata 中的 `prompt_cache_key`，再让 provider adapter sanitize messages：

```json
{
  "model": "some-openai-compatible-model",
  "messages": [
    {"role": "system", "content": "<base system + ReAct>"},
    {"role": "user", "content": "<stable workspace/tool/skill context>"},
    {"role": "user", "content": "实现 P8 recovery diagnostics"},
    {"role": "assistant", "content": "I'll inspect recovery.py"},
    {"role": "tool", "content": "class RecoveryPolicy...", "tool_call_id": "call_read"},
    {"role": "user", "content": "<dynamic memory/plan/rehydration>"},
    {"role": "user", "content": "<runtime reminders>"},
    {"role": "user", "content": "继续实现 P8 doctor diagnostics"}
  ],
  "max_tokens": 4096,
  "temperature": 0,
  "prompt_cache_key": "mycli:compatible:chat_completions:<stable-prefix-hash>",
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "exec_command",
        "description": "...",
        "parameters": {
          "type": "object",
          "properties": {},
          "required": [],
          "additionalProperties": false
        }
      }
    }
  ]
}
```

Rules:

- Default compatible lane 会剥离 `metadata`、`provider_state`、`cache_control`、`anthropic`、`responses`、underscore-prefixed keys。
- compatible provider 可通过 profile/config 禁用 `prompt_cache_key`。禁用后 wire payload 不带该字段，doctor 状态是 `disabled_by_policy`，不是失败。
- Chat lane 不伪造 Responses `encrypted_content`。

## 7. DeepSeek 组装

DeepSeek 也是 `chat_completions` lane，但有 provider-specific adapter。

Provider profile：

```python
provider = "deepseek"
protocol = "chat_completions"
capability = ProviderCachePolicyCapability(
    prompt_cache_key_enabled=False,
    cache_control_enabled=False,
    wire_hints_supported=False,
    provider_family="deepseek",
    cache_strategy="automatic_prefix_cache",
)
```

这意味着 DeepSeek wire payload 不带：

```json
{
  "prompt_cache_key": null,
  "cache_control": null
}
```

### 7.1 DeepSeek message adaptation

输入给 adapter 前：

```json
[
  {"role": "system", "content": "<base system + ReAct>", "metadata": {"provider_request_policy": {"wire_hint_state": "unsupported"}}},
  {"role": "developer", "content": "<developer tool exposure>"},
  {"role": "user", "content": "<workspace context>"},
  {
    "role": "assistant",
    "content": "I'll inspect recovery.py",
    "metadata": {
      "deepseek": {
        "reasoning_content": "I need to inspect recovery diagnostics before editing."
      }
    }
  },
  {"role": "user", "content": "<runtime reminders>"},
  {"role": "user", "content": "继续实现 P8 doctor diagnostics"}
]
```

DeepSeek adapter 输出：

```json
[
  {
    "role": "system",
    "content": "<base system + ReAct>\n\n<developer tool exposure>"
  },
  {"role": "user", "content": "<workspace context>"},
  {
    "role": "assistant",
    "content": "I'll inspect recovery.py",
    "reasoning_content": "I need to inspect recovery diagnostics before editing."
  },
  {"role": "user", "content": "<runtime reminders>"},
  {"role": "user", "content": "继续实现 P8 doctor diagnostics"}
]
```

DeepSeek request body：

```json
{
  "model": "deepseek-chat",
  "messages": [
    {"role": "system", "content": "<base system + ReAct>\n\n<developer tool exposure>"},
    {"role": "user", "content": "<workspace context>"},
    {
      "role": "assistant",
      "content": "I'll inspect recovery.py",
      "reasoning_content": "I need to inspect recovery diagnostics before editing."
    },
    {"role": "user", "content": "<runtime reminders>"},
    {"role": "user", "content": "继续实现 P8 doctor diagnostics"}
  ],
  "max_tokens": 4096,
  "temperature": 0,
  "extra_body": {"thinking": {"type": "enabled"}},
  "reasoning_effort": "high"
}
```

Rules:

- `developer` role 会降级/合并到 `system`。
- DeepSeek 自己的 `metadata.deepseek.reasoning_content` 可以 replay 成 `reasoning_content`。
- 如果 assistant 有 tool_calls 但 provider 没给 reasoning_content，会补 synthetic reasoning marker，避免 DeepSeek tool-call replay shape 断裂。
- DeepSeek 不支持 P4 的 wire cache hints，doctor 应显示
  `wire_hint_state=unsupported`，同时显示
  `cache_strategy=automatic_prefix_cache`，表示命中来源是 provider 侧自动
  prefix cache，不是 `prompt_cache_key` / `cache_control`。

## 8. 跨 turn 组装

假设 turn A：

```text
User A: 实现 P8 recovery diagnostics
Assistant: 我先检查 recovery.py
Tool: read recovery.py -> ...
Assistant: 已添加 RecoveryPolicy
```

落库后有：

```json
{
  "history_items": [
    {"type": "user_message", "text": "实现 P8 recovery diagnostics"},
    {"type": "assistant_message", "text": "我先检查 recovery.py"},
    {"type": "tool_result", "text": "class RecoveryPolicy..."},
    {"type": "assistant_message", "text": "已添加 RecoveryPolicy"}
  ],
  "context_baseline": {
    "fragments": [
      {"kind": "workspace_instructions", "content": "<workspace-context>...</workspace-context>"},
      {"kind": "plan", "content": "Active plan: recovery -> doctor -> smoke"}
    ]
  }
}
```

turn B 用户输入：

```text
继续把 doctor detail 补齐
```

本轮 request shape：

```text
stable:
  system
  tool schema
  workspace instructions

dynamic:
  replay from history:
    user: 实现 P8 recovery diagnostics
    assistant: 我先检查 recovery.py
    tool: class RecoveryPolicy...
    assistant: 已添加 RecoveryPolicy
  plan baseline:
    Active plan: recovery -> doctor -> smoke

ephemeral:
  runtime reminders

current user last:
  继续把 doctor detail 补齐
```

这就是“跨 turn 不断上下文”的实际效果。

## 9. Compact 后复水

compact 不改 stable prefix。它改的是 dynamic replay 区。

compact 前：

```text
stable:
  system / tool schema / workspace

dynamic:
  200 条历史消息
  大量 tool result
  invoked skill body
  active plan

tail:
  最近 user / assistant tool_call / tool_result / current user
```

compact pipeline：

```text
canonical timeline
  -> cheap pruning dynamic replay
     - old large tool result -> structured summary
     - duplicate tool result -> back-reference
     - old oversized tool args -> JSON-preserving truncation
     - protected tail unchanged
  -> summary generation
  -> rehydration selection
     - invoked skill body
     - important edited file snapshots
     - active plan / unresolved task state
  -> replacement timeline
     - compact summary
     - rehydration
     - protected tail
```

compact 后落库示例：

```json
{
  "history_items": [
    {
      "type": "compaction",
      "text": "Summary: We implemented recovery policy, updated doctor diagnostics, and verified focused tests.",
      "metadata": {
        "compaction": true,
        "lineage": "compact_003",
        "source_turns": ["turn_001", "turn_010"]
      }
    },
    {
      "type": "assistant_message",
      "text": "I will now run the provider-free smoke."
    },
    {
      "type": "tool_call",
      "tool_name": "exec_command",
      "call_id": "call_smoke"
    },
    {
      "type": "tool_result",
      "text": "provider_cache_policy_smoke passed",
      "call_id": "call_smoke"
    }
  ],
  "context_baseline": {
    "fragments": [
      {
        "kind": "compaction_rehydration",
        "title": "Compaction rehydration",
        "content": "[Invoked skills after compaction]\n...\n\n[Compaction file rehydration]\n...",
        "metadata": {
          "cache_class": "dynamic",
          "scope": "turn",
          "model_visible": true
        }
      }
    ]
  }
}
```

发送给模型时：

```text
stable:
  system / tool schema / workspace

dynamic:
  compact summary
  compaction rehydration
  protected tail replay

ephemeral:
  runtime reminders

current user last:
  用户的新请求
```

Rules:

- frozen/stable prefix hash 不变。
- protected tail 不切断 tool_call/tool_result group。
- provider-private reasoning state 不写进自然语言 summary。
- compact summary 失败默认 abort，不静默删除历史。

## 10. Diagnostics 长什么样

`RequestShape.summary()` / trace / doctor 不输出 raw prompt，但会输出 bounded fields：

```json
{
  "provider": "openai",
  "protocol": "responses",
  "model": "gpt-5",
  "cacheable_prefix_fragment_ids": [
    "stable:system",
    "stable:tool_schema",
    "stable:workspace_instructions"
  ],
  "cacheable_prefix_hash": "sha256:...",
  "first_dynamic_fragment_index": 3,
  "first_ephemeral_fragment_index": 10,
  "provider_projection": {
    "lane": "responses",
    "cache_hint": "prompt_cache_key_candidate",
    "wire_only_hints": ["prompt_cache_key"]
  },
  "provider_request_policy": {
    "wire_hint_state": "enabled_and_emitted",
    "prompt_cache_key_hash": "sha256:...",
    "prompt_cache_key_preview": "mycli:openai:responses:..."
  }
}
```

Dry-run compare 示例：

```json
{
  "cache_boundary_hash_stable": true,
  "prompt_cache_key_hash_stable": true,
  "first_changed_cache_class": "ephemeral",
  "wire_hint_state": "enabled_and_emitted",
  "snapshot_counts": {
    "previous": {"message_count": 8, "runtime_item_count": 8},
    "current": {"message_count": 8, "runtime_item_count": 8}
  },
  "recovery_counts": {"invalid_encrypted_content": 1},
  "latest_recovery": {
    "error_class": "invalid_encrypted_content",
    "action": "strip_encrypted_reasoning_retry",
    "will_retry": true
  }
}
```

不会输出：

- raw user prompt
- raw tool output
- secret
- full `prompt_cache_key`
- full provider wire body
- raw `provider_state`

## 11. 最小端到端例子

输入：

```text
User: 修复 doctor cache warning
Runtime reminder: 当前是 Plan mode，只能分析不能改代码
Workspace: AGENTS.md
Memory: 上次已经发现 prompt_cache_key 不能进入 trace
Plan: 1. inspect doctor 2. add test 3. run smoke
```

落库：

```json
{
  "history_items": [
    {"type": "user_message", "text": "修复 doctor cache warning"}
  ],
  "context_baseline": {
    "fragments": [
      {"kind": "workspace_instructions", "content": "<workspace-context>AGENTS.md...</workspace-context>"},
      {"kind": "memory", "content": "prompt_cache_key 不能进入 trace"},
      {"kind": "plan", "content": "1. inspect doctor 2. add test 3. run smoke"}
    ]
  }
}
```

Request fragments：

```text
stable:system
stable:tool_schema
stable:workspace_instructions
replay:conversation
dynamic:memory
dynamic:plan
volatile:runtime_reminders
intent:current
```

Responses payload：

```json
{
  "input": [
    {"role": "system", "content": [{"type": "input_text", "text": "<system>"}]},
    {"role": "user", "content": [{"type": "input_text", "text": "<workspace>"}]},
    {"role": "user", "content": [{"type": "input_text", "text": "<memory + plan>"}]},
    {"role": "user", "content": [{"type": "input_text", "text": "当前是 Plan mode，只能分析不能改代码"}]},
    {"role": "user", "content": [{"type": "input_text", "text": "修复 doctor cache warning"}]}
  ],
  "prompt_cache_key": "mycli:openai:responses:<hash>"
}
```

Anthropic payload：

```json
{
  "system": [
    {"type": "text", "text": "<system>", "cache_control": {"type": "ephemeral"}}
  ],
  "messages": [
    {"role": "user", "content": [{"type": "text", "text": "<workspace>"}]},
    {"role": "user", "content": [{"type": "text", "text": "<memory + plan>", "cache_control": {"type": "ephemeral"}}]},
    {"role": "user", "content": [{"type": "text", "text": "当前是 Plan mode，只能分析不能改代码"}]},
    {"role": "user", "content": [{"type": "text", "text": "修复 doctor cache warning"}]}
  ]
}
```

Compatible Chat payload：

```json
{
  "messages": [
    {"role": "system", "content": "<system>"},
    {"role": "user", "content": "<workspace>"},
    {"role": "user", "content": "<memory + plan>"},
    {"role": "user", "content": "当前是 Plan mode，只能分析不能改代码"},
    {"role": "user", "content": "修复 doctor cache warning"}
  ],
  "prompt_cache_key": "mycli:compatible:chat_completions:<hash>"
}
```

DeepSeek payload：

```json
{
  "messages": [
    {"role": "system", "content": "<system>"},
    {"role": "user", "content": "<workspace>"},
    {"role": "user", "content": "<memory + plan>"},
    {"role": "user", "content": "当前是 Plan mode，只能分析不能改代码"},
    {"role": "user", "content": "修复 doctor cache warning"}
  ],
  "extra_body": {"thinking": {"type": "enabled"}},
  "reasoning_effort": "high"
}
```

DeepSeek 不带 `prompt_cache_key`，因为 profile 明确
`wire_hints_supported=false`；cache 命中率主要由 stable prefix 是否保持
字节级稳定决定。

## 12. 关键结论

1. 落库的是 canonical / structured state，不是 provider wire payload。
2. 发给模型的是 provider projection，不同 provider 的 wire shape 可以不同。
3. 只要 agent 后续需要知道，内容就应该 persistent；只服务传输和缓存的 hint 才是 wire-only。
4. current user input 永远在最后，保护模型注意力，也保护 stable prefix。
5. compact 改写 dynamic replay，不改 frozen/stable prefix。
6. Responses 可以 replay same-issuer encrypted reasoning；Chat/Anthropic/DeepSeek 都不能乱发这个字段。
7. Anthropic 的 `cache_control` 和 OpenAI 的 `prompt_cache_key` 都不是普通上下文，不能落进 transcript。
