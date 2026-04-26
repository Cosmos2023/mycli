# mycli V1 设计文档

日期：2026-04-04  
状态：已完成设计确认，待进入实现规划

## 1. 产品定义

`mycli` V1 不是“一个带 agent 能力的 CLI 工具”，而是：

`一个基于 ReAct runtime 的主动侦察型 personal coding agent，CLI 只是它当前的本地交互宿主。`

用户向它给出的应该是目标、问题或任务意图，而不是一连串手工拆开的操作指令。Agent 接收到目标后，默认会在安全边界内主动组合 `tools`、`memory`、`skills` 和 `planning` 来收集信息、理解环境、推进任务，并在合适的时机给出结果、阶段性结论，或请求用户确认。

第一版聚焦单用户、单 agent、本地终端工作流，开发语言为 Python 3.13，包管理工具为 `uv`。

## 2. 产品目标

V1 的目标是做出一个“真的像 agent”的最小闭环，而不是一个会聊天的命令包装器。

用户应当能够：

1. 在终端中像与工程搭档对话一样提出目标。
2. 让 agent 主动侦察项目，而不是手动逐步指挥它读什么、搜什么。
3. 让 agent 自主决定何时调用 tools、何时读取 memory、何时套用 skill、何时形成短计划。
4. 在低风险范围内让 agent 自动推进任务。
5. 在高风险、不可逆或边界不清晰的动作前，由 agent 停下来说明原因并请求确认。
6. 跨会话保留用户偏好与项目级记忆，让 agent 具备持续协作能力。

## 3. 核心理念

V1 采用以下核心理念：

- 用户给的是目标，不是每一步操作说明。
- agent 默认主动推进，而不是被动等待指令拆解。
- `tools`、`memory`、`skills` 和 `planning` 都是 agent 的内建能力，而不是外挂模块。
- CLI 只负责承载 agent，不负责定义 agent。
- 安全边界始终存在，主动推进不等于无限自治。

## 4. 非目标

V1 不追求以下内容：

- 多 agent 协作
- 云端服务或远程同步
- Web UI 或 GUI
- 向量数据库、embedding 检索或复杂知识库
- 长时间无人监管的高自治执行链
- 多模型提供方
- 庞大的插件市场或复杂扩展生态

## 5. 运行时模型

### 5.1 ReAct 作为核心执行模型

V1 的核心不是“外层编排器按需调用工具”，而是一个默认主动运作的 ReAct agent runtime。

当用户输入一个目标后，agent 进入内部循环：

1. `Reason`
   理解用户目标，判断当前信息是否足够，推断下一步最有价值的动作。
2. `Act`
   主动调用工具、检索记忆、套用合适 skill，或生成短期计划来组织接下来的动作。
3. `Observe`
   读取工具结果、memory 命中内容、文件内容和环境反馈，更新当前判断。
4. 重复上述过程，直到：
   - 已经足够回答用户
   - 当前任务已完成
   - 需要请求用户确认
   - 达到循环步数或成本上限

主链可以表述为：

`User Goal -> ReAct Agent Loop -> Answer / Approval Request / Task Result`

### 5.2 默认行为

第一版的默认行为是“主动侦察”，而不是“协作副驾”或“高度自治代理”。

这意味着当用户说：

- “帮我看看这个项目怎么开始”
- “这个仓库里的配置系统是怎么组织的”
- “把这个模块整理一下，但不要做危险操作”

agent 默认应当先自己判断需要看什么、搜什么、记住什么、是否要套 skill，然后主动推进，而不是先把一串细碎问题甩回给用户。

## 6. 核心能力模型

在 V1 中，`tools`、`memory`、`skills` 和 `planning` 都不是彼此孤立的附加系统，而是 ReAct agent runtime 的内在能力层。

### 6.1 Tools

`tools` 是 agent 与外部环境交互的行动能力。

当 agent 判断信息不足时，应优先通过 tools 获取事实，而不是直接猜测。Tools 负责让 agent 能够：

- 读取文件
- 搜索文本
- 枚举目录
- 修改文件
- 执行受控的本地 shell 命令
- 生成或查看 diff

