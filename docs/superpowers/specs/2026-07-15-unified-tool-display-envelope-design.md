# Unified Tool Display Envelope 设计

## 目标

为 mycli 的工具展示建立一个由后端生成的稳定 envelope，使实时执行和恢复历史使用相同的展示语义。

完成后需要达到以下效果：

- 全部内置工具都能投影为统一字段，不再由 TUI 猜测任意 `raw_payload`。
- 同一工具在 live、session resume 和 legacy transcript fallback 中显示一致。
- Shell、Subagent、Plan 和 AskUserQuestion 等专用交互仍保留各自视图。
- MCP 和插件工具不需要采用 mycli 的内部 payload schema，也能通过稳定 fallback 展示。
- 展示 envelope 有明确内容上限，不能重新引入 session 重复膨胀。

## 非目标

- 不替换 `ToolResult`，也不改变工具执行接口。
- 不要求不同工具返回相同的 `raw_payload`。
- 不使用展示 envelope 构造模型上下文；模型输出继续由 `ToolResultFormatter` 负责。
- 不在本阶段重新设计 Shell、Subagent、Plan 或 clarification 的专用 TUI。
- 不迁移或重写已有 session 文件；旧历史在读取时兼容投影。

## 当前问题

工具执行已经统一返回 `ToolResult`，但 TUI 展示语义仍分散在多个位置：

- lifecycle event 从调用参数选择少数字段生成 `args_preview`；
- transcript projection 从 metadata、arguments 和 raw payload 中提取白名单；
- TypeScript adapter 再次按字段优先级推断 target、summary、detail 和 status；
- tool component 根据 `contentPreview`、`diffPreview` 和 `outputPreview` 决定最终文字；
- 部分工具拥有专用规则，其他工具依赖通用 fallback。

这会造成两个直接问题：新增工具时必须同时修改 Python 和 TypeScript 推断规则；实时事件与恢复历史只要缺失不同字段，就会显示不同结果。

## 核心设计

新增不可变的展示值对象 `ToolDisplayEnvelope`，作为 `ToolCall + ToolResult` 到 TUI transcript 的唯一标准投影：

```python
@dataclass(frozen=True, slots=True)
class ToolDisplayEnvelope:
    target: str | None = None
    status: str = "running"
    summary: str = ""
    detail: str | None = None
    error: str | None = None
    metrics: dict[str, int | float | str | bool] = field(default_factory=dict)
    truncated: bool = False
    omitted_chars: int = 0
    presentation: str = "tool"
```

序列化后的 metadata 使用 `display` 字段：

```json
{
  "tool_name": "Grep",
  "call_id": "call-1",
  "display": {
    "target": "src/**/*.py: ToolResult",
    "status": "success",
    "summary": "12 matches",
    "detail": "src/a.py:10: class ToolResult",
    "metrics": {
      "match_count": 12
    },
    "truncated": false,
    "presentation": "search"
  }
}
```

空值、空 metrics、`false` 和 `0` 默认值在持久化时省略。`display` 中只允许 JSON scalar、字符串和一层 metrics 字典，禁止嵌入任意 raw payload。

## 字段语义

### target

工具操作对象的单行短文本，例如文件路径、查询、URL、skill 名称、shell ID 或子代理 ID。换行和重复空白在后端归一化，最大 240 字符。

### status

只允许：

- `running`
- `success`
- `error`
- `cancelled`
- `waiting`

后端生命周期状态在进入 envelope 时完成映射，TUI 不再解释 `done`、`failed`、`completed` 等别名。

### summary

一行用户可见结果，不包含 target 的重复文本。最大 500 字符。例如 `12 matches`、`Updated`、`Activated`、`Exit 1`。

### detail

可折叠的有界展示正文。可以包含文件内容、搜索结果、diff、诊断或工具返回的文本，但不能包含未过滤 raw payload。最大 8,000 字符，超限使用 head-tail 截断。

### error

失败原因的用户可见文本。最大 2,000 字符。错误状态仍可以同时保留有用 detail，例如编译器输出。

### metrics

只保存渲染或诊断有用的小型 scalar：`duration_ms`、`exit_code`、`line_count`、`match_count`、`file_count`、`shell_id` 等。禁止列表、嵌套对象和完整统计载荷。

### presentation

提示 TUI 选择展示策略，而不是组件名称：

- `tool`
- `context`
- `mutation`
- `shell`
- `skill`
- `web`
- `diagnostic`
- `control`
- `external`

TUI 对未知值必须回退到 `tool`。

## 内置工具分类

### Context

Read、Grep、Glob、LS：

- target 使用 path、query 或 pattern；
- summary 使用读取范围、匹配数量或条目数量；
- detail 保存有界内容；
- presentation 为 `context`，允许连续聚合。

### Mutation

Write、Edit、Patch：

- target 使用文件路径；
- summary 使用 `Wrote N lines`、`Updated` 或 `No changes`；
- detail 保存 diff 或内容预览；
- metrics 保存 line count、match count 和 diagnostics count；
- presentation 为 `mutation`。

### Shell

Shell、Bash、ShellOutput、BashOutput、KillShell：

- 保留现有 shell runtime 和 `BashExecutionComponent`；
- envelope 提供统一 command target、状态、输出 detail、exit code 和 duration；
- running shell 的实时 output delta 继续走专用事件，不重复写入 envelope event；
- presentation 为 `shell`。

