# L4 Summarization

> 替换 `_call_summarizer()` 字符串拼接 stub 为真实 LLM 调用 + post-compact 文件提示。

## 1. 当前状态

`LLMSummarization` 框架完整（安全分割、断路器、成本感知、模型可配），但 `_call_summarizer()`（pipeline.py:351-359）是纯字符串拼接。每次 L4 触发产生低质量摘要 + 破坏缓存。构造时未注入 LLM client——`__init__` 只有 `model_name` 参数，没有实际调用链路。

## 2. 修复

### 2.1 SummarizerClient 协议 + 注入

新增 `SummarizerClient` Protocol —— 只需要 `complete(messages, model, max_tokens)` 一个方法。`LLMSummarization.__init__()` 新增两个可选参数：

- `summarizer_client: SummarizerClient | None` — 默认 `None`，保持向后兼容（测试走 stub）
- `summarizer_model_name: str | None` — 摘要专用模型，默认 `"deepseek-lite"`，与主模型分离

`AgentRuntime` 构造 `LLMSummarization` 时，将现有 `ModelTurnRequester` 通过 `_SummarizerClientAdapter` 注入。

### 2.2 9 段结构化 prompt

```
1. Primary Request
2. Key Technical Concepts
3. Files Examined or Edited
4. Errors and Fixes
5. Decisions Made
6. All User Messages
7. Pending Tasks
8. Current Work
9. Optional Next Step
```

输出预期 ~500 tokens。失败抛异常 → 现有断路器拦截 → `_failure_count += 1` → 返回原 conversation。

### 2.3 Post-compact 文件提示（volatile）

`_collect_recent_files()` 从被压缩消息中提取最近 3 个文件的路径（编辑过的优先）。存入 `last_cost_metrics["recent_files"]`。TurnExecutor 读取后注入 `runtime_reminders`，不写入 transcript。下一轮模型看到 `[Compaction applied. Recent files: auth.py, db.py, ...]` 后自主决定是否重读。

## 3. 文件变更

| 操作 | 文件 | 说明 |
|---|---|---|
| 修改 | `pipeline.py` | `SummarizerClient` Protocol + `__init__` 新参数 + `_call_summarizer()` 替换 + `_collect_recent_files()` |
| 修改 | `agent_runtime.py` | 注入 `_SummarizerClientAdapter` 到 `LLMSummarization` 构造 |
| 修改 | `turn_executor.py` | 读取 `last_cost_metrics["recent_files"]` 注入 `runtime_reminders` |
| 新建 | `tests/unit/test_l4_summarizer.py` | 4 个测试 |
| 新建 | `tests/unit/application/test_agent_runtime_l4.py` | 2 个测试 |
| 新建 | `tests/unit/test_l4_rehydration.py` | 4 个测试 |

## 4. 验收

- `summarizer_client` 为 `None` 时回退到字符串拼接（向后兼容）
- `summarizer_client` 注入时调用真实 LLM，9 段 prompt
- 失败传播到断路器
- `recent_files` 通过 `runtime_reminders` 呈现（不进 transcript）
- FROZEN ZONE 在 L4 前后不变
