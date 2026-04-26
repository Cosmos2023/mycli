# mycli 对照 Codex 的通用 Agent 能力差距研究

**日期：** 2026-04-12

**状态：** 研究完成，可作为后续 proposal、design 与 roadmap 的上游输入

**研究目标：**

回答下面三个问题：

1. Codex 为什么能够成为一款通用性的 agent，而不是“只会改代码的 CLI”
2. Codex 采取了哪些关键架构与方法，才让它可以稳定承载多类任务
3. 以“通用个人智能助手”为目标的 `mycli`，当前与 Codex 还有哪些差距

---

## 1. 先说结论

Codex 最值得借鉴的点，不是“它会很多”，而是“它把很多能力都收进了统一 runtime 主链”。

它之所以能够逐步成为通用 agent，核心不是因为：

- 单独做了 coding 模式
- 单独做了 research 模式
- 单独做了 connector 模式
- 单独做了 multi-agent 模式

而是因为它把下面这些能力都视为统一主链上的接入点：

- turn context assembly
- skills / capability injection
- tool exposure / routing
- item / event lifecycle
- approval / safety governance
- multi-surface thread representation

这意味着 Codex 的“通用性”不是功能堆叠出来的，而是 runtime 设计的自然结果。

对于 `mycli` 来说，最重要的判断是：

`mycli` 当前的方向并没有跑偏，但仍处于“runtime 骨架已经出现，中层尚未真正产品化”的阶段。

它已经开始具备：

- turn context assembly
- capability injection 雏形
- tool exposure / router 雏形
- responses item/block 适配
- approval / trace / planning 骨架

但与 Codex 相比，`mycli` 还缺少把这些点真正连成平台级主链的中层能力。

一句话总结：

`Codex 强在“把通用性工程化”；mycli 当前强在“已经看到了正确方向，并开始搭统一 runtime 骨架”。`

---

## 2. 事实与判断边界

为了避免把“调研结论”说成“源码事实”，这里先明确区分：

### 2.1 事实

下面这些结论可以直接从源码中看到：

- Codex 有明确的主链函数：`build_initial_context()`、`built_tools()`、`build_prompt()`、`run_sampling_request()`
- Codex 会把 skills、plugins、apps/connectors、permissions、memory、environment context 统一装配进 turn 上下文
- Codex 的工具系统不是静态列表，而是按当前 turn 和配置构造出的 router / registry 计划
- Codex 把 MCP、dynamic tools、request_user_input、apply_patch、web_search、view_image、multi-agent 等都放进统一工具体系
- Codex 对外暴露的是统一 thread item / event，而不是让每个 surface 自己拼接 agent 行为
- `mycli` 当前已有 `AgentRuntime`、`TurnContextAssembler`、`CapabilityResolver`、`ToolExposurePlanner`、`ToolRouter`、`RuntimePolicy`、`ResponsesModelAdapter`
- `mycli` 当前的 dynamic tool、MCP、capability profile、多 surface 仍然不完整，更多处于路线图与局部骨架阶段

### 2.2 判断

下面这些属于基于源码结构做出的架构判断：

- Codex 的通用性，主要来自统一主链，而不是单点功能数量
- `mycli` 当前最大的差距不在“有没有某个功能”，而在中层 runtime 的收敛度
- 如果 `mycli` 继续优先堆功能，而不是继续补中层主链，后续很容易演化成“功能很多，但行为不统一”的系统

### 2.3 不确定处

本次研究以本地源码与仓库文档为基础，以下内容仍然存在有限不确定性：

- Codex 某些产品层行为可能还依赖仓库外的托管服务或官方文档约定
- 某些未深入展开的 crate 或 app-server 行为，本文只引用了足够支持结论的核心路径，没有逐个穷尽
- `mycli` 当前 OpenSpec 文档里已经规划的能力，未必都已经进入稳定实现

---

## 3. Codex 为什么能够成为通用 Agent

## 3.1 它先定义统一 turn 主链，再把能力往里挂

Codex 的核心不是“先有很多 feature，再想办法组织”，而是先有主链：

1. 构建本轮上下文
2. 构建本轮可见工具面
3. 构建模型 prompt
4. 发起采样请求
5. 统一消费模型输出与工具调用
6. 把结果沉淀为 history / items / events / state

这一点可以从这些函数直接看出：

- `codex-rs/core/src/codex.rs`
  - `build_initial_context()`
  - `build_prompt()`
  - `run_sampling_request()`
  - `built_tools()`

