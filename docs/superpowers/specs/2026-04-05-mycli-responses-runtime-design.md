# mycli 面向 Responses API 的 Runtime 重构设计

**日期：** 2026-04-05

**状态：** 设计草案已完成，待用户审阅

**目标：** 将 `mycli` 的模型协议主线从 OpenAI-compatible `chat/completions` 迁移为 `Responses API`，同时把内部 runtime 从 provider-specific message/tool_call 语义升级为 item/block-first 抽象。CLI 交互、审批流和工具语义尽量保持稳定，但底层模型接入与运行时数据模型全面面向现代 agent 场景重构。

---

## 1. 设计结论

这次重构不应理解为“把 HTTP 端点从 `/chat/completions` 改成 `/responses`”，而应理解为：

`以 Responses API 为外部主协议，重建 mycli 的模型输出抽象与 transcript 结构。`

本设计采用以下总体决策：

- 模型协议主线：全面押注 `Responses API`
- 内部运行时抽象：从 message-first 升级为 item/block-first
- CLI 表现：尽量保持当前 REPL、审批、slash command 和 plan 展示不变
- DeepSeek 策略：允许暂时降级或不可用，不再作为协议设计锚点
- 后续模型方向：优先面向 OpenAI 与未来可能支持 Responses 或等价 item-based 协议的 Qwen 系列

---

## 2. 为什么要从 chat/completions 迁移到 Responses

### 2.1 chat/completions 已不再适合作为 agent 主协议

当前 `mycli` 虽然已经部分摆脱了“强制 JSON 文本协议”，但核心模型层仍然建立在以下前提上：

- provider 返回 `message`
- 文本在 `message.content`
- 工具调用在 `message.tool_calls`
- runtime 通过 `assistant_message + tool_call + done` 这种固定结构推进

这种结构在“单轮文本问答 + 简单函数调用”里还能工作，但不适合作为长期 agent runtime 的基础，因为它天然缺少：

- 更细粒度的 output item / block 表达
- 对 reasoning、tool call、tool result、text output 的统一抽象
- 更现代的 provider 对齐路径
- 面向后续扩展的稳定协议边界

### 2.2 Responses 更接近现代 agent 的真实执行形态

Responses 的核心价值，不只是一个新接口，而是它把模型输出显式结构化为若干 item：

- 文本输出
- 工具调用
- reasoning
- 其他 provider-native output item

这与 agent runtime 真正需要消费的数据更接近：

`不是一条 message，而是一组有类型的运行时事件。`

因此，Responses 更适合作为：

- tool-using agent
- 长链路 reasoning
- 多阶段输出处理
- provider adapter 抽象层

的主协议。

---

## 3. 这次重构的范围

### 3.1 包含的内容

- 新建 Responses 主线模型 adapter
- 新建统一的 runtime block / item 抽象
- 改造 `AgentRuntime` 使其按 block 驱动，而不是按 `assistant_message/tool_call` 二元结构驱动
- 改造 transcript 持久化格式，使其能保存 block/item 级别的信息
- 保持 CLI 输出层尽量稳定
- 更新 README 与配置说明，使其明确 Responses 是主协议

### 3.2 暂不包含的内容

- 不在本轮解决 DeepSeek 的 Responses 兼容问题
- 不在本轮同时支持 Anthropic/Gemini 原生协议
- 不在本轮改造为多 agent / subagent runtime
- 不在本轮重做 CLI 交互形态
- 不在本轮引入复杂的 provider capability discovery

---

## 4. 当前实现的关键问题

### 4.1 模型层仍然是 provider shape 驱动

当前 runtime 虽然已经支持原生 tool calling，但内部仍然直接围绕以下 provider-specific 概念组织：

- `messages`
- `tool_calls`
- `tool_call_id`
- `assistant_message`

这意味着 runtime 理解的是“某个 provider 的消息结构”，而不是“agent 的运行时输出语义”。

### 4.2 内部契约过于扁平

当前 `ModelAction` 的结构为：

- `assistant_message`
- `progress_message`
- `tool_call`
- `done`

这套契约适合简单循环，但不适合未来的 item-based 响应，因为它默认同一轮最多只存在一个主要动作。现代模型输出更自然的表达应该是：

- 一组 block
- 每个 block 有显式类型
- runtime 根据 block 类型推进执行

### 4.3 transcript 仍然偏 message 视角

当前 conversation 虽然已经能记录 assistant tool calls 和 tool messages，但本质上仍是“消息 + 附加字段”，而不是“typed transcript items”。这会限制：

- provider output 的保真度
- runtime 恢复的一致性
- 后续的日志、trace、调试和压缩

---

## 5. 新的核心设计

## 5.1 外部协议主线

`mycli` 默认模型接入统一改为 `Responses API`。

主线调用方式不再是：

- `POST /chat/completions`

而是：

- `POST /responses`

