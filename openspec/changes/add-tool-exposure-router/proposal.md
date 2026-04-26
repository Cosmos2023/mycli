## Why

当前 `mycli` 的工具面仍然主要由 `ToolRegistryV2` 直接全量暴露给模型：runtime 没有正式的 exposure planning 层，也没有统一 router 来承接静态工具、task-scoped dynamic tools 与未来的 MCP/provider tools。随着阶段二的 capability injection 已经建立，阶段三需要把“工具如何进入本轮 turn”也收敛到正式主链，否则工具面会继续依赖全量直出和临时旁路，难以扩展也难以约束。

## What Changes

- 引入正式的 `ToolExposurePlanner`，在每轮 turn 中生成结构化的 `ToolExposure` 结果，而不是继续默认暴露整个 registry。
- 将本轮工具暴露拆分为三类：
  - `direct tools`：直接暴露给模型、可立即调用
  - `deferred tools`：本轮被识别但暂不直接暴露，只进入工具面摘要
  - `dynamic tools`：由 runtime 或 capability activation 按任务范围生成的临时工具
- 引入统一 `ToolRouter`，让静态工具与动态工具走同一条执行与校验路径，并为未来 `mcp.*` 等 provider-specific namespace 预留路由入口。
- 支持两类动态工具来源：
  - runtime 根据当前任务或工作区状态生成
  - 已激活 capability 为当前 turn 注入额外工具
- 为 turn history / trace / context 增加结构化 tool exposure 可见性，让 runtime 与 surface 能知道“本轮实际暴露了哪些工具、哪些被延迟、为什么”。
- 让模型侧工具定义与运行时可调用工具集合从 `ToolExposure` 渲染，而不再直接依赖 registry 全量输出。

## Capabilities

### New Capabilities
- `tool-exposure-router`: 定义 turn-scoped 工具暴露规划、direct/deferred/dynamic 分类、统一工具路由与动态工具接入语义。

### Modified Capabilities

None.

## Impact

- 受影响代码：
  - `src/mycli/tools/registry.py`
  - `src/mycli/application/runtime/agent_runtime.py`
  - `src/mycli/services/context/turn_context_assembler.py`
  - `src/mycli/domain/runtime/*`
  - 以及新增的 tool exposure / router 相关 domain 与 service 模块
- 受影响状态：
  - turn context
  - turn history / trace
  - model tool definitions
  - runtime 工具调用校验与执行路径
- 受影响后续能力：
  - capability injection 与工具面的联动
  - task-scoped dynamic tools
  - 未来 MCP / provider-specific tool sources 的统一接入
