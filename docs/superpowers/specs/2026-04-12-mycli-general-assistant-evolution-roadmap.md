# mycli 向通用个人 AI Assistant 演进路线图

**日期：** 2026-04-12

**状态：** 长期方向收敛，可作为后续架构与产品提案的上层路线图

**路线判断：** `mycli` 的终局不应只是 “本地 coding agent”，而应演进为“以统一 agent runtime 为底座、可承载多任务类型的通用个人 AI assistant”

---

## 1. 路线图结论

如果未来希望 `mycli` 不仅能写代码、修 bug、分析仓库，还能写小说、整理文档、做研究、处理日常事务，那么正确方向不是继续往 CLI 里堆更多 feature，也不是把每一类任务都做成一个单独模式，而是：

`先把统一 turn 主链做稳，再把不同任务能力收敛成 capability / workflow / tool exposure 的组合，让同一个 runtime 能承载不同类型的助手行为。`

这条路线背后的核心判断是：

1. `mycli` 的长期价值，不在于“会多少个单点功能”，而在于“是否有能力把不同任务统一纳入同一个 runtime 主链”
2. 如果没有统一主链，后面新增“写代码”“写作”“研究”“任务自动化”只会变成多套分叉逻辑
3. 真正接近 Codex / Claude Code 的路径，不是简单模仿它们当前支持的功能面，而是学习它们把能力收敛进统一 agent runtime 的方法

一句话概括：

`先做成稳定的 agent runtime，再让它长成通用个人 assistant。`

---

## 2. 终局产品定义

长期来看，`mycli` 不应该只被定义为：

`一个会调用工具的 coding CLI`

而应该被定义为：

`一个以本地工作区和个人上下文为中心、能根据任务类型切换能力与策略的通用个人 AI assistant，CLI 只是它当前最先成熟的宿主界面。`

这个 assistant 需要同时满足四件事：

1. **能做工程任务**
   - 写代码
   - 修 bug
   - 分析仓库
   - 做评审
   - 执行受控的本地工作流

2. **能做知识与写作任务**
   - 写设计文档
   - 写长文
   - 写小说或角色设定
   - 总结、改写、润色、翻译

3. **能做个人助手任务**
   - 组织待办
   - 维护长期记忆
   - 协助研究、归档、整理
   - 帮用户推进多步任务

4. **始终保持 agent 形态**
   - 能主动探索
   - 能按任务切换策略
   - 能知道何时调用工具、何时停下来、何时请求确认
   - 能在不同 surface 中保持统一行为语义

---

## 3. 为什么不能把“全能”理解成多功能堆叠

如果未来目标是“像 Codex 或 Claude Code 一样，成为一个全能 AI 助手”，最容易犯的错误是：

- 给 coding 单独做一套模式
- 给 creative writing 单独做一套模式
- 给 research 单独做一套模式
- 给 assistant automation 再做一套模式

这样短期会显得功能很多，但长期会带来四个问题：

### 3.1 Prompt 会分叉失控

每多一种任务模式，就会多一套系统提示、行为规则、工具说明与输出模板。最后不是一个 assistant，而是多个拼接在一起的小系统。

### 3.2 工具面会变成碎片化旁路

coding 用一套工具、写作用一套工具、研究用一套工具、插件再用一套工具，最终 runtime 不再知道“本轮到底有哪些能力在生效”。

### 3.3 记忆和能力很难共享

如果写作模式和 coding 模式各自独立，就无法自然共享：

- 用户偏好
- 项目记忆
- 写作风格
- 当前任务上下文

### 3.4 Surface 会承担过多解释责任

CLI、IDE、Web、移动端都会开始自己猜：

- 当前是什么模式
- 哪些能力正在生效
- 为什么现在显示的是这种行为

这会让系统越来越像“前端上拼出来的智能感”，而不是一个真实统一的 agent。

---

## 4. 正确的长期架构视角

从长期看，`mycli` 的能力增长应该落在同一套结构里，而不是新增一个个模式开关。

建议把能力增长理解成四层：

### 4.1 Runtime 主链层

这是所有任务共享的统一骨架，包括：

- turn context assembly
- capability injection
- tool exposure / router
- item lifecycle
- trace / session persistence
- runtime policy

这是“所有能力都依赖的底座”。

### 4.2 Capability 层

Capability 表示“这轮 turn 被注入了什么能力语义”，例如：

- `repo-analysis`
- `coding-implementation`
- `systematic-debugging`
- `code-review`
- `creative-writing`
- `longform-writing`
- `research-assistant`
- `task-automation`

Capability 不是工具，也不是 prompt 附件，而是：

`影响本轮行为策略、工具暴露、回答结构和验证要求的正式运行时能力对象`

### 4.3 Workflow / Policy 层

不同任务并不只是内容不同，推进方式也不同。

例如：

- coding 任务强调探索、修改、验证
- debugging 任务强调定位根因、复现、验证修复
- 写小说任务强调风格、角色、节奏、一致性
- research 任务强调信息搜集、证据标注、归纳总结

这些差异应该落在 workflow / policy 层，而不是散在 prompt 里。

### 4.4 Tool / Connector 层

工具面并不是只服务 coding。

长期来看，它应该承载：

- workspace tools
- shell / git tools
- dynamic tools
- MCP / provider-specific tools
- future external connectors

不同任务只是暴露和使用工具的方式不同，不应拥有彼此独立的工具主链。

---

## 5. 长期能力地图

