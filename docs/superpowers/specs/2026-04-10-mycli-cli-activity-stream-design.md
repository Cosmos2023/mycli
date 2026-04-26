# mycli CLI 活动流设计

**日期：** 2026-04-10

**状态：** 设计已收敛，进入计划阶段

**目标：** 为 `mycli` 增加一套类似 Codex CLI / Claude Code 的实时活动流，让用户在最终回答出现之前，能够看到 agent 当前正在思考什么、正在调用什么工具、正在读取哪些文件，以及是否卡在审批或模型错误上。

---

## 1. 设计结论

本轮不追求完整 TUI 或复杂状态栏，而是优先做一版稳定、清晰、可扩展的实时活动流。

本设计采用以下总体决策：

- 第一版交互形态：在 CLI 中输出结构化 `[activity]` 行
- 显示范围：覆盖“模型正在思考/规划”加“工具级动作”
- 核心策略：由 runtime 产生结构化 activity events，由 CLI 负责渲染
- 不依赖 trace：前台活动流和事后 trace 分离，但允许共享部分信息来源
- 第一批重点：让用户能看到 `Searching`、`Reading`、`Editing`、`Git`、`Shell`、`Waiting approval`、`Model error`
- 向后兼容：保留现有 `progress_updates` 和 `/trace` 能力，不强制一次性替换全部展示逻辑

一句话概括：

`先把 mycli 变成一个“用户看得见它在做什么”的 agent，再考虑更复杂的终端 UI。`

---

## 2. 为什么现在要补这一层

当前 `mycli` 已经具备：

- 可运行的 CLI REPL
- Responses-first runtime 主链
- tool result reinjection
- `/trace` 的事后查看能力
- 部分 `progress_updates`

但用户体验上仍有明显缺口：

- 最终回答出现前，用户看不到 agent 当前正在做什么
- 即使 agent 已经在搜索、读文件、等审批，前台也往往是“沉默”的
- `/trace` 更像事后调试日志，不适合做实时交互反馈
- 当前 `progress_updates` 主要依赖模型显式输出，稳定性不够

这会直接造成一种体验问题：

- 用户不知道 agent 是在正常工作、卡住、还是出错
- 一旦模型请求较慢或工具链路较长，CLI 看起来像“没反应”
- 与 Codex CLI / Claude Code 这类产品相比，缺乏“正在执行”的可见性

因此，这一层的价值不是“让界面更好看”，而是：

`让 mycli 的执行过程变得可观察、可理解、可等待。`

---

## 3. 本轮范围

### 3.1 本轮包含

- 为 runtime 增加结构化 activity event 表达
- 在 CLI 中渲染 `[activity]` 行
- 覆盖模型思考/规划类活动
- 覆盖工具开始/结束类活动
- 覆盖审批等待状态
- 覆盖模型错误状态
- 为高频工具提供可读的活动文案映射
- 补充 CLI 和 runtime 相关测试

### 3.2 本轮不包含

- 真正的 TUI、多栏布局或状态栏
- 动画、流式 token 级渲染
- trace viewer 重做
- 模型原始响应全文在前台实时展示
- 历史活动折叠/展开交互
- 彩色主题和复杂终端样式系统

第一版的目标是“可见、稳定、简洁”，不是“炫酷”。

---

## 4. 方案比较

### 方案 A：只增强现有 `progress_updates`

继续依赖模型返回的 `reasoning` / `progress_message`，CLI 只是换一种更像活动流的显示格式。

优点：

- 改动最小
- 上线最快

缺点：

- 活动内容不稳定，取决于模型会不会主动说自己在做什么
- 工具级信息不够结构化
- 很难稳定显示“正在读取哪个文件”“正在搜索什么”

### 方案 B：新增结构化 activity events，由 runtime 主动发，CLI 被动渲染

runtime 在关键节点发出 `thinking`、`planning`、`tool_started`、`tool_finished`、`waiting_approval`、`model_error` 等事件；CLI 统一把它们渲染成 `[activity]` 行。

优点：

