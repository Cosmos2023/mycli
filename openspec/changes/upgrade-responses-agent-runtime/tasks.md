## 1. Responses 非流式语义适配

- [x] 1.1 扩展 `src/mycli/infrastructure/models/responses_adapter.py`，正式支持 `reasoning`、`summary`、`function_call`、`message.output_text` 到 runtime block 的映射
- [x] 1.2 扩展 `src/mycli/domain/runtime/blocks.py` 或相关结果对象，保留 response/status/usage 和 item metadata
- [x] 1.3 增加 Responses adapter 测试，覆盖 reasoning、metadata、unknown item warning 和已知 item 共存场景

## 2. Runtime 执行语义升级

- [x] 2.1 更新 `src/mycli/application/runtime/agent_runtime.py`，让 Responses reasoning 成为 `thinking` / `planning` activity 的正式来源
- [x] 2.2 确保 Responses reasoning 与 tool call 可以在同一轮中共同推进执行链路，而不会互相覆盖
- [x] 2.3 增加 runtime 测试，验证 reasoning-derived activity、tool execution continuity 和最终回答形成过程

## 3. Responses Streaming 接入

- [x] 3.1 更新 `src/mycli/infrastructure/openai_responses_client.py`，增加 streaming 能力并归一化基础流式事件
- [x] 3.2 在 runtime 中增加对 Responses streaming 路径的消费逻辑，并复用现有 activity / text 语义
- [x] 3.3 增加 streaming 相关测试，覆盖 reasoning、function_call 和 streamed answer 片段

## 4. CLI 执行过程展示

- [x] 4.1 更新 `src/mycli/cli/main.py`，渲染 Responses-derived reasoning activity 和 streamed answer 输出
- [x] 4.2 保持 streamed output 与现有 `[activity]`、`[error]`、`[progress]`、`[plan]`、`[decision]` 输出顺序兼容
- [x] 4.3 增加 CLI 测试，验证 richer agent activity 与 streamed answer 渲染行为

## 5. 日志与回归验证

- [x] 5.1 更新日志路径，记录 unsupported Responses item、stream 生命周期和流式解析异常
- [x] 5.2 运行 Responses client、Responses adapter、runtime 和 CLI 相关测试，确认新适配没有破坏现有链路
- [x] 5.3 运行相关 `ruff` 检查，确认新增的 Responses runtime 代码符合当前代码规范
