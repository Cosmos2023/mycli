## 1. 共享 grounding 契约

- [x] 1.1 在 `src/mycli/domain/tools.py` 中新增共享的 `ToolEvidence` dataclass
- [x] 1.2 扩展 `ToolResult` 和 `ToolResultV2`，让它们都能携带 `evidence` 元组，并在 `to_legacy()` 转换时保留这些数据
- [x] 1.3 新增或更新单元测试，验证 evidence 在旧版转换路径中不会丢失

## 2. 工具 evidence 产出器

- [x] 2.1 更新 `src/mycli/tools/search_text.py`，让它在保留现有 payload 字段的同时，为高价值匹配产出 `search_match` evidence
- [x] 2.2 更新 `src/mycli/tools/read_file.py`，让它产出整文件的 `file_excerpt` evidence
- [x] 2.3 更新 `src/mycli/tools/read_file_range.py`，让它产出带实际返回行边界的 `file_excerpt` evidence
- [x] 2.4 扩展读取/搜索工具测试，覆盖新的 evidence 输出

## 3. 以 evidence 为优先的 transcript 渲染

- [x] 3.1 重构 `src/mycli/services/context/context_manager.py`，让工具结果渲染优先使用结构化 evidence，并在没有 evidence 时回退到现有 payload-preview 路径
- [x] 3.2 增加 context manager 测试，验证 evidence 格式化与截断后仍能保留路径和行号元数据
- [x] 3.3 确保 grounded 工具消息仍然能够穿过 runtime transcript 流程，而不改变 block 或 session 持久化契约

## 4. Prompt 指引与工作流验证

- [x] 4.1 更新 `src/mycli/prompts/system.py`，让模型在 evidence 可用时优先基于路径、行号和 snippet 推理
- [x] 4.2 增加 runtime 测试，覆盖 `search -> read_file_range -> answer` 的回注工作流
- [x] 4.3 更新 prompt 测试，验证新的 grounding guidance
- [x] 4.4 运行 implementation plan 中定义的定向 grounding `pytest` 测试集和 `ruff` 检查
