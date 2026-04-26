# mycli Responses Agent Runtime 适配设计

**日期：** 2026-04-11

**状态：** 设计已收敛，进入计划阶段

**目标：** 让 `mycli` 从“能调用 Responses API”升级为“真正按 Responses 的 agent-native 语义运行”，完整适配 `reasoning`、`summary`、`function_call`、`message` 等返回内容，并把 agent 的执行过程以更像 Codex CLI / Claude Code 的方式在前台展示出来。

---

## 1. 设计结论

这次工作不应再理解为“继续修补 `/responses` 兼容层”，而应理解为：

`把 mycli 的模型运行时升级为 Responses-first agent runtime，并让执行过程可见。`

本设计采用以下总体决策：

- 协议方向：继续以 OpenAI Responses 作为主协议，不回退到 chat/completions 语义设计
- 架构路径：先补齐非流式 Responses 语义适配，再在同一套运行时事件模型上叠加 streaming
- 适配重点：优先吃透 `reasoning`、`summary`、`function_call`、`message.output_text`
- 显示策略：前台展示以结构化 activity events 为主，模型 reasoning 作为高价值活动来源之一
- 兼容策略：保留现有 block/item-first runtime，不重新设计另一套 transcript 模型
- 范围控制：第一版不做多模态、图片/音频输出、复杂 hosted tools 全覆盖

一句话概括：

`先让 mycli 真正理解 Responses 返回的 agent 语义，再让这些语义通过 CLI 流式呈现出来。`

---

## 2. 为什么现在要做这一层

当前 `mycli` 已经具备：

- Responses-first 的默认模型链路
- 基础的 `ResponsesModelAdapter`
- block/item-first runtime
- CLI activity stream
- 工作区日志与原始 response 落盘

但当前仍有两个关键缺口：

### 2.1 Responses 语义适配仍然太浅

当前 adapter 主要只处理：

- `function_call`
- `output_text`
- `message` 中的 `output_text`

而 Responses 中更贴近 agent runtime 的内容，例如：

- `reasoning`
- `summary`
- item `status`
- 更细粒度的 output item 结构

还没有被正式消费。

这会直接带来两个问题：

- 模型已经返回了“它正在想什么 / 为什么继续调用工具”，但 runtime 没接住
- 前台活动流看起来像“工具在执行”，而不是“agent 在执行”

### 2.2 执行过程展示还不够贴近 agent

当前 activity stream 已经能显示：

- Thinking
- Planning
- Tool started / finished
- Waiting approval
- Model error

但这些活动主要来自 runtime 的本地推断，而不是 Responses 自身更丰富的 reasoning / streaming 信号。

结果是：

- 前台能看到“在读文件”，但很难看到“模型为什么决定继续读”
- 日志里能看到模型 reasoning，但 CLI 前台接不到
- 整体体验离真正的 agent console 还差一截

因此，这次工作的价值不是“再多解析几种 JSON”，而是：

`让 Responses 返回的 agent-native 语义真正穿透到 runtime 与前台。`

---

## 3. 本轮范围

### 3.1 本轮包含

- 补齐 Responses 非流式 output item 适配
- 正式支持 `reasoning` 与 `summary` 到 runtime block 的映射
- 补齐 `function_call` / `message` / `output_text` 的状态与元数据保留
- 扩展 runtime 对 Responses-derived activity events 的消费
- 为 CLI 增加更完整的模型执行过程展示
- 在 Responses client/adapter 上增加 streaming 能力
- 把 streaming events 映射到现有 activity stream 渲染链路
- 增加相关测试与日志验证

### 3.2 本轮不包含

- 图片、音频等多模态输出全量支持
- hosted tool / web search / code interpreter 等 OpenAI 原生托管工具完整接入
- 真正的 TUI、多栏面板或复杂终端布局
- token 级逐字打字机样式输出
- 多 provider 统一 streaming 抽象

第一版目标是：

`让 text + reasoning + tool-call 这条 agent 主链完整跑通，并让用户看得见。`

