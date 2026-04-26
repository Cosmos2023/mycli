## Context

`mycli` 当前已经开始向 agent runtime 收敛，但 turn-time 上下文仍然处于“半产品化”状态。今天的真实结构大致如下：

- `ExecutionContext` 在 `src/mycli/domain/runtime/__init__.py` 中保存 memory、active skill、tool names、plan、conversation 和 runtime reminders 等扁平字段
- `AgentRuntime` 在 `src/mycli/application/runtime/agent_runtime.py` 中通过 `_build_context()` 与 `_build_runtime_items()` 同时承担来源收集、结构决定和模型输入拼装
- `build_react_prompt()` 在 `src/mycli/prompts/react.py` 中直接读取 `ExecutionContext`，按固定顺序拼接成单块文本

这种方式的问题不是“字段不够”，而是：

- context source 与 rendered prompt section 没有分层
- section 顺序和进入条件没有正式契约
- runtime policy、workspace instructions、capability injection、tool exposure 还没有稳定挂点
- prompt builder 实际承担了过多运行时组织职责

结合 `openai/codex` 的主链调研与当前路线图，下一步最值得先补的不是“继续加能力”，而是先把这些能力进入 turn 的装配过程正式化。

## Goals / Non-Goals

**Goals:**

- 建立正式的 turn-time context assembly 层，明确 source collection、section shaping 和 prompt rendering 的边界
- 定义确定性的 section 顺序，让同类上下文总能以稳定位置进入模型输入
- 让 prompt generation 依赖 assembled context，而不是继续直接消费扁平字段
- 为 `skills`、workspace/project instructions、runtime policy reminders、tool exposure summary 预留标准接入点
- 与现有 `Responses` runtime、turn protocol、activity stream 兼容，作为下一阶段主链增强的第一步

**Non-Goals:**

- 不在本变更中完整实现 skills 产品化 capability injection
- 不在本变更中统一 MCP、dynamic tools 或 provider-specific tool exposure
- 不重做全部 prompt 模板，也不一次性引入 Codex 式多层 prompt 体系
- 不改变当前 session/thread 持久化协议，只关注“本轮发模型前的上下文装配”

## Decisions

### 1. 引入独立的 turn context assembly 模型，而不是继续扩充 `ExecutionContext`

本变更决定把“收集到的原始上下文来源”和“最终发给模型的装配结果”区分开来。`ExecutionContext` 可以继续作为运行时原始来源容器存在，但 prompt 不再直接消费它，而是先进入一个正式的 assembly 层，例如：

- source collection：memory、conversation、plan、active skill、runtime reminders、workspace/project instructions、environment metadata
- section shaping：把来源映射成有类型、有顺序的 section
- rendering：把 section 渲染成当前 provider 所需的 prompt/items

这样做的原因是，当前问题不只是字段少，而是“字段直接等于 prompt 文本”，导致后续很难插入新的上下文类型。

未采用的方案：

- 继续往 `ExecutionContext` 里加字段，再让 `build_react_prompt()` 读更多属性。否决，因为这会继续放大 prompt builder 的耦合。

### 2. 定义确定性的 section 顺序，作为 turn 主链契约

本变更决定为 turn context 建立稳定 section 顺序。第一版至少要覆盖以下逻辑顺序：

1. base instructions
2. workspace/project instructions
3. session/environment context
4. conversation summary 与 recent conversation
5. memory 与 plan
6. runtime reminders / exploration discipline reminders
7. active capability/skill sections
8. tool exposure summary
9. current user request

这样做的原因是，未来无论是 capability injection 还是 tool router，都需要知道自己应该挂在什么位置，而不是和其他上下文抢 prompt 拼接顺序。

未采用的方案：

- 仅定义一组 section 类型，不定义顺序。否决，因为没有顺序的 section 仍然无法成为运行时契约。

### 3. section 是运行时对象，不只是 prompt 文本片段

assembly 结果不应只是“一段最终字符串”，而应至少保留：

- section 类型
- section 来源
- section 是否启用
- section 文本或块内容
- 可能的 metadata

这允许 `mycli`：

- 在 trace 或调试日志里解释本轮带了哪些上下文
- 在未来不同 provider 或 surface 下重用同一份 assembled context
- 把 capability injection、workspace instruction、tool exposure 做成可观测对象，而不是隐形 prompt 文本

未采用的方案：

- 让 assembly 直接产出最终 prompt 字符串。否决，因为这无法支撑后续 provider/rendering 分层。

### 4. 第一版先保持对现有 prompt 路径兼容

虽然目标是建立正式的 assembly 层，但第一版不要求一次性重写整个 prompt 体系。更稳妥的路径是：

- 先新增 assembly model 和 assembler
- 让 `build_react_prompt()` 改为消费 assembled sections
- 保留当前单块文本 prompt 形态作为第一版 renderer

这样做的原因是，当前仓库还在快速演进，先把装配边界做出来，比同时重写 renderer 更有性价比。

未采用的方案：

- 一步到位引入全新的多-message、多-block prompt renderer。暂不采用，因为变更面过大，且会与 Responses/provider 适配产生叠加风险。

### 5. 为 capability injection 和 tool exposure 预留显式挂点

本变更虽然不直接完成 `skills` 产品化或 MCP/tool router 收敛，但必须在 assembly 里留下正式接口：

- capability sections：用于后续注入显式/隐式激活的 skill 或其他能力
- tool exposure section：用于后续收敛当前可见工具面、deferred tools、router summary

这样做的原因是，路线图已经明确 turn context assembly 是后续 capability injection 和 tool exposure 的前置骨架。如果这次设计没有预留挂点，下一次还得再拆一次 prompt 主链。

## Risks / Trade-offs

- [风险] 新增一层 assembly 抽象后，短期内会同时存在 `ExecutionContext` 和 `TurnContext` 两类对象。  
  缓解：明确一个是 raw source，一个是 assembled result，并在实现阶段逐步减少 prompt 对 raw context 的直接依赖。

- [风险] section 设计过早，导致后续 capability/tool 场景仍需改 schema。  
  缓解：第一版只约束核心 section 和顺序，metadata 保持可扩展，避免一次性设计过宽。

- [风险] 兼容现有 prompt renderer 可能让收益不够显著。  
  缓解：本变更的重点本来就是“先把边界立起来”，收益会更多体现在后续 changes 的落地效率和行为稳定性上。

- [风险] exploration discipline 与 context assembly 的责任边界模糊。  
  缓解：discipline 决定 reminder 和 context slot 的内容，assembly 只负责把它们装进标准位置。

## Migration Plan

1. 先定义 turn context、turn context section 与 section type 等正式对象。
2. 将现有 `_build_context()` 的来源收集与 `_build_runtime_items()` 的 prompt 注入拆开，引入 assembler。
3. 让 `build_react_prompt()` 改为消费 assembled context，保持当前文本 renderer 兼容。
4. 把 runtime reminders、active skill、tool list 等现有内容迁移到明确的 section 中。
5. 补齐测试，确保 section 顺序、启用条件和 prompt 兼容行为可回归验证。

本变更不要求持久化迁移；如需回滚，只需恢复原有 prompt/context 直连路径。

## Open Questions

- workspace/project instructions 第一版是否直接复用现有 `AGENTS.md` 收集链路，还是先只保留接口位置
- tool exposure section 第一版是否仅渲染工具名摘要，还是应允许按任务类型做分层显示
- assembled context 是否需要进入 turn trace 持久化，还是先只写调试日志
