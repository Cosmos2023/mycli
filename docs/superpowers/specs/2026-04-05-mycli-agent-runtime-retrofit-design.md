# mycli 面向现代 Agent Runtime 的整体改造设计

**日期：** 2026-04-05

**状态：** 已完成设计草案，待用户审阅

**目标：** 认真吸收 `shareAI-lab/learn-claude-code` 这类极简 agent 实现所体现的核心思想，重新定义 `mycli` 的产品边界与运行时内核。在保持 `mycli` 作为“长期可用的个人 coding assistant”定位不变的前提下，重建其 agent harness、工具系统、审批机制、planning、skills 与上下文管理能力，并形成一套允许大幅重构仓库的分阶段改造方案。

---

## 1. 设计结论

这次改造不应被理解为“继续给当前骨架打补丁”，而应被理解为：

`保留 mycli 的产品外壳与部分持久化资产，重建其 agent runtime 内核。`

最终目标不是复刻 `learn-claude-code`，而是把它所体现的现代 agent 必备思想，落实到一个更适合个人长期使用的本地 coding assistant 中。

本设计采用以下总体决策：

- 产品定位：长期可用的个人 coding assistant
- 兼容策略：中兼容，保留 CLI 外壳和部分持久化资产，重写核心 runtime
- 模型接入：双通道抽象，优先支持原生 tool calling，也支持兼容 fallback 模式
- 实施路径：先产出总蓝图，再分阶段落地；第一阶段重建核心 harness，第二阶段补齐个人 assistant 能力，第三阶段再引入高级 agent 能力

---

## 2. 对 learn-claude-code 的核心学习结论

本设计参考了 `shareAI-lab/learn-claude-code` 仓库公开呈现的主线内容，包括 README、`v1_basic_agent.py`、`v2_todo_agent.py`、`v3_subagent.py`、`v4_skills_agent.py` 以及其文档中对后续上下文管理演进方向的说明。

这些内容的重要价值不在“功能清单”，而在于它展示了一个现代 agent 应如何按正确顺序生长。

### 2.1 Agent 的本体是 loop，不是 prompt 拼装器

最核心的抽象不是一个大 prompt，而是一个循环：

1. 把消息历史和工具定义交给模型
2. 模型决定是继续说话还是调用工具
3. 如果调用工具，执行工具
4. 把工具结果回注到消息历史
5. 再次进入下一轮推理

换句话说，agent 的心脏是：

`messages + tools + tool_result + loop`

而不是：

`用户输入 + 大 prompt + 模型输出 JSON`

### 2.2 Tool 必须是正式接口，不是提示词补丁

从极简版本开始，工具就应该是结构化能力：

- 有稳定 `name`
- 有清晰 `description`
- 有机器可读 `input_schema`
- 有统一执行契约

模型不是靠阅读一段散文式 prompt 来“猜工具参数”，而是基于正式 schema 来构造调用。

### 2.3 Planning 不是可有可无的展示层

`v2` 把 todo/plan 变成显式状态，这背后的真正思想是：

- 复杂任务需要显式外化计划
- 计划需要结构化约束，而不是纯文本
- 同一时刻只能有一个进行中步骤，能明显提升长任务稳定性

这意味着 planning 不应只是输出里的装饰字段，而应是 runtime 的原生机制。

### 2.4 Subagent 的价值是上下文隔离，不是并发噱头

`v3` 展示的重点不是“可以开多个 agent 很酷”，而是：

- 把探索任务放进独立上下文
- 把实现任务放进另一个上下文
- 主上下文只保留压缩后的结果
- 不同 agent type 拥有不同工具权限和提示约束

这是控制上下文污染、权限扩散和复杂度失控的关键机制。

### 2.5 Skill 的本质是外部化知识

`v4` 最有价值的启发是：

- Tool 解决“能做什么”
- Skill 解决“知道该怎么做”

Skill 应当是可索引、可按需装载、可进一步解析资源的知识系统，而不是每轮都塞进上下文的静态 prompt 附加物。

### 2.6 Context Management 是专门子系统

成熟 agent 面临的不是“对话太长就截断”这么简单的问题，而是：

- token 预算如何分配
- 大工具输出如何裁剪
- 历史如何分层持久化
- 哪些事实必须保留，哪些可以压缩
- 摘要如何滚动更新

这要求一个独立的 Context Manager，而不是一个简单的窗口裁剪函数。