这条链的意义是：

- runtime 先于单点功能存在
- 能力必须以“可嵌入主链”的方式进入系统
- UI、skills、MCP、plugins、subagents 都不是旁路

这是 Codex 能从 coding assistant 走向通用 agent 的第一性原因。

## 3.2 它把“上下文”做成正式装配流程，而不是拼 prompt

Codex 在 `build_initial_context()` 中统一处理：

- permissions / approvals instructions
- developer instructions
- memory tool instructions
- collaboration mode instructions
- personality
- apps / connectors section
- skills section
- plugins section
- user instructions
- environment context

这件事很关键，因为通用 agent 的本质不是“模型很强”，而是：

`本轮模型到底看到了什么上下文，是由 runtime 稳定决定的。`

如果没有这层，系统就会退化成：

- 某些行为靠 system prompt
- 某些行为靠 surface 判断
- 某些行为靠 skill 拼接
- 某些行为靠外部工具旁路

这种系统短期能工作，长期很难变成真正通用的 agent。

## 3.3 它把 skills 当成 runtime 能力，不是提示词附件

Codex 对 skills 的处理远比“命中后插入一段 prompt”更深：

- 能解析显式 skill mention
- 能解析 skill env var dependencies
- 缺依赖时可以通过 `request_user_input` 补充
- 能把 skill 注入结果变成 turn items
- 能记录 implicit skill invocation
- 能做 telemetry 追踪

这说明在 Codex 中，skill 至少同时承担三类职责：

1. 本地可发现资产
2. turn-time capability injection
3. 行为与观测层的正式 runtime 对象

这让 Codex 的能力增长不是“加一段 prompt”，而是“给 runtime 新增一种稳定能力来源”。

## 3.4 它把 tools 做成正式平台能力，而不是一个工具列表

Codex 的工具系统具备几个很重要的特点：

- schema / spec-first
- handler 注册明确
- 支持 namespace
- 支持 deferred tool exposure
- 支持 MCP / dynamic tool / local tool / agent tool 同台治理
- 支持 request_user_input、apply_patch、view_image、web_search、js_repl、spawn_agent 等不同形态

这意味着 Codex 的“做很多事”不是因为它塞了很多命令，而是因为它有一套能够承载不同工具形态的统一协议。

这套工具协议直接决定了它能否自然演进为：

- coding agent
- research assistant
- multimodal assistant
- external connector orchestrator
- multi-agent coordinator

## 3.5 它把 plugins / connectors / MCP 收敛成“能力市场”

Codex 没有把 plugins、apps/connectors、MCP 分别做成三套孤立系统。

相反，它的设计更接近：

- plugin 是能力包
- plugin 里可以包含 skills、MCP servers、apps
- connectors 的 enabled state 会影响可见工具面
- MCP tools 会先进入 tool exposure，再统一路由

这带来一个非常大的长期优势：

`未来新增能力来源时，不必重新发明一条 agent 主链。`

这正是通用 agent 能持续演进的关键。

## 3.6 它把 surface 建在统一 item/event 语义之上

Codex 的 TypeScript SDK 和执行事件模型表明：

- thread 是正式对象
- turn 是正式对象
- command execution、file change、MCP tool call、reasoning、web search、todo list 都是正式 item

这件事的价值非常大：

- CLI 不需要自己拼解释逻辑
- TUI / IDE / desktop / app server / SDK 可以共用同一套运行时语义
- surface 负责“展示”，而不是“猜 agent 在干什么”

这也是 Codex 能够同时作为 CLI、IDE 集成、桌面体验和 SDK 存在的重要原因。

## 3.7 它把安全、审批、人机协作也收进主链

Codex 的安全治理不是“外面包一层拦截器”：

- permissions instructions 会进入上下文
- request_user_input 是正式工具
- request_permissions 是正式工具
- MCP tool approvals 有配置与策略
- approval / sandbox 不是 UI 自己处理的细节，而是 runtime 行为的一部分

对于通用 agent 来说，这非常重要。

因为一个真正支持日常工作的 agent，迟早会处理：

- 文件修改
- shell 执行
- 外部系统操作
- 凭证依赖
- 用户确认

如果这些能力不在主链内治理，系统越通用，风险越大。

---

## 4. Codex 采取了哪些关键架构与方法

把上面的观察再抽象一层，可以归纳成六种方法。

## 4.1 统一主链方法

