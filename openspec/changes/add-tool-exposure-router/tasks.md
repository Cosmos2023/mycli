## 1. Tool Exposure Runtime Model

- [x] 1.1 定义 `ToolExposure`、exposure entry 与相关分类枚举，区分 `direct`、`deferred`、`dynamic`
- [x] 1.2 扩展 runtime protocol / execution context，加入结构化 tool exposure 字段与 exposure turn item
- [x] 1.3 为 tool route identity 增加统一表示，支持静态工具、dynamic tools 和预留的 provider-specific namespace

## 2. Exposure Planning

- [x] 2.1 新增 `ToolExposurePlanner`，基于静态 registry、用户请求与当前上下文生成本轮 exposure
- [x] 2.2 把 capability activation 作为 planner 输入，使 capability 能贡献本轮 dynamic tools
- [x] 2.3 为 runtime-generated task-scoped tools 增加接入口，并纳入 `ToolExposure.dynamic`

## 3. Tool Routing And Runtime Integration

- [x] 3.1 新增统一 `ToolRouter`，让 direct 与 dynamic tools 共用校验、执行与结果回写路径
- [x] 3.2 更新 `AgentRuntime`，让模型工具定义从 exposure 渲染，并基于 router 执行工具调用
- [x] 3.3 保持静态 registry 作为基础工具注册层，但不再直接决定模型侧全量工具暴露

## 4. Context And Surface Visibility

- [x] 4.1 更新 `TurnContextAssembler`，让 tool exposure section 从结构化 `ToolExposure` 渲染 direct/deferred/dynamic 分类摘要
- [x] 4.2 更新 turn history / trace / session persistence，让 exposure 决策进入结构化可见对象
- [x] 4.3 为 deferred tools 的可见但不可调用语义增加回归校验，避免再次退化为全量直出

## 5. Verification

- [x] 5.1 为 exposure planner 增加单元测试，覆盖 direct/deferred/dynamic 分类和 capability/runtime 两类 dynamic tool 来源
- [x] 5.2 为 router 与 runtime 增加集成测试，覆盖静态 direct tools、dynamic tools 与未暴露工具的拒绝调用
- [x] 5.3 运行相关测试与 smoke，验证 turn context / trace 能展示结构化 tool exposure，且模型只拿到本轮允许调用的工具集合
