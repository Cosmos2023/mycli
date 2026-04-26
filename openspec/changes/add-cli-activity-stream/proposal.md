## Why

`mycli` 目前已经有可运行的 CLI REPL、runtime 主链和事后 `/trace` 能力，但在用户交互当下仍然缺少“正在做什么”的实时可见性。对于搜索、读文件、等待审批或模型请求较慢的场景，CLI 往往表现为沉默，用户很难判断 agent 是在正常工作、卡住，还是已经出错。

现在补这一层是合理的，因为 `mycli` 已经具备 runtime、工具和 trace 的基础设施，缺的不是执行能力，而是执行过程的可观察性。增加一套类似 Codex CLI / Claude Code 的实时活动流，可以显著改善等待体验，也为后续更成熟的终端 UI 留下稳定事件源。

## What Changes

- 引入一套 runtime 产出的结构化 activity event 模型，用于表达思考、规划、工具执行、审批等待和模型错误等状态。
- 扩展 CLI 响应链路，让前台在最终回答之前渲染 `[activity]` 行，而不是只显示最后的 assistant message。
- 为高频工具增加可读的活动文案映射，例如 `Reading`、`Searching`、`Editing`、`Git`、`Shell`。
- 保留现有 `progress_updates` 和 `/trace` 能力，使第一版活动流与既有调试能力并存，而不是互相替代。
- 增加 runtime 和 CLI 测试，确保活动流渲染顺序、兼容性和错误状态可验证。

## Capabilities

### New Capabilities
- `cli-activity-stream`: 定义 runtime 如何产生活动事件，以及 CLI 如何把这些事件实时渲染成用户可见的执行活动流。

### Modified Capabilities
- None.

## Impact

- 受影响代码：`src/mycli/domain/runtime/*`、`src/mycli/application/runtime/agent_runtime.py`、`src/mycli/application/turn_service.py`、`src/mycli/cli/main.py`
- 可能受影响的辅助层：与 progress、trace、审批展示相关的渲染路径
- 受影响测试：CLI 测试、runtime 测试、可能的 trace/turn-service 兼容性测试
- 外部 API 和依赖：无
- 用户可见影响：用户在最终回答出现前，能够看到 `mycli` 正在思考、规划、读取文件、搜索内容、等待审批或发生模型错误
