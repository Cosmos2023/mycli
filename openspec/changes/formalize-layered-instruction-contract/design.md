## Context

当前 `mycli` 已经完成了几件重要的基础工作：

- `turn context assembly` 把上下文来源变成了有顺序的 sections
- `capability injection` 把 skill 从静态附件推进成了 turn-scoped activation
- `runtime decision policy` 已经让探索策略开始进入 runtime 主链
- `dynamic tool contract` 和 tool exposure 也开始形成正式对象

但模型输入主链仍然偏早期：

- `build_system_prompt()` 仍承载了“稳定通用规则”的全部语义
- `AgentRuntime` 还会为 `active_skill` 特判追加一条 system message
- `build_react_prompt()` 同时承担 assembled context 渲染、runtime policy 提醒和下一步动作协议
- workspace instructions、capability bodies、environment context 虽然已经进入 turn context，但还没有被定义成正式的“模型输入层级”

这使得 `mycli` 还没有真正完成从“prompt patching”到“layered model input contract”的升级。

Codex 值得借鉴的部分不是某段具体提示词，而是以下结构：

- 基础稳定契约与 turn-scoped 约束分离
- developer 侧运行时说明和 contextual user 侧环境说明分离
- skill / project instructions / environment context 通过可识别片段按需注入
- 脚手架型 prompt 片段不与真实对话内容混为一谈

## Goals / Non-Goals

**Goals:**

- 为 `mycli` 定义一套正式的分层指令契约，而不是继续依赖 ad hoc prompt builder
- 把稳定 base rules、turn-scoped runtime guidance、contextual user fragments、真实对话消息分层表达
- 让 capability、workspace instructions、environment context、dynamic tool summaries 都有明确模型侧归属
- 为后续 Responses-style provider、多 surface 和更细粒度 memory/trace 奠定统一装配主链
- 明确这套契约服务的是通用 agent，而不是某类任务的 prompt 优化

**Non-Goals:**

- 不在本变更中一比一复刻 Codex 的 prompt 文案、标签体系或全套 AGENTS/skills 机制
- 不在本变更中引入完整的 plugin marketplace、MCP prompt 协议或 subagent message 协议
- 不在本变更中用关键词路由替代 runtime 决策
- 不要求一次性废除现有 `react` prompt 风格；第一版允许保留兼容渲染器

## Decisions

### 1. 引入显式 `InstructionContract`，而不是继续扩展 `build_system_prompt()` / `build_react_prompt()`

本变更决定增加一层显式的模型输入契约对象，作为 `turn context` 与 provider/model adapter 之间的桥梁。它至少包含：

- `base_instructions`
- `developer_sections`
- `contextual_user_sections`
- `conversation_messages`
- `current_user_request`

必要时可以保留一个兼容型的 `assistant_scaffold` 字段，用于承接现有 react-style “Decide the next best action” 协议，但它不再等同于整个 prompt 主链。

这样做的原因是：

- 当前 `turn context` 解决了“收集什么”，但还没有解决“模型侧如何分层表达”
- 当前 runtime 仍有 `active_skill` system message 特判，说明主链语义还没统一
- 把分层契约产品化后，后续 legacy prompt、Responses-style message、realtime surface 才能共享同一份模型输入结构

未采用的方案：

- 继续只改 `system.py` / `react.py` 的字符串内容。否决，因为这仍然是 patch prompt，不是升级架构边界。

### 2. 将 runtime policy、tool exposure、capability policy 归入 developer instructions

本变更决定把“运行时告诉模型怎么工作”的内容放入 developer 层，而不是继续散落在 react prompt 的自然语言段落中。第一版 developer 层至少承载：

- runtime decision policy 的当前 profile / reminder
- tool exposure summary 与使用约束
- capability availability / dependency status 的策略性说明
- approval / runtime safety reminders

这样做的原因是：

- 这些内容不是用户请求本身，也不是工作区事实，而是运行时施加给模型的执行约束
- 把它们放进 developer 层，能让 base instructions 保持稳定、通用，不必因为每轮运行时状态变化而膨胀

未采用的方案：

- 继续把这些内容都写在 `react prompt` 文本后半段。否决，因为它会让 runtime policy 和任务脚手架长期纠缠。

