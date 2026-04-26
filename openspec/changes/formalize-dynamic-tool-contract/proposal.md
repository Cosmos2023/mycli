## Why

`mycli` 的目标是成为通用性的 general agent，而不是只承载少量固定工具的 coding runtime。当前虽然已经有了 `tool exposure / router` 骨架，但 dynamic tools 仍然停留在“本轮可以临时接入”的阶段：缺少稳定 descriptor、缺少 turn/thread scoped lifecycle、缺少 conflict handling，也没有统一进入 trace / session / surface 的正式协议。接下来如果继续推进 provider tools、MCP bridge 与多任务 capability，而不先把 dynamic tools 从 hook 升级成正式 runtime 对象，能力面会再次发散，主链也会重新退化成多条旁路。

## What Changes

- 将这条 change 明确定位为通用 agent runtime 的能力承载层增强，而不是局部的工具实现整理。
- 定义正式的 `dynamic tool contract`，明确 dynamic tools 的 descriptor、identity、scope、lifecycle 与可见性语义。
- 将 dynamic tools 区分为至少两类来源，但使用同一协议承载：
  - runtime-generated dynamic tools
  - capability-contributed dynamic tools
- 为 dynamic tools 增加稳定的作用域语义，至少覆盖：
  - turn-scoped
  - thread-scoped
- 为 dynamic tools 增加正式的状态流转，而不是只在被调用时临时拼接：
  - declared
  - exposed
  - invoked
  - completed / failed
  - expired
- 为 dynamic tools 增加冲突处理与优先级规则，避免同名工具、同 route key 或跨来源工具相互覆盖时出现不透明行为。
- 让 dynamic tools 的 descriptor 与 lifecycle 进入 turn context、trace、session persistence 与 surface event，而不是只停留在 router 内部。
- 让后续 provider / MCP / hosted tool bridge 以及更多通用任务能力可以复用这套 contract，而不必重新定义另一套动态工具语义。

## Capabilities

### New Capabilities
- `dynamic-tool-contract`: 定义通用 agent runtime 中 dynamic tools 的 descriptor、scope、lifecycle、conflict handling 与结构化可见性语义。

### Modified Capabilities

None.

## Impact

- 受影响代码：
  - `src/mycli/services/tool_router.py`
  - `src/mycli/services/tool_exposure_planner.py`
  - `src/mycli/application/runtime/agent_runtime.py`
  - `src/mycli/services/context/turn_context_assembler.py`
  - `src/mycli/services/session_store.py`
  - `src/mycli/domain/runtime/*`
  - CLI activity / trace / session persistence 相关模块
- 受影响行为：
  - dynamic tool 的声明、注入、暴露、调用、过期与回放
  - capability activation 对 dynamic tool 的贡献方式
  - turn / thread 级别的工具可见性与冲突处理
- 对后续工作的影响：
  - 为 `provider / MCP bridge` 提供统一的动态工具承载协议
  - 为多任务 capability profile 提供稳定的工具贡献接口
  - 为通用 agent 在 coding、debugging、writing、research、automation 等任务中按需装配能力提供统一主链接口
