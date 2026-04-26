- [x] 1. 建立 Responses 协议模型层
- [x] 1.1 新增 typed Responses models，覆盖 request item、response item、stream event、function call output payload
- [x] 1.2 让 `responses_adapter` 优先消费 typed event，而不是 provider 原始字典
- [x] 1.3 为协议模型补齐序列化/反序列化与兼容性单测

- [x] 2. 引入 provider/model capability profile
- [x] 2.1 定义 capability profile，至少覆盖 reasoning、parallel tool calls、previous_response_id、assistant output text、empty function_call_output
- [x] 2.2 把现有 DashScope 兼容逻辑收敛到 capability-aware request shaping
- [x] 2.3 为 request builder 增加 capability profile 回归测试

- [x] 3. 建立 Responses continuation state
- [x] 3.1 为 session/runtime 增加 `last_response_id`、last normalized input、last output items 等 continuation snapshot
- [x] 3.2 实现“非 input 字段等价 + input 严格扩展”判断
- [x] 3.3 在满足条件时使用 `previous_response_id + delta input`，否则回退 full create

- [x] 4. 正式化 stream termination 与 fallback 状态机
- [x] 4.1 区分 `response.completed`、`response.failed`、stream disconnect 和 provider parse failure
- [x] 4.2 让 runtime 能根据 termination state 决定终止、重试或 fallback
- [x] 4.3 把关键状态写入 trace / log，便于调试真实 provider 行为

- [x] 5. 升级 tool output payload 表达能力
- [x] 5.1 让 `function_call_output` 支持正式 payload 抽象，而不是只有单一字符串
- [x] 5.2 保留文本渲染兼容层，避免破坏现有对外行为
- [x] 5.3 增加结构化 output payload 的单测与 session round-trip 测试

- [x] 6. 完成集成验证
- [x] 6.1 运行 responses client / adapter / runtime / session 相关单测
- [x] 6.2 运行至少一轮 continuation/fallback 相关 smoke
- [x] 6.3 记录 provider 差异与 capability profile 的运行时说明