- 最稳定
- 显示内容不依赖模型的自发表达
- 后续可复用到更强的前端/TUI
- 便于测试和演进

缺点：

- 改动比单纯复用 `progress_updates` 稍大
- 需要同时调整 runtime 响应结构和 CLI 渲染

### 方案 C：直接复用 trace 作为实时前台展示源

把 trace 当作事件源，在前台边执行边读取并渲染。

优点：

- 复用现有 trace 基础设施

缺点：

- 前台展示和事后审计职责混乱
- 延迟和展示粒度不好控制
- 容易为了展示污染 trace 结构

### 结论

选择方案 B。

---

## 5. 设计目标

本轮完成后，CLI 应优先达到以下效果：

1. 当 agent 开始处理任务时，用户能看到它正在思考或规划。
2. 当 agent 调用读取、搜索、编辑、git、shell 等工具时，用户能看到它正在执行的动作。
3. 当 agent 需要风险审批时，用户在看到审批选项前已经知道它正在等待确认。
4. 当模型请求失败时，用户不仅能看到最终错误消息，也能在活动流里看到失败状态。
5. 整个实现为未来更复杂的前端或 TUI 留下稳定事件源。

---

## 6. 数据模型设计

## 6.1 新增 `ActivityEvent`

建议在 runtime/domain 层增加一个专用事件模型，例如：

```python
@dataclass(slots=True, frozen=True)
class ActivityEvent:
    kind: str
    message: str
    tool_name: str | None = None
    path: str | None = None
    query: str | None = None
    preview: str | None = None
```

本轮优先支持以下 `kind`：

- `thinking`
- `planning`
- `tool_started`
- `tool_finished`
- `waiting_approval`
- `model_error`

字段原则：

- `message` 给 CLI 直接渲染
- 结构化字段给未来 richer UI 或 trace 复用
- 第一版保持简单，不做层级嵌套或复杂 metadata

## 6.2 扩展 `TurnResponse`

在 `TurnResponse` 中新增：

```python
activity_events: tuple[ActivityEvent, ...] = ()
```

这样前台渲染链路会变成：

- `activity_events`：显示“正在做什么”
- `progress_updates`：保留现有模型输出式进度补充
- `assistant_message`：最终答复

第一版允许三者并存，不强制完全合并。

---

## 7. Runtime 事件发射设计

## 7.1 事件来源

活动事件应由 runtime 主动发出，而不是依赖模型自己“描述自己正在做什么”。

关键落点建议如下：

### 模型请求前

发出：

- `thinking`

示例文案：

- `Thinking: 分析用户请求`
- `Thinking: 决定下一步动作`

### 收到 reasoning / progress block

发出：

- `thinking` 或 `planning`

原则：

- 如果 block 内容更像“正在思考”，归到 `thinking`
- 如果 block 内容更像“计划更新”或“下一步安排”，归到 `planning`

### 工具调用前

发出：

- `tool_started`

### 工具调用后

发出：

- `tool_finished`

### 审批等待前

发出：

- `waiting_approval`

### 模型请求失败时

发出：

- `model_error`

---

## 8. 工具活动文案设计

## 8.1 文案策略

第一版不显示全部参数，而是优先输出“人能快速看懂”的动作文案。

建议映射如下：

- `list_directory` → `Listing: <path>`
- `read_file` → `Reading: <path>`
- `read_file_range` → `Reading: <path>:<start>-<end>`
- `search_text` → `Searching: query=<query>`，有 `glob` 时追加 `glob=<glob>`
- `edit_file` → `Editing: <path>`
- `replace_in_file` → `Editing: <path>`
- `append_file` → `Appending: <path>`
- `git_status` → `Git: status`
- `git_diff` → `Git: diff`
- `git_log` → `Git: log`
- `run_shell` → `Shell: <preview>`
- `update_plan` → `Planning: updating task plan`

## 8.2 噪音控制

为了避免活动流太吵：

- `tool_started` 显示精炼动作
- `tool_finished` 只显示简短结果，如 `Done reading README.md`
- 不在前台展示完整 diff、stdout 或原始 payload
- 详细信息仍保留给 `/trace`

