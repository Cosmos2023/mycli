# Context Management：上下文压缩管线设计

> 参考 Claude Code（5 层压缩管线 + 三分区缓存保护）和 OpenAI Codex（TruncationPolicy + auto-compaction）。

## 1. 问题

mycli 的上下文管理有三个缺陷：

### 1.1 截断一刀切

`ContextManager.render_tool_result()` 已经做了 1600 字符硬截断，但：

- **不区分工具类型**。read_file 需要更多上下文（代码文件），run_shell 只需要退出码和尾部输出
- **预览太短**。`_render_tool_result_from_payload` 里 content/stdout/stderr 统一取 `[:240]`，对 read_file 来说几乎没用——模型看不清内容，被迫反复调 read_file

### 1.2 无去重

调了两次 `read_file("a.py")`，两次的预览都会保留在 messages 里。模型看到两个相似的片段，可能困惑或被误导。

### 1.3 Conversation 只增不减

`Conversation.messages` 是纯追加列表，没有淘汰机制。随着轮次增加，早期轮次的 tool_result 永远占着上下文空间。

### 1.4 缓存零感知

工具定义顺序未显式锁定，消息写入不区分缓存 zone。DeepSeek 的 KV cache 按消息列表前缀匹配，任何前缀内的变化都会导致缓存 miss。

## 2. 设计原则

- **缓存优先（Cache-First）**。每次修改消息前先判断：这会在缓存前缀内吗？会就绝对不碰。
- **双表示分离**。存储层保留完整 `raw_payload`（过 trace_service），上下文层只发精简版。两者永不混用。
- **分层递进。**从最便宜（截断）到最贵（LLM 摘要），逐级触发。
- **不影响现有 API 路径**。不改 `request_shape`、`runtime_items`、`legacy_messages` 的构建逻辑。

## 3. 缓存 Zone 模型

```
messages:
  ┌─────────────────────────────┐
  │ system_prompt               │
  │ tool_def_1                  │  FROZEN ZONE（缓存前缀）
  │ tool_def_2                  │  绝对不可修改、不可删除、
  │ ...                         │  不可调序、不可插入
  │ tool_def_N                  │
  ├─────────────────────────────┤ ← frozen boundary（本轮第一个 user_message）
  │                             │
  │  当前轮次的所有消息           │  FRESH ZONE
  │  user_message, assistant,   │  可自由裁剪、去重、占位
  │  tool_result, ...           │
  │                             │
  └─────────────────────────────┘
```

**规则**：
- Frozen zone 的消息，**永不修改内容、永不删除、永不调序**
- Fresh zone 的消息，可被 L1/L2/L3 修改
- L4（LLM 摘要）会打破缓存前缀，但只在极端情况触发，且带断路器

## 4. 四层压缩管线

### 4.1 工具层：差异化截断 + 终止暗示（源头提纯）

在 `ToolExecutionService._record_tool_message()` 写入 conversation 之前：

```
                 ToolResult.raw_payload（完整原始数据）
                         │
                         ├──→ trace_service（存完整版，永不截断）
                         │
                         └──→ tool_result_formatter（按工具类型差异化截断）
                                   │
                                   ▼
                              context_representation → conversation.append()
```

| 工具 | 上限 | 截断策略 |
|------|------|---------|
| `read_file` | 3000 字符 | 代码内容保留前 2000 字符 + 截断标注 |
| `read_file_range` | 2000 字符 | 同上，标注 boundary 参数 |
| `run_shell` | 500 字符 | 退出码 + 最后 30 行 stdout + 行数统计 |
| `list_directory` | 输出结构化 JSON | `{dirs: [...], files: [...], total: 47}`，>30 条目只列前 5 + 留检索提示 |
| `search_text` | 10 条匹配 | 超出标注 `"[共 N 条匹配，以上为前 10 条]"` |
| `edit_file` | 保持现有行为 | 无需改动 |
| `update_plan` | 保持现有行为 | 无需改动 |

**终止暗示**：每个工具结果末尾追加一行提示，如：

- read_file 完整读取：`"[文件读取完毕。如果你已有足够信息，现在就可以回答。]"`
- run_shell 成功：`"[命令执行成功。退出码: 0]"`
- search_text 完整：`"[搜索完毕，共 N 条匹配。]"`

**对缓存影响**：✅ 安全。修改发生在写入 conversation 之前。

### 4.2 L1 — ToolResultBudget（始终执行）

在 `render_tool_result` 中，对每个 tool_result 应用上述差异化截断。替换现有的统一 1600 硬截断。

**触发**：始终。

**对缓存影响**：✅ 安全。

### 4.3 L2 — ToolResultDedup（token >= 40% 预算时触发）

当前 turn 内，检查是否已有相同 `(tool_name, args_hash)` 的 tool_result。如果有，用占位符替换重复结果：