未来如果某 provider 不支持 Responses：

- 可以进入 legacy fallback
- 但不再反向影响主 runtime 设计

### 5.2 内部模型输出抽象

新增统一的运行时 block 契约，作为 provider adapter 与 runtime 之间的唯一语言。

建议的核心数据模型如下：

```python
@dataclass(slots=True, frozen=True)
class RuntimeBlock:
    type: str
    text: str | None = None
    tool_name: str | None = None
    tool_arguments: dict[str, object] | None = None
    call_id: str | None = None
    provider_id: str | None = None
    metadata: dict[str, object] = field(default_factory=dict)
```

推荐先支持的 block 类型：

- `text`
- `tool_call`
- `tool_result`
- `reasoning`

其中：

- `text`：模型给用户的自然语言内容
- `tool_call`：模型请求执行工具
- `tool_result`：runtime 执行完工具后回注的结果
- `reasoning`：可选保留的中间推理或摘要型 item

### 5.3 一轮模型响应的统一结构

新增聚合结果模型：

```python
@dataclass(slots=True, frozen=True)
class ModelTurnResult:
    blocks: tuple[RuntimeBlock, ...] = ()
    done: bool = False
    response_id: str | None = None
```

runtime 不再依赖：

- `assistant_message`
- `tool_call`
- `progress_message`

这种单字段式结构，而改为：

- 一轮返回多个 block
- runtime 按 block 顺序消费

### 5.4 输入 transcript 也升级为 item-first

当前内部输入仍是 `ModelMessage`。本设计建议引入更适合 Responses 的 transcript item 表达，例如：

```python
@dataclass(slots=True, frozen=True)
class RuntimeItem:
    role: str
    blocks: tuple[RuntimeBlock, ...] = ()
```

不过为了控制首轮改造规模，可以采用两阶段策略：

#### 第一阶段

- 保留 conversation 的 message 存储壳子
- 但把 `tool_calls/tool_call_id/content` 逐步映射为 block

#### 第二阶段

- 真正把 conversation 存储迁移为 item/block-first

设计上应直接朝第二阶段建模，但实现允许阶段性过渡。

---

## 6. 新的 provider adapter 边界

### 6.1 Responses adapter 成为主实现

新增：

- `src/mycli/infrastructure/models/responses_adapter.py`
- `src/mycli/infrastructure/openai_responses_client.py`

职责分层如下：

#### `OpenAIResponsesClient`

负责：

- 构造 `Responses API` HTTP 请求
- 传递 `input`
- 传递工具定义
- 解析 provider 原始响应

不负责：

- runtime 决策逻辑
- 工具执行
- 审批逻辑

#### `ResponsesModelAdapter`

负责：

- 把 Responses 原始 output items 归一化为 `RuntimeBlock`
- 产出 `ModelTurnResult`

不负责：

- 持久化
- CLI 呈现
- 工具执行

### 6.2 旧 adapter 的地位

当前这两个模块不再作为主线：

- `CompatChatModelAdapter`
- `NativeToolModelAdapter`

它们应被标记为：

- `legacy`
- `fallback`

并从默认 CLI wiring 中移除。

---

## 7. AgentRuntime 如何改成 block-driven

### 7.1 当前 loop 的问题

当前 loop 大体是：

1. 调模型
2. 读 `assistant_message`
3. 读 `tool_call`
4. 如果有 tool_call 就执行工具
5. 否则输出 assistant_message

这要求模型输出符合一个非常窄的契约。

### 7.2 新 loop 的目标形态

迁移后应变为：

1. 组装当前 transcript
2. 调 `ResponsesModelAdapter`
3. 得到 `ModelTurnResult(blocks=...)`
4. 顺序遍历 block
5. 对 `tool_call` block 走审批与执行
6. 对 `tool_result` block 注回 transcript
7. 对 `text` block 作为最终或阶段性输出候选
8. 当本轮完成且无待执行动作时结束

也就是：

`loop 驱动力从字段判断变成 block 消费。`

### 7.3 审批流如何保持兼容

CLI 层仍保持现有数字选项：

- `1` 仅本次允许
- `2` 拒绝
- `3` 本次会话内始终允许同类命令

但 runtime 内部保存的待审批对象，不再仅仅是 `ToolCall`，而应至少能恢复：

- 发起该调用的 `tool_call` block
- `call_id`
- 与当前 turn 相关的 transcript checkpoint

这样恢复执行时，block 链路不会丢失。

### 7.4 文本输出策略

为了保持 CLI 表现尽量稳定：

- runtime 可以把同一轮内多个 `text` block 合并成最终 assistant 文本
- `reasoning` block 默认不直接展示给用户
- `tool_result` block 默认不直接裸露给用户，而是继续回注模型

这保证用户仍然看到：

- 进度更新
- 审批提示
- 最终自然语言答复

而不是一堆原始 provider item。

---

