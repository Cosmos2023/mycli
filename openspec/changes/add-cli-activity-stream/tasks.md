## 1. 活动事件模型

- [x] 1.1 在 runtime/domain 层新增 `ActivityEvent` 模型
- [x] 1.2 扩展 `TurnResponse` 以承载 `activity_events`
- [x] 1.3 增加基础测试，验证没有活动事件时现有响应结构仍然兼容

## 2. Runtime 事件发射

- [x] 2.1 在模型请求前和 reasoning / planning 节点发出 `thinking` / `planning` 活动事件
- [x] 2.2 在工具调用前后发出 `tool_started` / `tool_finished` 活动事件
- [x] 2.3 在审批等待和模型错误路径发出 `waiting_approval` / `model_error` 活动事件
- [x] 2.4 为高频工具增加可读活动文案映射，例如 `Reading`、`Searching`、`Editing`、`Git`、`Shell`

## 3. CLI 活动流渲染

- [x] 3.1 更新 `src/mycli/cli/main.py`，让 CLI 在最终回答前渲染 `[activity]` 行
- [x] 3.2 保持活动流与现有 `[progress]`、`[plan]`、`[decision]` 输出共存
- [x] 3.3 确保没有活动事件时，CLI 仍保持当前行为

## 4. 验证与回归

- [x] 4.1 增加 CLI 测试，验证活动流渲染顺序和输出格式
- [x] 4.2 增加 runtime 测试，验证不同状态下的活动事件发射
- [x] 4.3 运行相关 `pytest` 和 `ruff` 检查，确认活动流没有破坏现有交互链路
