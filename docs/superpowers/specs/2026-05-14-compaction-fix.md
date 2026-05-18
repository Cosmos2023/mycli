# Compaction 修复

> 基于对 `pipeline.py`、`budget.py`、`cache_zones.py`、`turn_executor.py`、`tool_execution_service.py` 的实际代码审查。Codex review 反馈已整合。

## 实际状态

| 组件 | 实际状态 |
|---|---|
| CacheZones | ✅ 已按 cache_policy 计算边界，有 frozen_fingerprint + validate() |
| ToolResultBudget (L1) | ✅ 已实现。检查 cache_frozen 跳过已处理消息 |
| ToolResultDedup (L2) | ✅ 已实现。但**不检查 cache_frozen** |
| SlidingWindowEviction (L3) | ✅ 已实现。但**不检查 cache_frozen** |
| LLMSummarization (L4) | ✅ 框架完整。但 `split_index = len//2`，`_call_summarizer()` 是 stub |
| TokenCounter | ✅ 已有 tiktoken |
| _record_tool_message | ❌ append 时**不标记 cache_frozen=True** |

## 三个实际 bug

### Bug 0：工具结果 append 时未封存

`tool_execution_service.py` line 532：`_record_tool_message()` 追加的 Message 没有 `cache_frozen=True`。这意味着 CompactionPipeline 首次运行时，ToolResultBudget（L1）会修改所有未标记的 tool message——即使它们已经 append 过了。

**修法**：`_record_tool_message()` 追加时标记 `cache_frozen=True` + `l1_truncated=True`。

### Bug 1：L2/L3 不检查 cache_frozen

`ToolResultDedup` 和 `SlidingWindowEviction` 扫描 `zones.fresh_start` 之后所有 tool_result，不跳过已标记 `cache_frozen=True` 的消息。被 L1 处理过并进入缓存前缀的消息，后续 turn 可能被 L2/L3 再次修改 → 破坏缓存前缀。

**修法**：L2 迭代中加 `if message.metadata.get("cache_frozen"): continue`。L3 列表推导中滤除 `cache_frozen`。

### Bug 2：L4 一刀切分割

`LLMSummarization.apply()` 第 239 行：`split_index = len(fresh_messages) // 2`。不关心消息边界，可能切断 tool_call/tool_result pair。

**修法**：加 `_find_safe_split(messages, candidate)` —— 从 candidate 向后找第一个安全分割点。安全 = 不孤儿任何 tool_result，不拆分同一个 response_id 的 chunk。

## 不在范围内的

- 真实 LLM 摘要调用（不属于本次 bug 修复范围，单独设计）
- Budget nudge 信号注入（不属于 bug 修复，单独设计）
- 并行工具执行分组（已存在，与本 bug 无关）
