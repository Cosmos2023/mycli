# P0 Context Stability

> 目标：先把上下文窗口、L4 压缩、恢复路径做可靠，再进入工具安全、编辑安全和多代理。

## 1. 背景

当前 `mycli` 已完成 L1 工具结果截断、L4 真实 LLM 摘要、摘要模型配置、摘要时禁用工具/thinking、provider `input_tokens` 统计，以及切 session 后从 `model_usage` 恢复窗口已用量。剩余最影响真实任务完成率的是：L4 没有预留压缩缓冲、provider 返回 context/prompt too long 后缺少可靠 reactive compact、压缩后复水只是一条 reminder、summary prompt 缺少明确 TEXT ONLY 约束。

本批次只处理 P0 上下文稳定化，不处理 Bash 安全、Edit 并发控制、Sub-agent、流式 API、Context Collapse、MCP defer loading。这些属于后续独立批次。

## 2. 范围

### 2.1 13K Auto-Compact Buffer

在请求发送前的 L4 触发判断中引入固定保留区，默认 `13_000` tokens。有效触发阈值取 `min(config.compaction_l4_trigger_ratio, (max_prompt_tokens - buffer) / max_prompt_tokens)`，避免模型请求已经接近硬上限时才开始 compact。

当 `max_prompt_tokens <= buffer` 时，buffer 退化为 20% 窗口，保证小窗口测试和低配模型仍能工作。该逻辑只影响 L4 触发判断，不改变 `max_prompt_tokens` 本身，也不改变 provider 请求的输出上限。

### 2.2 Reactive Compact

当模型请求抛出 `ModelResponseError` 且 `failure_kind` 或 `stop_reason` 表示 context/prompt window exceeded 时，同一个 turn 内最多执行一次 reactive L4 compact，然后重建 context/request 并 retry。该路径必须有防循环状态，避免 compact 失败后重复 compact。

Reactive compact 使用当前完整 provider request snapshot，而不是只压缩 SQLite conversation 的一部分。压缩失败时走现有错误恢复路径，不吞掉最终错误。

### 2.3 L4 Rehydration

L4 触发后，从 `recent_files` 中选出最多 3 个路径，读取当前磁盘内容并注入 volatile runtime reminder。单文件最多 5K tokens，总计最多 15K tokens；超限时保留文件路径和截断提示，不写入 transcript。

复水块用于减少压缩后模型猜文件内容，不替代工具调用。它只包含最近文件的当前内容片段，不恢复旧 tool result，不修改 session history。

### 2.4 Summary Prompt TEXT ONLY Guard

L4 summary prompt 必须显式要求：只输出文本 summary，不调用工具，不输出 JSON/XML，不请求用户确认，不继续执行任务。虽然 summarizer adapter 已经传 `tools=[]`，prompt 仍要作为 provider 兼容和输出质量约束。

### 2.5 Observability

`last_cost_metrics` 需要记录触发来源：`pre_request` 或 `reactive_error`，并记录是否使用 buffer、buffer token 数、复水文件数、复水 token 估算。`/stats` 继续显示现有 budget/cache 指标；本批次不做 `/context` 图形化。

## 3. 非目标

- 不实现 Context Collapse / L4.5。
- 不实现 streaming / AsyncGenerator。
- 不实现 Bash 23 项安全规则。
- 不实现 Edit optimistic concurrency。
- 不实现 sub-agent 执行。
- 不引入新依赖。

## 4. 文件变更

| 操作 | 文件 | 说明 |
|---|---|---|
| 修改 | `src/mycli/domain/runtime/__init__.py` | `AgentConfig` 增加 `compaction_l4_buffer_tokens`，默认 `13_000` |
| 修改 | `src/mycli/config/settings.py` | 从 env/user/project config 读取 `compaction_l4_buffer_tokens` |
| 修改 | `src/mycli/services/context/compaction/pipeline.py` | buffer-aware trigger、TEXT ONLY prompt、reactive source metrics、rehydration payload helper |
| 修改 | `src/mycli/application/runtime/agent_runtime.py` | 配置 L4 buffer，构造 full context snapshot，提供 recent-file rehydration helper |
| 修改 | `src/mycli/application/runtime/turn_executor.py` | pre-request buffer 触发、reactive compact retry、复水块注入 |
| 修改 | `src/mycli/application/turn_service.py` | `/stats` 可继续读取更新后的 metrics，不新增命令 |
| 测试 | `tests/unit/test_l4_summarizer.py` | prompt guard 和 buffer trigger 单测 |
| 测试 | `tests/unit/application/test_agent_runtime_l4.py` | pre-request buffer、reactive compact、同 turn retry |
| 测试 | `tests/unit/test_l4_rehydration.py` | recent file 内容复水、预算截断、不写 transcript |
| 测试 | `tests/unit/services/test_config_service.py` | config/env 读取 buffer |

## 5. 验收标准

- 当 request budget 未超过 `compaction_l4_trigger_ratio` 但进入 13K buffer 区时，L4 会在发主模型请求前触发。
- 当 provider 返回 context window exceeded，runtime 同一个 turn 内最多 reactive compact 一次，并重建 request 后 retry。
- Reactive compact 成功后，模型可继续调用工具或完成回答，turn 不丢失用户请求。
- L4 summary prompt 包含 TEXT ONLY / no tools / no JSON/XML / do not continue task 约束。
- L4 后最多 3 个 recent files 的当前内容作为 volatile reminder 注入，且不会写入 transcript/history。
- 切换 session 后 provider input token 统计仍按已有 `model_usage` 恢复；本批次不得回退该行为。
- `uv run ruff check src tests`、`uv run mypy src/mycli`、`uv run pytest -q` 通过。
