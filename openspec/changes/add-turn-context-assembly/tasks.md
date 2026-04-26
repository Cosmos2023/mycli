## 1. Turn Context Schema

- [x] 1.1 定义 turn context、turn context section、section type 与相关 metadata 的正式领域对象
- [x] 1.2 明确 raw execution context 与 assembled turn context 的职责边界，并补齐类型与注释
- [x] 1.3 为 capability section 与 tool exposure section 预留可扩展字段，避免后续再次拆主链

## 2. Assembly Pipeline

- [x] 2.1 从 `AgentRuntime` 中拆分 source collection、section assembly 与 prompt rendering 三个阶段
- [x] 2.2 新增 assembler，把 conversation、memory、plan、runtime reminders、active skill、workspace/project instructions 与 tool summary 映射为标准 section
- [x] 2.3 定义并测试 section 的确定性顺序和启用条件，避免同类上下文在不同 turn 中位置漂移

## 3. Prompt Integration

- [x] 3.1 更新 `src/mycli/prompts/react.py`，让现有 renderer 从 assembled context 渲染而不是直接依赖 `ExecutionContext`
- [x] 3.2 保持当前 React-style prompt 的行为兼容，同时减少 prompt builder 对 runtime 字段结构的直接耦合
- [x] 3.3 为后续 provider-specific renderer 保留同一 assembled context 的复用入口

## 4. Verification and Observability

- [x] 4.1 增加单元测试，覆盖 section 内容、顺序、空 section 行为与 active skill/tool exposure 渲染
- [x] 4.2 为调试路径补充 assembled context 摘要输出，帮助定位上下文注入问题
- [x] 4.3 运行相关测试与 smoke，确认 context assembly 接入后没有破坏现有 runtime、prompt 和 repo-analysis 行为
