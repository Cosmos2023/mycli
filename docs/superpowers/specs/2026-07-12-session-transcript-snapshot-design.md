# Session Transcript Snapshot 瘦身设计

## 目标

把 `session.json` 从完整运行时会话副本改成轻量的 TUI transcript 快照。

改完以后需要达到这些效果：

- `session.json` 保留全部用户可见历史，恢复后 TUI 内容不丢失。
- 模型续聊所需的完整 canonical messages 只从 SQLite 加载。
- provider metadata、raw reasoning、流式 delta 和重复工具载荷不再进入快照。
- 同一次工具调用在快照中只有一个稳定条目，不同时保存 call、preview、summary 和 result 多份内容。
- 快照缺失或损坏时，可以从 SQLite 重建。
- 旧版 `session.json` 可以继续读取，并在后续保存时安全迁移。

## 当前问题

当前 `session.json` 同时承担了多个职责：

- 会话元数据索引；
- 完整模型消息持久化；
- provider 原始响应记录；
- 工具调用与工具结果记录；
- TUI 历史恢复；
- 兼容性快照。

最大的样本约为 `1.9 MB`，其中绝大部分空间位于 `messages`：

- tool messages 约 `963 KB`；
- assistant messages 约 `706 KB`；
- tool result blocks 约 `662 KB`；
- tool call blocks 约 `331 KB`；
- reasoning blocks 约 `220 KB`。

同一段信息还可能同时出现在以下位置：

- 原始工具输出；
- formatter summary；
- `args_preview`；
- runtime block metadata；
- provider metadata；
- TUI 展示文本。

另外，每条消息和 block 都会写出大量 `null`、空数组和空字典。删除这些空字段可以减少一部分空间，但无法解决大型内容重复保存的问题。

## 设计原则

### SQLite 是 canonical 数据源

SQLite 继续保存完整 conversation messages，并负责：

- 构造下一次模型请求；
- 恢复 tool call 与 tool result 关系；
- 会话搜索与 lineage 组合；
- 从持久化数据重建 TUI transcript。

`session.json` 不再参与模型上下文构造。

### session.json 只保存可见 transcript

`session.json` 保存全部 TUI 可见历史和恢复 transcript 所需的最小结构字段，但不保存内部运行时载荷。这里的“可见”指产品允许投影到 transcript 的最终内容，而不是每个流式中间状态。工具输出在进入 transcript 前已经按 TUI 展示规则截断，因此“全部可见历史”不等于保存未展示的 raw output。

### 单一投影规则

新增独立的 transcript 投影边界：

```text
Runtime Message
    ├── SessionSerialization -> SQLite canonical message
    └── TranscriptProjector  -> session.json transcript item
```

TUI 恢复与快照生成必须共享相同的 typed transcript item 语义，避免 serializer 和 renderer 分别维护两套判断逻辑。

### 有界工具内容

用户消息和 Assistant 可见正文完整保留。工具输出、diff、搜索结果和诊断信息必须使用有界展示内容。

单个 shell transcript item 最多保存 `8,000` 个 Unicode 字符。超过限制时保留 head 和 tail，并记录省略字符数。其他工具复用各自 TUI 展示层已有的截断结果，不回退到 raw payload。

## 新版快照结构

新版 `session.json` 使用明确的 schema version：

```json
{
  "schema_version": 2,
  "session_id": "4be33988-9070-4ed9-8613-972185d6578a",
  "title": "检查测试失败原因",
  "cwd": "/workspace/project",
  "model": "deepseek-chat",
  "provider": "deepseek",
  "state": "idle",
  "message_count": 42,
  "created_at": "2026-07-12T10:00:00Z",
  "updated_at": "2026-07-12T10:05:00Z",
  "transcript": [
    {
      "id": "user-1",
      "type": "user_message",
      "text": "运行测试"
    },
    {
      "id": "assistant-1",
      "type": "assistant_message",
      "text": "我先检查测试配置。"
    },
    {
      "id": "tool-1",
      "type": "command",
      "command": "pytest -q",
      "status": "completed",
      "output": "128 passed in 4.21s",
      "exit_code": 0,
      "duration_ms": 4210
    }
  ]
}
```

序列化时省略：

- 值为 `null` 的可选字段；
- 空数组和空字典，但必需的顶层 `transcript` 即使为空也保留为 `[]`；
- 默认状态字段；
- 可以从 transcript 或 SQLite 推导的内部字段。

## Transcript Item 类型