把所有能力接入都围绕 turn 主链组织，而不是围绕 feature 分类组织。

这意味着新增功能时优先问：

- 它如何进入上下文
- 它如何进入工具面
- 它如何进入 item lifecycle
- 它如何进入 trace / telemetry

而不是优先问：

- 它是 coding feature 还是 research feature

## 4.2 能力收敛方法

Codex 的技能、插件、连接器、MCP 都没有被设计成“产品上彼此平级的几套系统”，而是被收敛成能力来源。

这种设计让系统可以继续长大，但不会越来越碎。

## 4.3 工具协议方法

Codex 并不满足于“模型能调到某个工具就行”，而是让工具具备正式结构：

- descriptor
- schema
- namespace
- handler kind
- router
- lifecycle
- approval / policy integration

这决定了工具生态能不能长期扩张。

## 4.4 事件归一化方法

Codex 会把不同来源的动作统一映射成 item/event。

这让：

- history
- surface
- analytics
- debugging
- SDK

都围绕同一套运行时对象工作。

## 4.5 渐进扩展方法

Codex 没有要求所有能力一次性抽象完成，而是采用：

- 先抽稳定共享原语
- 再把新能力挂到统一边界后面
- 逐步把高耦合逻辑从核心区剥离

例如 `codex-tools` 明确强调不要过早抽走高耦合 orchestration，而是先迁移稳定 tool primitives。

这说明它不是一开始就“设计完美”，而是通过强约束的渐进抽象，逐步长成平台。

## 4.6 以多 surface 为目标的方法

Codex 从仓库结构上就不是单一 CLI 心智。

它显然在同时服务：

- CLI
- TUI / app
- IDE 集成
- TypeScript SDK
- app server / protocol

这会反过来迫使 runtime 必须抽象得更稳定。

换句话说，Codex 的通用性，不只是任务类型通用，也包含宿主 surface 通用。

---

## 5. mycli 当前已经具备的正确方向

尽管 `mycli` 与 Codex 还有明显差距，但它并不是“方向错误”，相反，很多关键点已经对上了。

## 5.1 已经开始从 CLI 逻辑转向 runtime 主链

`mycli` README 已明确说明：

- CLI 不再直接承担 agent 主循环
- 内部已经切换到 message-driven runtime
- tools 通过 schema-first registry 暴露
- tool result 会回灌到后续推理
- planning 已内建为能力
- 高风险调用会挂起 turn
- protocol 已切到 responses-first

这说明 `mycli` 已经不再是“命令行壳子 + prompt 拼接”，而是在往正式 agent runtime 走。

## 5.2 已经有 turn context assembly 的第一版骨架

`TurnContextAssembler` 已经能统一装配：

- base instructions
- workspace instructions
- environment context
- conversation context
- memory
- plan
- runtime reminders
- capability
- tool exposure
- user request

这说明 `mycli` 已经开始把“本轮模型看到了什么”从分散逻辑里收回来。

## 5.3 已经有 capability injection 的第一版模型

`CapabilityResolver` 已能根据：

- 显式 `$skill` mention
- metadata trigger hints
- env / workspace dependency 状态

生成 `CapabilityActivation`。

虽然它还不深，但思路已经正确：

`skill` 不再只是 prompt 文件，而开始变成 runtime 能力对象。

## 5.4 已经有 tool exposure / router 的第一版骨架

`ToolExposurePlanner` 与 `ToolRouter` 已经体现出几个重要方向：

- direct / deferred / dynamic tool 区分
- capability-contributed dynamic tools
- turn-scoped callable tool enforcement
- tool exposure summary 进入 turn item

这说明 `mycli` 已经开始拥有“本轮哪些工具可见”这层中间抽象，而不是一股脑把工具都给模型。

## 5.5 已经开始补 exploration / evidence / stopping policy

`RuntimePolicy` 现在主要覆盖：

- overview
- source-first codebase analysis
- implementation verification
- failure investigation
- loop stop / reroute
- evidence threshold

虽然当前最明显服务的是代码库分析 / verification 场景，但它本质上已经不是单纯 prompt tweak，而是 runtime 决策层。

这条路非常接近正确方向。

---

## 6. mycli 与 Codex 的核心差距

如果把目标定义为“通用个人智能助手”，那么 `mycli` 当前和 Codex 的差距主要有六层。

## 6.1 差距一：中层 runtime 还没有真正站稳

现在 `mycli` 已经有骨架，但很多点仍然是“有入口，没闭环”：

