# mycli 对 openai/codex agent runtime 主链的源码调研

日期：2026-04-12

## 调研目的

这次调研不再停留在“Codex 有哪些功能”，而是聚焦一个更本质的问题：

- Codex 是如何在运行时层面引导 agent 完成任务的？
- skills、MCP、dynamic tools、plugins、multi-agent 这些能力，是如何嵌入这条主链的？
- 哪些点值得 `mycli` 借鉴，哪些点应该谨慎引入？

一句话概括这次结论：

`Codex 的强项不在于功能多，而在于它把所有能力都收敛到同一条 turn 主链里。`

---

## 一、快速结论

如果只说最重要的判断，Codex 的 agent runtime 可以概括为下面这条链路：

1. 先为当前 turn 组装基础指令、项目指令、环境指令和模式指令
2. 再根据当前输入、skills、plugins、connectors、MCP 状态构建“本轮可见工具面”
3. 把这些内容打包成 prompt 发给模型
4. 将模型返回统一映射成 `ResponseItem` / `TurnItem`
5. 若出现工具调用，则全部进入统一 `ToolRouter`
6. 工具执行过程再统一产出 begin/end/output delta 等结构化事件
7. app-server / TUI / session history 都只消费这些统一事件与 item

这意味着：

- skills 不是外挂 prompt
- MCP 不是旁路工具系统
- multi-agent 不是特殊分支
- UI 也不是自己理解模型输出

它们都只是这条主链上的“上下文注入器”“工具来源”或“事件消费者”。

这就是 Codex 看起来像一个成熟 agent runtime 的根本原因。

---

## 二、Codex 如何引导 agent 完成任务

### 2.1 引导不是一层 prompt，而是四层叠加

Codex 对 agent 的引导，不是只有一个 system prompt。

从源码看，至少有四层：

1. **Base Instructions**
   - 来自 `codex-rs/protocol/src/prompts/base_instructions/default.md`
   - 定义全局工作方式、响应风格、工具使用规则、计划工具规则、验证习惯等

2. **项目与用户指令**
   - 由 `codex-rs/core/src/project_doc.rs` 自动收集 `AGENTS.md`
   - 用户级 `instructions` 与项目级 `AGENTS.md` 会被拼接成统一 user instructions

3. **会话/模式上下文**
   - 在 `codex-rs/core/src/codex.rs` 的 `build_initial_context()` 中拼装
   - 包括 approval/sandbox 指令、collaboration mode、personality、environment context 等

4. **本轮工具与能力面**
   - 由 `built_tools()` 结合 MCP、dynamic tools、plugins、connectors、skills 构造
   - 最终通过 `build_prompt()` 注入模型

这四层叠加后，模型拿到的不是“一个字符串 prompt”，而是一整套与当前 turn 绑定的运行时上下文。

### 2.2 Codex 真正的任务引导中心在 `build_initial_context()`

`codex-rs/core/src/codex.rs:3704` 的 `build_initial_context()` 是整个引导逻辑的核心之一。

这里会把很多能力变成模型可见上下文：

- policy / permission instructions
- developer instructions
- memory tool instructions
- collaboration mode instructions
- realtime instructions
- personality instructions
- apps section
- skills section
- plugins section
- user instructions
- environment context

这说明 Codex 的设计思路非常清晰：

`先把“你是谁、你在哪、你能做什么、这轮有哪些约束”说清楚，再开始做任务。`

这和很多轻量 agent runtime 的差异很大。后者通常只是在发请求时附一个 system prompt，然后把一堆工具裸露给模型。

### 2.3 主循环不是“问一次模型”，而是“持续采样 + 工具闭环”

在 `codex-rs/core/src/codex.rs:6215` 一带，Codex 的 turn 主循环大致如下：

1. 整理 pending input / accepted input / blocked input
2. 从 `ContextManager` 取出当前模型可见 history
3. 调用 `run_sampling_request()`
4. 在 sampling 过程中构建本轮工具路由器
5. 模型返回 message / reasoning / tool call / 其他 item
6. 若有工具调用，则交给 `ToolCallRuntime`
7. 将执行结果写回 history，再继续下一轮 sampling
8. 直到模型不再需要 follow-up，或被 pending input / compact / error 打断

