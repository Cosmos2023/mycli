## Why

`mycli` 已经完成了 turn context assembly 与 exploration discipline，但 `skill` 仍然主要以“被选中的提示词附件”形式存在，runtime 无法正式知道本轮到底激活了哪些能力、为什么激活、是否缺少前置依赖。这使得 `skills` 仍更像 prompt 增强，而不是 agent runtime 的一等能力对象。现在推进这一层，正好承接路线图阶段二，让后续 MCP、dynamic tools 和插件能力都能挂到统一 capability 主链上。

## What Changes

- 引入正式的 capability injection 主链，把 `skill` 从扁平 prompt 注入升级为运行时 capability activation。
- 支持两类 capability 激活来源：
  - 显式 capability mention
  - 兼容现有 `trigger_hints` 的隐式自动激活
- 为“本轮实际生效的 capability”定义独立激活对象，而不是继续只依赖 `SkillDefinition` 静态定义。
- 为 turn history 增加独立的 `TurnItem/CAPABILITY` 语义，让 capability 激活结果进入 trace、session 与 surface 可见对象。
- 在第一版中加入 capability 依赖检查入口，用于检测环境变量、工作区文件或其他前置条件是否缺失，并把结果反馈给 runtime。
- 让 turn context 的 capability section 从 capability activation 集合渲染，而不再完全依赖 `active_skill` 的手工特判拼接。

## Capabilities

### New Capabilities
- `capability-injection`: 定义 capability 的解析、激活、依赖检查、turn item 记录以及 turn context 注入语义。

### Modified Capabilities

None.

## Impact

- 受影响代码：
  - `src/mycli/services/skill_registry.py`
  - `src/mycli/application/runtime/agent_runtime.py`
  - `src/mycli/domain/runtime/protocol.py`
  - `src/mycli/domain/runtime/__init__.py`
  - `src/mycli/services/context/turn_context_assembler.py`
  - 以及新增的 capability resolver / domain 模块
- 受影响状态：
  - turn history
  - trace
  - session transcript
  - CLI activity / trace inspection
- 受影响测试：
  - runtime policy / runtime protocol
  - prompt / turn context
  - skill registry / capability resolver
  - CLI / session persistence 回归测试