第一阶段支持以下稳定类型：

- `user_message`
- `assistant_message`
- `reasoning_summary`
- `command`
- `tool`
- `file_change`
- `plan`
- `warning`
- `error`
- `web_search`
- `image`
- `subagent`
- `status`

每个 item 都包含稳定 `id` 和 `type`。只有 TUI 渲染需要的字段可以进入 item。

无法映射到专用类型但确实对用户可见的旧内容使用通用 `status` item 保存文本，不能静默丢弃。

## 投影规则

### 用户消息

保存：

- 用户可见文本；
- 本地图片或附件的展示引用；
- TUI 用于区分消息的稳定 ID。

不保存：

- 图片 base64；
- provider 输入结构；
- IDE 注入的重复 metadata。

### Assistant 消息

保存最终可见正文。流式 delta 不逐条保存，消息完成时只写最终合并结果。

### Reasoning

只保存 TUI 允许展示的 reasoning summary。以下内容不得进入快照：

- raw reasoning content；
- encrypted reasoning；
- provider reasoning metadata；
- reasoning delta。

### Shell 与 Bash

保存：

- command；
- status；
- TUI 可见的最终 output；
- exit code；
- duration；
- TUI 可见的运行状态。

单个条目的 output 最多 `8,000` 字符。截断格式保留 head 和 tail，并包含：

- `truncated: true`；
- `omitted_chars`；
- 明确的省略标记。

运行中的每个 output delta 只更新内存和实时 TUI，不触发快照写入。稳定保存点只写当前工具条目的一份状态。shell runtime session identifier 继续由 shell runtime 自己管理，不进入 transcript 快照。

### 其他工具

保存 TUI 最终展示的结构化摘要。禁止直接复制整个 `raw_payload` 或 runtime metadata。

Read、Glob、Git、Lint、MCP 和搜索结果继续遵守各自 formatter 的展示上限。快照只能接收 formatter 或 transcript projector 输出，不能绕过它读取原始结果。

### 文件修改

保存 TUI 可见的文件列表、状态和 diff 摘要。完整 patch、文件快照和 rewind 数据继续由现有专用存储管理。

### 工具调用去重

同一个 tool call 使用稳定 item ID：

1. 工具开始时在内存 transcript 中创建 `running` item。
2. 工具完成时原位更新相同 item。
3. 快照中不能同时出现独立 call、preview、summary 和 result 条目。
4. 恢复时按 item ID 重建最终显示状态。

## 保存流程

每次 canonical conversation 变更时，SQLite 先提交。快照只在稳定边界保存：

- 用户消息提交；
- Assistant 消息完成；
- 工具调用完成；
- turn 完成或中断；
- 应用正常退出。

保存流程：

1. 从当前 conversation 或 SQLite canonical messages 生成 typed transcript。
2. 应用白名单字段和内容上限。
3. 使用 `indent=2` 的多行 JSON 编码写入同目录临时文件。
4. flush 并关闭临时文件。
5. 原子替换正式 `session.json`。

shell output delta、reasoning delta 和 token count 更新不触发完整快照重写。

## 序列化格式

schema v2 `session.json` 使用 UTF-8、`indent=2` 和稳定字段排序写成多行 JSON，确保用户可以直接在编辑器中阅读和检查。格式化只改变空白，不恢复 canonical `messages`、provider metadata 或其他已移除的重复数据。

快照继续通过“临时文件写入、文件 `fsync`、原子替换”完成更新。`events.jsonl` 仍保持一行一个事件，不应用多行格式化。

## 加载流程

### 正常加载

1. 读取 `session.json` 元数据和 transcript。
2. 使用 transcript 快速恢复 TUI 历史。
3. 从 SQLite 加载 canonical conversation，供模型续聊使用。
4. 后端对 transcript 与 SQLite 的 session ID 和 message count 做轻量一致性检查。

### 快照缺失或损坏

1. 不阻止会话恢复。
2. 从 SQLite canonical messages 重新投影 transcript。
3. 原子写入新的 `session.json`。
4. 记录诊断日志，但不向模型注入错误信息。

### SQLite 不可用

如果 `session.json` 可读，TUI 可以进入只读历史模式，但不能声称已经恢复完整模型上下文。需要向用户显示明确错误，不能使用 transcript 伪造 canonical conversation。

## 旧版迁移

新版 reader 同时支持 schema v1 和 v2。

schema v1 加载流程：

