# mycli Compaction 根因修复

> 根因：compaction 在消息已进缓存前缀之后运行。L2/L3 改已缓存消息 → 破缓存；L4 一刀切分割 → 破坏 tool pair。
> 修复：L2/L3 限定当前 turn 新增消息；L4 安全分割边界。

## 1. 问题

### 1.1 Compaction 破坏缓存前缀

当前 L2（去重）和 L3（滑动窗口）操作 `zones.fresh_start` 之后**所有**消息——包括已随上一次 API 请求进了 DeepSeek KV cache 的历史消息。每次触发都在 invalidate 缓存前缀。

```
Turn N 的请求: [system] [tools] [user] [asst] [tool_result①] [tool_result②]
                                          └─── 已进缓存 ────┘ └── 本轮新增 ──┘

Turn N+1 前 L3 触发: 把 tool_result① 替换为 [archived]
        → 缓存前缀变了 → cache miss → 成本涨 10 倍 → budget ratio 更高 → 更激进压缩 → 恶性循环
```

### 1.2 L4 一刀切破坏 tool pair

`LLMSummarization.apply()` 用 `len(fresh_messages) // 2` 分割，不管消息边界。切在 `assistant(tool_A)` 之后、`tool_result(A)` 之前——tool_A 进前半段被删，tool_result(A) 留在后半段变成孤儿。Sanitizer 丢弃孤儿，模型看到残缺对话。

## 2. 修复方案

### 2.1 L2/L3：只操作当前 turn 新增的消息

`CompactionPipeline` 所有策略加 `scope` 参数：

- `scope="fresh_only"` → 只操作当前 turn 新增的消息（上次 API 请求之后 append 的）
- 历史消息（已进缓存前缀的）**只读不写**

```python
def _compute_turn_boundary(self, conversation, zones):
    """返回本轮第一次 API 请求边界——边界之前的已进缓存，不碰。"""
    return conversation.metadata.get("last_sent_index", zones.fresh_start)
```

### 2.2 L4：安全分割边界

`len // 2` 替换为 `_find_safe_split()`——向后扫描到没有活跃 tool_call 的位置：

```python
def _find_safe_split(self, messages, candidate):
    """从 candidate 向后找第一个'安全'分割点。"""
    idx = max(0, candidate)
    result_ids_after = {m.tool_call_id for m in messages[idx:] 
                        if m.role == "tool" and m.tool_call_id}
    while idx > 0:
        prev = messages[idx - 1]
        if prev.role == "assistant":
            call_ids = {tc.id for tc in (prev.tool_calls or [])}
            if call_ids & result_ids_after:
                idx -= 1; continue
        if idx > 0 and messages[idx - 1].response_id == messages[idx].response_id:
            idx -= 1; continue
        break
    return idx
```

### 2.3 L1 前移

L2/L3 操作范围缩小 → 压缩能力下降 → L1 必须更激进。调整 L1 截断规则：

| 工具 | 当前 | 修复后 |
|---|---|---|
| Read | 3K 字符 | <15K 全文，15-60K head_tail，>60K 报错 |
| Bash | 500 字符 | 10K head_tail + 磁盘持久化 |
| Grep | 10 条 | 50 条 |

## 3. 文件变更

| 操作 | 文件 | 说明 |
|---|---|---|
| 修改 | `pipeline.py` | `CompactionPipeline.apply()` 加 scope 参数；`LLMSummarization` 加安全分割 |
| 修改 | `pipeline.py` | `SlidingWindowEviction` 和 `ToolResultDedup` 尊重 scope |
| 修改 | `pipeline.py` | `ToolResultBudget` 从 no-op 到真实实现（L1 前移） |
| 修改 | `cache_zones.py` | 修复边界计算（按 cache_policy 而非 '第一条 user 消息'） |
| 修改 | `turn_executor.py` | 每次 API 响应后记录 `last_sent_index` |
| 新建 | `tests/unit/test_compaction_safety.py` | L4 安全分割 + L2/L3 scope + 缓存稳定性测试 |