如果按终局目标看，`mycli` 的能力面大致会扩展成下面几类。

### 5.1 工程助手能力

- 仓库分析
- 代码实现
- bug 调试
- 代码评审
- 测试生成与验证
- 变更总结与文档更新

### 5.2 写作助手能力

- 文档起草
- 规格说明整理
- README / PR / release notes 撰写
- 长文写作
- 小说、人物设定、世界观草拟
- 语气与风格重写

### 5.3 研究助手能力

- 资料收集
- 对比调研
- 证据归纳
- 结构化总结
- 下一步建议生成

### 5.4 个人任务助手能力

- 待办组织
- 长期记忆维护
- 任务拆解
- 习惯性偏好保持
- 日常文本与事务协助

这些能力未来应表现为：

`不同 capability / workflow 的组合，而不是不同产品。`

---

## 6. 演进阶段建议

为了从“coding agent”稳定演进为“通用个人 assistant”，建议分四个大阶段推进。

## 6.1 阶段 A：把 agent runtime 做成真正稳定的主链

这是当前已经在推进的阶段。

目标不是追求能力面广，而是让 runtime 足够统一，后续不同任务都能挂上来。

关键工作包括：

- turn context assembly
- exploration discipline
- capability injection
- tool exposure / router
- item lifecycle

完成标志：

- 新能力能清晰挂接到 runtime 主链
- provider 差异不污染 surface
- capability 和工具面可以正式协作

## 6.2 阶段 B：把“coding agent”升级为“多任务 agent”

当主链稳定后，下一步不是立刻接很多外部系统，而是先把不同任务类型做成正式能力。

建议优先产品化的 capability：

- `coding-implementation`
- `systematic-debugging`
- `code-review`
- `creative-writing`
- `research-assistant`
- `task-automation`

完成标志：

- 同一个 `mycli` runtime 能根据任务类型切换策略
- 写代码、做分析、写作三类任务能走同一主链

## 6.3 阶段 C：扩展外部工具与连接器生态

当任务能力已经比较稳定后，再接：

- MCP
- provider-specific hosted tools
- future external connectors

这一步的重点不是“接更多工具”，而是：

`让外部能力仍然通过统一 tool exposure / router 进入 turn 主链。`

完成标志：

- 外部工具和本地工具可以统一路由、统一 trace、统一可见
- capability 可以按任务需要动态暴露外部工具

## 6.4 阶段 D：成为多 surface 的个人 assistant

只有当前三阶段稳定后，`mycli` 才值得从“CLI 宿主”进化为“多 surface 的 assistant”。

可能的 surface 包括：

- CLI
- IDE / editor
- Web
- mobile / lightweight companion

这一阶段的重点不再是能力本身，而是：

- 不同 surface 共享同一个 runtime
- 不同 surface 消费同一类 turn item / event / state
- assistant 具备更连续的长期协作体验

---

## 7. 与 Codex / Claude Code 的关系

如果目标是“像 Codex 或 Claude Code 一样强”，正确理解应该是：

### 7.1 要学的是主链，不是功能清单

真正值得借鉴的不是：

- 它们支持多少命令
- UI 长什么样
- 现在有哪些快捷特性

而是：

- 能力如何进入 turn
- 工具如何被暴露
- 事件如何被持久化
- surface 如何只消费统一协议对象

### 7.2 `mycli` 的长期差异化可以更宽

Codex / Claude Code 当前更偏工程协作。

而 `mycli` 的长期定位可以更宽一些：

- 既是 coding assistant
- 也是 writing assistant
- 也是 research assistant
- 也是 personal task assistant

前提是：

`这些能力都不能破坏统一 runtime 主链。`

---

## 8. 接下来几年最应该坚持的原则

为了不在“全能”目标里失控，建议长期坚持下面几条原则。

### 8.1 任何新能力都必须回答“挂在哪个接入点上”

新增能力前，要先问：

- 它是 capability 吗？
- 它是 workflow 吗？
- 它是 tool source 吗？
- 它是 surface 展示问题吗？

如果回答不清，就不应该直接实现。

### 8.2 不做“模式动物园”

不要把系统做成：

- code mode
- write mode
- research mode
- assistant mode

然后每个 mode 各有一套隐藏逻辑。

应该做成：

- 同一个 runtime
- 不同 capability / policy / tool exposure 组合

### 8.3 不让 prompt 成为唯一协调层

Prompt 很重要，但不能承担：

- 所有能力接入
- 所有策略差异
- 所有工具协作
- 所有状态解释

真正的协调层必须是 runtime。

### 8.4 不让 UI 反向定义 agent

CLI、IDE、Web 都只是宿主。

不应该因为某个 surface 暂时容易实现，就让它反向决定 agent 的架构边界。

---

## 9. 最终判断

如果未来真想把 `mycli` 做成一个“像 Codex 或 Claude Code 一样强、但能力面更宽的通用 AI 助手”，最重要的不是现在立刻去做“写小说 feature”“研究 feature”“自动化 feature”，而是：

`继续坚持“先做强统一主链，再扩展能力面”的路线。`

这意味着：

- 短期看起来会比“堆功能”更慢
- 但长期才有机会真的长成一个统一 assistant

一句话收尾：

`mycli 的终局，不该只是一个更强的 coding CLI，而应该是一个以统一 agent runtime 为底座、能在工程、写作、研究和个人事务之间自然切换的通用个人 AI assistant。`
