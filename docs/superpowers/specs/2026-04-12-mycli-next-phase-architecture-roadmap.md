# mycli 下一阶段架构路线图

**日期：** 2026-04-12

**状态：** 路线图收敛，可进入分项 spec 与 OpenSpec 提案阶段

**路线选择：** 采用方案 2，以 `turn 主链增强` 为核心推进

---

## 1. 路线图结论

`mycli` 的下一阶段，不应该理解为“继续补几个 Responses 事件”或者“继续零散加 feature”，而应该理解为：

`围绕 turn 主链，把 context assembly、capability injection、tool exposure、item lifecycle 四个接入点补齐，让 mycli 从“有一些 agent 能力的 CLI”升级成“有统一主链的 agent runtime”。`

这条路线的核心判断是：

1. 当前 `mycli` 的主要瓶颈，已经不再是单点协议兼容，而是缺少一条足够稳定的 turn 主链
2. 如果没有统一主链，后续继续加 `skills`、`MCP`、`dynamic tools`、多 surface，只会增加复杂度，不会真正接近 Codex
3. 如果直接做“大一统 Codex 化重构”，会在当前阶段把已有成果打散，风险过高

因此，下一阶段最合理的方向不是“做得更多”，而是：

- 先把 turn-time context assembly 做起来
- 再把探索纪律和回答边界挂到这条主链上
- 然后把 `skills`、`MCP`、`dynamic tools` 收进统一 tool exposure / router
- 最后再推进多 surface、multi-agent、memory/compaction 深化

一句话概括：

`先做强主链，再做大能力面。`

---

## 2. 为什么选择方案 2

相较于另外两条路线，方案 2 最适合当前 `mycli`。

### 2.1 为什么不继续沿“补协议 + 补策略”线性推进

如果只延续当前路径，虽然可以继续修补：

- Responses completeness
- runtime policy
- CLI activity

但这些仍然是在现有主链偏薄的前提下打补丁。

问题在于：

- `skills` 还没有真正成为 turn-time injection
- `MCP` 还没有统一 tool exposure / router 入口
- `context assembly` 还没有成为正式层
- 很多能力仍然直接依赖 prompt 或 CLI 解释

继续线性补丁，短期能跑，长期会越来越难组织。

### 2.2 为什么不直接做大一统重构

如果现在就直接照着 Codex 做大重构，理论上很完整，但代价过高：

- 当前仓库还在快速演进，边界尚未完全稳定
- 一次性重做 session/thread/tooling/state/surface，容易导致回归和停滞
- 会把“当前什么最影响 agent 表现”这个重点稀释掉

当前阶段更适合的是：

- 保留已有正确方向
- 在关键接入点上补架构骨架
- 用多阶段方式逐步收敛到更成熟的 runtime

### 2.3 方案 2 的核心优势

方案 2 的优势在于，它同时满足三件事：

1. **保持连续性**
   - 不推翻 `productize-agent-runtime` 与 `upgrade-responses-agent-runtime` 的已有成果

2. **建立主链**
   - 把后续 feature 收敛到几个明确接入点，而不是继续散着长

3. **允许渐进演进**
   - 可以先做 `runtime exploration discipline`
   - 再做 `skills`
   - 再做 `MCP/dynamic tools`
   - 每一步都能独立交付和验证

---

## 3. 当前阶段的真实问题

结合近期 smoke、日志和对 Codex 源码的调研，`mycli` 当前最核心的问题可以归纳为四类。

### 3.1 缺少正式的 turn-time context assembly

当前 `mycli` 已经有 prompt、memory、plan、runtime reminder，但还没有一层明确的 turn context assembler 去统一处理：

- base instructions
- workspace/project instructions
- active skill / capability injection
- runtime policy reminders
- environment / session context
- tool exposure summary

结果是：

- 很多能力仍然是零散拼接
- prompt 容易成为“大杂烩”
- 后续新增能力没有稳定挂点

### 3.2 缺少统一 capability injection 机制

当前 `skills` 已经存在，但更像 prompt 附件，而不是正式 capability。

相比 Codex，`mycli` 还没有：

- turn 内显式 capability mention 解析
- capability 注入 item
- capability 依赖检查
- capability 与工具面的联动

这会导致：

- 功能越多，越难管理
- agent 知道“有这个能力”和真正“把能力带入本轮”之间仍有断层

### 3.3 工具面仍然偏静态，缺少 tool exposure 层

当前工具集已经不算少，但暴露给模型的方式仍然偏直接。

缺少一层像 Codex 那样的 tool exposure / routing 策略，会带来两个问题：

