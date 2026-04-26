## Context

`mycli` 现在已经具备 Responses-first runtime、CLI 活动流、工具 trace 和会话持久化，但日志职责仍然分散在不同位置。`TraceService` 主要面向 `~/.mycli/sessions` 下的会话级事后审计，模型基础设施层只负责请求与解析，不负责工作区可见的调试日志，CLI 在报错时也只能给出一条简短失败消息，无法让用户直接知道日志去了哪里。

这次变更的目标，不是把整个仓库一次性改造成复杂 observability 平台，而是建立一套稳定的工作区级日志底座，让模型请求、模型响应、关键运行事件和内部异常都能在当前仓库的 `log/` 目录中被记录下来。这样既能帮助开发调试，也能为后续更丰富的前端展示、trace 融合和排障能力留出清晰扩展点。

约束：
- 第一版必须使用标准库完成，不引入新的第三方日志依赖。
- 需要保持现有 `TraceService`、session 持久化和活动流能力继续可用。
- 需要同时覆盖 Responses 与 legacy chat 两条模型调用路径。
- 日志系统不能把认证信息写入磁盘，例如 `Authorization` header 或 API Key。

## Goals / Non-Goals

**Goals:**
- 新增工作区级 `WorkspaceLogService`，固定写入 `<workspace>/log/`。
- 统一支持 `info`、`warning`、`error` 三种日志等级。
- 为模型请求、模型响应和模型错误同时写入摘要事件与原始 JSON。
- 在 runtime 中补充 turn 级上下文，并记录内部可捕获异常。
- 让 CLI 在错误时向用户显示日志文件路径和原始错误文件路径。
- 保持现有 trace 和 session 机制不变，避免引入兼容性回归。

**Non-Goals:**
- 不在第一版里实现日志轮转、压缩、上传或清理策略。
- 不把现有 `TraceService` 直接替换成统一日志系统。
- 不把全仓库所有模块都一次性迁移到新 logger 接口。
- 不引入可视化日志 viewer 或复杂检索接口。
- 不在第一版中设计完整 metrics、telemetry 或远程 observability 管线。

## Decisions

### 1. 使用独立的 `WorkspaceLogService`，而不是扩展 `TraceService`

这次变更会新增 `src/mycli/services/workspace_log_service.py`，负责所有工作区日志落盘。

为什么这样设计：
- `TraceService` 当前写入 `~/.mycli/sessions`，关注点更接近会话审计和工具轨迹，而不是当前仓库里的调试日志。
- 工作区日志和会话 trace 的消费方式不同。前者强调当前项目内快速排障，后者强调历史会话追溯。
- 独立服务更容易扩展出 `app.log`、`error.log`、`model-events.jsonl` 和 `model-raw/` 这种分层结构。

考虑过的替代方案：
- 直接往 `TraceService` 增加模型与错误事件：否决，因为这会让 trace 和日志职责耦合，路径也不符合用户要的工作区目录。
- 只在 CLI 中做临时文件写入：否决，因为 CLI 不应承担核心日志职责。

### 2. 采用“文本日志 + 结构化事件 + 原始 JSON”三层并存

第一版日志目录固定为：
- `log/app.log`
- `log/error.log`
- `log/model-events.jsonl`
- `log/model-raw/*.json`

为什么这样设计：
- `app.log` 适合直接 `tail`，用户和开发者日常查看成本最低。
- `model-events.jsonl` 更适合后续机器读取、前端消费和回放。
- 原始 request / response / error JSON 是调 provider 问题时最直接的证据，不能只保留摘要。

考虑过的替代方案：
- 全部写纯文本：否决，因为后续无法稳定让前端和工具程序消费。
- 全部写 JSON：否决，因为人类日常排障时会更累。

### 3. 以日志等级驱动文件分流

系统只定义三档等级：
- `info`
- `warning`
- `error`

并采用以下分流规则：
- `app.log` 接收全部等级
- `error.log` 只接收 `error`
- `model-events.jsonl` 只记录模型相关的结构化事件，但允许等级为三者之一

为什么这样设计：
- 三档已经足够覆盖第一版调试需求，不需要一开始引入更多层级。
- 能让用户快速区分“正常行为”“可恢复异常”“明确失败”。

