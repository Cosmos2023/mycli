## Why

`mycli` 已经具备可运行的 runtime、CLI 活动流、工具 trace 和会话持久化，但日志体系仍然偏零散。模型请求与响应没有稳定落到当前工作区，内部异常也缺少统一记录出口，导致一旦出现 provider 兼容问题、响应解析问题或 runtime 兜底异常，用户和开发者都很难快速知道“哪里出错了”和“模型到底返回了什么”。

现在补这一层是合理的，因为 `mycli` 已经进入产品化推进阶段，grounding、activity stream 和 runtime 主链都已经初步成型。此时建立一套工作区级日志系统，可以把模型调用、关键运行事件和错误记录统一起来，让调试、排障和后续前端展示建立在稳定的可观测性基础上。

## What Changes

- 新增工作区级日志系统，固定将日志写入当前项目的 `log/` 目录，而不是复用现有的 `~/.mycli/sessions` trace 路径。
- 引入统一的日志等级，第一版支持 `info`、`warning`、`error`，分别覆盖正常运行事件、可恢复异常和明确失败。
- 为模型请求、模型响应和模型错误增加双重落盘能力：一份摘要事件日志，一份原始 request / response / error JSON。
- 在 runtime 中补充 turn 级上下文和内部异常记录，确保代码内部可捕获异常也能及时持久化，而不是只在 provider 请求失败时才有日志。
- 调整 CLI 错误展示，使用户在出错时能直接看到日志位置和原始错误文件位置，便于快速排查。
- 为日志服务、模型客户端接入和 runtime 异常路径增加测试，确保不破坏现有 trace、session 和活动流能力。

## Capabilities

### New Capabilities
- `workspace-logging`: 定义 `mycli` 如何在当前工作区中记录应用日志、模型事件日志、原始模型 payload，以及 runtime 内部错误的持久化方式和可见性要求。

### Modified Capabilities
- None.

## Impact

- 受影响代码：`src/mycli/services/`、`src/mycli/infrastructure/openai_responses_client.py`、`src/mycli/infrastructure/openai_client.py`、`src/mycli/application/runtime/agent_runtime.py`、`src/mycli/cli/main.py`
- 可能受影响的辅助层：模型适配层、错误处理路径、活动流与 trace 的协同边界
- 受影响测试：日志服务测试、模型客户端测试、runtime 错误处理测试、CLI 错误展示测试
- 外部 API 和依赖：无新增外部依赖，继续优先使用标准库
- 用户可见影响：用户可以在工作区 `log/` 中直接查看模型请求/响应和错误日志，CLI 发生故障时也能直接知道日志位置
