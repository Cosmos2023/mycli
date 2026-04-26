# mycli 对照 learn-claude-code 的改造方案

**日期：** 2026-04-05

**目标：** 参考 `shareAI-lab/learn-claude-code` 的极简 agent 设计思想，重新审视当前 `mycli` 的架构，明确哪些部分已经具备、哪些部分偏离了现代 agent 的核心模式，并给出一套分阶段、可落地的整体改造路线。

---

## 1. 参考仓库的核心结论

基于 `shareAI-lab/learn-claude-code` 的 README、`v1_basic_agent.py`、`v2_todo_agent.py`、`v3_subagent.py`、`v4_skills_agent.py`，以及中文 README 中对 `v5+` 的机制说明，可以把它的关键思想压缩成以下几条。

### 1.1 模型才是 agent，本体只是一个 loop

最核心的模式并不复杂：

```python
while True:
    response = model(messages, tools)
    if response.stop_reason != "tool_use":
        return response.text
    results = execute(response.tool_calls)
    messages.append(results)
```

这背后的重点不是“循环”本身，而是：

- 模型根据完整上下文和工具定义自主决定下一步
- 工具调用结果会重新回到消息历史，成为下一轮推理输入
- agent 的本质不是“先写死流程”，而是“给模型可行动的能力，再让模型在循环中决策”

### 1.2 工具必须是结构化能力，不是模糊提示

`learn-claude-code` 的 `v1` 版本虽然极简，但工具层有一个很重要的工程约束：

- 每个工具都有明确的 `name`
- 每个工具都有清晰的 `description`
- 每个工具都有机器可读的 `input_schema`
- 工具参数由模型按 schema 生成，而不是靠模糊自然语言猜

这意味着工具不是“prompt 里的一段文字说明”，而是 agent runtime 的正式接口。

### 1.3 显式计划不是装饰，而是复杂任务的稳定器

`v2` 引入 `TodoWrite` 的核心思想不是“多一个功能”，而是：

- 把模型脑内的隐式计划外显
- 强制任务状态结构化
- 用约束提升稳定性

参考仓库强调了几个关键约束：

- Todo 数量有限
- 同一时间只能有一个 `in_progress`
- 每个条目必须有完整字段

这类约束不是限制模型，而是帮助模型在长任务中保持聚焦。

### 1.4 子代理的真正价值是上下文隔离

`v3` 的重点不是“并发炫技”，而是：

- 把探索、规划、实现等子任务放到独立上下文里执行
- 主上下文只保留子任务产出的压缩结果
- 不同 agent type 使用不同工具集和系统提示

核心收益：

- 主循环上下文更干净
- 大量探索性读取不会污染主任务上下文
- 工具权限可以天然按 agent type 收缩

### 1.5 Skill 的本质是外部化知识，而不是硬编码逻辑

`v4` 的思想可以概括成一句话：

- Tool 是“能做什么”
- Skill 是“知道怎么做”

`learn-claude-code` 里 skill 的重要点：

- skill 元数据常驻
- skill 正文按需加载
- 资源文件按需进一步加载
- skill 内容应尽量通过消息或工具结果注入，而不是频繁改 system prompt，以保住缓存前缀

这意味着 skill 应该是 agent 的一等公民，但仍然是按需进入上下文，而不是每轮强塞全部知识。

### 1.6 上下文管理不是简单截断，而是一个专门子系统

虽然当前参考仓库首页主线展示到 `v4`，但中文 README 已经把 `v5+` 的演进线讲得很清楚：

- 压缩不是“消息太长就裁掉”
- 需要单独的 `ContextManager`
- 需要大输出处理、摘要、转存、历史持久化
- 压缩应围绕 token 预算和结构化保留策略展开

这说明成熟 agent 的上下文管理是 runtime 的核心子系统，不是一个小工具函数。

### 1.7 复杂性应按阶段渐进引入

`learn-claude-code` 最大的工程启发不只是功能点，而是“能力增长顺序”：

1. Agent loop
2. Core tools
3. Explicit planning
4. Subagents
5. Skills
6. Compression
7. Tasks / Background / Team

这条路径强调：

- 不要一开始就做很复杂的 orchestration
- 先把 agent loop 做对
- 再让 planning / subagent / skills / compression 逐步成为原生能力

---

## 2. 当前 mycli 的现状总结