---

## 9. CLI 渲染设计

## 9.1 渲染顺序

当前 CLI 在一次 turn 里主要输出：

- `[progress]`
- `[plan]`
- `[decision]`
- assistant message

本轮建议改为：

- `[activity]`
- `[progress]`（保留）
- `[plan]`
- `[decision]`
- assistant message

这样活动流总是在更靠前的位置出现。

## 9.2 渲染样式

第一版保持最简单的纯文本样式：

```text
[activity] Thinking: 分析仓库入口和主要模块
[activity] Listing: .
[activity] Reading: src/mycli/cli/main.py
[activity] Reading: src/mycli/application/runtime/agent_runtime.py
[activity] Planning: 总结入口、runtime 主链和工具层
```

这样做的好处是：

- 与现有 CLI 输出样式一致
- 无需引入更复杂的终端控制
- 测试简单

---

## 10. Trace 与活动流的关系

trace 和活动流相关，但不应强耦合。

原则：

- activity 是前台交互反馈
- trace 是事后审计与调试

本轮不建议让 CLI 直接读 trace 再渲染活动流，原因是：

- 职责混淆
- 实时性不可控
- 为展示污染 trace 结构

更合适的关系是：

- runtime 在同一个事件源上同时产生活动信息和 trace 信息
- 但前台展示与落盘逻辑分别处理

---

## 11. 测试策略

### 11.1 CLI 测试

- `main.py` 能渲染 `activity_events`
- 活动流出现在最终 assistant message 之前
- 活动流与 `[decision]`、`[plan]` 输出可以共存

### 11.2 Runtime 测试

- 工具调用会产出 `tool_started` / `tool_finished`
- 模型 reasoning block 会变成 `thinking` 或 `planning`
- 审批等待会产出 `waiting_approval`
- 模型失败会产出 `model_error`

### 11.3 回归测试

- 没有活动事件时，现有 CLI 行为保持兼容
- `/trace` 现有展示不被破坏
- 现有 `progress_updates` 逻辑保持可用

---

## 12. 实施顺序

建议按以下顺序推进：

1. 定义 `ActivityEvent` 与 `TurnResponse.activity_events`
2. 在 runtime 关键节点发出结构化活动事件
3. 为工具调用增加活动文案映射
4. 调整 CLI 渲染顺序和样式
5. 补齐 CLI / runtime 测试

这样能尽早看到前台效果，同时避免把实现扩散到太多无关层。

---

## 13. 风险与约束

### 风险 1：活动流太吵，影响阅读

缓解：

- 第一版只显示高价值动作
- 不展示完整 payload
- 保持单行摘要风格

### 风险 2：活动流和 `progress_updates` 重复

缓解：

- `activity` 优先表达结构化动作
- `progress_updates` 继续承载模型自发 reasoning
- 后续可再评估是否收敛

### 风险 3：活动流来源不统一

缓解：

- 明确 runtime 是唯一事件源
- CLI 只渲染，不自己推断

### 风险 4：实现范围失控，滑向 TUI 重构

缓解：

- 第一版只做文本活动流
- 不做多栏、不做颜色系统、不做复杂终端状态控制

---

## 14. 成功标准

如果本轮完成，`mycli` 应达到以下状态：

- 用户在等待答案时，能看到 agent 正在做什么
- 常见工具动作会被实时显示成可读活动流
- 思考/规划状态也能被前台感知
- 审批等待和模型错误不再表现为“CLI 沉默”
- 后续如果要做更强的前端或 TUI，有稳定事件模型可复用

---

## 15. 最终判断

当前 `mycli` 最缺的不是“有没有 trace 文件”，而是“用户能不能在交互当下感知 agent 的执行过程”。

因此，正确的第一步不是直接上复杂前端，而是先建立一套由 runtime 驱动、由 CLI 渲染的结构化活动流，把 thinking / planning / tool activity / approval / model error 这些状态显式呈现出来。

这样既能立刻改善交互体验，也能为更成熟的终端 UI 留下清晰基础。