### 2.7 复杂度应该渐进引入

`learn-claude-code` 的真正工程启发，是能力增长顺序本身：

1. agent loop
2. core tools
3. explicit planning
4. subagents
5. skills
6. compression / context management
7. tasks / background / team

这条顺序说明：

- 不要一开始就过度平台化
- 先把 loop 做对
- 再让 planning、subagent、skills、context manager 逐步成为一等能力

---

## 3. 当前 mycli 的现状判断

当前仓库并非空壳。它已经具备一个可以运行的 personal agent 骨架，并且方向不算错。

### 3.1 已有能力

当前 `mycli` 已经具备：

- CLI REPL 入口与基础 slash command
- ReAct 风格单 agent 执行骨架
- 基础工具：`list_directory`、`read_file`、`search_text`、`edit_file`、`run_shell`
- 配置加载、会话持久化、记忆与项目级记忆
- skill 注册与简单匹配
- 风险分类与选项式审批交互
- 轻量级上下文窗口与摘要压缩

### 3.2 已经做对的方向

以下方向值得保留：

- `tools`、`memory`、`skills`、`safety` 被识别为独立模块
- session 与 memory 已经持久化，不是一次性 demo
- 高风险动作引入审批，而不是完全自治
- 仓库结构基本符合分层意识

### 3.3 核心结论

当前 `mycli` 的问题不是“没有 agent 架构”，而是：

`它已经有一批 agent 相关能力，但核心 harness 仍然更像 prompt orchestrator，而不是现代 message-driven agent runtime。`

---

## 4. 当前 mycli 的关键不足

### 4.1 核心 loop 仍然以 prompt 为中心

当前主循环本质上是：

1. 组装系统提示与 ReAct prompt
2. 请求模型输出 JSON 结构
3. 本地解析 JSON
4. 执行工具
5. 继续循环

这和现代 agent runtime 的最大差异在于：

- 消息历史不是一等对象
- 工具定义没有以正式 provider schema 暴露给模型
- 工具结果没有标准化回注消息流
- 整个系统高度依赖模型“稳定吐 JSON”

### 4.2 Tool 系统不是 schema-first

当前工具有注册表，但缺少：

- 统一 `ToolSpec`
- 明确 `input_schema`
- 参数级校验机制
- 工具调用失败后的标准反馈语义
- provider 适配层可直接消费的工具定义

这使得工具系统仍然深度依赖 prompt 文本。

### 4.3 Approval 还不是暂停与恢复的 loop

当前审批虽然已经能做选项式确认，但本质仍偏向：

- 先中断当前流程
- 等用户做决定
- 直接执行或拒绝

真正成熟的流程应该是：

1. runtime 暂停
2. 保存待执行 tool call
3. 用户批准
4. 工具执行
5. 把工具结果重新注入 turn
6. agent 继续推理直到产出最终答复

也就是：

`approval 是 suspended execution，不是旁路控制流。`

### 4.4 Planning 不是一等状态

当前虽然有 `plan_steps` 概念，但并没有正式的：

- `TodoWrite` 或 `PlanUpdate` 能力
- plan 状态约束
- 当前进行中步骤
- 长任务的状态追踪与恢复

这意味着复杂任务里 planning 很容易退化成自然语言描述。

### 4.5 Skill 更像静态 prompt patch

当前 skill 机制缺少：

- metadata 与正文分层
- 按需加载正文
- 资源解析与引用文件装载
- 通过消息或事件注入 skill 内容的能力

因此 skill 更像“匹配到后附加一段文本”，而不是一套正式知识系统。

### 4.6 Context 管理仍然是轻量原型

当前上下文压缩更像：

- 基于字符长度的 token 粗估
- 最近消息保留
- 老消息拼摘要

这可以支撑早期版本，但无法长期承载：

- 大输出工具结果
- 长会话
- 后续 subagents
- 任务恢复

### 4.7 运行时职责边界尚不清晰

目前 `TurnService`、`ReactAgent`、CLI 入口之间存在职责重叠：

- 运行时控制
- 提示构造
- 安全决策
- 待审批动作处理
- 会话状态更新

边界不清晰会导致未来任何大能力接入都变得脆弱。

---

## 5. 改造目标与非目标

### 5.1 改造目标

本次整体改造的目标如下：

