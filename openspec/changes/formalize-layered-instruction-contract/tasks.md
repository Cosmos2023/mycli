- [x] 1. 定义分层指令契约领域模型与装配接口
- [x] 1.1 新增 `InstructionContract` 及其 section / fragment 类型，明确 `base`、`developer`、`contextual_user`、`conversation` 的边界
- [x] 1.2 增加 instruction contract assembler，使其从 `TurnContext` 生成模型可消费的分层输入

- [x] 2. 重构 runtime 模型输入主链去消费 instruction contract
- [x] 2.1 更新 `AgentRuntime`，移除 `active_skill` 直接 system message 注入的主路径
- [x] 2.2 更新 legacy prompt/rendering 路径，使其从 instruction contract 渲染，而不是直接拼接 `system.py` / `react.py` / runtime 特判
- [x] 2.3 为后续 Responses-style provider 保留将 `base`、`developer`、`contextual_user` 分开映射的接口

- [x] 3. 将运行时约束与环境片段迁移到正确层级
- [x] 3.1 将 runtime decision policy、tool exposure summary、capability policy reminders 迁移到 developer instructions
- [x] 3.2 将 workspace instructions、environment context、capability bodies、dynamic tool context 迁移到 contextual user fragments
- [x] 3.3 收敛 `system.py` 的职责，让其只保留稳定、低频变化的通用代理契约

- [x] 4. 建立 prompt scaffolding 的 memory / trace 边界
- [x] 4.1 让脚手架型 contextual fragments 可被 memory/summary 识别并按规则排除
- [x] 4.2 让 trace / debug summary 能展示本轮注入了哪些 developer/contextual fragments 及其来源

- [x] 5. 完成回归验证与文档更新
- [x] 5.1 增加 instruction contract、prompt assembly、runtime 注入顺序、memory exclusion 的单元测试
- [x] 5.2 运行相关 runtime / agent / prompt 测试与至少一轮真实 smoke
- [x] 5.3 更新相关设计文档或运行时说明，明确 `mycli` 的 layered instruction contract 面向通用 agent，而不是任务特化 agent
