# mycli 风险操作选项式确认设计

**日期：** 2026-04-05

**目标：** 将 `mycli` 当前基于 `/confirm` 和 `/reject` 的风险操作确认流程，改造成更自然的选项式交互：工作区内默认可信，普通操作自动执行；危险操作展示明确选项，由用户通过数字选择处理，并支持“本次会话内始终允许同类命令”。

---

## 1. 背景

当前 `mycli` 的高风险工具执行流程依赖：

- agent 生成 `pending_approval`
- CLI 提示用户输入 `/confirm` 或 `/reject`
- 用户必须记住命令式确认方式

这个模型的问题是：

- 交互过于机械，不像自然的 agent 对话体验
- 用户需要记忆 slash command
- 确认状态和普通输入混在一起，容易误操作
- 无法表达“本次会话内同类命令都放行”这样的更高层决策

同时，当前项目的目标并不是做一个高度保守、处处打断的终端工具，而是做一个工作区内可信、尽量少摩擦的个人 agent。因此安全模型需要从“高频确认”调整为“默认信任工作区，危险动作再明确决策”。

---

## 2. 设计目标

这次改造的目标如下：

- 取消 `/confirm` 和 `/reject` 作为主要确认方式
- 将工作区内普通工具调用视为默认可信
- 仅在危险操作时进入显式用户决策
- 决策方式使用可见选项，而不是命令记忆
- 支持“本次会话内始终允许同类命令”
- 保持 CLI REPL 架构简单，不立即引入复杂 TUI

---

## 3. 非目标

本次改造不包含以下内容：

- 不引入完整终端 UI 框架或方向键菜单
- 不做跨会话持久化 allowlist
- 不做复杂的命令语义分析器
- 不重写整套 agent harness
- 不取消所有安全限制

换句话说，这次是“确认交互模型和安全策略”的重构，不是整个 agent runtime 的总重写。

---

## 4. 用户体验设计

## 4.1 普通操作

对于工作区内的普通操作，agent 直接执行，不打断用户，例如：

- `list_directory`
- `read_file`
- `search_text`
- workspace 内安全的 `edit_file`
- 被安全策略判定为可自动执行的 `run_shell`

用户只看到正常的 progress 和结果，不进入确认流程。

## 4.2 危险操作

当 agent 生成被判定为危险的工具调用时，CLI 不再提示 `/confirm` 或 `/reject`，而是展示明确选项。

示例：

```text
Risky action detected:
Tool: run_shell
Command: git reset --hard
Reason: clean repository state before proceeding

[1] 仅本次允许
[2] 拒绝
[3] 本次会话内始终允许同类命令
```

用户下一次输入只能是：

- `1`
- `2`
- `3`

如果输入其他内容，CLI 提示：

```text
Please choose 1, 2, or 3.
```

并保持在等待选择状态。

## 4.3 会话级放行

如果用户选择 `3`：

- 当前待执行动作立即执行
- 系统把“同类命令模式”加入当前 session allowlist
- 同会话内后续匹配的同类命令不再询问

这是一个会话级决策，不跨 session 持久化。

---

## 5. 安全模型

## 5.1 新的总体原则

新的安全模型分为三层：

### 自动执行

满足以下条件的动作直接执行：

- 工具本身属于只读工具
- 文件修改明确落在 workspace 内，且不命中危险模式
- shell 命令被判定为 workspace-trusted

### 需要用户选择

满足以下条件的动作进入选项式确认：

- shell 命令可能修改仓库状态
- shell 命令具有不可逆风险
- 文件操作超出普通编辑范围
- 命令未命中自动允许规则，也未命中直接禁止规则

### 直接拒绝

满足以下条件的动作不提供选项，直接拒绝：

- 明显越界访问 workspace 外路径
- 明显破坏宿主环境
- 命令结构不合法
- 工具参数缺失或不满足 schema

## 5.2 “同类命令”定义

第一版不做复杂语义聚类，而采用“命令前缀模式”。

示例：

- `git push origin main` 归类为 `git push`
- `git reset --hard HEAD~1` 归类为 `git reset --hard`
- `rm -rf build` 归类为 `rm -rf`
- `python manage.py migrate` 归类为 `python manage.py migrate`

这个前缀模式将作为 session allowlist 的 key。

目标是：

- 易实现
- 易解释
- 可预测

---

## 6. 架构改造

## 6.1 运行时状态

当前系统只有 `pending_approval` 概念，后续应调整为更明确的“风险决策状态”。

建议新增：

- `PendingDecision`
- `DecisionOption`
- `SessionCommandAllowance`

其中 `PendingDecision` 至少包含：

