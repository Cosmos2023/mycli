## ADDED Requirements

### Requirement: 系统必须在工作区中持久化应用日志
系统必须在当前工作区下创建并维护一个 `log/` 目录，用于保存 `mycli` 的应用日志，而不能把这类日志仅写入用户主目录下的会话存储。

#### Scenario: 首次写日志时自动创建目录
- **WHEN** 某次 `mycli` 运行首次需要写入工作区日志
- **THEN** 系统必须自动创建 `<workspace>/log/` 以及所需子目录，而不要求用户手动准备目录结构

#### Scenario: 应用日志写入工作区
- **WHEN** 系统记录一条普通运行日志
- **THEN** 该日志必须被写入工作区下的 `log/app.log`

### Requirement: 系统必须按日志等级分类记录事件
系统必须至少支持 `info`、`warning`、`error` 三种日志等级，并按等级将日志分流到合适的文件中。

#### Scenario: info 和 warning 保留在应用日志中
- **WHEN** 系统记录 `info` 或 `warning` 级别事件
- **THEN** 该事件必须出现在 `log/app.log` 中

#### Scenario: error 同时进入错误日志
- **WHEN** 系统记录 `error` 级别事件
- **THEN** 该事件必须同时出现在 `log/app.log` 和 `log/error.log` 中

### Requirement: 系统必须为模型交互保存摘要和原始 payload
系统必须为每次模型请求保存结构化摘要事件，并分别持久化原始 request、response 或 error JSON，以便排查 provider 行为和响应解析问题。

#### Scenario: 成功请求保存 request 和 response
- **WHEN** 一次模型请求成功返回 provider 响应
- **THEN** 系统必须把该次请求的摘要事件写入 `log/model-events.jsonl`
- **THEN** 系统必须把原始 request JSON 和原始 response JSON 分别写入 `log/model-raw/`

#### Scenario: 失败请求保存错误详情
- **WHEN** 一次模型请求因 HTTP 错误、网络错误或响应解析错误而失败
- **THEN** 系统必须把失败摘要事件写入 `log/model-events.jsonl`
- **THEN** 系统必须把完整错误详情写入 `log/model-raw/` 下的错误文件

#### Scenario: 认证信息不得写入原始日志
- **WHEN** 系统持久化模型请求相关日志
- **THEN** 它不得把 `Authorization` header、API Key 或等价认证字段写入磁盘

### Requirement: 系统必须记录内部可捕获异常
系统必须在关键异常边界捕获失败时立即记录内部异常，而不能只在 provider 请求失败时才留下错误信息。

#### Scenario: runtime 内部异常被持久化
- **WHEN** runtime 主调用链中出现可捕获的未预期异常
- **THEN** 系统必须把该异常记录为 `error` 级别日志
- **THEN** 系统必须保存包含异常类型、错误消息和 traceback 的错误详情

#### Scenario: 工具执行异常被持久化
- **WHEN** 工具执行过程中抛出异常或进入明确失败路径
- **THEN** 系统必须记录对应的 `error` 级别日志，并保留必要的上下文用于排查

### Requirement: CLI 必须在错误时暴露日志位置
系统必须在用户可见的错误输出中说明错误日志位置和可用的原始错误文件位置，帮助用户快速定位故障。

#### Scenario: 模型请求失败时显示日志路径
- **WHEN** CLI 向用户展示一次模型请求失败
- **THEN** 错误输出必须包含工作区日志位置
- **THEN** 在原始错误文件可用时，错误输出必须包含该错误文件路径

#### Scenario: 日志写入失败时暴露降级信息
- **WHEN** 系统在处理某次错误时又遇到日志写入失败
- **THEN** CLI 必须向用户明确说明日志写入失败，而不能静默忽略该情况