- 把 `mycli` 重构为一个 message-driven agent runtime
- 让 tool、approval、planning、skill、context 都成为一等能力
- 保留 CLI 作为主要宿主界面
- 保留 session / memory / config 等产品化资产的总体方向
- 优先服务个人 coding assistant 场景，而不是做教学 demo
- 为第二阶段的长期可用性和第三阶段的 subagent 能力打下边界清晰的基础

### 5.2 非目标

本次设计不追求以下事项在第一阶段一次到位：

- 不立即做成完整多 agent 平台
- 不一开始就引入后台长任务调度系统
- 不为了抽象而抽象到 provider/plugin 过度工程化
- 不要求兼容当前所有内部模块形态
- 不要求保留当前所有数据结构和旧 prompt 协议

---

## 6. 目标产品定位

改造后的 `mycli` 应被定义为：

`一个运行在本地终端中的个人 coding assistant，其内核是现代 agent runtime，而 CLI 只是当前最自然的交互宿主。`

这个定义有三层含义：

- 它不是教学 demo，因此需要持久化、审批、安全边界与任务连续性
- 它不是重平台化框架，因此第一阶段以单 agent runtime 为核心
- 它不是简单的命令行工具封装，而是以目标驱动、主动推进、受安全门控的 assistant

---

## 7. 目标架构

### 7.1 总体架构原则

新的 `mycli` 应从“围绕大 prompt 拼接能力”转向“围绕 runtime 事件流组织能力”。

核心原则如下：

- CLI 只负责交互承载，不负责业务决策
- runtime 负责单轮执行生命周期
- model adapter 负责 provider 差异
- tool system 负责结构化能力定义与执行
- approval service 负责风险决策状态机
- planning service 负责外化任务状态
- skill runtime 负责知识装载
- context manager 负责 token 预算与历史压缩

### 7.2 建议的核心组件

建议把核心能力重组为以下组件。

#### 1. `cli/`

负责：

- REPL 循环
- slash command
- 事件渲染
- 待审批输入接收

不负责：

- 提示拼装
- agent 决策
- 工具执行策略

#### 2. `application/runtime/`

负责：

- 驱动 turn lifecycle
- 管理消息流
- 调度模型、工具、审批、planning、skills、context
- 管理暂停与恢复

这是新的内核中心。

#### 3. `domain/runtime/`

定义：

- `TurnState`
- `RuntimeEvent`
- `ExecutionCheckpoint`
- `PlanState`
- `PendingApproval`
- `ToolSpec`
- `ToolInvocation`
- `ToolExecutionResult`

领域层只定义契约，不直接依赖 provider 或 filesystem 细节。

#### 4. `infrastructure/models/`

实现模型适配器，统一对上暴露相同接口。

建议至少支持两类实现：

- `NativeToolModelAdapter`
- `CompatChatModelAdapter`

#### 5. `tools/`

每个工具都应由两部分组成：

- `ToolSpec`
- `ToolExecutor`

并带有风险声明、schema 定义和统一错误语义。

#### 6. `services/approval/`

把风险审批升级成正式状态机：

- `requested`
- `pending_user_choice`
- `approved`
- `rejected`
- `resumed`

#### 7. `services/planning/`

把 todo/plan 作为正式状态处理，并执行约束校验。

#### 8. `services/skills/`

Skill 系统至少拆分为：

- metadata index
- content loader
- resource resolver

#### 9. `services/context/`

负责：

- transcript 存储
- recent window
- rolling summary
- tool output trimming
- token budget strategy

### 7.3 事件驱动的数据流

建议一轮用户回合的数据流如下：

1. `CLI` 接收用户输入
2. `Runtime` 读取会话状态、plan 状态、memory 和上下文摘要
3. `ContextManager` 组装本轮消息与预算
4. `ModelAdapter` 调用模型
5. 模型返回以下之一：
   - assistant text
   - tool invocation
   - plan update
   - skill load request
6. 如果是 tool invocation：
   - 交给 `ApprovalService` 判断
   - 若自动允许则执行工具
   - 若需审批则挂起 turn，等待用户选择
7. 工具结果写回 transcript，再继续进入下一轮模型推理
8. 直到产生最终回答
9. 更新会话、memory、摘要与 plan 状态

核心语义应变成：

`user message -> runtime events -> model/tool/approval -> resumed events -> final answer`

而不是：

`user message -> prompt -> json -> parse -> maybe tool`