当前 `mycli` 已经具备一个可运行的 CLI agent 骨架，完成度已经明显超过“项目初始化”阶段。

### 2.1 当前已经具备的能力

- CLI REPL 和基本 slash command
- ReAct 风格单 agent loop
- 基础工具：`list_directory`、`read_file`、`search_text`、`edit_file`、`run_shell`
- session 持久化
- 偏好 / 项目记忆 / session summary
- skill 文件注册与基础匹配
- 审批流和风险分类
- 简单的上下文窗口与压缩摘要

### 2.2 当前做对了的部分

从方向上看，`mycli` 有几个设计已经是对的：

- 工具、skill、memory、approval 都被建模成独立模块
- session 和 memory 已经持久化，不是全内存 demo
- 已经开始把 context window 视为一个独立问题
- 高风险动作引入了显式确认，而不是完全自动执行

也就是说，`mycli` 不是“没有 agent 架构”，而是“agent 架构已经起步，但核心 loop 还不够正宗”。

---

## 3. 当前 mycli 的关键不足

如果用 `learn-claude-code` 的标准回看，`mycli` 当前最大的不足，不在“有没有某个功能”，而在“核心 agent harness 还没有完全按 agent 的方式搭起来”。

### 3.1 当前不是标准的 messages + tools 循环

这是最大差异。

当前 `mycli` 的 loop 本质上是：

- 自己拼一个大 prompt
- 要求模型返回一段 JSON
- 从 JSON 中解析 `tool_name`、`arguments`、`assistant_message`

这会带来几个问题：

- 工具 schema 没有正式暴露给模型
- 参数质量非常依赖 prompt 表达
- 工具结果没有作为标准消息历史参与下一轮推理
- 很多错误其实来自“模型猜格式”，而不是“模型不会解题”

这和参考仓库的“模型直接面对工具定义并在 tool_use 循环中行动”差异很大。

### 3.2 工具是注册表，但不是 schema-first 的能力系统

当前工具层有 `ToolRegistry`，但缺少这些关键能力：

- 每个工具的结构化输入 schema
- 参数校验器
- 统一的工具说明渲染
- 工具调用错误到模型循环的标准反馈机制

后果是：

- 模型容易生成错误参数
- 审批前后都需要补很多兜底
- 工具层和 prompt 层耦合太强

### 3.3 审批流还不是“暂停并恢复 loop”

目前审批流已经比之前稳定很多，但仍然不是理想形态。

当前审批流是：

- agent 先返回 `pending_approval`
- 用户 `/confirm`
- 系统执行工具
- 直接把结果作为一条最终响应返回

但成熟 agent 的理想流程应该是：

1. loop 暂停
2. 保存待执行 tool call
3. 用户批准
4. 执行工具
5. 把工具结果重新送回 loop
6. agent 基于真实结果继续推理并给出最终回答

也就是说，审批不是“提前结束 agent”，而是“暂停后恢复 agent”。

### 3.4 planning 还不是一等公民

当前 `TurnResponse` 里虽然有 `plan_steps` 字段，但整个系统里并没有真正的：

- `TodoWrite` / `PlanUpdate` 工具
- 显式任务约束
- 当前进行中步骤
- 长任务状态追踪

这意味着 `mycli` 虽然“支持计划这个概念”，但还没有让 planning 成为 agent runtime 的原生机制。

### 3.5 skill 目前更像静态 prompt 附加，而不是按需知识加载

当前 skill 机制具备：

- 加载 skill 文件
- 根据 trigger hints 选择 skill

但还缺：

- skill 元数据和正文分层加载
- skill 作为显式工具调用或显式知识加载动作
- skill 资源目录（scripts / references / assets）
- skill 内容通过 tool result 注入上下文

这意味着当前 skill 更像“轻量 prompt patch”，而不是成熟 agent 的外部知识系统。

### 3.6 上下文压缩还很初级

当前 `ContextWindowService` 已经是一个好开端，但和参考仓库后续的方向相比，还缺：

- 更真实的 token 预算模型
- tool result 大输出处理
- transcript 持久化与分层压缩
- summary 的滚动更新，而不是每次现算
- 不同类型消息的差异化保留策略

当前方案更像“窗口裁剪 + 文字摘要”，不是完整的 context manager。

### 3.7 缺少子代理与上下文隔离机制

目前 `mycli` 是单 agent runtime。

缺失带来的直接后果是：