## 8. 工具系统在 Responses 主线下如何表达

当前 `ToolRegistryV2` 与 schema-first 方向是正确的，应该保留。

需要调整的不是工具本身，而是工具如何暴露给 provider：

- 由 Responses client 负责把内部 `ModelToolDefinition` 转成 Responses 所需工具 schema
- 由 Responses adapter 负责把 provider 的工具调用 item 转成 `RuntimeBlock(type="tool_call")`

工具执行后，runtime 生成：

```python
RuntimeBlock(
    type="tool_result",
    call_id="call_xxx",
    tool_name="read_file",
    text="...",
)
```

并将其重新注入 transcript。

---

## 9. 持久化与 transcript 迁移

### 9.1 持久化目标

会话持久化应该能表达：

- 用户输入
- assistant 文本输出
- assistant 发起的工具调用
- tool result
- suspended turn checkpoint
- call_id

### 9.2 迁移策略

推荐采用渐进迁移：

#### 第一步

- 保留现有 `Conversation` 外壳
- 在内部序列化中增加 block/item 信息
- 旧字段继续保留一段时间，便于兼容现有测试与会话文件

#### 第二步

- 新 session 全量写入 item/block-first 结构
- 旧 session 仅读兼容，不再按旧格式写出

#### 第三步

- 清理旧的 compat-only 字段

### 9.3 兼容性立场

由于这次是协议主线切换，可以接受：

- 旧 session 的部分行为退化
- DeepSeek 在新主线下暂不可用

但不应接受：

- 新 session 的 tool transcript 丢失 `call_id`
- 审批恢复后无法正确续跑

---

## 10. 配置与 provider 策略

### 10.1 新的默认前提

README 和配置说明应明确：

- 默认模型接入协议为 `Responses API`
- 推荐 provider 为 OpenAI 或未来支持 Responses 的兼容 provider
- DeepSeek 当前不保证可用

### 10.2 provider 策略

本轮不做复杂 provider 自动探测。

建议只保留简单配置：

- `model`
- `api_base_url`
- `api_key`
- 可选的 `protocol = "responses" | "legacy_chat"`

默认值建议是：

- `protocol = "responses"`

这样可以清晰表达：

- Responses 是主线
- legacy chat 只是临时回退

---

## 11. 推荐的落地路径

本设计建议分四个实施阶段落地。

### 阶段 1：建立新的模型契约

- 新增 `RuntimeBlock`
- 新增 `ModelTurnResult`
- 新增 `ResponsesModelAdapter`
- 新增 `OpenAIResponsesClient`
- 为 Responses item 解析编写单测

### 阶段 2：改造 runtime 主循环

- 将 `AgentRuntime` 从 `assistant_message/tool_call` 驱动改为 block-driven
- 保持审批、planning、memory 和 skill 注入现有行为不变
- 增加 tool_result block reinjection 测试

### 阶段 3：迁移 transcript 与持久化

- 改造 `SessionService`
- 持久化 `call_id`、block、suspended turn checkpoint
- 校验恢复执行链路

### 阶段 4：切换 CLI 主线并清理 legacy

- `main.py` 默认接线到 Responses 主链
- 更新 README
- legacy chat adapter 降级为 fallback
- 为不支持 Responses 的 provider 给出可理解错误

---

## 12. 风险与应对

### 风险 1：Responses item 结构与当前假设不完全一致

应对：

- provider 原始响应解析只放在 client/adapter 层
- runtime 永远不直接理解 provider payload

### 风险 2：Qwen 的未来支持形态未完全确定

应对：

- 以内部 block 契约为核心
- provider 差异只留在 adapter

### 风险 3：过渡期代码同时存在两套主线

应对：

- 在代码和 README 中明确标注 `responses` 是主线
- `compat/native chat` 标为 legacy

### 风险 4：session 持久化的历史兼容成本

应对：

- 接受短期兼容层
- 优先保证新 session 正确性

---

## 13. 设计结论总结

这次改造的真正目标不是“支持一个新接口”，而是：

`把 mycli 从基于 provider message 形状的 agent，升级为基于 typed runtime blocks 的 agent。`

因此，本次 Responses 重构的核心不是 HTTP 层，而是：

- 内部输出模型重构
- runtime loop 重构
- transcript 持久化重构
- provider adapter 重新分层

一旦这一步完成，`mycli` 后续接 OpenAI、Qwen，甚至未来其他 item-based provider 时，成本都会显著下降。

---

## 14. 下一步建议

本设计确认后，下一步应立刻为本设计单独编写 implementation plan，计划重点包括：

- 新模型契约文件与测试
- Responses client / adapter 落地
- AgentRuntime block-driven 改造
- SessionService transcript 迁移
- CLI 主线切换与 README 更新

建议计划文件名：

- `docs/superpowers/plans/2026-04-05-mycli-responses-runtime-implementation.md`