---

## 8. 与当前代码的保留与重写边界

### 8.1 建议保留的资产

以下资产方向上正确，建议保留并重构接口：

- `src/mycli/cli/main.py` 所承载的 CLI 宿主形态
- `services/config_service.py` 的配置读取职责
- `services/session_service.py` 的会话持久化方向
- `services/memory_service.py` 的本地记忆方向
- 现有五个基础工具所代表的能力语义
- `services/safety_policy.py` 中的风险分类与 session allowlist 思路

### 8.2 建议重写的核心内核

以下部分不适合作为未来内核继续叠加能力，应视为重构重点：

- `application/turn_service.py`
- `agents/react_loop.py`
- `infrastructure/openai_client.py`
- `prompts/react.py` 中承担 runtime 协议的部分
- `services/skill_registry.py`
- `services/context_window_service.py`

### 8.3 中兼容的具体含义

“中兼容”在本设计中的含义是：

- CLI 命令入口尽量保持连续
- 用户级配置和会话概念保留
- 旧数据文件可在必要时提供迁移或降级读取
- 但 runtime 协议、内部模型接口、工具契约和上下文机制允许重写

---

## 9. 推荐的目录重组方案

在现有 `src/` 结构下，建议逐步重组为更清晰的分层：

```text
src/
  mycli/
    cli/
      main.py
      repl.py
      renderers.py
      commands.py
    application/
      runtime/
        agent_runtime.py
        turn_orchestrator.py
        event_stream.py
      use_cases/
        handle_user_turn.py
        resolve_pending_approval.py
    domain/
      runtime/
        events.py
        turn_state.py
        approvals.py
        planning.py
      tools.py
      conversation.py
      memory.py
      skills.py
    services/
      approval/
        approval_service.py
      planning/
        planning_service.py
      context/
        context_manager.py
      skills/
        skill_index.py
        skill_loader.py
      memory/
        memory_service.py
      sessions/
        session_service.py
      config/
        config_service.py
    tools/
      base.py
      registry.py
      list_directory.py
      read_file.py
      search_text.py
      edit_file.py
      run_shell.py
      plan_update.py
      load_skill.py
    infrastructure/
      models/
        base.py
        native_tool_adapter.py
        compat_chat_adapter.py
      filesystem/
      shell/
      persistence/
    prompts/
      system/
      compat/
```

这不是要求一次性搬完，而是建议明确未来依赖方向：

- `domain` 不依赖 `infrastructure`
- `application` 依赖 `domain`
- `infrastructure` 实现上层接口
- `cli` 只依赖 application 层

---

## 10. 分阶段改造方案

### 10.1 第一阶段：重建核心 harness

第一阶段目标是把 `mycli` 变成一个正确的单 agent runtime。

必须落地的内容：

#### A. 重建统一 runtime

新增统一的 `AgentRuntime` 或同等核心对象，负责：

- turn 生命周期
- 模型调用
- 工具执行
- 审批挂起与恢复
- 事件流输出

#### B. 重建 schema-first tool system

为所有工具建立正式契约：

- name
- description
- input schema
- risk profile
- executor
- normalized result

#### C. 引入双通道模型适配

统一模型接口，并提供：

- 原生 tool calling 模式
- 兼容 chat/fallback 模式

要求上层 runtime 不依赖具体 provider 的细节。

#### D. 把 approval 做成暂停恢复机制

审批一旦发生，需要保存：

- 待执行调用
- 当时的 turn state
- 上下文检查点

批准后继续执行，而不是只返回一条工具结果文本。

#### E. 引入显式 planning

最少支持：

- `pending`
- `in_progress`
- `completed`

并保证任一时刻最多一个 `in_progress`。

#### F. 替换 ContextWindowService

实现 `ContextManager v2`，至少支持：

- recent window
- rolling summary
- tool output trimming
- token budget 分配
- transcript 分层持久化

### 10.2 第二阶段：补齐个人 assistant 能力

在内核稳定后，再补齐更完整的产品能力：

#### A. Skill runtime v2

- 常驻 metadata
- 正文按需加载
- references/scripts/assets 解析
- skill 通过事件装载，而不是 prompt 拼接

#### B. 更成熟的 memory 检索

- 区分 preference / project / session summary
- 让 memory 检索更可控
- 明确写入与读取策略

#### C. 任务与恢复能力