### Git 与诊断

GitStatus、GitDiff、GitLog、GitShow、Lint：

- target 使用 workspace、path 或 ref；
- detail 使用有界 status、diff、commit 或 diagnostics 内容；
- presentation 分别为 `context`、`mutation` 或 `diagnostic`。

### Web

WebSearch、WebFetch：

- target 使用 query 或 URL；
- summary 使用结果数量、HTTP 状态或完成状态；
- detail 保存有界摘要和来源；
- presentation 为 `web`。

### Control

Skill、Plan、enter_plan_mode、exit_plan_mode、AskUserQuestion、Task、SubagentOutput、SendMessage：

- Skill 的 target 是 skill name，summary 是 `Activated`；
- Plan 和 mode 工具的 envelope 只用于 transcript fallback，主计划面板保持不变；
- AskUserQuestion 继续使用 clarification selector；
- Task/SubagentOutput 继续使用 subagent 专用视图，不在主 transcript 重复展示；
- SendMessage 的 target 是 child session，summary 是发送状态；
- presentation 为 `skill` 或 `control`。

## 外部工具 fallback

MCP 和插件工具不强制使用内置字段。投影顺序为：

1. target 从已知标量字段中选择：`path`、`file_path`、`query`、`url`、`command`、`name`、`id`。
2. summary 使用 `ToolResult.summary`。
3. detail 优先使用 evidence，其次使用字符串 `content`、`output`、`stdout`、`stderr`。
4. error 使用 `ToolResult.error`。
5. 未识别的 raw payload 不序列化到 display。
6. presentation 使用 `external`。

外部工具没有可展示 detail 时仍能稳定显示工具名、target、status 和 summary。完整 raw payload 仍可以留在 canonical runtime/trace 中，但不能进入 session transcript。

## 数据流

```text
ToolCall + ToolResult
        |
        v
ToolDisplayProjector
        |
        +--> lifecycle tool.start/progress/complete/failed
        |
        +--> HistoryItem metadata.display
        |
        +--> TranscriptSnapshotItem metadata.display
        |
        v
TypeScript runtime adapter
        |
        +--> generic ToolExecutionComponent
        +--> existing specialized component selected by presentation
```

工具开始时 projector 可以只接收 `ToolCall`，生成 running envelope。工具完成时接收 call 和 result，生成最终 envelope。历史 coalescing 使用结果 envelope 覆盖 running envelope，但保留调用阶段已有且结果阶段缺失的 target。

## TUI 兼容策略

TypeScript adapter 按以下顺序读取：

1. `metadata.display`；
2. 现有扁平 metadata；
3. legacy `raw_payload` 和 `arguments` 推断。

新事件和新快照不再依赖第 2、3 层。兼容层至少保留到 session schema 再次升级，确保已有历史可以恢复。

`MycliShellTool` 第一阶段继续使用现有字段，由 adapter 将 envelope 映射成 `args`、`status`、`outputPreview`、`errorPreview`、`durationMs` 和 `mutating`。这样可以控制改动范围，后续再决定是否让 model 直接持有 display envelope。

## 内容限制

- target：240 字符，单行尾部截断；
- summary：500 字符，单行尾部截断；
- detail：8,000 字符，head-tail 截断；
- error：2,000 字符，head-tail 截断；
- metrics：最多 16 个 scalar 字段；
- 单个 envelope 序列化后不得超过 12,000 字符。

截断必须设置 `truncated=true` 和准确的 `omitted_chars`。detail 中只出现一个统一省略标记。

## 错误处理

- projector 不得因未知字段类型使工具执行失败；无法识别的值直接忽略。
- projector 自身异常时生成最小 fallback：工具名、状态和有界 summary/error。
- TUI 遇到损坏或未知 display 字段时回退 legacy adapter，不中断 transcript 加载。
- 非成功工具必须保留 `error`；如果工具没有提供 error，则使用有界 summary。

## 测试策略

### Python 单元测试

- 每个工具类别至少一个成功、失败和截断案例；
- 全部默认内置工具都有明确分类或显式 fallback；
- 外部 MCP/插件 payload 不泄漏未知字段；
- envelope 只包含允许的数据类型；
- running 与 completed envelope coalescing 保留 target；
- snapshot 不复制 raw payload。

### TypeScript 单元测试

- adapter 优先读取 display envelope；
- live 和 resume 输入生成相同 `MycliShellTool`；
- legacy session 继续使用现有推断；
- presentation 选择 generic、context、mutation、shell、skill 和 control 行为；
- 损坏 envelope 不导致渲染失败。

### 集成测试

- 对全部默认工具清单做覆盖断言，新增工具未分类时测试失败；
- lifecycle event、HistoryItem、snapshot 三条链路输出相同 display；
- session resume 的 golden transcript 与 live transcript 等价；
- session 大小预算不因 envelope 引入明显回归。

## 实施顺序

1. 新增 typed envelope 与纯 projector，先覆盖通用 fallback。
2. 覆盖 context、mutation、shell、git、web、diagnostic 和 control 分类。
3. 将 lifecycle 和 HistoryItem 接入 projector。
4. 将 transcript snapshot 保存 display，并保留 legacy 字段读取。
5. 更新 TypeScript adapter 优先消费 display。
6. 补齐全工具矩阵和 live/resume 等价测试。

每一步都保持现有工具执行和 TUI 可用，避免一次性替换全部兼容逻辑。