---

## 4. 方案比较

### 方案 A：只增强当前非流式 adapter

只在 `responses_adapter.py` 里补齐 `reasoning` 与 `summary`，不做 streaming。

优点：

- 改动最小
- 最容易验证

缺点：

- 只能让 runtime 更懂 Responses，不能显著改善“执行中可见性”
- 无法真正做出 agent console 的连续感

### 方案 B：直接以 streaming 为中心重做

跳过非流式收敛，直接基于 Responses streaming events 重做一套前台展示。

优点：

- 体验最强
- 更接近 OpenAI agent 原生形态

缺点：

- 容易把协议适配和前台呈现耦死
- 如果非流式语义层没收稳，streaming 实现会更脆弱

### 方案 C：两层推进，先语义适配，再叠加 streaming

先完整适配非流式 Responses 语义，再在同一套运行时 block / activity event 模型上接 streaming。

优点：

- 架构最稳
- 非流式与流式共享同一套语义模型
- 调试与测试成本更低

缺点：

- 首轮工作量略大于只做非流式

### 结论

选择方案 C。

---

## 5. 设计目标

本轮完成后，系统应优先达到以下效果：

1. `mycli` 能稳定消费 Responses 返回的 `reasoning`、`summary`、`function_call`、`message.output_text`。
2. runtime 能基于这些内容生成更真实的 agent activity，而不只是本地猜测。
3. CLI 能显示“模型正在分析什么、决定做什么、正在调用什么工具、何时开始形成答案”。
4. 流式模式下，用户无需等待完整 response 完成后才看到这些执行过程。
5. 非流式和流式共用同一套运行时语义，避免重复实现。

---

## 6. 数据模型设计

## 6.1 Responses item 到 runtime block 的映射

本轮不新增另一套 transcript 契约，而是在现有 `RuntimeBlock` 基础上扩展 Responses item 的映射。

建议映射如下：

- `reasoning.summary[].text` -> `RuntimeBlock(type="reasoning")`
- `output_text` -> `RuntimeBlock(type="text")`
- `message.content[].output_text` -> `RuntimeBlock(type="text")`
- `function_call` -> `RuntimeBlock(type="tool_call")`

同时保留以下元数据：

- provider item `id`
- `call_id`
- `status`
- 原始 item `type`

这些元数据建议进入 `RuntimeBlock.metadata`，例如：

```python
RuntimeBlock(
    type="reasoning",
    text=summary_text,
    provider_id=item_id,
    metadata={
        "provider_item_type": "reasoning",
        "status": item_status,
    },
)
```

## 6.2 扩展 `ModelTurnResult`

建议在 `ModelTurnResult` 中增加对 provider 元数据的承载，例如：

- `response_id`
- `response_status`
- `usage`

第一版可以先把 `response_status` 与 `usage` 放入一个轻量 metadata 字段，避免立刻改太多调用方。

---

## 7. 非流式 Responses 适配设计

## 7.1 `reasoning` item

这是第一版必须补的核心。

当前 provider 已经会返回：

- `type: "reasoning"`
- `summary[]`

而且日志已经证明模型会在这里表达：

- 当前判断
- 下一步计划
- 为什么继续调用工具

设计要求：

- 读取 `summary[]` 中的文本
- 每段文本都转成一个 `reasoning` block
- 若没有 `summary`，允许 fallback 到更保守的文本提取方式

## 7.2 `function_call` item

当前已有基础支持，但需要增强：

- 保留 `status`
- 保留 provider item `id`
- 更稳地处理 arguments 的字符串/对象形态

## 7.3 `message` / `output_text`

继续支持，但需要统一：

- `message` 中的 `output_text`
- 顶层 `output_text`

都映射到 `text` block

## 7.4 忽略策略

第一版对未知 item 类型不应直接崩溃。

建议策略：

- 记录 warning 日志
- 保留最小 metadata
- 在安全前提下忽略该 item

这样可以减少 provider 小变更导致的整轮失败。

---

