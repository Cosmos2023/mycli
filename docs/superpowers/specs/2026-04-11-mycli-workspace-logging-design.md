# mycli 工作区日志系统设计

**日期：** 2026-04-11

**状态：** 设计已收敛，待评审

**目标：** 为 `mycli` 建立一套工作区级日志系统，能够把模型请求、模型响应、内部异常和关键运行事件统一落到当前项目的 `log/` 目录下，并按 `info`、`warning`、`error` 等等级分类，帮助用户及时观察 agent 在做什么、哪里失败了、以及模型到底返回了什么。

---

## 1. 设计结论

本轮不追求一步到位做成完整 observability 平台，而是优先建立一套正式、可扩展、能立刻帮助调试的日志系统。

本设计采用以下总体决策：

- 日志根目录固定为当前工作区下的 `log/`
- 不复用现有 `TraceService` 作为主日志入口，而是新增独立的工作区日志服务
- 同时保留两种视图：
  - 摘要事件日志，适合快速排查
  - 原始请求/响应/错误 JSON，适合深度调试
- 日志等级先收敛为三档：`info`、`warning`、`error`
- 模型客户端负责记录 provider 调用原始数据
- runtime 负责补充 turn 上下文、兜底异常和用户可见错误信息
- 代码内部异常也必须作为一等日志事件被即时记录，而不是只在模型请求失败时记录

一句话概括：

`先把 mycli 的“发生了什么、模型返回了什么、哪里出错了”系统化记录下来，再继续增强前端与 trace 展示。`

---

## 2. 为什么现在要做这一层

当前 `mycli` 已经具备：

- Responses-first 的主调用链
- CLI 活动流
- 工具执行 trace
- 会话持久化

但与正式产品化相比，日志和错误可观测性仍有明显缺口：

- 模型请求和响应没有稳定落盘到工作区
- 出错时通常只能看到一条简短错误消息，缺少上下文
- provider 返回了什么、请求发了什么，排查时不够直观
- 代码内部异常如果被兜底处理，用户很难知道失败点在哪里
- 现有 trace 更偏向工具事件，不适合承载完整模型日志和通用应用日志

这会直接导致两个问题：

- 用户不知道 agent 是卡在模型、runtime、工具，还是日志写入本身
- 一旦出现 provider 兼容性问题、响应结构变化或代码异常，定位成本很高

因此这一层的价值不是“多加几份文件”，而是：

`让 mycli 的执行链路具备基础可观测性，让调试行为从“猜”变成“查日志”。`

---

## 3. 本轮范围

### 3.1 本轮包含

- 在当前工作区下建立统一 `log/` 目录
- 新增工作区日志服务，支持按等级写日志
- 为模型请求、模型响应落盘摘要和原始 JSON
- 为模型错误、解析错误、runtime 内部异常落盘错误日志
- 为关键运行事件写入 `info` / `warning` / `error` 级别日志
- 在 CLI 错误输出中增加日志路径提示
- 为日志服务、模型客户端接入、runtime 异常记录补充测试

### 3.2 本轮不包含

- 日志轮转、压缩与自动清理
- 远程日志上传
- 完整 metrics / dashboard
- 复杂的结构化查询接口
- 基于日志的独立前端 viewer
- 全仓库所有模块一次性接入统一日志调用

第一版的目标是“能记录、能定位、能深查”，不是“一次性做完所有运维能力”。

---

## 4. 方案比较

### 方案 A：继续扩展现有 `TraceService`

把模型请求、错误和内部异常都塞进当前 trace 文件。

优点：

- 改动最小
- 可复用现有 JSONL 机制

缺点：

- `TraceService` 当前路径在 `~/.mycli/sessions`，与工作区 `log/` 诉求不一致
- trace 与日志职责不同，强行复用会混淆“实时活动/审计”和“调试日志”
- 随着模型日志进入，trace 文件可读性会迅速变差

### 方案 B：新增工作区级日志服务，模型日志与应用日志分层保存

新增 `WorkspaceLogService`，专门负责写入当前工作区的 `log/` 目录；在其之上增加模型原始请求/响应/error 落盘能力。

优点：

- 职责清晰
- 与用户预期目录一致
- 后续前端、CLI、OpenSpec 验证都能直接消费
- 适合继续扩展到工具异常和运行期事件

缺点：

- 需要新增服务与测试
- 需要分别在模型客户端和 runtime 层接入

### 方案 C：直接做统一事件总线 + 全量结构化日志

把模型、runtime、工具、CLI 事件全部做成统一总线，再由不同 sink 写文件。

优点：

- 长期最完整
- 后续做 richer timeline UI 很顺

缺点：

- 第一版工程量过大
- 容易把“先把日志建起来”做成底层框架工程
- 超出当前问题最小闭环

