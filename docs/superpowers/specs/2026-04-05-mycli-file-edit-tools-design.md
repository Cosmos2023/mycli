# mycli 文件编辑增强工具设计

**日期：** 2026-04-05

**状态：** 设计已收敛，进入计划阶段

**目标：** 为 `mycli` 增加一批高频、结构化、可审计的文件编辑与关键词搜索工具，减少模型在常见文件读写和文本检索场景下对 `run_shell` 的依赖，同时保留 `run_shell` 作为兜底能力。

---

## 1. 设计结论

本轮不追求“一次性补齐全部命令行工具”，而是优先补齐最常见、最高频、最适合结构化建模的文件编辑动作。

本设计采用以下总体决策：

- 工具策略：走平衡型路线，优先专用文件工具，保留 `run_shell` 兜底
- 第一批范围：先做文件编辑增强，不先做目录/文件管理全家桶
- 工具集合：新增 `read_file_range`、`append_file`、`replace_in_file`
- 搜索能力：把现有 `search_text` 明确升级为更接近 `rg` 的关键词搜索工具
- 现有工具定位：`edit_file` 保留，但明确为“整文件覆盖写入兜底”
- 模型提示策略：明确要求优先使用专用文件工具，其次 `edit_file`，最后才是 `run_shell`
- 安全策略：读工具保持低风险，写工具维持中风险并默认自动允许，`run_shell` 继续高风险/兜底

一句话概括：

`让 mycli 在高频文件编辑场景里更像 coding agent，而不是总想绕回 shell。`

---

## 2. 为什么现在要补这一层工具

当前 `mycli` 已经有：

- `list_directory`
- `read_file`
- `search_text`
- `edit_file`
- `run_shell`
- `update_plan`

这套骨架已经能工作，但对真实 coding 场景仍然偏粗：

- 读文件只能整文件读，读大文件不经济
- 小范围修改经常退化成整文件覆盖
- 追加内容没有专用工具
- 局部文本替换没有专用工具
- 模型虽然理论上能用 `edit_file` 或 `run_shell` 完成任务，但路径并不优雅，也不够稳

在 coding agent 中，最常见的真实动作通常不是“执行一个万能命令”，而是：

- 看某几行
- 在文件末尾追加一点内容
- 把某段旧文本精确替换成新文本

这些动作天然适合工具化，而且比 shell 更容易做：

- 参数约束
- 安全审计
- 失败解释
- 测试覆盖
- 后续 trace 与日志落盘

---

## 3. 范围

### 3.1 本轮包含

- 新增 `read_file_range`
- 新增 `append_file`
- 新增 `replace_in_file`
- 增强 `search_text`，让它覆盖高频 `rg` 使用场景
- 调整 prompt，让模型优先走专用文件工具
- 更新 CLI `/tools` 列表与 README 文档
- 为新工具补充单元测试与风险策略测试

### 3.2 本轮不包含

- `create_file` / `mkdir` / `move` / `copy` / `delete`
- 行级编辑工具，如 `insert_at_line`、`delete_line_range`
- git 专用工具
- 二进制文件编辑
- 跨 workspace 的任意路径操作

---

## 4. 方案比较

### 方案 A：最小增强

只补 `read_file_range`、`append_file`、`replace_in_file`，其他都不动。

优点：

- 改动小
- 风险低
- 能快速补上最明显短板

缺点：

- 模型侧不一定会稳定优先使用这些工具
- `edit_file` 和 `run_shell` 的职责边界仍然不够清晰

### 方案 B：平衡方案

补齐三种新工具，并把现有搜索工具升级为 `rg` 风格，同时重新强调工具优先级：

- `search_text`
- 专用编辑工具
- `edit_file`
- `run_shell`

并同步调整 prompt、README、测试与安全策略。

优点：

- 最贴合当前仓库阶段
- 改动闭环完整
- 能显著改善模型的工具使用路径

缺点：

- 仍然不是完整文件工具体系

### 方案 C：激进扩展

直接把文件编辑做成全套，包括按行插入、按范围删除、文件创建、移动、删除等。

优点：

- 能力覆盖最全

缺点：

- 参数设计复杂
- 测试矩阵膨胀
- 模型误用概率更高
- 会把本轮范围从“增强编辑能力”扩成“重做文件系统工具层”

### 结论

选择方案 B。

---

## 5. 新工具设计

## 5.1 `read_file_range`

**用途：** 按行读取文件片段，避免每次都整文件读。

**参数：**

- `path: string`
- `start_line: integer`
- `end_line: integer`

**语义：**

- 行号为 1-based
- `start_line` 与 `end_line` 均为闭区间
- 要求 `start_line >= 1`
- 要求 `end_line >= start_line`
- 仅读取 UTF-8 文本文件

**成功返回建议：**

- `summary`：`Read lines 20-40 from README.md`
- `raw_payload`：
  - `path`
  - `start_line`
  - `end_line`
  - `actual_start_line`
  - `actual_end_line`
  - `content`

**失败条件：**

- 文件不存在
- 行号非法
- 路径越界 workspace
- 文件非 UTF-8 文本

**风险等级：** `low`

---

## 5.2 `append_file`

**用途：** 在文件末尾追加文本内容，适合补充文档、日志、配置片段或代码片段。

**参数：**

- `path: string`
- `content: string`

**语义：**

- 以 UTF-8 文本方式追加
- 若文件不存在，则创建新文件
- 若父目录不存在，则报错，不隐式创建目录
- 追加内容保持原样，不自动插入额外换行

**成功返回建议：**

