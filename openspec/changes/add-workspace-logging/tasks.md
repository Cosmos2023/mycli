## 1. 工作区日志基础设施

- [x] 1.1 新增 `src/mycli/services/workspace_log_service.py`，实现工作区 `log/` 目录、`app.log`、`error.log`、`model-events.jsonl` 与 `model-raw/` 的基础写入能力
- [x] 1.2 定义日志等级和结构化模型事件所需的数据结构，确保 `info`、`warning`、`error` 分流行为稳定可测
- [x] 1.3 增加日志服务测试，覆盖目录创建、应用日志写入、错误日志分流和原始 JSON 落盘

## 2. 模型客户端日志接入

- [x] 2.1 更新 `src/mycli/infrastructure/openai_responses_client.py`，为模型请求成功和失败路径记录摘要事件与原始 request / response / error JSON
- [x] 2.2 更新 `src/mycli/infrastructure/openai_client.py`，让 legacy chat 路径具备同等的日志记录能力
- [x] 2.3 增加模型客户端测试，验证成功、HTTP 失败、网络失败和非法 JSON 场景都会生成正确日志，并且不会把认证信息写入磁盘

## 3. Runtime 与 CLI 错误可见性

- [x] 3.1 在 `src/mycli/application/runtime/agent_runtime.py` 中补充 turn 级日志上下文和内部异常记录，确保 runtime 可捕获异常即时落盘
- [x] 3.2 更新 CLI 错误输出，让用户在失败时看到工作区日志路径和可用的原始错误文件路径
- [x] 3.3 增加 runtime 与 CLI 测试，验证内部异常记录、错误路径展示和日志写入失败时的降级行为

## 4. 回归验证

- [x] 4.1 运行工作区日志、模型客户端、runtime 和 CLI 相关测试，确认新日志系统未破坏现有 trace、session 和活动流能力
- [x] 4.2 运行相关 `ruff` 检查，确认新增日志代码符合当前代码规范