1. 优先检查 SQLite 是否已有该会话的 canonical messages。
2. SQLite 已有消息时，直接从 SQLite 生成 v2 transcript。
3. SQLite 没有消息时，读取旧版 `session.json.messages` 并使用现有 deserializer 导入。
4. 导入成功后提交 SQLite。
5. 从 canonical messages 生成 v2 transcript。
6. v2 临时文件完整写入后，再原子替换旧快照。

迁移失败时保留原始 v1 文件，不允许写出部分迁移结果。

不在升级时批量改写所有历史会话。每个会话在首次加载或下次保存时惰性迁移。

## 错误处理

- SQLite 写入失败时，不更新 `session.json`，避免快照领先 canonical 数据。
- `session.json` 写入失败时，不回滚已经成功的 SQLite turn；记录错误并在下一个稳定边界重试。
- 临时文件写入失败时删除临时文件，保留原快照。
- 未知 transcript item 类型由 reader 忽略并记录日志，其他条目继续恢复。
- 单个 malformed item 不能导致整个会话无法加载。
- item ID 冲突时保留首次出现的顺序，并使用最后一次有效状态更新该 item。

## 与 Codex 的对应关系

Codex 使用追加式 canonical rollout 和独立会话索引，并在落盘前过滤瞬态事件。TUI 从结构化 thread items 生成显示历史，而不是保存一份 provider 原始对象作为 UI 状态。

mycli 已经使用 SQLite 保存 canonical conversation，因此不需要复制 Codex 的完整 rollout 架构。对应关系为：

| Codex | mycli |
|---|---|
| canonical rollout | SQLite conversation messages |
| session index | 精简 `session.json` 元数据 |
| thread item projection | `TranscriptProjector` |
| TUI replay | 从 transcript 快照快速恢复 |
| cold rollout compression | 后续独立处理旧 `events.jsonl` |

本设计只处理 `session.json`。`events.jsonl` 的事件过滤、轮转和 zstd 冷压缩属于后续独立工作。

## 非目标

本阶段不做：

- 修改模型上下文压缩算法；
- 重构 SQLite conversation schema；
- 对 SQLite payload 做内容寻址去重；
- 批量压缩历史 `events.jsonl`；
- 删除旧版 reader；
- 改变用户和 Assistant 可见正文的内容。

## 测试范围

### 单元测试

- 每种 message/block 到 transcript item 的投影。
- schema v2 快照是 `indent=2` 的多行 JSON，且可以重新读取。
- `null`、空数组、空字典和默认字段省略。
- provider metadata、raw reasoning 和 `args_preview` 不进入快照。
- shell output 使用 UTF-8 安全的 head-tail 截断。
- 同一 tool call 从 running 更新到 completed 后只保留一个 item。
- 未知旧消息降级为可见 `status` item。

### 集成测试

- 保存、退出、恢复后 TUI transcript 内容一致。
- 模型续聊从 SQLite 加载，不读取 transcript 作为上下文。
- schema v1 惰性迁移到 v2。
- SQLite 已有消息时不重复导入旧 snapshot messages。
- 快照损坏后可以从 SQLite 重建。
- SQLite 不可用时只允许恢复只读 TUI 历史。
- 原子写失败时旧快照保持完整。
- output delta 不触发逐 delta 快照重写。

### 体积回归

使用当前约 `1.9 MB` 的真实会话样本生成 v2 快照，并检查：

- 顶层不存在 canonical `messages`；
- 不包含 provider metadata 和 raw reasoning；
- 不包含重复 `summary`、`args_preview` 和 raw payload；
- 每个 tool call 最多对应一个 transcript item；
- v2 文件显著小于 v1，同时恢复出的 TUI 可见历史一致。

体积测试不绑定固定压缩比例，因为用户和 Assistant 可见正文长度不可控。结构性断言作为稳定回归门槛。

## 验收标准

- `session.json` 只包含会话元数据和全部 TUI 可见 transcript。
- TUI 看不到的内部数据不会进入快照。
- 完整模型上下文只从 SQLite 恢复。
- 旧会话无需批量迁移即可继续使用。
- 快照丢失或损坏不会导致 canonical conversation 丢失。
- shell 和其他工具输出具有明确硬上限。
- 同一工具调用不会在快照中重复保存多个表示。
- 最大样本迁移后 TUI 可见历史与迁移前一致。
- `session.json` 默认以可读的多行 JSON 保存，`events.jsonl` 继续遵循 JSONL 格式。
