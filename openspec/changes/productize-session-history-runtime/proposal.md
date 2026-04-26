## Why

`mycli` 已经有了 Responses runtime、turn context、layered instructions、dynamic tools 和 runtime policy，但它的运行时真值仍然更接近“conversation 文本 + 若干辅助状态”，还没有升级成通用 agent 所需的“结构化 session/history/runtime 主链”。这会直接限制 continuation 稳定性、context 复用、tool 记忆、compaction、resume/recovery 和多 agent 演进能力，所以现在需要把工程化改造收敛到一条更底层的 runtime 基础设施提案上。

## What Changes

- 将 `mycli` 的会话主链从文本 conversation 提升为结构化的 `session / thread / turn / history item` 运行时对象，明确哪些历史项是模型后续推理的真值。
- 让 tool call、tool result、关键文件写入痕迹进入原生 history，而不是只保留摘要文本或松散日志。
- 引入显式的 `context baseline` 机制，使稳定上下文和多 turn history 分层维护，而不是每轮整包重灌。
- 正式定义 compaction 语义：以“历史替换事务”而不是“附加一段 summary”来压缩上下文。
- 为每个 turn 增加 rollout 持久化与 reconstruction 边界，让 session 能在中断后重建活跃历史并继续执行。
- 保持目标是为通用型个人助手 agent 打底，而不是为仓库分析、代码修改或某类固定任务做特化 runtime。

## Capabilities

### New Capabilities
- `session-history-runtime`: 定义结构化 session/thread/turn/history item 主链，以及 tool activity 进入会话真值的规则。
- `context-baseline-compaction`: 定义 reference context baseline、baseline diff 更新和 history compaction 的正式语义。
- `runtime-rollout-recovery`: 定义 per-turn rollout、state reconstruction、resume/replay 所需的持久化与恢复边界。

### Modified Capabilities

None.

## Impact

- 受影响代码：
  - `src/mycli/application/runtime/agent_runtime.py`
  - `src/mycli/services/session_service.py`
  - `src/mycli/services/context/*`
  - `src/mycli/infrastructure/openai_responses_client.py`
  - `src/mycli/infrastructure/models/responses_adapter.py`
  - `src/mycli/prompts/*`
  - `src/mycli/tools/*`
  - 新的 history / rollout / compaction / reconstruction 相关模块
- 受影响数据与状态：
  - session 文件结构
  - turn 持久化记录
  - tool history 表达方式
  - trace / debug / raw log 与 compaction 数据
- 受影响测试：
  - runtime、session、context、responses、tool persistence 单元测试
  - resume / reconstruction / compaction 集成测试
  - 至少一轮真实 provider smoke 和中断恢复 smoke