## 8. Runtime 活动事件设计

## 8.1 现有 activity stream 的问题

当前 activity 主要来自：

- 请求前固定发一个 `Thinking`
- 工具前后发 `tool_started` / `tool_finished`
- 审批或模型失败时发专门事件

这已经可用，但还不够“agent-native”。

## 8.2 Responses-derived 活动事件

本轮建议新增一条原则：

`Responses reasoning block 是 activity stream 的第一等输入。`

具体表现：

- `reasoning` block -> `thinking` 或 `planning` activity
- `function_call` block -> 对应工具 activity
- `text` block -> 在流式模式下可作为“forming answer”的信号

分类规则建议：

- 若 reasoning 文本中明显包含 plan / next / step / summarize 等意图，归为 `planning`
- 否则归为 `thinking`

这样 activity stream 会从“runtime 推测工具状态”升级成“runtime + model reasoning 共同驱动”。

---

## 9. Streaming 设计

## 9.1 核心策略

不直接让 CLI 处理 provider streaming event，而是：

- `OpenAIResponsesClient` 负责消费 streaming 响应
- `ResponsesModelAdapter` 或 runtime 层负责把增量事件归一化
- CLI 继续只消费统一的 activity / text 更新

这样能保持清晰边界。

## 9.2 第一版要支持的流式信号

建议优先支持这些事件类别：

- reasoning 文本完成/增量
- output_text 增量
- function_call 完成
- response 完成

第一版不要求 token 级最细粒度，只要求：

- reasoning 能尽早出现
- tool call 能及时出现
- 最终答案能逐段出现

## 9.3 CLI 展示策略

CLI 第一版仍保持文本形态，不做 TUI。

建议新增三类前台行为：

- `[activity] Thinking: ...`
- `[activity] Planning: ...`
- `[stream] ...` 或直接追加最终答案片段

如果不想引入新标签，也可以继续用：

- `[activity]` 展示过程
- 最终 assistant text 逐步输出

但要避免把原始 provider event 直接裸露给用户。

---

## 10. 日志与调试设计

本轮必须继续强化工作区日志的价值。

建议新增：

- 对 unknown Responses item 的 warning 日志
- 对 streaming event 类别的摘要日志
- 对 adapter 丢弃的 provider 内容做最小记录

这样后续再出现“模型明明返回了内容，但前台没显示”的问题时，更容易定位是：

- client 没收到
- adapter 没解析
- runtime 没消费
- CLI 没渲染

---

## 11. 测试策略

本轮建议至少覆盖：

### 11.1 adapter 测试

- `reasoning.summary` -> `reasoning` block
- `function_call` -> `tool_call` block
- `message.output_text` -> `text` block
- unknown item -> warning + ignore

### 11.2 runtime 测试

- reasoning block 能转成 `thinking/planning` activity
- tool call 仍能正常推进工具执行
- 非流式 Responses 结果能形成最终回答

### 11.3 streaming 测试

- streaming reasoning 能被前台尽早显示
- streaming tool call 能触发活动事件
- streaming final text 能逐步形成输出

### 11.4 CLI 测试

- 前台渲染 activity 顺序稳定
- 流式输出不破坏现有 decision / plan / error 渲染

---

## 12. 分阶段落地建议

第一阶段：

- 补齐非流式 Responses item 适配
- 接通 reasoning -> runtime block -> activity stream

第二阶段：

- 为 Responses client 增加 streaming 能力
- 在 runtime 中消费 streaming 事件并推送到前台

第三阶段：

- 基于日志和真实使用反馈，微调 activity 文案与流式输出节奏

---

## 13. 设计结语

这次升级真正要解决的，不是“Responses API 能不能打通”，而是：

`mycli 能不能像一个真正的 agent 一样，理解 Responses 的返回语义，并把自己的执行过程诚实地展示出来。`

只要这两件事做好：

- Responses 语义被完整消费
- agent 执行过程被稳定呈现

`mycli` 的 agent 体验就会从“能用”明显提升到“像样”。 