```
"[cleared: same as call #N (read_file: src/x.py). Result was identical.]"
```

**关键约束**：只扫描 fresh zone（当前 turn），不碰 frozen zone。

**对缓存影响**：✅ 安全。只修改 fresh zone 尾部。

### 4.4 L3 — SlidingWindowEviction（token >= 70% 预算时触发）

保留最近 8 条 tool_result，更早的替换为占位符：

```
"[earlier tool_result archived. call_id: call_abc123]"
```

**关键约束**：只淘汰 fresh zone 内的。frozen zone 内的 tool_result 不碰。

**对缓存影响**：✅ 安全。fresh zone 内的旧结果在缓存前缀之后。

### 4.5 L4 — LLMSummarization（token >= 90% 预算时触发）

调用一次轻量模型（如 deepseek-lite），将 early messages 压缩为一段摘要：

```python
summary = llm.summarize(
    conversation.messages[:compaction_boundary],
    instruction="Summarize the key findings and decisions so far."
)
conversation.messages = [summary_as_message(summary)] + conversation.messages[compaction_boundary:]
```

**对缓存影响**：❌ 必然打破缓存前缀。下一轮请求会重建缓存。
**断路器**：连续 3 次触发后放弃，不再尝试摘要。

## 5. 缓存稳定性（Cache Stability）

两个硬规则，每次模型请求前执行：

### 5.1 工具定义稳定排序

`tool_exposure_planner` 中，`render_for_model()` 时始终按 tool name 字母序排列：

```python
sorted_tools = sorted(tool_defs, key=lambda t: t.name)
```

**原因**：DeepSeek KV cache 按消息列表前缀精确匹配。工具定义顺序如果不稳定（如 MCP 工具动态增删导致整体重排），缓存命中率降到 0。

### 5.2 System prompt 不变

所有动态提醒走 `runtime_reminders` 通道（在 prompt 动态部分，不在缓存前缀内）。不在 system prompt 里插入本轮信息。

## 6. ContextBudget（预算追踪）

追踪每轮累计 token，作为 L2/L3/L4 的触发依据，同时喂给 TurnGuard：

```python
@dataclass(slots=True)
class ContextBudget:
    total_tokens: int = 0
    system_prompt_tokens: int = 0
    tool_defs_tokens: int = 0
    conversation_tokens: int = 0
    
    @property
    def usage_ratio(self) -> float:
        return self.total_tokens / self.max_tokens
```

每轮模型请求后累加 `usage["total_tokens"]`。

## 7. 与存储层的边界

```
上下文路径（精简版）                  存储路径（完整版）
─────────────────                   ─────────────────
conversation.messages                trace_service
  │ 内容：截断/去重/占位的版本           │ 内容：raw_payload 完整保留
  │ 用途：发给 LLM                     │ 用途：session 恢复时回放
  │ 编码：Message.content + blocks      │ 编码：RuntimeTraceEvent.payload
  │                                    │
  └── Session 恢复时 ──────────────────→ 需要完整 raw → 从 trace 取
      正常回话直接用 conversation，不重建
```

**关键**：compaction 所有操作只动 context representation，不删存储层的 raw_payload。

## 8. 文件变更清单

| 操作 | 文件 | 说明 |
|------|------|------|
| 新增 | `src/mycli/services/context/compaction/__init__.py` | 导出 |
| 新增 | `src/mycli/services/context/compaction/pipeline.py` | CompactionPipeline + 4 个 CompactionStrategy |
| 新增 | `src/mycli/services/context/compaction/budget.py` | ContextBudget |
| 新增 | `src/mycli/services/context/compaction/cache_zones.py` | frozen/fresh zone 边界计算 |
| 新增 | `src/mycli/services/context/tool_result_formatter.py` | 按工具类型的截断规则 + 终止暗示 |
| 修改 | `src/mycli/services/context/context_manager.py` | render_tool_result 接入 ToolResultFormatter |
| 修改 | `src/mycli/application/runtime/tools/tool_execution_service.py` | _record_tool_message 接入 L1/L2 |
| 修改 | `src/mycli/application/runtime/turn_executor.py` | 模型请求前跑 pipeline + budget 追踪 |
| 修改 | `src/mycli/tools/routing/tool_exposure_planner.py` | 工具定义稳定排序 |
| 修改 | `src/mycli/services/context/window_service.py` | 可废弃（被 pipeline 替代） |

## 9. 不在范围内的

- 不改 model adapter 层（不碰 OpenAI Responses / Anthropic Messages 适配）
- 不改 request_shape 构建逻辑
- 不改变 Conversation 数据结构（Message 结构保持不变）
- 不改 TurnGuard 逻辑（只从 ContextBudget 读取 token 数）
- 不实现 LLM 摘要（L4 只做策略占位，摘要模型调用的实现细节后续 spec）
