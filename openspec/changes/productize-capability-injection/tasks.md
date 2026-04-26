## 1. Capability Runtime Model

- [x] 1.1 定义 capability activation 领域对象，并区分静态 capability 定义与 turn-scoped activation
- [x] 1.2 扩展 runtime protocol，增加独立的 `TurnItemType.CAPABILITY` 以及对应序列化/反序列化
- [x] 1.3 为 capability activation 增加依赖状态与来源字段，覆盖 `explicit_mention`、`trigger_hint` 和缺失依赖场景

## 2. Capability Resolution

- [x] 2.1 新增 `CapabilityResolver`，支持显式 capability mention 解析
- [x] 2.2 兼容现有 `trigger_hints` 自动激活，并定义显式 mention 优先级高于隐式激活
- [x] 2.3 在 resolver 中加入第一版依赖检查，覆盖环境变量与工作区资源依赖

## 3. Runtime And Context Injection

- [x] 3.1 更新 `AgentRuntime`，在每轮 turn 中解析 capability activations 并写入 turn history
- [x] 3.2 更新 turn context assembly，使 capability section 从 activation 集合渲染，而不再只依赖单个 `active_skill`
- [x] 3.3 保持 legacy skill 注入兼容，同时避免 capability section 与 legacy 注入产生明显重复

## 4. Verification

- [x] 4.1 为 resolver 增加单元测试，覆盖显式 mention、trigger hint、优先级和依赖缺失
- [x] 4.2 为 runtime/context/protocol 增加回归测试，覆盖 `TurnItemType.CAPABILITY`、capability section 渲染与 session persistence
- [x] 4.3 运行相关测试与 smoke，验证 capability activation 会进入 turn history 且能被 turn context 正式消费