- 模型拿到的工具面与当前任务上下文耦合不够
- 未来引入 `MCP`、dynamic tools 后，很容易把工具体系搞乱

### 3.4 item lifecycle 还不够完整

现在 `mycli` 已经有 trace、turn、activity、tool result，但还没有把所有关键运行时过程统一建模成稳定 lifecycle，例如：

- commentary
- final answer
- tool begin
- tool output delta
- tool completed
- approval waiting
- context update
- capability injection

没有这层，CLI 就容易承担过多“运行时理解”责任。

---

## 4. 下一阶段的北极星

下一阶段的北极星不是“尽快把 `skills + MCP + multi-agent` 都做出来”，而是：

`让 mycli 的每一轮 turn，都能沿着统一主链完成：组装上下文 -> 暴露能力 -> 执行探索 -> 产生结构化事件 -> 持久化状态 -> 对 surface 可见。`

这条主链应该满足：

1. 新能力可以明确落到某个接入点
2. provider 差异不会一路污染到 CLI
3. surface 只消费协议对象和事件，不自己猜
4. 策略能力可以被插入主链，而不是只能藏进 prompt

如果这条主链做出来，后面的 `skills`、`MCP`、dynamic tools、多 surface 都会更自然。

---

## 5. 下一阶段的四个推进阶段

## 5.1 阶段一：Turn Context Assembly 与 Exploration Discipline

这是下一阶段的第一优先级。

目标是建立最小但正式的 turn-time context assembly，并把通用 exploration discipline 挂到这条主链上。

### 本阶段要完成什么

- 明确 `base instructions / user request / memory / plan / runtime reminders / capability sections / environment context` 的装配顺序
- 把当前 prompt 组装逻辑从“字符串拼接”升级为更清晰的 assembly 过程
- 引入面向证据型任务的独立策略路径，并先用代码库分析场景验证
- 把“确认事实 / 推断边界 / 证据门槛 / 收口时机”纳入 runtime 主链
- 让 activity stream 能展示更语义化的探索阶段

### 本阶段解决什么问题

- 解决“只读 README 就总结”的高频失败样本
- 解决 prompt 承担过多运行时组织责任的问题
- 建立后续 `skills` / `MCP` / dynamic tools 的统一上下文挂点

### 完成标志

- `mycli` 对代码库分析类请求不再依赖 README-only 提前收口
- turn context 装配过程在代码中有清晰边界，而不是零散散布
- CLI 可以展示更稳定的探索阶段语义

补充约束：

- 本阶段虽然先以代码库分析场景验证，但目标不是做“仓库分析模式”
- 同一套 exploration discipline 后续必须能够外推到 verification、debugging、research 与 assistant automation

---

## 5.2 阶段二：Skills 产品化为正式 Capability Injection

这一阶段的目标，不是“做更多 skill”，而是让 skill 变成正式运行时能力。

### 本阶段要完成什么

- 定义 capability injection 在 turn 中的进入点
- 支持显式 capability mention 与 capability 注入 item
- 建立 capability 依赖解析，例如环境变量、工作区资源或其他前置条件
- 让 capability 注入结果进入 turn history，而不是只拼进 prompt
- 区分静态能力声明与本轮实际启用能力

### 本阶段解决什么问题

- 解决当前 `skills` 只是“提示词增强”的问题
- 为未来 capability 市场化、插件化打基础
- 让 runtime 可以知道“本轮到底有哪些能力在生效”

### 完成标志

- skill/capability 的启用可以以结构化 item 的形式进入 turn
- capability 的依赖缺失能够被 runtime 检测并处理
- prompt 中的 capability 信息不再完全依赖手工拼接

---

## 5.3 阶段三：MCP 与 Dynamic Tools 收敛到统一 Tool Exposure / Router

当 turn context assembly 和 capability injection 站稳后，再把工具生态收进同一条主链。

### 本阶段要完成什么

- 增加正式的 tool exposure 层
- 区分 direct tools、deferred tools、task-scoped dynamic tools
- 为未来 MCP 接入预留统一 namespaced routing 入口
- 把 dynamic tools 看作 turn/thread-scoped tools，而不是特殊旁路
- 建立工具暴露数量控制、按需暴露、检索式暴露的策略

### 本阶段解决什么问题

- 解决工具面越做越大后上下文失控的问题
- 解决未来 `MCP` / dynamic tools 接入时无统一归口的问题
- 让工具面与当前 turn 的 capability / workspace / connectors 发生联动

### 完成标志