### 结论

选择方案 B。

---

## 5. 设计目标

本轮完成后，系统应优先达到以下效果：

1. 每次模型请求都能在工作区 `log/` 中留下摘要和原始记录。
2. 模型响应无论成功还是失败，都能留下可追溯证据。
3. 代码内部的可捕获异常能够立即被记录，而不是静默吞掉。
4. 用户在 CLI 看到错误时，能直接知道日志保存到了哪里。
5. 日志系统按 `info`、`warning`、`error` 分级，满足日常查看与故障定位两种场景。
6. 设计为后续扩展工具日志、trace 融合和前端展示留出清晰边界。

---

## 6. 日志目录与文件结构

日志根目录固定为：

```text
<workspace>/log/
```

第一版建议结构如下：

```text
log/
  app.log
  error.log
  model-events.jsonl
  model-raw/
    <timestamp>-<session_id>-<turn_id>-request.json
    <timestamp>-<session_id>-<turn_id>-response.json
    <timestamp>-<session_id>-<turn_id>-error.json
```

各文件职责：

- `app.log`
  记录全局应用日志，包含 `info`、`warning`、`error`
- `error.log`
  仅记录 `error` 级别日志，便于故障快速定位
- `model-events.jsonl`
  记录模型交互摘要事件，适合后续 CLI 或前端读取
- `model-raw/`
  保存模型原始请求、原始响应和完整错误详情

命名原则：

- 文件名必须包含 `timestamp`、`session_id`、`turn_id`
- 时间戳使用可排序格式，便于人工浏览
- 同一轮请求的 request / response / error 文件可以按共同前缀关联

---

## 7. 日志等级设计

第一版统一使用三个等级：

### 7.1 `info`

用于记录正常但重要的运行事件，例如：

- turn 开始 / 结束
- 模型请求已发送
- 模型响应已接收
- 工具开始执行 / 执行完成
- 日志文件已写入

### 7.2 `warning`

用于记录可恢复但不理想的情况，例如：

- provider 返回结构不完整但系统还能兜底
- 原始响应部分字段缺失
- 日志写入部分失败但主流程还能继续
- 某些事件只能以降级形式记录

### 7.3 `error`

用于记录明确失败或未预期异常，例如：

- 模型 HTTP 请求失败
- provider 返回非法 JSON
- 模型响应解析失败
- runtime 内部异常
- 工具执行异常
- 错误日志自身写入失败

等级策略：

- `app.log` 接收全部等级
- `error.log` 仅接收 `error`
- `model-events.jsonl` 可记录模型相关的 `info` / `warning` / `error` 摘要事件

---

## 8. 服务边界设计

## 8.1 新增工作区日志服务

新增工作区级日志服务，模块路径固定为：

```text
src/mycli/services/workspace_log_service.py
```

接口形态固定为：

```python
class WorkspaceLogService:
    def log(self, level: str, event: str, message: str, context: dict[str, Any] | None = None) -> None: ...
    def log_model_event(self, ...) -> ModelLogRecord: ...
    def write_raw_model_payload(self, ...) -> Path: ...
    def write_error_payload(self, ...) -> Path: ...
```

核心职责：

- 确保 `log/` 和 `model-raw/` 目录存在
- 将应用日志写入 `app.log`
- 将错误日志写入 `error.log`
- 将模型摘要事件写入 `model-events.jsonl`
- 将原始 request / response / error JSON 写入 `model-raw/`

不负责：

- 决定何时捕获异常
- 解释模型返回语义
- 替代现有 trace 或 session service

## 8.2 与 `TraceService` 的关系

本轮不替换 `TraceService`。

边界建议如下：

- `TraceService` 继续承担会话级工具 trace / 审计职责
- `WorkspaceLogService` 承担工作区调试日志职责

后续如果要融合，也应该基于稳定的数据模型进行桥接，而不是第一版直接混写。

---

## 9. 模型日志设计

## 9.1 记录位置

模型请求真实发生在：

- `src/mycli/infrastructure/openai_responses_client.py`
- `src/mycli/infrastructure/openai_client.py`

因此原始 request / response / provider error 的记录，应当优先在这两处接入。

## 9.2 模型摘要事件

每次模型请求至少应写入以下摘要事件：

- `model_request_started`
- `model_response_received`
- `model_request_failed`

建议字段：

- `timestamp`
- `level`
- `event`
- `session_id`
- `turn_id`
- `protocol`
- `model`
- `provider`
- `request_path`
- `response_path`
- `error_path`
- `message`

## 9.3 原始请求与响应

当模型请求发出时：

- 将发给 provider 的完整请求体写入 `model-raw/...-request.json`

当模型响应成功时：

- 将 provider 返回的完整 JSON 写入 `model-raw/...-response.json`