考虑过的替代方案：
- 继续只靠一份单一日志文件：否决，因为模型日志与应用错误会混在一起。
- 引入 `debug` 或更细等级：当前否决，因为还没有对应的消费需求。

### 4. 模型基础设施层负责记录原始 provider 事实，runtime 负责补充上下文

这次变更里：
- `openai_responses_client.py` 和 `openai_client.py` 负责记录原始 request / response / HTTP error
- runtime 负责补充 `session_id`、`turn_id`、`phase`、用户可见错误摘要和内部异常记录

为什么这样设计：
- 原始 provider payload 只有基础设施层最清楚，应该在那里原样保存。
- turn 级别的业务上下文只有 runtime 最清楚，应该在那里挂接。
- 这样可以避免模型客户端知道太多 runtime 控制流，也避免 runtime 重新拼 request 细节。

考虑过的替代方案：
- 全部在 runtime 统一记录：否决，因为 runtime 不掌握完整底层响应细节。
- 全部在模型客户端记录：否决，因为客户端不掌握完整 turn 语义和 CLI 展示需求。

### 5. 内部异常必须作为一等事件即时记录

第一版不会把日志只限定在“模型调用成功/失败”这一个点上，而是要求所有关键异常边界在捕获后立刻落盘。

首批异常边界包括：
- 模型 HTTP / 网络异常
- provider 返回非法 JSON 或结构不合法
- 模型适配层解析异常
- runtime 主循环中的未预期异常
- 工具执行异常
- 日志系统自身写入失败

为什么这样设计：
- 如果只记录 provider 失败，真正的内部 bug 仍然很难定位。
- “内部异常即时记录”是让日志系统具备产品价值的关键条件之一。

考虑过的替代方案：
- 只记录顶层兜底错误：否决，因为会丢掉最近的出错上下文。

### 6. CLI 只负责错误可见性，不承担核心持久化职责

CLI 在第一版里只做两件事：
- 保持现有输出兼容
- 在错误场景下显示日志路径和原始错误文件路径

为什么这样设计：
- CLI 是用户界面层，适合负责“告诉用户去哪看”，不适合负责“决定怎么记日志”。
- 这样也能避免同一错误在 CLI 和 runtime 各写一遍，导致重复和不一致。

考虑过的替代方案：
- CLI 直接读完整 `error.json` 并原样打印：否决，因为前台噪音太大，也会暴露过多底层细节。

## Risks / Trade-offs

- [日志量增长过快] → 第一版先只覆盖模型、runtime 和关键错误边界，不把全仓库所有事件都写进去。
- [模型原始 JSON 过大] → 接受这一取舍，因为当前优先目标是可调试性；后续再评估轮转和清理策略。
- [日志写入失败掩盖原始异常] → 记录日志时优先保留原始异常主因，日志失败只作为附加错误暴露。
- [路径职责混乱，trace 和 log 重复] → 明确分层：trace 继续服务会话审计，workspace log 服务调试和排障。
- [引入日志后影响现有测试和 CLI 输出] → 增加定向测试，确保正常路径与错误路径都可验证。

## Migration Plan

1. 新增 `WorkspaceLogService`，完成 `log/` 目录创建、文本日志写入、模型事件写入和原始 JSON 写入能力。
2. 在模型客户端接入 request / response / error 落盘，并补齐必要的日志上下文字段。
3. 在 runtime 中补充 turn 级上下文、内部异常记录和 CLI 可见错误路径。
4. 为 CLI 错误输出增加日志位置提示。
5. 补充单元测试和集成测试，确认不破坏现有 trace、session 和活动流行为。

回滚策略：
- 直接回滚该 change 即可；第一版不涉及持久化 schema 迁移，也不改变现有 session 文件结构。

## Open Questions

- 后续是否需要为日志增加轮转和自动清理，以避免长时间运行后 `model-raw/` 过大。
- 将来如果需要把工具 trace 和 workspace log 做统一时间线，是否采用桥接层还是统一事件模型。
- 是否要在后续版本里增加 `debug` 级别，用于更细粒度的开发调试。