- context assembly 已有，但仍偏静态 section 汇总
- capability activation 已有，但仍偏 trigger-based
- tool exposure 已有，但策略仍偏启发式
- provider item 已有，但归一化生命周期不完整

这意味着 `mycli` 目前更像：

`一个已经开始产品化的 coding runtime`

而不是：

`一个已具备平台稳定性的通用 agent runtime`

## 6.2 差距二：能力注入深度不够

Codex 的 skill 处理是：

- 发现
- 依赖解析
- 用户补依赖
- 注入 item
- 隐式触发
- telemetry

而 `mycli` 当前更多还是：

- 显式 mention
- trigger hint 命中
- 读取正文
- 注入指令

这会导致 `mycli` 的 capability 更接近“有结构的 prompt 扩展”，还没有变成“强 runtime 语义”。

## 6.3 差距三：工具协议仍不够正式

`mycli` 现在的 dynamic tools 能接进来，但还没有成为强约束的 runtime 对象。

突出表现包括：

- `_runtime_dynamic_tools()` 仍为空
- tool exposure 默认 direct tool 主要依赖 user message 关键词
- dynamic tool 的 lifecycle / trace / conflict / scope 还不充分
- MCP 尚未成为统一 router 下的一等对象

这意味着一旦后续继续加：

- writing tools
- research tools
- automation tools
- MCP tools
- hosted tools

工具体系很容易再次发散。

## 6.4 差距四：provider / MCP bridge 仍然不完整

当前 `mycli` 的 `ResponsesModelAdapter` 已经能识别 provider 的 `mcp_call` 相关事件，但主要仍是把它映射成 reasoning block。

这说明现在的 provider / MCP 处理更像：

- “我知道 provider 传了一个 MCP 事件”

而不是：

- “这个 MCP 调用已进入 mycli 的统一工具主链，并受统一治理”

这层差距很关键，因为通用 agent 迟早要处理外部能力桥接。

## 6.5 差距五：多任务 capability 还没有产品化

Codex 的代码结构已经能看出它在为多任务 agent 做准备：

- 多种工具形态
- request_user_input
- image / web / apps / plugins / subagents
- 多 surface thread item 语义

而 `mycli` 当前虽然有“通用 assistant”的明确路线判断，但落到 runtime 上，还没有正式 capability profile，例如：

- coding-implementation
- debugging
- code-review
- writing
- research
- personal-assistant automation

现在的 `RuntimePolicy` 已经像这个方向迈了一步，但还远没有完成产品化。

## 6.6 差距六：日常工作助手能力仍以愿景为主

用户对 `mycli` 的目标并不只是：

- 总结项目
- 修改代码

而是：

- 支持日常工作
- 维护长期上下文
- 协助研究与整理
- 作为个人智能助手存在

从这一目标反推，`mycli` 当前最大的缺口之一在于：

`“个人工作助手”相关任务还没有进入正式 runtime 语义。`

也就是说，现在的 `mycli` 仍然容易被感知成“面向代码仓库的 agent”，而不是“以个人上下文和工作任务为中心的 agent”。

这不意味着方向错误，而意味着还没有进入下一阶段。

---

## 7. 如果 mycli 的目标是通用个人助手，这意味着什么

如果 `mycli` 要追赶 Codex，而且目标不只是 coding，而是通用个人智能助手，那么需要明确一件事：

