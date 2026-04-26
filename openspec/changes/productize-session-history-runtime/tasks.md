## 1. Session History Foundations

- [x] 1.1 定义 `session / thread / turn / history item` 的领域模型、持久化 schema 和兼容迁移策略
- [x] 1.2 为 session service 增加结构化 history item 的读写接口，并保留 legacy conversation 的兼容读取
- [x] 1.3 为 tool call、tool result、关键文件变更痕迹定义统一的 history item 类型和 metadata 约定

## 2. Context Baseline And Compaction

- [x] 2.1 设计并实现 `context baseline` 与 baseline update 的持久化表示
- [x] 2.2 改造 turn context / instruction contract，使其从结构化 history 与 baseline 构建模型输入
- [x] 2.3 实现 compaction item 与历史替换事务，并保留 reconstruction 所需元数据

## 3. Rollout And Recovery

- [x] 3.1 为每个 turn 引入 rollout 持久化，记录状态迁移、关键请求响应摘要和恢复快照
- [x] 3.2 实现基于 history、baseline 和 rollout 的 reconstruction / resume 主链
- [x] 3.3 明确 durable state 与临时 transport state 的边界，并更新 continuation 恢复逻辑

## 4. Runtime Integration

- [x] 4.1 改造 `AgentRuntime` 与 responses 适配层，使其在执行过程中产生并消费结构化 history item
- [x] 4.2 让工具执行、审批结果和 stop reason 进入统一 history / rollout 主链
- [x] 4.3 将 legacy conversation 降级为派生视图或兼容导出，而不是默认运行时真值

## 5. Verification And Documentation

- [x] 5.1 增加 session/history/baseline/compaction/rollout/reconstruction 的单元测试与集成测试
- [x] 5.2 运行至少一轮真实 provider smoke，以及一轮中断恢复或 resume smoke
- [x] 5.3 更新相关设计文档与运行时说明，明确该改造面向通用 agent 的工程化基础设施