### 3. 将 workspace / environment / capability bodies 归入 contextual user fragments

本变更决定把以下内容视为“上下文化用户片段”，而不是系统规则或开发者约束：

- workspace/project instructions
- environment context
- capability / skill bodies
- dynamic tool descriptors 或等价的上下文化说明

第一版不要求完全复刻 Codex 的 XML/tag 形式，但要求这些片段具备：

- 明确的 fragment 类型
- 明确的来源
- turn-scoped 注入语义
- 后续可被 memory / trace 识别和筛选

这样做的原因是：

- 这些内容描述的是当前环境、项目、能力和工作区，而不是 runtime 的抽象执行原则
- 它们与真实用户请求关系更近，但又不应伪装成用户本轮自然语言本体

未采用的方案：

- 把 capability body 继续作为 system message 注入。否决，因为这会把“能力说明”误放进最高优先级的稳定规则层。

### 4. turn context 保留为来源装配层，instruction contract 成为模型装配层

本变更决定不让 `InstructionContract` 取代 `TurnContext`，而是建立两层关系：

- `TurnContext`: 汇总 runtime、conversation、memory、plan、capability、tool exposure 等来源
- `InstructionContract`: 从 `TurnContext` 中提取真正需要进入模型的分层输入

这样做的原因是：

- `TurnContext` 仍然适合做调试、trace、activity 和统一来源汇总
- 模型输入层不应该直接回头读取原始 `ExecutionContext` 字段，更不应该在 runtime 中随处散落拼接逻辑

未采用的方案：

- 让 `TurnContextAssembler` 直接产出最终字符串 prompt。否决，因为这会再次把结构化装配退化回字符串拼接。

### 5. Prompt scaffolding 必须有 memory/trace 边界

本变更决定让脚手架型片段具备显式的可识别语义，至少区分：

- 应保留到 conversation / trace 的真实交互内容
- 仅用于本轮模型输入但不应进入长期记忆的 scaffolding 片段

第一版至少要求：

- workspace instructions / capability bodies / 其他 contextual scaffolding 可被 memory 过滤
- trace / debug summary 能看见本轮到底注入了哪些 developer/contextual fragments

这样做的原因是：

- 如果不建立边界，后续 memory 很容易继续吸收 prompt 脚手架，破坏通用 agent 的记忆质量
- 这也是 Codex 一个很值得借鉴的点：prompt scaffolding 不是对话本体

## Risks / Trade-offs

- [风险] 第一版同时保留 legacy react scaffold 与新的 layered contract，短期会出现双轨。  
  缓解：明确 layered contract 是主路径，legacy scaffold 只作为渲染兼容层存在。

- [风险] 把 capability / workspace 信息从 system message 降到 contextual 层后，模型行为可能需要重新校准。  
  缓解：同步更新 prompt 测试和 smoke，用真实任务验证工具调用与回答收口没有回退。

- [风险] 过早设计复杂 fragment taxonomy，会拖慢落地。  
  缓解：第一版只覆盖 base / developer / contextual user 三大层和少量核心 fragment 类型。

- [风险] 如果 developer instructions 写得过多，仍可能演化成另一种“大 prompt”。  
  缓解：明确 developer 层只容纳运行时约束，不重复 workspace facts、长篇 capability body 或 conversation 内容。

## Migration Plan

1. 定义 instruction contract 领域对象与渲染接口。
2. 让 runtime 在 `TurnContext` 之后构建 `InstructionContract`。
3. 把 runtime policy、tool exposure、capability policy 移入 developer layer。
4. 把 workspace instructions、environment context、capability bodies、dynamic tool context 移入 contextual layer。
5. 更新 legacy prompt/rendering 路径去消费 layered contract，而不是直接读取原始上下文字段。
6. 增加 memory exclusion 与 trace visibility。

回滚时可恢复到当前 `system + active_skill system message + assistant react scaffold` 路径，并移除 instruction contract 相关模块。

## Open Questions

- workspace instructions 第一版是否继续只来自单一工作区配置，还是要同步设计更细粒度的目录作用域说明
- contextual fragments 是否在第一版就引入显式 tag/header，还是先只做 typed section metadata
- legacy `assistant` scaffold 最终是继续存在，还是在后续 Responses-style runtime 中彻底降级为 renderer 细节