- 仓库探索和实现共用一个上下文
- 复杂任务容易把主上下文污染掉
- 没法给探索型子任务更小权限
- 没法把 planning / explore / code 明确分型

### 3.8 任务系统和后台机制尚未出现

当前项目还没有：

- 持久化任务板
- 后台任务
- 通知总线
- 多 agent 协同

这不是当前必须立刻做的，但如果目标是靠近 Claude Code / Codex 风格 agent，后续一定会进入这部分。

---

## 4. mycli 的整体改造原则

基于上述对比，我建议 `mycli` 的改造遵循以下原则。

### 4.1 不推倒重来，按 agent 内核逐层替换

当前代码已经有不少可复用资产：

- CLI
- 工具实现
- 持久化服务
- 安全策略
- 基础测试

所以不建议重写项目，而建议：

- 保留工具实现层和持久化层
- 替换 agent harness
- 再逐步把 planning / skills / compression / subagent 提升为一等公民

### 4.2 先修“loop 形态”，再补“能力数量”

最重要的不是立刻增加更多工具，而是先把下面几件事做对：

- 标准 tool schema
- 真正的 messages + tool_result 循环
- 审批后的 loop 恢复
- planning / skill / compression 的接入点

如果 loop 形态不对，继续加功能只会把系统复杂度越堆越高。

### 4.3 把 planning / skills / context 视为 runtime 原生模块

不是“业务功能”，而是 agent runtime 的组成部分：

- planning 负责稳定长任务
- skills 负责外部知识
- context manager 负责上下文经济学

这三者都不应该只是 prompt 小补丁。

### 4.4 先做到单 agent 强，再进入 subagent

我不建议立刻上多 agent 或后台执行。

更稳的演进顺序是：

1. 把单 agent harness 做正
2. 把计划、skill、压缩做实
3. 再加 subagent 作为上下文隔离手段
4. 最后再考虑 tasks / background / team

---

## 5. 建议的整体改造路线

下面是我建议的 `mycli` 改造阶段划分。

## Phase 1：重建 agent harness

**目标：** 让 `mycli` 从“JSON 驱动的伪工具循环”升级为“schema-first 的真正 agent loop”。

### 改造内容

- 为每个工具引入正式 schema
- 为工具加入统一参数校验
- 构建标准 `messages + tools + tool_result` 循环
- 让模型直接基于工具定义做决策，而不是手写 JSON
- 统一工具错误回传格式

### 结果

- 工具调用质量显著提升
- `run_shell` 之类的参数问题大幅减少
- prompt 更短、更稳
- 审批流、planning、skills 都有统一接入点

### 优先级

这是当前最高优先级。

---

## Phase 2：把审批流改成“暂停并恢复”

**目标：** 审批不再提前终结 agent，而是把 agent loop 从高风险动作处暂停，并在批准后恢复。

### 改造内容

- `PendingApproval` 保存完整的待执行 tool call
- `/confirm` 后执行工具并把 tool result 重新送回 loop
- `/reject` 后让 loop 接收到拒绝结果
- 审批消息里展示更清晰的 tool preview
- 对高风险动作引入更细粒度的风险分类

### 结果

- 用户确认之后，agent 能根据真实工具结果继续回答
- 交互体验更接近 Claude Code / Codex

### 优先级

和 Phase 1 紧密相连，建议连续完成。

---

## Phase 3：引入显式 planning

**目标：** 把 planning 从“隐式文本”升级成“可见、可验证、可约束”的 runtime 能力。

### 改造内容

- 增加 `TodoWrite` 或等价的计划工具
- 增加 TodoManager / PlanManager
- 强制一条任务只能有一个 `in_progress`
- 在 prompt 中加入对 multi-step task 必须先 plan 的规则
- 在 CLI 中展示当前 todo / plan 状态

### 结果

- 多步任务稳定性显著提升
- 用户能看到 agent 当前正在做什么
- 更容易做后续 subagent / background 扩展

### 优先级

高优先级，建议在 harness 稳定后立即做。

---

## Phase 4：重做 skill 机制

**目标：** 把当前 trigger-hint skill 机制改造成“元数据常驻、正文按需加载、资源逐层展开”的知识系统。

### 改造内容

- skill 目录升级为 `SKILL.md + scripts/ + references/ + assets/`
- 只在系统中常驻 skill metadata
- 增加显式 `Skill` 工具或显式 skill load 动作
- skill 内容通过工具结果注入上下文
- 对 skill 资源提供可访问路径提示