这套循环的关键不是“循环”本身，而是：

- 每一步都有统一 item/event
- 每一步都能被状态层、历史层、UI 层消费
- 功能扩展不会破坏主循环，只会在主循环的输入或工具面上做增强

### 2.4 Codex 不是 runtime 替模型做所有决定

Codex 的 runtime 很强，但它没有把“任务怎么做”全部硬编码掉。

它做的是：

- 明确注入规则
- 明确注入能力
- 明确构建工具面
- 明确统一事件与 item
- 明确错误恢复、compact、retry、approval、sandbox

至于“先搜什么、后读什么、何时停下回答”，大量仍然交给模型在这套约束中完成。

这和 `mycli` 当前一个明显差异是：

- 我们现在更容易在 runtime policy 里直接决定“overview 足够了，可以回答”
- Codex 更像是在搭建一个高约束但高自由度的执行场，让模型自己完成收敛

---

## 三、skills 是如何嵌进主链的

### 3.1 skills 先是本地资产，再是运行时上下文

Codex 的 system skills 会先被安装到本地缓存，相关逻辑在：

- `codex-rs/skills/src/lib.rs`

这层做的是：

- 把内置 sample skills 从嵌入资源写到 `CODEX_HOME/skills/.system`
- 用 marker/fingerprint 避免重复安装

也就是说，skills 先是“可发现的本地资产”，而不是运行时里硬编码的一堆字符串。

### 3.2 每个 session/thread 持有 SkillsManager

在 `codex-rs/core/src/thread_manager.rs` 中，`ThreadManager` 会统一持有：

- `SkillsManager`
- `SkillsWatcher`

这意味着 skills 的发现、缓存、失效、热更新都不是 UI 的职责，也不是 prompt builder 的职责，而是 runtime 基础设施职责。

### 3.3 每个 turn 会做显式 mention、隐式注入和依赖解析

在 `codex-rs/core/src/codex.rs:6008` 之后，Codex 会做一整套 skill 处理：

- `collect_explicit_skill_mentions`
- `build_skill_injections`
- `collect_env_var_dependencies`
- `resolve_skill_dependencies_for_turn`
- `maybe_prompt_and_install_mcp_dependencies`

然后把 skill 产出的 `items` 直接记录到 conversation history 里。

这说明 skill 在 Codex 中不是“读完就忘”的临时提示，而是会进入 turn 历史、进入模型输入、进入 analytics 的正式运行时对象。

### 3.4 skills 既是上下文，也是隐式行为触发器

除了显式 mention，Codex 还支持 implicit invocation。

`codex-rs/core/src/skills.rs` 里的 `maybe_emit_implicit_skill_invocation()` 表明：

- 某些命令/上下文可以触发 skill 的隐式调用记录
- runtime 会跟踪哪些 implicit skill 已在本轮见过，避免重复注入

同时，`build_initial_context()` 又会通过 `render_skills_section()` 把允许隐式触发的 skills 渲染到 developer context。

所以 skill 在 Codex 里至少承担两种职责：

1. **静态能力声明**
2. **动态 turn 注入与依赖解析**

这比 `mycli` 当前“active skill + prompt”模型明显更深。

---

## 四、MCP 是如何嵌进主链的

### 4.1 MCP 先进入工具暴露层，而不是直接暴露给模型

Codex 不会把所有 MCP tools 一股脑全塞给模型。

在：

- `codex-rs/core/src/codex.rs:6776`
- `codex-rs/core/src/mcp_tool_exposure.rs`

可以看到一套明确策略：

- 先收集所有 MCP tools
- 再区分 direct tools 和 deferred tools
- 如果工具太多，就只直接暴露一部分
- 其余通过 `tool_search` 延迟暴露

这非常重要，因为它避免了：

- 模型上下文被大量工具 schema 淹没
- 连接器工具爆炸后 prompt 失控

### 4.2 MCP tool 最终仍然走统一 ToolRouter

在：

- `codex-rs/core/src/tools/router.rs`

里，`ResponseItem::FunctionCall` 如果解析后发现是 namespaced MCP tool，就会被构造成 `ToolPayload::Mcp`，然后继续走统一工具分发。