当 provider 返回 HTTP 错误或非法响应时：

- 将错误详情写入 `model-raw/...-error.json`

这样可以同时满足：

- 日常用摘要日志快速定位
- 深挖时直接查看原始 payload

---

## 10. 内部异常与错误记录设计

本轮明确要求：

`代码内部出现异常情况时，也必须及时记录。`

因此第一版必须把“内部异常”提升为正式设计对象，而不是只处理 provider 失败。

## 10.1 必须记录的异常边界

建议优先覆盖以下异常边界：

- 模型客户端中的 HTTP / 网络 / JSON 解析异常
- 模型适配层中的响应结构解析异常
- runtime 主调用链中的未预期异常
- 工具执行阶段的异常
- 日志写入自身的异常

## 10.2 错误记录原则

一旦异常被捕获：

- 立即写入 `app.log`
- 若等级为 `error`，同步写入 `error.log`
- 若与模型请求相关，写入 `model-events.jsonl`
- 将完整异常详情写入 `model-raw/...-error.json`

完整错误详情建议至少包含：

- `error_type`
- `message`
- `traceback`
- `phase`
- `session_id`
- `turn_id`
- `model`
- `protocol`
- `tool_name`
- 相关 request / response 路径

## 10.3 日志写入失败的处理

日志系统本身也可能失败，例如：

- 目录创建失败
- 文件写入失败
- JSON 序列化失败

第一版策略：

- 尽量不让日志失败覆盖原始业务异常
- 如果日志写入失败，应在当前异常处理分支中追加一条降级错误信息
- CLI 至少应该暴露“日志写入失败”这一事实

---

## 11. CLI 可见性设计

第一版不要求 CLI 实时展示完整日志内容，但在错误场景下必须让用户知道：

- 错误是什么
- 详情落到了哪里

建议错误文案形态：

```text
[error] Model request failed: provider returned invalid JSON
[error] Details logged to log/error.log
[error] Raw error saved to log/model-raw/<...>-error.json
```

对于 runtime 内部异常，也应保持类似风格：

- 展示简短可读摘要
- 展示日志路径
- 不直接把整个 traceback 打到前台

这样既能保证可排查，也不会让终端输出过度噪音。

---

## 12. 字段脱敏与安全边界

虽然用户当前明确希望保留完整请求/响应 JSON，但第一版仍应明确最基本安全边界。

建议策略：

- 不记录 `Authorization` header
- 不记录原始 API Key
- 若后续 payload 中引入敏感认证字段，应做统一脱敏

第一版默认允许记录：

- 模型名
- 协议
- 请求输入内容
- 工具 schema
- provider 原始响应

原因是当前需求的首要目标就是可调试性；但认证信息必须排除在外。

---

## 13. 测试策略

本轮建议至少覆盖以下测试：

### 13.1 日志服务单元测试

- 创建 `log/` 目录
- 正确写入 `app.log`
- `error` 同时写入 `app.log` 和 `error.log`
- 正确写入 `model-events.jsonl`
- 正确写入 `model-raw/` 下的 request / response / error JSON

### 13.2 模型客户端接入测试

- Responses client 成功时写 request / response 日志
- Responses client 失败时写 error 日志
- Legacy chat client 成功时写 request / response 日志
- Legacy chat client 失败时写 error 日志

### 13.3 runtime 异常测试

- runtime 捕获模型异常后，返回给 CLI 的消息包含日志路径提示
- runtime 内部异常会写入错误日志
- 日志写入失败时，系统仍保留原始错误主因

### 13.4 回归测试

- 不破坏现有 session / trace 机制
- 不破坏现有 CLI 正常输出
- 现有 OpenSpec 变更中的 grounding 和 activity stream 行为继续可用

---

## 14. 分阶段落地建议

第一阶段：

- 新增工作区日志服务
- 建立 `log/` 目录和基础文件写入能力
- 接入 responses / legacy chat 客户端的 request / response / error 落盘

第二阶段：

- 在 runtime 中补充 turn 级上下文与异常兜底记录
- CLI 输出错误日志路径

第三阶段：

- 把工具异常和更多运行期 warning 接入统一日志体系
- 视情况考虑与 activity stream / trace 做有限桥接

这样可以先拿到“模型日志可查”的核心收益，再逐步扩展到更完整的应用日志系统。

---

## 15. 设计结语

这套设计的核心不是“增加更多文件”，而是为 `mycli` 建立一个最基本但正式的可观测性底座。

第一版只要做到以下三点，就已经有明确价值：

- 每次模型调用都有记录
- 每次失败都有证据
- 每次内部异常都能被追踪

在这个基础上，后续无论是继续增强 CLI 活动流、接入更多 provider、还是做更强的前端调试视图，都会容易很多。