它们是 agent 的“行动器官”。

### 6.2 Memory

`memory` 是 agent 的持续上下文系统。

它不是用户手动查询的资料库，而是 agent 在推理前和推理中按需主动检索的长期背景。它帮助 agent 记住：

- 用户偏好
- 项目约定
- 重要模块摘要
- 已确认过的设计决定
- 近期会话的压缩上下文

它是 agent 的“长期上下文”。

### 6.3 Skills

`skills` 是 agent 面向特定任务类型的行为协议。

它们不是只有在用户显式点名时才起作用的模板，而是 agent 在识别出任务模式后可主动套用的策略层。例如：

- 代码评审
- 调试排查
- 需求澄清
- 设计文档整理
- 仓库分析总结

它们帮助 agent 改变提问方式、行动顺序、输出结构和安全边界。

### 6.4 Planning

`planning` 是 agent 的内部任务组织能力。

它不应总是被设计成一个外露的、先于一切的独立阶段，而应作为 ReAct 循环中的内建能力自然浮现：

- 简单任务时，agent 可能不显式展示计划
- 中等复杂任务时，agent 可能形成一个内部短计划后执行
- 高风险或多步骤任务时，agent 可能把短计划部分展示给用户，用于解释当前动作和确认理由

`planning` 的职责是组织多步推进，而不是强迫每轮都走复杂流程。

## 7. 用户体验与 CLI 角色

### 7.1 CLI 的定位

CLI 不是产品本体，而是当前阶段最合适的宿主界面。

它的价值在于天然贴近：

- 本地代码仓库
- 文件系统
- shell 环境
- 开发者的工作流

但用户真正面对的是一个 agent，而不是一套命令集合。

### 7.2 主要交互方式

主入口：

```bash
uv run mycli
```

进入后，用户应通过自然语言给出目标，例如：

- “帮我看看这个项目从哪里开始读。”
- “搜索一下配置加载逻辑，并总结风险。”
- “给这个项目起草一个 README。”
- “帮我继续上次关于 skill 系统的设计。”

第一版应强调自然语言目标输入，而不是复杂命令语法。

### 7.3 过程展示风格

第一版采用“简洁展示”的执行反馈方式。

这意味着 agent 的行动过程应当对用户可感知，但不过度暴露内部推理文本。用户看到的应该是：

- 正在检查什么
- 执行了哪些关键动作
- 发现了什么
- 为什么现在需要确认，或者为什么已经足够回答

例如：

- 正在检查仓库结构
- 已读取 2 个可能的入口文件
- 找到 1 份相关项目记忆
- 接下来我会先比对配置初始化路径

第一版不默认展示完整 chain-of-thought，也不应把终端变成工具日志流。

### 7.4 Slash Commands 的角色

Slash commands 依然存在，但它们属于控制面，不是主交互路径。

第一版建议支持：

- `/help`
- `/skill`
- `/skills`
- `/memory`
- `/plan`
- `/tools`
- `/session`
- `/confirm`
- `/quit`

这些命令主要用于：

- 查看或管理 memory
- 查看可用 skills
- 查看 agent 当前状态
- 控制会话与确认流
- 调试与辅助观察

## 8. 安全模型

### 8.1 总体原则

第一版不是高自治 agent，而是一个：

`Goal-driven, ReAct-driven, safety-gated`

的 personal agent。

也就是说：

- `Goal-driven`
  用户给出目标，而不是逐步操作指令。
- `ReAct-driven`
  agent 自主组织侦察、行动、观察与内部规划。
- `Safety-gated`
  agent 的每一步行动都受安全边界约束。

### 8.2 Safety Gate

agent 在内部决定某个 `Act` 动作后，不应立刻无条件执行，而必须先经过 safety gate。

V1 将动作分为三类：

- `low`
  读文件、搜文本、列目录、读取本地 memory 等低风险信息收集动作
- `medium`
  边界明确、可解释、可预览的小范围修改动作
- `high`
  删除文件、批量改写、目录越界、危险 shell、不可逆或影响不清晰的动作

默认行为：

- `low`：自动执行
- `medium`：在 half-auto 模式下，如果范围窄且可预览，则自动执行；否则先确认
- `high`：必须先确认