这意味着：

- MCP tool 对模型来说仍然是 tool call
- 对 runtime 来说只是另一种 payload
- 对事件层来说仍然能产出统一 begin/end/output

这就是主链稳定带来的好处。

### 4.3 MCP 还有自己的一层审批与安全治理

真正执行 MCP tool call 的逻辑在：

- `codex-rs/core/src/mcp_tool_call.rs`

这里不是单纯“转发给 MCP server”，而是带着：

- tool metadata 查找
- app tool policy
- approval mode
- guardian review
- begin/end events
- telemetry

所以 MCP 在 Codex 中不是“外挂远程工具”，而是被纳入与本地工具同等级的 runtime 治理体系。

### 4.4 connectors / plugins / codex apps 会影响 MCP 暴露

MCP 不只是协议层问题，它还和 connectors、plugins 联动。

例如：

- plugin mentions 需要 raw MCP/app inventory
- connectors 的 enabled state 会影响哪些 MCP tools 被暴露
- discoverable tools 又会反馈到 `tool_search` / `tool_suggest`

也就是说，Codex 把 MCP 看成一个更大的“能力市场”，而不是孤立的远程调用协议。

---

## 五、dynamic tools 是如何嵌进主链的

### 5.1 dynamic tools 有独立协议，但不单独开辟执行体系

协议定义在：

- `codex-rs/protocol/src/dynamic_tools.rs`

这里定义了：

- `DynamicToolSpec`
- `DynamicToolCallRequest`
- `DynamicToolResponse`

这说明 Codex 允许 thread 启动时带入一批临时工具。

### 5.2 dynamic tools 在 thread 启动时进入 turn context

在：

- `codex-rs/app-server/src/codex_message_processor.rs:2280`

可以看到 app-server 接收外部 dynamic tools 后，会先做 schema 校验，再转成 core 的 `DynamicToolSpec`，最后在 `start_thread_with_tools_and_service_name()` 时带入 thread。

所以 dynamic tools 不是后期热插进去的 hack，而是 thread/session 初始化的一部分。

### 5.3 dynamic tool response 仍然回灌到主链

在：

- `codex-rs/app-server/src/dynamic_tools.rs`

dynamic tool 的响应最终会被转成：

- `Op::DynamicToolResponse`

回灌给 `CodexThread`。

因此，dynamic tools 虽然来源特殊，但生命周期仍然服从同一条主链：

- 声明
- 暴露
- 调用
- 响应
- 回写 turn

---

## 六、为什么其他功能不会把系统搞乱

Codex 最值得借鉴的一点，是它把新增能力统一收敛到有限的几个接入点。

### 6.1 上下文类能力，统一进 `build_initial_context()`

比如：

- AGENTS.md
- user instructions
- skills section
- plugins section
- apps section
- environment context
- collaboration mode
- personality

这些都不是散落在各个 handler 里，而是集中在 turn 上下文组装阶段处理。

### 6.2 工具类能力，统一进 `built_tools()` + `ToolRouter`

比如：

- 本地工具
- MCP tools
- deferred tools
- discoverable tools
- dynamic tools

这些最终都会落到统一工具注册、统一工具分发、统一工具执行事件上。

### 6.3 安全类能力，统一挂在执行路径上

比如：

- approval
- sandbox
- guardian
- hooks
- exec policy

这些不是 UI 弹窗逻辑，也不是 provider adapter 逻辑，而是执行路径上的一等公民。

### 6.4 surface 只消费 item/event，不自己猜

Codex 的 app-server、TUI、session log 都建立在统一事件与 item 上。

这意味着：

- UI 不需要自己猜模型当前在做什么
- 只要订阅 begin/end/output/item lifecycle 就能还原过程

这也是它能稳定展示“正在执行命令”“正在等待后台终端”“正在运行 hook”的原因。

---

## 七、多 agent 也没有破坏主链

### 7.1 multi-agent 通过 role 配置叠加，而不是硬编码分叉

在：

- `codex-rs/core/src/agent/role.rs`

里，agent role 本质上是配置层叠加器。

它的职责是：

- 解析 built-in 或用户定义 role
- 把 role 作为高优先级 config layer 覆盖到 spawned agent config 上

