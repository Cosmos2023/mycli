# mycli Grounding 增强设计

**日期：** 2026-04-10

**状态：** 设计已收敛，进入计划阶段

**目标：** 为 `mycli` 引入一层轻量但正式的 grounding / evidence 表达，优先打通 `search_text -> read_file/read_file_range -> answer` 主链，减少工具结果在回注过程中的信息损失，让 agent 更稳定地基于真实证据回答。

---

## 1. 设计结论

本轮不追求一次性把所有工具结果都做成完整的 grounding pipeline，而是先围绕“搜索证据、读取证据、基于证据回答”这一条最关键链路做强。

本设计采用以下总体决策：

- 核心策略：引入统一 `evidence` 层，而不是继续在 context rendering 里做特判字符串拼接
- 第一批覆盖工具：`search_text`、`read_file`、`read_file_range`
- 第一优先目标：提升 `search -> read -> answer` 主链稳定性，而不是先处理编辑类 diff grounding
- 回注策略：runtime 仍然向模型注入文本，但该文本由 evidence-aware 渲染器统一生成
- 兼容策略：保留现有 `summary` / `raw_payload` 结构，让旧路径继续可用，逐步迁移到 evidence-first
- 扩展边界：后续 `edit_file`、`replace_in_file`、`git_diff`、`run_shell` 也接入同一 evidence 模型

一句话概括：

`先把 mycli 的工具结果从“松散 preview”升级成“结构化证据”，优先确保 agent 在搜索和阅读链路上拿到足够真实的上下文。`

---

## 2. 为什么现在要做 grounding

当前 `mycli` 已经具备：

- Responses-first runtime 主链
- `search_text`、`read_file`、`read_file_range` 等阅读类工具
- 工具结果回注 transcript 的能力
- context summary 与 recent window 管理

但当前 grounding 仍然偏轻，主要体现在：

- 工具结果常被压缩成 `summary + preview`
- 回注逻辑依赖 `raw_payload` 的临时字段判断
- 搜索结果与文件片段缺少统一表达
- 证据片段长度和数量控制比较粗
- 模型在多步链路中容易从“看过一点内容”退化成“脑补总结”

这会直接影响以下体验：

- 搜索命中了，但后续回答没有引用关键路径和行号
- 读到了文件，但回注只保留很短 preview，下一步推理依据不足
- 多步链路里，搜索证据和阅读证据之间缺少统一表示，难以稳定串起来

当前 Phase 2 路线图把 grounding 放在第一优先级，这是合理的，因为它直接决定 agent 回答是否可信。

---

## 3. 本轮范围

### 3.1 本轮包含

- 为工具结果增加统一 `evidence` 表达
- 首批支持 `search_text`
- 首批支持 `read_file`
- 首批支持 `read_file_range`
- 新增 evidence-aware 的工具结果渲染逻辑
- 调整 runtime 中工具结果回注格式，使其更稳定地暴露路径、行号和片段
- 为 grounding 补充单元测试和至少一条集成级主链测试

### 3.2 本轮不包含

- `edit_file`、`replace_in_file`、`append_file` 的 diff grounding
- `git_diff` / `git_log` / `run_shell` 的完整 evidence 接入
- 独立的引用编号系统，例如 `[E1]`、`[E2]`
- 模型输出强制 citation 格式
- 独立的 transcript 存储 schema 迁移

这些能力仍然重要，但不应该阻塞第一版 grounding 主链落地。

---

## 4. 方案比较

### 方案 A：继续增强 preview

只扩展当前 [`context_manager.py`](../../../src/mycli/services/context/context_manager.py) 的 `render_tool_result()`，让它对 `search_text`、`read_file`、`read_file_range` 输出更多文本片段。

优点：

- 改动最小
- 最快落地
- 不需要修改工具返回模型

缺点：

- grounding 逻辑继续散落在字符串拼接代码里
- 后续扩展到编辑类工具时复杂度会快速上升
- 很难为不同证据类型制定统一预算和排序策略

### 方案 B：引入轻量 evidence 层，先接通 search/read 主链

在 `ToolResultV2` 中增加结构化 `evidence` 字段；工具负责产出证据项，context/rendering 层统一消费并生成回注文本。

优点：

- 第一版就建立清晰扩展点
- 能明显提升 `search -> read -> answer` 主链稳定性
- 后续接入编辑类、git、shell 结果时复用性高

缺点：

- 改动面比纯 preview 增强更大
- 需要同时调整工具、context 渲染和测试

### 方案 C：一次性做完整 grounding pipeline

直接引入证据模型、预算控制、片段排序、工具级策略、引用格式和跨工具统一压缩。

优点：

- 长期最完整

缺点：

- 现在范围过大
- 容易把本轮任务从“提升可信回答”拖成底层重构
- 不利于快速验证第一版 grounding 是否真能改善行为

### 结论

选择方案 B。

---

## 5. 设计目标