- `summary`：`Appended 42 chars to docs/notes.md`
- `raw_payload`：
  - `path`
  - `appended_chars`
  - `created`
  - `before_size`
  - `after_size`

**失败条件：**

- 路径越界 workspace
- 父目录不存在
- 目标路径是目录
- 内容不是字符串

**风险等级：** `medium`

---

## 5.3 `replace_in_file`

**用途：** 对文件执行精确文本替换，适合局部补丁和小范围修复。

**参数：**

- `path: string`
- `old_text: string`
- `new_text: string`
- `expected_count: integer | optional`

**语义：**

- 执行字面量文本替换，不做正则
- `old_text` 不能为空字符串
- 若提供 `expected_count`，则实际命中次数必须与其完全一致，否则不写入
- 若未提供 `expected_count`，则默认要求至少命中一次

**成功返回建议：**

- `summary`：`Replaced 1 occurrence in src/mycli/prompts/react.py`
- `raw_payload`：
  - `path`
  - `replacement_count`
  - `diff`

**失败条件：**

- 未命中任何文本
- `expected_count` 与实际命中数不一致
- 路径越界 workspace
- 文件不存在
- 文件非 UTF-8 文本

**风险等级：** `medium`

---

## 5.4 现有工具重新定位

### `search_text`

当前仓库已经有 `search_text`，但能力比较粗。

本轮建议不是再额外增加一个“裸 `rg` 命令工具”，而是把 `search_text` 升级成 `rg` 风格的结构化搜索能力。这样做比直接暴露 shell 命令更合适，因为：

- 参数更容易约束
- 输出可以稳定结构化
- 风险等级仍可保持 `low`
- 更适合模型稳定调用

推荐增强方向：

- 支持限制搜索根路径，如 `path`
- 支持文件过滤，如 `glob`
- 支持大小写开关，如 `case_sensitive`
- 支持结果上限，如 `max_matches`
- 返回格式继续保持结构化 `matches`

一句话说，就是：

`对用户体验看起来像 rg，对 runtime 来说仍然是安全的 schema-first tool。`

### `edit_file`

继续保留，但定义应更明确：

- 它是“整文件覆盖写入”
- 用于模型已经重建完整文件内容时
- 不再是优先路径

### `run_shell`

继续保留，但定位收紧为：

- shell/进程类动作
- 工具体系未覆盖的兜底能力
- 明显不应由专用文件工具承担的任务

---

## 6. 路径与安全边界

所有新增工具都必须遵守统一边界：

- 仅允许访问当前 `workspace_root` 及其子路径
- 不允许通过 `..`、绝对路径或符号链接逃逸 workspace
- 目录路径与文件路径错误要给出明确失败信息

这意味着当前若工具里还存在“直接 `(workspace_root / path).resolve()` 然后无校验使用”的模式，本轮应顺手收敛为共享的路径解析辅助函数，而不是让每个工具自行处理。

---

## 7. 失败语义与可观测性

新工具不应只在异常时崩掉，而应尽量输出稳定、可读的失败语义。

建议遵循：

- 参数问题：返回 `success=False` 与明确 `error`
- 业务前置条件不满足：返回 `success=False` 与明确 `error`
- 真正不可恢复的程序错误：允许抛异常，但优先收敛为工具结果

工具结果里应尽量提供结构化 `raw_payload`，方便后续：

- transcript 持久化
- debug 日志
- UI 展示
- 审计与回放

---

## 8. Prompt 与模型使用策略

本轮不仅是“加 tool”，还要让模型更倾向于正确使用。

推荐把提示策略明确成：

- 需要读局部片段时优先 `read_file_range`
- 需要文件尾部补充时优先 `append_file`
- 需要精确局部替换时优先 `replace_in_file`
- 需要整文件改写时再用 `edit_file`
- 明确不要为了普通文件编辑优先调用 `run_shell`

这样做的收益是：

- tool 选择更稳定
- transcript 更干净
- shell 风险更低

---

## 9. 测试策略

本轮至少需要覆盖：

- 正常路径
- 参数非法
- 路径越界
- 文件不存在
- `search_text` 的 `rg` 风格过滤参数
- `replace_in_file` 命中次数不符
- CLI `/tools` 列表包含新工具
- prompt 文案体现“优先专用文件编辑工具”
- 安全策略对新增工具的风险分类正确

优先以单元测试为主，不强制增加集成测试。

---

## 10. 分阶段落地顺序

建议按以下顺序实现：

1. 先补共享路径解析与 `read_file_range`
2. 再增强 `search_text` 以覆盖 `rg` 高频场景
3. 再补 `append_file`
4. 再补 `replace_in_file`
5. 最后统一接入 CLI、prompt、README 与风险分类

原因是：

- `read_file_range` 最简单，适合作为新工具模式样板
- `append_file` 与 `replace_in_file` 都会复用同一套路径/错误处理
- prompt/README/CLI 放最后做，能减少来回修改

---

## 11. 风险与后续演进

### 风险 1：工具数量增加后模型选择可能更分散

缓解：

- 明确 prompt 优先级
- 保持工具职责边界清晰

### 风险 2：路径安全若继续散落在各工具里，后续会难维护

缓解：

- 抽共享辅助函数

### 风险 3：`replace_in_file` 若不约束命中次数，容易误改多处

缓解：

- 支持 `expected_count`
- mismatch 时拒绝写入

### 后续建议

完成本轮后，下一批最自然的扩展是：

- `create_file`
- `mkdir`
- `move_path`
- `delete_path`

这样可以形成“搜索增强 + 编辑增强 + 文件管理增强”的完整工具层。