这意味着 multi-agent 不是写死几种 agent 行为，而是把 agent 个性化配置当作标准配置层处理。

### 7.2 `spawn_agent` 本身只是普通工具 handler

在：

- `codex-rs/core/src/tools/handlers/multi_agents_v2/spawn.rs`

可以看到：

- `spawn_agent` 也是普通 ToolHandler
- 它会构建新的 agent config
- 再附加一段 spawned-agent developer instructions
- 然后交给 `AgentControl` 去创建新 thread

所以多 agent 不是 runtime 的“例外模式”，而是工具系统内的一等能力。

---

## 八、对 mycli 的启发

结合这次调研，`mycli` 最值得借鉴的不是某个具体 feature，而是下面 6 条原则。

### 8.1 不要把能力直接堆进 prompt

应优先区分：

- base instructions
- 项目/工作区指令
- turn policy/reminders
- capability sections
- tool exposure

换句话说，先做上下文装配层，再做 prompt 模板。

### 8.2 不要把 skills 只当作 prompt 附件

更合理的方向是：

- skill discovery / cache / watch 归基础设施层
- turn 中的显式 mention / 隐式注入归运行时层
- skill 结果进入 conversation items，而不是只拼成一段文本

### 8.3 不要让 MCP 绕开工具主链

如果 `mycli` 后续接 MCP，应该尽量做到：

- MCP tool 先进入统一 tool exposure
- 再进入统一 router
- 再进入统一 tool lifecycle event

而不是在 provider adapter 或 CLI 层特判。

### 8.4 feature 要么是上下文，要么是工具，要么是事件

这是我认为 Codex 最核心的设计哲学：

- 上下文类能力：进入 initial context
- 工具类能力：进入 tool registry / router
- 生命周期类能力：进入 item/event

只要新功能不能清楚落到这三类之一，就很容易把 runtime 搞乱。

### 8.5 `mycli` 现在最缺的是主链接入点，而不是更多功能

当前 `mycli` 已经有不少 feature 雏形，但还缺少 Codex 这种明确主链：

- context assembly
- tool exposure
- normalized event lifecycle
- turn-time injection

如果这些接入点不稳定，继续加 skills、MCP、插件，只会增加系统偶然复杂度。

### 8.6 repo-analysis discipline 只是第一步

我们刚写的 `improve-agent-exploration-discipline` 只是在 runtime policy 上补一层纪律。

若继续沿 Codex 的方向演进，后续更值得推进的是：

1. turn-time context assembly 产品化
2. skills 注入链路产品化
3. MCP tool exposure / router 统一化
4. item/event lifecycle 再补完整

---

## 九、最终判断

Codex 的强，不在于它“有 skills、有 MCP、有 plugins、有多 agent”。

真正的关键在于：

`这些能力都没有各玩各的，而是被收进了统一的 turn runtime 主链。`

因此，对 `mycli` 来说，最应该学的不是“把这些功能也做出来”，而是先学会：

- 如何为每个 turn 组装上下文
- 如何为每个 turn 构建可控工具面
- 如何让所有执行过程都变成统一 item/event
- 如何让功能扩展接入主链而不是破坏主链

只有这样，`mycli` 后面继续做 skills、MCP、插件、多 agent，才会越做越稳，而不是越做越乱。

---

## 参考源码

这次调研重点阅读了以下模块：

- `codex-rs/protocol/src/prompts/base_instructions/default.md`
- `codex-rs/core/src/project_doc.rs`
- `codex-rs/core/src/codex.rs`
- `codex-rs/core/src/thread_manager.rs`
- `codex-rs/core/src/skills.rs`
- `codex-rs/skills/src/lib.rs`
- `codex-rs/core/src/tools/router.rs`
- `codex-rs/core/src/mcp_tool_exposure.rs`
- `codex-rs/core/src/mcp_tool_call.rs`
- `codex-rs/protocol/src/dynamic_tools.rs`
- `codex-rs/app-server/src/dynamic_tools.rs`
- `codex-rs/core/src/agent/role.rs`
- `codex-rs/core/src/tools/handlers/multi_agents_v2/spawn.rs`
