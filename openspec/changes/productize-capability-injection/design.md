## Context

当前 `mycli` 的 skill 机制已经能工作，但仍停留在较早期的形态：

- `SkillRegistry` 负责发现和加载静态 skill 定义
- `AgentRuntime` 通过 `_select_skill_metadata()` / `_load_selected_skill()` 用 `trigger_hints` 选出单个 `active_skill`
- `TurnContextAssembler` 只会在 capability section 中渲染一个 `active_skill`
- legacy/runtime prompt 路径里仍保留了 skill 的特殊 message 注入兼容逻辑

这套机制的问题不是“不能用”，而是运行时语义过弱：

- 没有区分静态 skill 定义与本轮实际激活能力
- 没有记录能力激活来源，是显式 mention 还是 trigger hint
- turn history 不知道 capability 是否生效，更不知道本轮到底生效了几个 capability
- 没有正式依赖检查入口，后续很难扩展到 env var、workspace 资源、MCP 或插件依赖

在路线图里，turn context assembly 已经先一步建立了 context 挂点；现在最自然的下一步就是把 `skills` 产品化为正式 capability injection。

## Goals / Non-Goals

**Goals:**

- 定义 capability activation 的正式运行时对象，区分静态 capability 定义与本轮实际生效能力
- 同时支持显式 mention 激活与现有 `trigger_hints` 自动激活
- 为 turn history 增加独立 `TurnItemType.CAPABILITY`，让 capability 激活进入结构化运行时协议
- 在第一版提供 capability 依赖检查入口，并能把缺失依赖反馈给 runtime
- 让 turn context 的 capability section 从 activation 集合渲染，而不是继续只读单个 `active_skill`

**Non-Goals:**

- 不在本变更中引入完整 capability marketplace 或插件安装体系
- 不在本变更中把 MCP 或 dynamic tools 直接并入 capability router
- 不设计复杂的 capability 权限系统或 capability approval 流程
- 不在本变更中完全删除 skill 的 legacy 兼容路径，第一版允许保留兼容注入

## Decisions

### 1. 引入 `CapabilityResolver` 与 `CapabilityActivation`，而不是继续扩展 `active_skill`

本变更决定增加一层显式的 capability 解析与激活对象：

- `CapabilityResolver`：负责从用户输入和当前 registry 中解析本轮候选 capability
- `CapabilityActivation`：表示本轮实际生效的 capability，包括名称、来源、注入指令、依赖状态和 metadata

这样做的原因是，当前 `active_skill` 只适合表达“选中了一个 skill”，不适合表达多 capability 并存、激活来源、依赖缺失和 turn history 记录。

未采用的方案：

- 继续把更多字段塞进 `SkillDefinition` / `ExecutionContext.active_skill`。否决，因为这会让静态定义和动态激活语义混在一起。

### 2. 第一版同时支持显式 mention 与 trigger hint 自动激活

本变更决定 capability 激活来源分为两类：

- `explicit_mention`：用户明确提到某个 capability，例如未来约定的 `$capability-name`
- `trigger_hint`：兼容现有 skill 的自动激活体验

这样做的原因是：

- 保留现有体验，避免把已存在的 skill 触发能力直接打掉
- 为后续产品化建立更清晰的显式激活路径

未采用的方案：

- 第一版只做显式 mention。否决，因为会让当前 skill 体验倒退。
- 第一版只保留 trigger hint。否决，因为无法体现 capability 作为正式运行时能力的显式进入点。

### 3. 用独立 `TurnItemType.CAPABILITY` 进入 turn history

本变更决定 capability 激活结果不只存在于 turn context，而是要写入独立的 turn item：

- 成功激活时记录 capability name、source、dependency status
- 依赖缺失时也记录 capability item，并标明 disabled / missing dependency 状态

这样做的原因是：

- runtime、trace、session 与 surface 需要知道本轮到底生效了什么能力
- capability item 会成为后续多 surface、MCP/tool exposure 的重要观察点

未采用的方案：

- 先只在普通 `TurnItem` 的 `metadata` 中塞 capability 信息。否决，因为后续协议演进会更混乱。

### 4. 第一版依赖检查做成“轻量、可扩展”的 resolver 子步骤

本变更决定 capability 依赖检查只做成 resolver 内的正式步骤，不追求一开始覆盖所有依赖类型。第一版优先支持：

- 环境变量依赖
- 工作区文件/路径依赖

并将检查结果挂到 `CapabilityActivation` 中，例如：

- `ready`
- `missing_env`
- `missing_workspace_resource`

这样做的原因是，路线图已经明确 capability injection 不能只做 prompt 注入，否则后续依赖检查还得再拆一次。

未采用的方案：

- 第一版完全不做依赖检查。否决，因为这会让“正式 capability injection”名不副实。
- 一开始就做复杂 dependency installer / auto-remediation。暂不采用，因为阶段过大。

### 5. Turn context 从 activation 集合渲染 capability section

本变更决定 capability section 不再只依赖单个 `active_skill`，而改为：

- 先由 runtime 解析本轮 capability activations
- 再由 turn context assembler 渲染 capability section

第一版仍允许 legacy system message 注入保留兼容，但 capability section 将成为主路径。

这样做的原因是：

- 这与 turn context assembly 的设计目标一致
- 为后续多 capability 并存提供稳定承载

## Risks / Trade-offs

- [风险] capability injection 与现有 skill 注入逻辑短期会并存，容易产生重复注入。  
  缓解：第一版明确“turn context capability section 是主路径，legacy system message 仅兼容保留”，并在测试中校验重复最小化。

- [风险] trigger hint 自动激活可能过宽，导致 capability 误触发。  
  缓解：第一版保守沿用现有 hints，并为显式 mention 提供更高优先级。

- [风险] 独立 `TurnItemType.CAPABILITY` 会影响 session/trace 兼容。  
  缓解：同步更新 protocol 序列化与回归测试，保持旧 item 兼容读取。

- [风险] 第一版依赖检查覆盖不足，可能让用户误以为 capability 系统已完整。  
  缓解：在 design 和 spec 中明确只覆盖 env/workspace 依赖，其他类型留给后续阶段。

## Migration Plan

1. 定义 capability activation 领域对象与 `TurnItemType.CAPABILITY` 协议扩展。
2. 引入 `CapabilityResolver`，先接显式 mention 与 trigger hint 两类激活来源。
3. 将 capability activation 写入 turn history，并让 assembler 从 activation 集合渲染 capability section。
4. 为 env/workspace 依赖增加最小检查与缺失反馈。
5. 保留 legacy skill 注入兼容路径，待 capability 主链稳定后再进一步清理。

回滚时可撤回 resolver / capability turn item / context 渲染改动，恢复到当前 `active_skill` 直连路径。

## Open Questions

- 显式 capability mention 的语法第一版是否固定为 `$capability-name`，还是允许裸名字匹配
- dependency failure 是否只做 warning / disabled activation，还是要在后续引入更正式的 approval / install flow
- CLI 是否在下一变更开始单独渲染 capability activation 活动，还是先通过 trace / turn inspection 暴露