本轮 grounding 完成后，系统应优先达到以下效果：

1. 当 agent 使用 `search_text` 时，模型能稳定拿到多个真实命中片段，而不是只看到“Found N matches”。
2. 当 agent 随后使用 `read_file` 或 `read_file_range` 时，模型能拿到带路径和行区间语义的文件片段。
3. 在 `search -> read -> answer` 主链里，第二步和第三步都能消费第一步留下的真实证据。
4. 相关实现为后续编辑类 grounding 留出明确扩展边界，而不是继续追加 ad-hoc 分支。

---

## 6. 数据模型设计

## 6.1 新增 `ToolEvidence`

在工具层引入新的证据模型，建议放在 `src/mycli/tools/base.py` 或更合适的 domain/tools 模块中。

建议结构：

```python
@dataclass(slots=True, frozen=True)
class ToolEvidence:
    kind: str
    title: str
    path: str | None = None
    line_start: int | None = None
    line_end: int | None = None
    snippet: str | None = None
    metadata: dict[str, Any] = field(default_factory=dict)
```

字段语义：

- `kind`：证据类型，例如 `search_match`、`file_excerpt`
- `title`：给模型看的简短标签
- `path`：workspace 相对路径
- `line_start` / `line_end`：片段的行区间，适用于搜索和文件片段
- `snippet`：核心证据文本
- `metadata`：保留附加上下文，例如 `query`、`glob`、`match_index`

本轮先控制在最小集合，不引入过多泛化字段。

## 6.2 扩展 `ToolResultV2`

在 [`base.py`](../../../src/mycli/tools/base.py) 的 `ToolResultV2` 中新增：

```python
evidence: tuple[ToolEvidence, ...] = field(default_factory=tuple)
```

保留现有字段：

- `summary`
- `artifacts`
- `raw_payload`
- `error`

原因：

- 兼容当前逻辑和测试
- 允许逐工具渐进迁移
- 避免第一版 grounding 牵动所有 tool consumers

---

## 7. 工具级 grounding 设计

## 7.1 `search_text`

当前 `search_text` 已经返回：

- `path`
- `line_number`
- `line`

本轮新增 evidence 产出规则：

- 每条 match 转换成一条 `search_match` evidence
- `title` 形如 `Match 1 for "<query>"`
- `path` 使用 workspace 相对路径
- `line_start` 与 `line_end` 都等于 `line_number`
- `snippet` 为匹配行文本
- `metadata` 记录：
  - `query`
  - `glob`
  - `case_sensitive`

数量控制：

- 工具层最多生成前 `N` 条 evidence，建议默认 `N=8`
- `raw_payload["matches"]` 仍可保留更多结果用于兼容，但 evidence 主路径只注入最有价值的前几条

这样模型即使不读完整 payload，也能拿到稳定、直接可推理的命中片段。

## 7.2 `read_file`

`read_file` 不应继续只提供“整文件内容 + 简短 preview”，而应明确产出文件片段证据。

本轮规则：

- 当文件较短时，可把整个内容作为单条 `file_excerpt` evidence
- 当文件较长时，只提取开头稳定片段作为第一版 evidence
- 证据需带上 `path`
- 若能可靠计算行号，则补齐 `line_start=1` 与对应 `line_end`
- `title` 建议为 `Excerpt from <path>`

第一版不强求复杂 chunking。重点是让 `read_file` 的回注内容不再只是截断 preview，而是正式的文件证据项。

## 7.3 `read_file_range`

`read_file_range` 最适合做 grounding，因为它天然带区间语义。

本轮规则：

- 每次成功读取都产出一条 `file_excerpt` evidence
- `path` 为目标路径
- `line_start` / `line_end` 使用实际返回区间
- `snippet` 为读取到的原始文本片段
- `title` 形如 `<path>:<start>-<end>`

这会成为 `search -> read -> answer` 主链中最可靠的第二步证据来源。

---

## 8. Context / Rendering 设计

## 8.1 新的职责边界

当前 [`ContextManager`](../../../src/mycli/services/context/context_manager.py) 同时承担：

- conversation summary
- tool result preview 拼接

本轮保持类边界基本不变，但把工具结果渲染改成 evidence-first：

- 优先渲染 `result.evidence`
- 没有 evidence 时，再回退到现有 `raw_payload` 预览逻辑

这样迁移路径平滑，不会要求所有工具同步改造。

## 8.2 Evidence 渲染格式

建议回注格式保持纯文本，但结构稳定，示例：

```text
Tool result: Found 3 matches for approval
Evidence:
- [search_match] src/mycli/services/approval/approval_service.py:12
  snippet: class ApprovalService:
- [search_match] src/mycli/application/runtime/agent_runtime.py:44
  snippet: from mycli.services.approval.approval_service import ApprovalService
```

对于文件片段：

```text
Tool result: Read lines 20-40 from README.md
Evidence:
- [file_excerpt] README.md:20-40
  snippet: ...
```