### 8.3 边界约束

V1 必须保持以下安全边界：

- 只在本地工作区内活动
- 只使用受控的工具集合
- ReAct 循环必须有步数和成本上限
- 对高风险动作必须暂停并请求确认
- 默认优先执行可解释、可回退的动作

这保证 agent 虽然主动，但不会失控。

## 9. Memory 设计

V1 的 memory 追求结构化、本地化、透明化。

### 9.1 Memory 类型

- `preference`
  用户偏好，例如回复风格、审批倾向、常用开发习惯
- `project_note`
  项目级长期笔记，例如架构摘要、模块职责、项目约定
- `session_summary`
  最近会话的压缩摘要，用于跨 turn 连续性，而不是完整历史归档

### 9.2 Memory 的工作方式

memory 不是被动仓库，而是 agent 会主动使用的背景系统：

- 在进入 ReAct 循环前，agent 可先检索相关记忆
- 在推理过程中，agent 也可再次检索补充上下文
- 在任务结束后，agent 可判断是否值得沉淀新的长期记忆

### 9.3 存储策略

用户级全局 memory：

```text
~/.mycli/
  preferences.json
  skills/
  sessions/
```

项目级 memory：

```text
.mycli/
  project_memory.json
```

这样可以把个人偏好保存在用户范围内，把项目记忆保存在仓库范围内。

### 9.4 检索策略

V1 不引入 embedding 或向量数据库。

检索依据包括：

- 记录类型
- 标签
- 工作区标识
- 关键词匹配
- 简单时间优先排序

## 10. Skills 设计

V1 的 skill 为提示词型 skill，以 Markdown 文件表示。

每个 skill 至少包含：

- 名称
- 描述
- 触发提示
- 行为规则
- 输出要求
- 禁止事项或边界约束

### 10.1 使用方式

skill 有两种进入路径：

1. 显式调用  
   例如：`/skill code-review`
2. 隐式调用  
   agent 在识别出任务类型后主动启用相应 skill

这意味着 skill 在 V1 中不只是“用户点选模板”，更是 agent 用来塑造执行行为的协议。

### 10.2 存储位置

V1 使用两个 skill 来源：

- 应用内置 skill
- `~/.mycli/skills/` 下的用户本地 skill

同名时，用户本地 skill 覆盖内置 skill。

## 11. Tools 设计

V1 提供范围收敛但足够支撑 agent 感的工具集合：

- 文件读取
- 文本搜索
- 目录枚举
- 文件修改
- shell 执行
- diff 预览

### 11.1 工具契约

每个工具都应接受类型化输入，并返回统一的结构化结果。

建议 `ToolResult` 至少包含：

- `success`
- `summary`
- `artifacts`
- `raw_payload`
- `error`

agent runtime 其余部分应尽量依赖结构化结果，而不是耦合原始 stdout/stderr 文本。

### 11.2 工具在 ReAct 中的地位

tool call 不应被设计成“外部流程偶尔触发的附加能力”，而是 agent 在 `Act` 阶段的自然动作。

也就是说，当 agent 判断当前缺乏事实依据时，应默认优先调用工具收集事实，而不是直接生成结论。

## 12. Planning 设计

V1 的 planning 是 agent 的内建组织能力，而不是一个总在最外层显式出现的重量级模块。

它主要负责：

- 识别任务是否需要多步推进
- 在内部组织短期行动顺序
- 在必要时向用户展示简短计划
- 在高风险动作前解释为什么下一步需要确认

建议 V1 的短计划保持在 2 到 4 步，强调“帮助推进和解释”，而不是构建复杂任务图。

## 13. 组件边界

### 13.1 `cli/`

负责：

- REPL 入口
- 命令解析
- 会话生命周期
- 简洁执行反馈展示
- 确认交互

不负责业务规则与 runtime 决策。

### 13.2 `application/`

负责：

- 单次 turn 的应用层编排
- 会话 use case
- 调用 runtime 和相关服务

### 13.3 `domain/`

负责定义稳定核心模型，例如：