### 结果

- skill 成为真正的一等公民
- 上下文更省
- 可以更自然地扩展 agent 的领域能力

### 优先级

中高优先级。

---

## Phase 5：把 context window 升级成 ContextManager

**目标：** 让上下文管理从“窗口裁剪工具”升级为 runtime 核心子系统。

### 改造内容

- 建立 token budget 管理器
- 大输出自动转存到磁盘，只回传预览
- transcript 持久化为完整历史
- summary 变成滚动维护，而不是每次临时拼
- 对不同消息类型采用不同保留策略
- 在接近阈值时自动压缩而不是被动溢出

### 结果

- 长任务连续性显著增强
- 成本和上下文污染更可控
- 为 subagent 和后台任务打基础

### 优先级

中高优先级，建议在 planning 和 skill 之后推进。

---

## Phase 6：引入 subagent

**目标：** 用上下文隔离而不是“更长上下文”去处理复杂任务。

### 改造内容

- 增加 `Task` 工具
- 建立 `explore / plan / code` 等 agent type
- 每个 agent type 拥有不同工具集和提示词
- 子代理只返回压缩结果给主代理
- 先从串行子代理做起，不急着并发

### 结果

- 复杂仓库探索不再污染主上下文
- 权限边界更清晰
- 主代理可更专注于协调和收束

### 优先级

中期目标。

---

## Phase 7：任务系统与后台机制

**目标：** 从单次会话 agent 升级到更持续的任务执行系统。

### 改造内容

- 引入持久化 TaskManager
- 支持 create / update / list / dependency
- 后台执行长任务
- 通知结果回流主会话

### 结果

- `mycli` 从“会话型 agent”升级到“任务型 agent”
- 用户无需一直阻塞等待

### 优先级

后续增强，不是当前第一优先。

---

## 6. 推荐的实施顺序

如果只考虑未来 2 到 4 周内最值得做的部分，我建议顺序是：

1. **Phase 1：重建 agent harness**
2. **Phase 2：审批暂停/恢复**
3. **Phase 3：显式 planning**
4. **Phase 4：重做 skill 机制**
5. **Phase 5：完整 context manager**
6. **Phase 6：subagent**
7. **Phase 7：task / background**

这是因为：

- Phase 1/2 解决的是当前系统最根本的不稳定性
- Phase 3/4/5 解决的是 agent 长任务能力
- Phase 6/7 属于能力扩展，而不是内核矫正

---

## 7. 我对当前 mycli 的结论

当前 `mycli` 最大的问题不是“缺工具”，也不是“缺记忆”，而是：

- agent 内核还没有完全采用现代 coding agent 的标准 harness

更具体地说：

- loop 还不够像真正的 tool-use loop
- planning 还不是 runtime 一等公民
- skill 还不是按需知识系统
- context manager 还只是简化版
- subagent 还未进入架构

但是反过来说，当前项目也有一个非常好的基础：

- 分层已经出来了
- 工具和服务模块已经分开了
- 测试基础已经建立了
- CLI 和持久化已经能跑

所以 `mycli` 当前最适合的路线不是“推倒重来”，而是：

- 以 `learn-claude-code` 的核心 loop 为准绳，逐层把 planning、skills、compression、subagent 补成真正的一等公民

---

## 8. 推荐的下一步

如果接下来只做一件事，我建议是：

- **先启动 Phase 1：重建 agent harness**

原因很简单：

- 它会直接改善当前最频繁的问题：错误工具调用、坏参数、审批链条不自然
- 它会给 planning / skills / compression 提供统一而稳固的承载结构
- 如果不先做这一步，后续所有能力都会继续叠加在一个不够正统的 loop 上

换句话说：

- 现在最应该改的不是“再补几个功能”
- 而是“把 mycli 重新拉回到真正的 modern agent runtime 轨道上”

---

## 参考资料

- `shareAI-lab/learn-claude-code` README
- `shareAI-lab/learn-claude-code` README_zh
- `shareAI-lab/learn-claude-code` `v1_basic_agent.py`
- `shareAI-lab/learn-claude-code` `v2_todo_agent.py`
- `shareAI-lab/learn-claude-code` `v3_subagent.py`
- `shareAI-lab/learn-claude-code` `v4_skills_agent.py`