- 代码中存在明确的 tool exposure / routing 分层
- 新工具来源不需要绕过现有 runtime 主链
- 为接入 MCP 或更复杂插件工具提供稳定接口

---

## 5.4 阶段四：Surface、Multi-Agent、Memory/Compaction 深化

只有前三阶段稳定后，这一阶段才值得推进。

### 本阶段要完成什么

- 强化 item lifecycle，让 surface 只消费统一事件
- 为 TUI/IDE/Web 等 surface 准备更完整的 turn item 与状态对象
- 逐步增强 multi-agent runtime，但仍通过统一 role/config/tool 主链接入
- 深化 memory / compaction 与 turn context assembly 的协作

### 本阶段解决什么问题

- 解决 CLI 当前承担过多状态机理解的问题
- 让多 surface 和多 agent 不再成为额外旁路
- 让长期上下文管理与 turn runtime 形成闭环

### 完成标志

- surface 不再需要自己从 provider/raw trace 猜状态
- multi-agent 能复用既有主链，而不是额外做一套系统
- memory/compaction 能作为 turn 主链的一部分被稳定消费

---

## 6. 这四个阶段的依赖关系

这四阶段不是并列项，而是明确有依赖顺序。

### 6.1 为什么必须先做阶段一

因为如果没有 turn context assembly，后续：

- capability injection 没有入口
- tool exposure 没有承载位置
- 多 surface 也没有统一可见对象

### 6.2 为什么 skills 要先于 MCP/dynamic tools

因为 `skills` 更接近“能力如何进入 turn”，而 `MCP/dynamic tools` 更接近“能力如何进入工具面”。

如果 capability injection 这层没建好，后面接入更多工具来源，只会让系统更乱。

### 6.3 为什么多 surface 和 multi-agent 放在最后

因为它们都是主链消费者或主链扩展者。

如果主链本身还不清晰，越早做这些，越容易把问题放大。

---

## 7. 本路线图与既有设计的关系

这条路线不是推翻已有文档，而是对已有方向做“从产品化设计到主链接入点”的再收敛。

### 7.1 与 `productize-agent-runtime` 的关系

`productize-agent-runtime` 解决的是：

- 方向对不对
- 运行时应该如何分层

本路线图解决的是：

- 分层之后，下一阶段先补哪几个接入点
- 如何按阶段让 `mycli` 更接近 Codex 的主链组织方式

### 7.2 与 `improve-agent-exploration-discipline` 的关系

`improve-agent-exploration-discipline` 是本路线图的阶段一中的第一个落点。

它不是孤立优化，而是：

- turn context assembly
- runtime policy
- activity surface

三者结合的起步样板。

### 7.3 与旧的 `Phase 2 产品化路线图` 的关系

旧路线图强调的是：

- grounding
- task runtime
- tools
- trace
- provider 稳定性

这条新路线并不否定这些方向，而是进一步把它们重新映射到更清晰的主链接入点：

- grounding 与 discipline 属于阶段一
- task/runtime/capability 注入属于阶段二
- 工具体系扩展属于阶段三
- trace/surface/multi-agent 深化属于阶段四

换句话说：

`旧路线图说的是“做哪些东西”，这条新路线说的是“这些东西按什么主链长出来”。`

---

## 8. 下一阶段最值得先写的 spec / proposal

如果按这条路线继续往下走，最值得优先落 spec 的顺序建议是：

1. `improve-agent-exploration-discipline`
2. `turn-context-assembly`
3. `productize-skill-capability-injection`
4. `unify-tool-exposure-for-mcp-and-dynamic-tools`

原因是：

- 第一个直接解决真实使用中的可信度问题
- 第二个建立统一上下文装配层
- 第三个让能力进入 turn 主链
- 第四个让工具生态进入统一工具主链

---

## 9. 最终判断

对 `mycli` 来说，下一阶段最重要的不是“学 Codex 做更多功能”，而是：

`学 Codex 把所有能力收敛到同一条 turn 主链。`

因此，方案 2 的真正价值不只是“比较稳”，而是它正好击中了 `mycli` 当前最缺的那个层次：

- 不再只补协议
- 不再只补 prompt
- 不再只补 CLI 展示

而是开始建设：

- context assembly
- capability injection
- tool exposure
- item lifecycle

只要这四个接入点逐步成型，`mycli` 后续继续做 `skills`、`MCP`、dynamic tools、多 surface、多 agent，都会越来越顺；
如果这四个接入点不先补齐，后续 feature 越多，系统只会越难维护。

一句话收尾：

`mycli 的下一阶段，应该先成为“有统一主链的 agent runtime”，再成为“功能丰富的 agent 产品”。`