- 待执行 `tool_call`
- 风险级别
- 用户可见预览
- 可选项列表
- 命令模式 key

## 6.2 TurnService

`TurnService` 的职责变更如下：

- 不再暴露 `confirm_pending_action()` / `reject_pending_action()`
- 改为暴露类似：
  - `resolve_pending_decision(choice: str)`
- 当存在待决策动作时：
  - 普通用户消息不再送入 agent
  - CLI 必须先消费这个选择

`resolve_pending_decision("1")`

- 执行一次当前动作
- 不写入 allowlist

`resolve_pending_decision("2")`

- 清除待决策状态
- 返回拒绝消息

`resolve_pending_decision("3")`

- 将同类命令模式加入当前 session allowlist
- 执行当前动作

## 6.3 SessionService

`SessionService` 需要新增两类持久化：

- `pending-decision`
- `session-allowlist`

建议文件：

- `~/.mycli/sessions/<session_id>-decision.json`
- `~/.mycli/sessions/<session_id>-allowlist.json`

allowlist 只针对当前 session 保存。

## 6.4 SafetyPolicy

`SafetyPolicy` 不再只返回 `LOW / MEDIUM / HIGH`。

建议演进为更接近决策导向的结果，例如：

- `auto_allow`
- `needs_choice`
- `deny`

或者保留 risk level，但新增解析结果对象，例如：

- `ToolSafetyDecision`

包含：

- decision kind
- reason
- preview
- command pattern key

## 6.5 CLI

CLI 是这次改造的重点入口。

`run_repl()` 需要支持新的状态：

- 普通对话输入
- 等待风险选择输入

当存在待决策动作时：

- CLI 打印选项
- 下一次输入优先按 choice 处理
- 输入不合法时，继续停留在选择态

同时：

- `/confirm`
- `/reject`

将从帮助列表中移除。

---

## 7. 命令模式提取

`run_shell` 需要增加一个命令模式提取逻辑。

目标：

- 从 `args` 生成稳定、可解释的 allowlist key

第一版规则：

- 默认取前 2 到 4 个 token
- 对已知危险模式保留更长前缀
- 对明显参数值做适度截断

例如：

- `["git", "push", "origin", "main"]` -> `git push`
- `["git", "reset", "--hard", "HEAD~1"]` -> `git reset --hard`
- `["rm", "-rf", "build"]` -> `rm -rf`
- `["python", "manage.py", "migrate"]` -> `python manage.py migrate`

这部分实现应集中放在 shell 工具或安全策略附近，避免散落在 CLI。

---

## 8. 失败处理

这次改造必须保证失败模式可控。

### 输入失败

如果用户在等待选项时输入无效内容：

- 不清空待决策状态
- 提示重新输入 `1/2/3`

### 工具执行失败

如果用户已选择允许，但工具执行失败：

- 清除当前待决策状态
- 返回可读错误
- 不应抛 traceback

### allowlist 匹配失败

如果同类命令模式提取失败：

- 回退到 `needs_choice`
- 不自动执行

---

## 9. 测试策略

需要新增和修改的测试包括：

### CLI

- 帮助信息不再包含 `/confirm` `/reject`
- 待决策状态下输入 `1/2/3` 的行为
- 非法输入保持在选择态

### TurnService

- 普通 workspace 操作自动执行
- 危险动作生成 `PendingDecision`
- 选择 `1` 后执行并清理状态
- 选择 `2` 后拒绝并清理状态
- 选择 `3` 后写入 session allowlist 并执行
- allowlist 命中时后续动作直接执行

### SessionService

- pending decision round trip
- allowlist round trip

### SafetyPolicy

- shell 命令分类
- command pattern 提取
- workspace trusted 规则

---

## 10. 实施顺序

建议按以下顺序实施：

1. 重构 `SafetyPolicy`，引入 decision-oriented 结果
2. 新增 `PendingDecision` 和 session allowlist 持久化
3. 重构 `TurnService` 的待确认逻辑为待选择逻辑
4. 重构 `CLI` 的输入分支，加入数字选项交互
5. 移除 `/confirm` 和 `/reject`
6. 增加 command pattern 提取和 allowlist 匹配
7. 更新 README 和使用说明

---

## 11. 结论

这次改造的本质不是“把 `/confirm` 改成数字”，而是：

- 把 `mycli` 的安全交互从命令式确认，升级为低摩擦、对话式、会话可学习的决策模型

最终目标是：

- workspace 内默认可信
- 危险动作显式选择
- 同类命令支持会话级放行
- 不再让用户记忆 slash command

这是一个明显更接近真实 coding agent 体验的方向，也与 `mycli` 作为个人 agent 的定位一致。
