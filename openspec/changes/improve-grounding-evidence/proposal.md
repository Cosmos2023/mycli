## 为什么要做

`mycli` 已经有一条可运行的、以 Responses 为主的 runtime 主链，也具备一组实用的读取与搜索工具，但工具结果回注时仍然主要依赖轻量级 summary 和临时 preview。这会让 `search -> read -> answer` 这条链路的可靠性低于应有水平，也会增加 agent 基于不完整证据做泛化，而不是基于刚刚实际读到的文件内容继续推理的概率。

grounding 是当前 Phase 2 产品化里优先级最高的缺口，因为它直接影响回答是否可信。现在需要补上一层小而正式的 evidence 表达，这样搜索命中、文件 excerpt，以及未来的 diff / command 输出，才能以一致方式穿过 runtime。

## 会改什么

- 引入一套共享的工具 evidence 契约，能够同时挂在 `ToolResultV2` 和旧版 `ToolResult` 上。
- 更新 `search_text`，让它输出结构化的 `search_match` evidence，而不再只依赖 summary 文本和 raw payload 中的 matches。
- 更新 `read_file` 和 `read_file_range`，让它们输出带稳定路径与行区间语义的 `file_excerpt` evidence。
- 调整工具结果渲染逻辑，使其优先使用 evidence-first 的 transcript 格式，同时为尚未改造的工具保留当前 raw-payload preview fallback。
- 加强 prompt 和 runtime 验证，确保后续推理明确优先使用 grounded 的路径、行号和 snippet evidence。

## 能力范围

### 新增能力
- `tool-grounding`：定义工具如何产出结构化 evidence，以及在搜索和文件读取工作流中，grounded 工具结果如何保留在 agent 可见的 transcript 中。

### 修改现有能力
- 无。

## 影响范围

- 受影响代码：`src/mycli/domain/tools.py`、`src/mycli/tools/base.py`、`src/mycli/tools/search_text.py`、`src/mycli/tools/read_file.py`、`src/mycli/tools/read_file_range.py`、`src/mycli/services/context/context_manager.py`、`src/mycli/prompts/system.py`
- 受影响测试：读取/搜索工具测试、context manager 测试、agent runtime 回注测试、prompt 测试
- 外部 API 和依赖：无
- 用户可见影响：在使用搜索/读取工具之后，agent 的回答应当更稳定地引用具体文件路径、行号和 evidence snippet