这一格式的目标不是给人类做漂亮展示，而是让模型稳定识别：

- 这是什么类型的证据
- 来自哪个路径
- 对应什么行区间
- 证据正文是什么

## 8.3 预算与截断

第一版不要把预算控制做成复杂系统，但需要明确最小策略：

- `render_tool_result()` 对总字符数仍保留上限
- 单条 evidence 的 `snippet` 需要单独截断，例如 160 到 240 字符
- 多条 evidence 之间优先保留“多条短证据”，而不是“一条超长证据”

优先级建议：

- `search_text`：更多条数、较短 snippet
- `read_file_range`：较少条数、较长 snippet
- `read_file`：单条 excerpt 即可

---

## 9. Runtime 与 Prompt 设计

## 9.1 Runtime

本轮不改动 runtime 主循环的核心控制流，只调整“工具结果如何写回 transcript”这一段。

预期变化：

- runtime 仍向 conversation 中写入 `tool` message
- `tool` message 的 `content` 由 evidence-aware 渲染器生成
- trace 事件中可额外记录 `evidence_count`，但不是本轮硬要求

这意味着：

- Responses-first 主链不需要重写
- `tool_result` block 结构不需要新类型
- 模型侧能立即受益于更强的证据文本

## 9.2 Prompt

本轮 prompt 只做轻量调整，不引入复杂 citation 规则。

建议在系统提示或 ReAct 提示中进一步强化一条原则：

- 当工具结果里提供路径、行号和证据片段时，优先基于这些证据总结，而不是脱离证据泛化回答

重点是“鼓励 grounded reasoning”，不是强制输出模板。

---

## 10. 测试策略

本轮至少需要以下测试层次：

### 10.1 单元测试

- `search_text` 会产出 `search_match` evidence
- `read_file` 会产出 `file_excerpt` evidence
- `read_file_range` 会产出带行区间的 `file_excerpt` evidence
- `ContextManager.render_tool_result()` 在 evidence 存在时优先使用 evidence
- evidence 截断逻辑不会把路径或行号丢掉

### 10.2 集成测试

至少增加一条围绕 `search -> read -> answer` 的主链测试，验证：

- 第一轮搜索结果被回注为包含路径/行号/片段的 evidence 文本
- 第二轮阅读结果被回注为包含区间语义的 excerpt
- 模型 stub 能基于这些内容完成 grounded answer

### 10.3 回归测试

- 没有 evidence 的旧工具仍能正常工作
- 现有 runtime / CLI / trace 测试不应因为新增字段而破坏

---

## 11. 实施顺序

建议按以下顺序实施：

1. 定义 `ToolEvidence` 与 `ToolResultV2.evidence`
2. 为 `search_text` 接入 evidence
3. 为 `read_file` 与 `read_file_range` 接入 evidence
4. 改造 `ContextManager.render_tool_result()` 为 evidence-first
5. 适度调整 prompt 文案
6. 补齐单元测试与主链集成测试

这样能尽早拿到行为改进，同时避免一开始就改动过多 runtime 部件。

---

## 12. 风险与约束

### 风险 1：证据片段过长，反而挤占上下文窗口

缓解：

- 控制单条 snippet 长度
- 控制 evidence 条数
- 优先保留路径、行号和关键正文，而不是冗长文本

### 风险 2：证据模型设计过度泛化

缓解：

- 第一版只覆盖 `search_match` 与 `file_excerpt`
- 暂不抽象成复杂层级或多态体系

### 风险 3：旧工具和旧测试被一并拖进重构

缓解：

- 保留 `summary` 和 `raw_payload`
- evidence 采用渐进接入
- 渲染层先做“有 evidence 用 evidence，无 evidence 回退旧逻辑”

### 风险 4：只增强显示，但没有改善 agent 行为

缓解：

- 增加主链集成测试
- 以 `search -> read -> answer` 的行为闭环验证效果，而不是只看字符串渲染

---

## 13. 成功标准

如果本轮 grounding 完成，`mycli` 应达到以下状态：

- `search_text` 的结果回注不再只是“Found N matches”，而是稳定包含路径、行号和命中片段
- `read_file` 与 `read_file_range` 回注能提供正式的文件 excerpt 证据
- `search -> read -> answer` 主链中的回答更容易锚定真实文件内容
- grounding 扩展路径变清晰，后续可把同一 evidence 模型复用到编辑类和 git/shell 工具

---

## 14. 最终判断

当前 `mycli` 不缺“能不能读文件”，而是缺“读到的东西能不能稳定地留在模型可用上下文里”。

因此，这轮 grounding 的正确方向不是继续追加 preview，而是建立最小但正式的 evidence 层，并优先把 `search_text`、`read_file`、`read_file_range` 串成可信的证据链。

这样做既能直接改善回答可信度，也能为下一步编辑类 grounding 和更完整的 tool result grounding 打下统一基础。
