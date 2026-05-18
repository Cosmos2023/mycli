# mycli Compaction 重新设计

> 基于对 Claude Code、Codex 上下文管理的深度对比分析。根因：DeepSeek 没有 cache_edits，中间层 compaction 无法在不破坏缓存前缀的情况下修改已缓存消息。

## 1. 核心结论

**L1 是唯一可以在"不破缓存"的前提下修改消息内容的防线。** L2/L3 只能做监控和信号注入，不能做主动压缩。L4 是最后兜底，破缓存但值得。

```
┌──────────────────────────────────────────────────┐
│ 消息生命周期                                      │
│                                                  │
│ 工具执行 → L1 截断 → append → 发模型 → 进缓存     │
│              ↑                                   │
│         唯一修改窗口                               │
│         进缓存后封印，永不修改                      │
└──────────────────────────────────────────────────┘
```

## 2. Claude Code / Codex / DeepSeek 对比

| 机制 | Claude Code | Codex | DeepSeek |
|---|---|---|---|
| 缓存清理 | `cache_edits` API — 服务端删，本地不动 | `/responses/compact` 服务端压缩 | ❌ 都没有 |
| 中间层压缩 | 热缓存: cache_edits; 冷缓存: 本地改 | 不做——append-only 回避问题 | 只能本地改→必破缓存 |
| L1 策略 | 激进，每工具独立调参（Read 25K tokens） | 随意，10KB 一刀切 | — |
| 上下文窗口 | 200K | 400K (Codex 模型) | 1M |
| 缓存架构 | V4 CSA+HCA，KV cache 仅占传统 2% | GPT-5 服务端缓存 | 前缀自动匹配，无显式参数 |

## 3. 重新设计的四层模型

### L1 — 主力防线（始终在线，进缓存前执行）

| 工具 | 上限 | 策略 |
|---|---|---|
| Read | <15K 全文；15-60K head_tail；>60K 报错 | 三档分级 |
| Bash | 10K head_tail + 磁盘持久化 | head_tail |
| Grep | 50 条 | top_n |
| Glob | 200 文件 | top_n |

每工具执行后、append 前执行。纯本地操作，不计成本。

### L2 — 去重监控（≥40% budget）

不修改消息。注入 budget nudge:

```
[token_budget_remaining: 60% used. Consider finishing your response soon.]
```

### L3 — 窗口监控（≥70% budget）

不修改消息。注入强制收敛信号:

```
[token_budget_remaining: 85% used. MUST respond based on available information.
 Do NOT call more tools. Stop exploring and act now.]
```

连续 3 次检查增量 <500 tokens → 强制终止 turn。

### L4 — LLM 摘要（≥90% budget）

- 使用 `_find_safe_split()` 确保 tool pair 不孤儿
- 9 段结构化摘要（Primary Request, Key Technical Concepts, Files, Errors, Fixes, User Messages, Pending Tasks, Current Work, Next Step）
- 断路器：连续 3 次失败停止
- 破缓存，但有熔断保护

## 4. 并行工具执行

工具按 concurrency 安全标记动态分组。连续的 safe 工具 → 并行 batch。遇到 unsafe → 截断、排空 batch、串行执行 unsafe。

```python
CONCURRENCY_SAFE = {"Read", "Grep", "Glob", "LS", "WebSearch", "WebFetch", "Lint"}

def execute_tool_calls(calls):
    batch = []
    for call in calls:
        if call.name in CONCURRENCY_SAFE:
            batch.append(call)
        else:
            _flush_parallel(batch)
            _execute_serial(call)
    _flush_parallel(batch)
```

## 5. 设计原则

1. **已进缓存的消息永不修改。** DeepSeek 没有 cache_edits，这是唯一不破缓存的路。
2. **L1 必须够狠。** 这是唯一能安全改内容的窗口。
3. **L2/L3 是信号层，不是压缩层。** 给模型发提醒，让它自己收敛。
4. **重复读取不拦截。** System prompt 提示批量并行读取即可。L2 同 turn 兜底。
5. **L4 是最后手段。** 安全分割边界 + 结构化摘要 + 熔断。
