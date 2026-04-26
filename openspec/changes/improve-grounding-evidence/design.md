## 背景

`mycli` 已经具备构成实用 coding agent 循环所需的核心部件：以 Responses 为主的 runtime、结构化工具、工具结果回注，以及一组不断增长的读取与搜索能力。当前真正的短板，不在于 agent 能不能调用工具，而在于工具结果在回注之后是否还足够丰富，能够让模型稳定地基于这些结果继续推理。

目前，工具输出大多会在 `ContextManager` 中被压平成 `summary` 字符串，再附带一些临时性的 payload preview。对于简单场景这还能工作，但它会削弱 `search -> read -> answer` 这条主链，因为路径、行区间和片段文本这些语义并没有被当成一等概念来表示。这次变更的目标，就是引入一个最小化的 evidence 模型，让工具能够产出结构化证据，并把它渲染进 transcript，而不需要重写整个 runtime。

约束：
- 第一阶段要保持 runtime 主循环和 transcript block 类型稳定。
- 要继续兼容那些目前只填充 `summary` 和 `raw_payload` 的既有工具。
- 在第一条 grounded workflow 被验证之前，不要过度设计一个通用 evidence 系统。

## 目标 / 非目标

**目标：**
- 增加一个小而共享的 evidence 契约，能够同时穿过 `ToolResultV2` 和旧版 `ToolResult`。
- 让 `search_text`、`read_file` 和 `read_file_range` 为最关键的搜索/阅读工作流产出结构化 evidence。
- 让工具 transcript message 优先从 evidence 渲染，并保持稳定的路径、行号和 snippet 格式。
- 保留现有基于 payload preview 的 fallback，让未改造的工具继续工作。
- 加强 prompt guidance，促使模型在可用时直接依赖路径、行号和 snippet evidence 推理。

**非目标：**
- 本次变更不处理编辑类工具、git 或 shell 的 grounding。
- 本次变更不引入新的 transcript block 类型、引用编号机制，或 archive / migration 逻辑。
- 本次变更不解决仓库范围内的 `mypy` 打包问题，也不覆盖更广义的 Phase 2 产品化事项。
- 本次变更不设计一个面向所有未来 evidence 来源的完整排序 / 分块引擎。

## 决策

### 1. 在两套结果对象上共用一个 `ToolEvidence` dataclass

这次变更会在共享的 tool/domain 层中新增 `ToolEvidence`，并在 `ToolResultV2` 与 `ToolResult` 上都暴露 `evidence: tuple[ToolEvidence, ...]`。

为什么这样设计：
- 现在的 runtime 和测试已经同时混用了 `execute()` 与旧版 `run()` 路径，所以 grounding 数据必须在两条路径里都能保留下来。
- 对第一阶段来说，一个共享契约已经足够，也能避免把新旧工具 API 进一步拆成两套更深的协议。

考虑过的替代方案：
- 只在 `ToolResultV2` 中存 evidence：否决，因为 runtime 和测试仍然会通过 `run()` 消费旧版 `ToolResult`。
- 只把 evidence 编码进 `raw_payload`：否决，因为那会继续让 grounding 保持临时拼装、强依赖具体工具的状态。

### 2. 第一阶段只支持 `search_match` 和 `file_excerpt` 两类一等 evidence

第一版只会把 `search_text`、`read_file` 和 `read_file_range` 需要的 evidence 类型正式化。

为什么这样设计：
- 这和当前最直接的产品目标一致：提升 `search -> read -> answer` 主链的可靠性。
- 也能避免在编辑 diff、git 和 shell evidence 模式还没明确之前，过早做抽象。

考虑过的替代方案：
- 现在就引入更大的 evidence taxonomy：否决，因为当前并不需要这层额外弹性，而且会增加实现成本。

### 3. 保持 runtime 回注仍然是文本，但让文本变成 evidence-first

`AgentRuntime` 仍然会把工具输出保存为 `tool` message，以及包含文本的 `tool_result` block。真正的变化发生在 `ContextManager.render_tool_result()`：它会优先使用 evidence-aware 的格式渲染，没有 evidence 时再回退到现有的 payload preview 逻辑。

为什么这样设计：
- 它可以在不改 runtime 控制流和 transcript schema 的前提下，立刻提升模型可见的 grounding 质量。
- 它支持渐进迁移：只有已更新的工具才需要发出 evidence。

考虑过的替代方案：
- 新增一种结构化 transcript block 来表达 evidence：当前否决，因为那会把范围扩展到 runtime contract 变更和存储更新。

### 4. 让工具本身负责创建 evidence

每个最了解自己语义的工具，直接产出 evidence：
- `search_text` 为每条高价值命中产出一个 `search_match`
- `read_file` 产出整文件 `file_excerpt`
- `read_file_range` 产出带行区间语义的 `file_excerpt`

为什么这样设计：
- 工具最清楚准确的路径、行号和片段边界。
- 如果改成事后从 raw payload 再加工，不仅会重复解释逻辑，也会更脆弱。

考虑过的替代方案：
- 在 `ContextManager` 里统一从 payload 构造所有 evidence：否决，因为这会保留导致当前问题的那种强耦合。

### 5. 把 prompt guidance 当作增强，而不是强制规范

system prompt 会新增一句话，告诉模型：当路径、行号和 evidence snippet 可用时，应直接基于它们推理。

为什么这样设计：
- 它可以增强新行为，而不会强行引入僵硬的输出格式。
- 与强制引用模板相比，这种方式更容易验证、风险更低。

考虑过的替代方案：
- 要求每个 grounded answer 都必须带 citation：否决，因为这会把本次提案扩大成一次更大的 UX 与 prompt-format 变更。

## 风险 / 取舍

- [Evidence snippet 过长，挤占上下文] → 第一版保持简单，但限制单条 snippet 的渲染长度和总输出长度。
- [Evidence 模型过窄，后续工具类型接不进去] → 有意把第一阶段收窄，等编辑类 / git / shell grounding 开始时再扩展新类型。
- [部分 runtime 路径仍然继续使用旧 preview 渲染] → 通过设计保留 fallback 行为，再逐步把更多工具迁移过来。
- [视觉上更 grounded，但语义上没有真正改善] → 增加 runtime reinjection 测试，专门覆盖 `search -> read_file_range -> answer`。

## 迁移计划

1. 在 tool/domain 层加入共享 evidence 契约。
2. 更新选定的三个工具，让它们在保留现有 payload 字段的同时产出 evidence。
3. 把 `ContextManager` 切换为 evidence-first 渲染，并保留 fallback。
4. 更新 prompt guidance 和 runtime 测试。
5. 使用定向的 `pytest` 测试集与 `ruff` 做验证。

回滚策略：
- 直接回滚这组变更即可；第一阶段不涉及数据迁移，也不涉及持久化 schema 迁移。

## 开放问题

- 后续 `read_file` 在处理大文件时，应该继续产出整文件 excerpt，还是改成多个有边界的 excerpt。
- 未来的编辑类 / git / shell grounding，是否应复用同一套 transcript formatting，还是引入更丰富的 evidence 展示方式。