- `Message`
- `Conversation`
- `ExecutionContext`
- `ToolCall`
- `ToolResult`
- `MemoryRecord`
- `Plan`
- `PendingApproval`
- `RiskLevel`

### 13.4 `agents/`

负责真正的 ReAct agent runtime，包括：

- ReAct loop
- 当前步决策
- skill 应用
- memory 检索触发
- tool call 触发
- 回复生成编排

### 13.5 `services/`

负责：

- memory service
- skill registry
- safety policy
- session service
- 配置解析

### 13.6 `tools/`

负责定义与实现受控工具接口。

### 13.7 `infrastructure/`

负责：

- OpenAI 兼容模型适配
- 本地文件系统适配
- 本地 shell 适配
- 本地持久化

### 13.8 `prompts/`

负责：

- 系统指令
- ReAct agent prompt 组装
- skill 注入模板
- memory 展开模板
- 回复风格约束

## 14. 模型接入与配置

V1 只接入一个 OpenAI 兼容 provider，但必须保留明确适配边界，避免以后扩展时重写 runtime。

配置优先级：

1. CLI flags
2. 环境变量
3. 项目配置
4. 用户配置
5. 内置默认值

配置位置：

- 用户配置：`~/.config/mycli/config.toml`
- 项目配置：`.mycli/config.toml`

## 15. 仓库结构

建议初始结构如下：

```text
src/
  mycli/
    __init__.py
    cli/
    application/
    domain/
    agents/
    tools/
    services/
    infrastructure/
    prompts/
    utils/
tests/
  unit/
  integration/
docs/
  superpowers/
    specs/
```

这套结构的目的，是让“agent runtime 是中心”这一点在工程上也能被体现出来。

## 16. 测试策略

V1 至少需要覆盖以下层次：

### 16.1 单元测试

- safety policy 风险分类
- memory 检索与写入规则
- skill 解析与匹配
- ReAct 步进决策
- 配置解析

### 16.2 集成测试

- 单次 turn 的 ReAct 执行链
- 工具辅助回答
- memory 参与上下文后的回答
- 需要确认的动作流程
- 跨 turn 的 session 连续性

### 16.3 工具边界测试

- 路径限制
- 编辑预览
- shell 校验
- 结构化工具结果

系统必须能够在不依赖真实模型调用的情况下测试，模型层需要可替换、可 stub。

## 17. 成功标准

当用户能明显感受到“这是一个会主动工作的 agent”时，V1 才算成功。

更具体地说，用户应能：

1. 在 CLI 中直接给出目标，而不是拆解操作步骤。
2. 看到 agent 主动读文件、搜索、整理信息并推进任务。
3. 感受到 `tools`、`memory`、`skills` 和 `planning` 被自然地组合使用。
4. 在低风险范围内让 agent 自动执行动作。
5. 在高风险动作前得到清晰的确认请求。
6. 跨会话复用偏好和项目记忆。
7. 获得简洁而可信的行动反馈与最终回答。

## 18. 技术基线

第一版采用：

- Python `3.13`
- `uv`
- `pytest`
- `ruff`
- `mypy`

在依赖选择上，优先标准库与清晰边界，不为了短期便利引入过重依赖。

## 19. 本文固定的关键决策

本设计明确固定以下内容：

- 产品本体是 ReAct personal agent，不是 CLI 工具本身
- 默认行为是主动侦察和主动推进
- CLI 是宿主，不是中心
- `tools`、`memory`、`skills` 和 `planning` 都是 agent 的内建能力
- 它们在运行时由 agent 按需自主组合
- 执行模型是 `Reason -> Act -> Observe`
- 展示策略采用“简洁展示”
- 安全模型采用 half-auto + safety gate
- V1 仅支持单 agent、单 provider、本地终端工作流

## 20. 最终定义

`mycli` V1 是一个基于 Python 3.13 与 `uv` 的、以 ReAct runtime 为核心的主动侦察型 personal coding agent。用户通过 CLI 给出目标后，agent 会在安全边界内主动组合 `tools`、`memory`、`skills` 与 `planning` 来收集信息、理解环境并推进任务；CLI 只是当前的本地交互宿主，而不是产品本体。