`mycli` 的终局不应只是“更强的项目分析与改码工具”，而应是“以统一 runtime 承载工程任务、知识任务、日常工作任务的个人 agent”。`

这会带来三个设计后果。

## 7.1 不要把“全能”理解成模式叠加

不能走成：

- coding mode
- writing mode
- research mode
- assistant mode

分别各做一套 prompt、工具和状态。

这样会把系统做碎。

## 7.2 要把“通用性”落实为 capability / workflow / tool exposure 的正式组合

未来的任务类型差异，应该主要落在：

- capability profile
- workflow / policy
- tool exposure
- validation / stopping rule

而不是落在“切换一个新产品模式”。

## 7.3 要让“个人助手”能力也走主链

例如未来的：

- 待办管理
- 长期记忆
- 研究整理
- 写作与改写
- 自动化执行

都不应作为独立外挂系统，而应进入统一 runtime。

这点和 Codex 的启发是一致的：

`真正通用的 agent，不是功能越来越多，而是越来越多任务都走同一条主链。`

---

## 8. 对 mycli 的建议排序

结合本次源码调研，`mycli` 如果要继续追赶 Codex，建议仍然按下面顺序推进。

## 8.1 第一优先级：继续稳定探索、验证、收口策略

原因：

- 这是所有高阶任务质量的地基
- 如果这层不稳，继续加工具只会放大犹豫、重复探索和噪音
- 现在代码库分析场景之所以显眼，只是因为它最容易暴露这类问题

应该把它明确表述为：

`通用 agent 的探索 / 验证 / 收口策略层`

而不是：

`仓库分析优化`

这里需要明确约束：

- 代码库分析是当前最强的样本任务，不是长期产品目标
- 后续 runtime 改动必须能解释自己对 debugging、writing/research、assistant automation 的收益
- 如果某项改动只能改善代码库分析，而不能改善更广义的任务推进与收口，那它不应占据主线优先级

## 8.2 第二优先级：把 dynamic tools 升级成正式协议

重点应包括：

- descriptor
- lifecycle
- turn / thread scope
- visibility
- trace / session / surface integration
- priority / conflict handling

这是未来接 writing / research / automation / provider tool 的关键中层。

## 8.3 第三优先级：建立 provider / MCP bridge

重点应包括：

- provider item lifecycle 归一化
- namespaced route
- provider tool metadata / error / trace 归一化
- MCP 最小稳定接入

没有这层，`mycli` 很难真正从“本地工作区 agent”成长为“可连接外部能力的通用助手”。

## 8.4 第四优先级：把多任务能力做成正式 capability profile

建议优先产品化的 profile：

- coding-implementation
- systematic-debugging
- code-review
- writing
- research
- task-automation
- personal-assistant

其中 `personal-assistant` 很重要，因为这会逼迫 `mycli` 从“项目中心”进一步转向“人 + 工作流中心”。

## 8.5 第五优先级：再考虑多 surface

在 runtime 中层更稳之后，再考虑：

- 更强的 CLI activity surface
- IDE / editor integration
- background task or app server
- structured SDK / thread API

否则多 surface 只会把当前主链的不稳定进一步外显。

---

## 9. 最重要的战略判断

如果要用一句话概括这次研究最重要的结论，那就是：

`Codex 之所以像“通用 agent”，不是因为它把所有功能都做完了，而是因为它先把统一 runtime 主链做成了能力收敛中心。`

而 `mycli` 当前最应该做的，不是焦虑“功能面还不够大”，而是继续把这条主链做深。

因此，真正值得坚持的路线是：

1. 先把 runtime 中层做稳
2. 再把更多能力作为 capability / tools / connectors 接进来
3. 最后让 system naturally grow into a general personal assistant

这条路线与“继续做一个更强的 coding CLI”相比，短期更难，但长期更接近你给 `mycli` 设定的终局。

---

## 10. 关键证据文件

### 10.1 Codex

- `README.md`
- `docs/config.md`
- `codex-rs/core/src/codex.rs`
- `codex-rs/core/src/skills.rs`
- `codex-rs/core/src/plugins/render.rs`
- `codex-rs/tools/src/tool_registry_plan.rs`
- `codex-rs/tools/src/dynamic_tool.rs`
- `sdk/typescript/src/items.ts`
- `sdk/typescript/src/thread.ts`

### 10.2 mycli

- `README.md`
- `src/mycli/application/runtime/agent_runtime.py`
- `src/mycli/services/context/turn_context_assembler.py`
- `src/mycli/services/capability_resolver.py`
- `src/mycli/services/tool_exposure_planner.py`
- `src/mycli/services/tool_router.py`
- `src/mycli/services/runtime_policy.py`
- `src/mycli/infrastructure/models/responses_adapter.py`
- `docs/superpowers/specs/2026-04-12-mycli-general-assistant-evolution-roadmap.md`
- `docs/superpowers/specs/2026-04-12-mycli-codex-inspired-next-step-recommendations.md`

---

## 11. 可直接复用的后续提案方向

基于本次研究，后续最自然的 OpenSpec / roadmap 方向包括：

- `formalize-dynamic-tool-contract`
- `build-provider-mcp-bridge`
- `productize-task-capability-profiles`
- `expand-personal-assistant-runtime-scope`
- `normalize-thread-item-lifecycle`

这些方向的共同目标都不是“多做一个功能”，而是：

`继续把 mycli 推向一个真正统一、可扩展、可承载日常工作的通用 agent runtime。`