- 引入任务对象
- 支持跨轮继续
- 支持从挂起状态恢复

#### D. 更清晰的控制面

把真正对用户有价值的运行时状态，以 slash command 暴露出来。

### 10.3 第三阶段：高级 agent 能力

这一阶段再引入：

- subagent
- background tasks
- team-style coordination

这些能力非常重要，但不应阻塞第一阶段。

---

## 11. 第一阶段的验收标准

若第一阶段改造完成，应达到以下标准：

- 主循环不再依赖模型输出固定 JSON 协议
- 工具以正式 schema 定义对模型暴露
- 工具结果会被重新写回消息流并驱动下一轮推理
- 高风险操作可挂起并恢复，而不是只做旁路确认
- 复杂任务中 plan 是正式状态，可被更新和校验
- 长会话中的上下文管理不再依赖简单字符截断
- CLI 仍然保持简洁可用
- 单元测试和集成测试可以在不依赖真实 provider 的情况下验证 runtime 行为

---

## 12. 测试与质量策略

改造过程中必须同步重建测试策略，而不是把测试留到后期补。

### 12.1 单元测试重点

- runtime 事件流
- tool schema 与参数校验
- approval 状态机
- planning 约束
- context manager 的预算与裁剪逻辑
- skill metadata / content load 路径

### 12.2 集成测试重点

- CLI 输入到最终输出的主链
- 需要审批的挂起与恢复流程
- 多轮工具调用流程
- 长会话摘要与恢复
- fallback model adapter 的降级行为

### 12.3 设计要求

- 运行时主链应可用 fake model adapter 驱动
- 工具执行应可在测试中替换为假实现
- skill、memory、session 存储应基于可注入路径，避免依赖真实用户目录

---

## 13. 主要风险与应对

### 13.1 风险：一次性重构范围过大

应对：

- 明确按阶段落地
- 第一阶段只围绕单 agent runtime
- 高级能力先保留接口，不着急实现

### 13.2 风险：抽象过度，导致实现速度下降

应对：

- 只为当前阶段需要的能力建模
- provider 抽象保持双通道，不做无限泛化
- 目录重组逐步推进，不强行一步到位

### 13.3 风险：上下文与审批状态迁移复杂

应对：

- 新旧会话状态允许短期并存
- 必要时提供迁移器或兼容读取层
- 优先保证新 runtime 的正确性，而不是死保旧格式

### 13.4 风险：Skill 和 memory 容易继续退化成 prompt 材料

应对：

- 明确 skill 与 memory 都通过 runtime 事件进入上下文
- 避免在 prompt builder 中无限堆文本
- 把知识加载与提示构造分离

---

## 14. 关键设计决策摘要

这次改造的关键设计决策可以压缩成以下几条：

- `mycli` 继续做个人 coding assistant，不转向纯教学 demo 或大平台
- 兼容策略选中兼容，允许重写内核
- 核心 loop 从 prompt-driven 改为 message-driven
- tool system 采用 schema-first 设计
- approval 升级为暂停恢复执行机制
- planning 升级为正式状态
- skill 升级为按需知识加载系统
- context 管理升级为独立子系统
- subagent 留到第三阶段，不阻塞第一阶段

---

## 15. 建议的实施顺序

若进入实现规划，建议按以下顺序拆解：

1. 建立新的 runtime 契约与 event model
2. 建立新的 tool contract 与 registry
3. 接入双通道 model adapter
4. 重建 approval pause/resume
5. 接入 planning state
6. 替换 context manager
7. 迁移 CLI 到新 runtime
8. 迁移 skill 与 memory 接入方式
9. 补齐测试
10. 再规划第二阶段工作

---

## 16. 结论

`mycli` 当前最大的问题，不是功能点缺失，而是核心 runtime 还没有完全按现代 agent 的方式搭建。

真正需要改造的不是某个工具、某个 prompt，甚至也不只是审批 UI，而是整个 agent harness 的中心抽象：从“模型吐 JSON 的提示驱动器”，升级为“消息、工具、状态、事件共同驱动的 agent runtime”。

一旦这个内核被重建，`mycli` 才能稳定承载你真正想要的东西：

- 一个能长期协作的个人 coding assistant
- 一个能逐步长出 planning、skills、subagent 和任务系统的 agent
- 一个即使仓库还处于早期，也能按企业级代码库标准继续演进的项目
