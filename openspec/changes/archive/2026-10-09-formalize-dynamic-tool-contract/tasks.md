## 1. Dynamic Tool Domain Model

- [ ] 1.1 定义 `DynamicToolDescriptor`、`DynamicToolScope`、`DynamicToolLifecycleState` 与 conflict outcome 等核心模型
- [ ] 1.2 为 dynamic tool identity、route key、origin metadata 建立统一表示，覆盖 runtime-generated 与 capability-contributed 两类来源
- [ ] 1.3 扩展 runtime protocol / execution context，使 dynamic tools 不再只是临时 tool spec，而是通用 agent runtime 中的正式运行时对象

## 2. Planner / Router Integration

- [ ] 2.1 更新 `ToolExposurePlanner`，让 dynamic tools 的声明、暴露与过期基于正式 descriptor / scope 运行
- [ ] 2.2 更新 `ToolRouter`，基于稳定 descriptor 和 route identity 处理 dynamic tool 调用与冲突
- [ ] 2.3 为 turn-scoped 与 thread-scoped dynamic tools 增加统一注册、复用与失效逻辑

## 3. Lifecycle Visibility And Persistence

- [ ] 3.1 扩展 turn context / activity / trace，记录 dynamic tool 的 declared、exposed、invoked、completed、failed、expired 事件
- [ ] 3.2 扩展 session persistence / replay，保存 dynamic tool descriptor 快照与 lifecycle 状态变化
- [ ] 3.3 让 CLI surface 能展示 dynamic tool 的来源、scope 与生命周期，而不只展示调用结果

## 4. Capability And Future Bridge Readiness

- [ ] 4.1 更新 capability injection 接口，使 capability-contributed tools 通过统一 dynamic tool contract 注入
- [ ] 4.2 为 provider / MCP / hosted tools 预留 descriptor origin 与 route 扩展点，但不在本 change 中完成 bridge
- [ ] 4.3 为 dynamic tool conflict handling 增加显式错误或状态反馈，避免静默覆盖旧工具
- [ ] 4.4 验证这套 contract 能承载 future coding、debugging、writing、research、automation capability 的工具注入语义

## 5. Verification

- [ ] 5.1 为 dynamic tool descriptor、scope 与 conflict 规则增加单元测试
- [ ] 5.2 为 runtime / router 增加集成测试，覆盖声明未暴露、暴露后调用、调用失败、scope 过期与冲突处理
- [ ] 5.3 运行相关测试与 smoke，验证 trace / session / CLI activity 能看到完整 dynamic tool 生命周期
