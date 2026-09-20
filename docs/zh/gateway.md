# Gateway API

[English](../gateway.md) | **简体中文** | [中文目录](README.md)

`mycli app-server` 通过 stdin/stdout 提供现有的受监督 Agent 运行时，每行一条 JSON-RPC 2.0 消息。支持 `--session`、`--model`、`--profile`/`-p`，不要求 TTY。单次任务可用 `mycli exec`。

后端同一时间只有一个活动会话。`session.new` 和 `session.resume` 复用 TUI 的持久会话协调器。Stdio 服务一条外部连接；嵌入宿主可为一个后端挂接多个客户端。不提供 TCP 监听、远程认证或跨进程发现。

<a id="connect"></a>

## 连接

安装后的应用公开 `@cosmos2023/mycli/gateway`。Node 客户端也可与 `@cosmos2023/mycli/backend` 的 `startBackend` 一起使用嵌入式受监督后端；内部工作区直接使用 `@mycli/gateway`。

```typescript
import { spawn } from "node:child_process";
import { GatewayClient } from "@cosmos2023/mycli/gateway";

const child = spawn("mycli", ["app-server"], { stdio: ["pipe", "pipe", "inherit"] });
const client = new GatewayClient({ input: child.stdout, output: child.stdin });
client.start();
try {
  await client.waitForEvent("runtime.ready");
  const session = await client.request("session.bootstrap", { protocol_version: 1 });
  const transcript = await client.request("transcript.load", {
    session_id: session.session_id,
    limit: 100,
  });
  // Consume transcript.items in the host application.
  client.expectClose();
  await client.request("shutdown", {});
} finally {
  client.stop();
  child.stdin.end();
}
```

在 `start()` 前注册 `log(event)`，以接收验证过的通知，包括审批和流式轮次事件。`waitForEvent` 有有限重放缓冲和超时，`signal` 取消待处理客户端工作。停止客户端释放监听器和事件计时器；关闭进程或嵌入后端仍由传输所有者负责。

`request(method, params)` 使用生成的参数/结果类型并验证两侧。已有 `send(method, params)` 保留给协议探测和兼容调用，接受字符串方法名并验证已知方法响应。未知控制器请求收到 `method_not_found`；观察者只能使用明确只读允许列表。

<a id="embedded-service"></a>

## 嵌入式服务

`startBackendService` 独立于客户端拥有一个受监督后端。宿主指定一个 `controller`，其余为 `observer`。默认 observer，RPC 参数不能改变角色。

```typescript
import { startBackendService } from "@cosmos2023/mycli/backend";
import { GatewayClient } from "@cosmos2023/mycli/gateway";

const service = await startBackendService({
  cwd: process.cwd(), env: process.env, args: [],
}, { maxClients: 16 });
const control = service.attach({ role: "controller" });
const observe = service.attach();
const controller = new GatewayClient(control.transport);
const observer = new GatewayClient(observe.transport);
controller.start();
observer.start();
try {
  await Promise.all([controller, observer].map((client) =>
    client.waitForEvent("runtime.ready")));
  const session = await observer.request("session.bootstrap", { protocol_version: 1 });
  await control.close();
  controller.stop();
  // The observer and backend remain usable after the controller detaches.
  const history = await observer.request("transcript.load", { session_id: session.session_id });
} finally {
  await service.close();
  controller.stop();
  observer.stop();
}
```

Observer 可引导、查看状态/设置/清单、列出会话/资源、读取对话、Shell 输出和跟踪，接收共享事件；不能提交轮次、回答决定、运行命令、更改设置、切换会话、停止进程或关闭服务。拒绝返回 `read_only_client` 和 `data.dispatched=false`。这些角色只约束可信本地宿主内的控制操作，不是远程认证或会话数据访问策略。

每个 attachment 有独立 RPC ID、输出队列和 `completion` promise。`attachment.close()`、EOF、无效帧大小或输出失败移除连接。所有客户端脱离后，已接受工作仍继续，宿主不再需要后端时必须 `service.close()`。`GatewayClient.stop()` 只停止本地读取，脱离需关闭 attachment。

第二个 controller 收到 `controller_attached`。原控制器断连后，已接受的修改 RPC 必须先结算，否则新控制器挂接返回 `controller_draining`。运行轮次和进程保留原运行时所有者；原 RPC 结算后替代控制器可查看、审批或中断。请求和响应 ID 不转移、不重放。

新客户端先收 `runtime.ready`，再调用 `session.bootstrap` 获取当前会话与待决交互。Ready 可能描述启动会话，不是当前快照。Bootstrap 明确重发当前可见审批/澄清（含子请求），不增加队列项，其他客户端可能再次看到相同 ID。已决事项和历史工具事件不由服务重放，历史使用 `transcript.load`。

实时挂接不同于启动新后端或从存储激活。冷激活持有会话租约，发布前原子中断未完成轮次，移除旧审批/澄清 continuation。完成工具结果留在历史，未知副作用不重试，旧进程句柄无法恢复。历史读取和预览不执行恢复。

`service.snapshot()` 报告连接角色、服务状态及正在排空的控制器。宿主 `close()` 幂等。接受的 controller `shutdown` 立即停止新准入，先响应后清理，关闭后端和所有 attachment，即使控制器未读回复就断开也如此。`service.completion` 在清理后以退出码结束；传输或清理失败将原本成功的退出码改为 1。

<a id="plugin-management"></a>

## 插件管理

`plugin.catalog` 按明确 `session_id` 和 `generation` 读取已安装/可用包元数据及市场，可选 `marketplace` 缩小列表，不启动 Worker、MCP、hook 或模型。`plugin.inspect` 接受 `target` 和 `revision`，按需加载声明能力名。修订绑定包来源、配置和市场快照，目录限制通过 `truncated` 和 issues 明示。

`plugin.operation.start` 接受同一会话所有权、唯一 `operation_id` 和封闭 `change` 变体：`install`、`enable`、`disable`、`update`、`remove`、`marketplace_upgrade`、`marketplace_remove`（target/revision），或 `install_source`/`marketplace_add`（source），并及时返回。轮询 `plugin.operation.get` 至 `state` 为 `completed`、`failed`、`cancelled`，或请求 `plugin.operation.cancel`。取消在原子提交前尽力执行，已提交成功优先。传输结果未知时不自动重试修改，应刷新目录。

每个后端同时只运行一个包修改，重叠在分发前拒绝。保留 32 个操作结果，在此窗口去重相同 ID；总暂存五分钟后取消，已有 Git 子进程限制仍适用。会话切换和后端关闭取消待处理工作，关闭等待清理。UI 关闭显式请求取消；attachment 断连遵循普通所有权，已接受工作继续直到取消或关闭后端。轮询/取消保持原会话/generation。Observer 可读目录、详情和结果，只有 controller 可启动/取消；取消有预留控制容量，不受普通队列满影响。

安装将验证包数据复制到不可变快照。启用/安装在现有沙箱和审批规则下授权声明能力。运行时在下一安全刷新激活，待决轮次保留捕获配置。

<a id="contract-ownership"></a>

## 契约所有权

`backend/packages/contracts/schemas/gateway-rpc.schema.json` 是已实现方法（含兼容入口）的权威来源。修改后运行 `npm run contracts:generate`，CI 使用 `contracts:check`。公开 gateway 导出 `GatewayMethod`、`GatewayParams<M>`、`GatewayResult<M>` 和 `GatewayTranscriptItem`。

生成器还会把独立的 Ajv 校验器输出到 `backend/packages/contracts/src/generated/validators/`。运行时模块直接 import 这些函数，不再在每次 import 时编译 JSON Schema，这为 CLI、shell TUI 和后端 worker 的启动各节省约 350 ms。Ajv 只保留用于校验插件在运行时提供的 JSON Schema。因此修改 schema 后必须重新生成并提交校验器文件，两者不一致时 `contracts:check` 会失败。

已知请求在 controller 分发前验证。权限、工作区信任、generation 隔离和持久预留仍归控制器/运行时。无效参数产生 `invalid_params`，格式错误的后端结果产生 `internal_error`，不暴露内容。客户端在结果到达消费者前拒绝无效结果。

协议版本 1 保留可扩展字段和历史对话元数据。`transcript.load` 的工具项，以及 `tool.start`、`tool.complete`、`tool.failed` 通知（含 `runtime.event` 镜像）包含 `tool_record`。标准 schema 为 `gateway-tool-record.schema.json`，公开导出包括 `GatewayToolRecord`、`GatewayShellRecord`、`parseGatewayToolRecord`。

记录包含 `version: 1`、`kind: "tool_execution"`、`name`、`status`（`running`、`success`、`error`、`cancelled`）、`mutating`，可选 `call_id`、目标/输出预览、耗时和 Shell 进程事实。拒绝未知字段，预览最多 8192 字符，只保留选定显示字段，不含原始参数对象或私有理由。旧元数据仍供旧读取器和文件改动展示使用。

消费者优先用 `tool_record`，旧 payload 使用 `@mycli/contracts` 的 `projectGatewayToolRecord` 兼容规范化。TUI 负责折叠和工作区相对路径，按标准标识匹配调用，工具返回时保留更新的 Shell 生命周期输出和终态。其他对话展示变体保持可扩展。

可读项可带 `turn_id`。即使恢复将中断提示移到更早轮次旁，存储和 gateway 也保留归属。消费者先按所属轮次放置尝试记录，再按时间排序；缺归属的旧项保留基于用户消息边界的兼容路径。

原文此处的历史完整对话描述为：按可见区域读取 Shell 输出，最多三个并发加载器；关闭查看器或切换会话停止后续分页，已发页面可完成但丢弃结果。Ctrl+C 和配置的对话快捷键只关闭查看器，不中断轮次。当前保留输出与诊断读取行为另见本页生命周期说明。

<a id="provider-attempts"></a>

## Provider 尝试记录

协调器提交后才发布 `provider.attempt.updated`，携带标准 `ProviderAttemptRecord`：会话/轮次/请求标识、尝试和序号、冻结请求/流重试预算、状态、时间戳和有界安全失败详情。`runtime.event` 镜像相同。Gateway 验证语义和归属，不从显示字符串重建。

首个 `transcript.load` 页包含按时间排列、最多 200 条近期 `provider_attempts`、`provider_attempts_truncated` 和 `provider_attempts_next_before` 事件游标。只读 `provider.attempts.load` 接受 `session_id`、可选 `turn_id` 或 `request_id`、1–500 的 `limit`。会话/轮次查询返回最新记录，以 `before_event_id` 读旧页；请求查询升序，支持 `after_sequence`。序号分页必须指定 request，不能混用会话事件游标。结果含 `session_id`、`records`、`has_more`、`next_before_event_id`，小于 1 MiB；游标必须属于所选会话/轮次。加载历史不发请求。

TUI 每请求一条恢复行，显示 provider/模型、尝试和预算；详情开关展开已加载状态和安全诊断，每请求上限 1000 事件。引导和旧对话加载按显示范围回填重试，每次交互最多八页。消息历史结束后，剩余重试页仍可通过 Home/旧历史操作加载，页脚显示可用/加载状态。计划尝试按持久 `retryAt` 倒计时，恢复开始/结束清除倒计时。恢复的待决尝试没有活动轮次时显示暂停。轮次终态事件停止 Working，并独占最终失败提示。旧 `stream.retrying`、`stream.recovered` 仍可用；有持久尝试记录后 TUI 不重复展示。

<a id="lifetime"></a>

## 生命周期

`shutdown` 先响应再有序清理。EOF/连接关闭结束 stdio 会话并关闭其后端。SIGINT 退出 130，SIGTERM 为 143，启动/传输失败为 1，正常关闭为 0。启动取消也终止协调 Worker。

Stdout 仅协议数据，启动诊断走 stderr，不含原始错误或凭据。审批和澄清保持显式协议交互，app-server 不授予信任或自动回答。

当前轮次和 Worker 租约仍活动时，实时根 `approval.request` 可回答。每个兼容工具独立等待；一次回答后，已批准命令仍执行/等待输出时可出现下一提示。现代 `Shell` 保留普通 `yield_time_ms`，审批不强制立即返回进程句柄。

`tool.complete` 结束调用，但进程可能仍运行。用 `shell.output`、`shell.completed` 跟踪进程，`shell.list`、`shell.stop` 控制进程，`transcript.load` 读取历史。TUI `Ctrl+T` 只展开已保留输出，打开或滚动不额外获取 Shell 输出，长输出保留截断标记。明确需要存储块的客户端仍可用诊断 `shell.output.load`。Agent 用 `WriteStdin` 等待命令退出后再执行依赖工作。普通 Shell 保留前台让出窗口，旧 `Bash` 保留等待行为。

<a id="capacity-and-backpressure"></a>

## 容量与背压

共享客户端、RPC 服务和协调监督器限制帧、待处理工作和输出队列；按连接、队列分别生效：

| 资源 | 默认值 |
| --- | --- |
| UTF-8 帧（不含换行） | 8 MiB |
| 对话结果页 / 最大请求项数 | 6 MiB / 500 |
| 待处理普通 RPC / 编码请求字节 | 64 / 16 MiB |
| 额外控制容量 | 8 请求 / 256 KiB |
| 输出队列（含未完成写入） | 256 写入 / 16 MiB |
| 批量通知写入 | 最多 64 KiB 完整帧 |
| 输出无写入进展 | 15 秒 |
| 客户端 RPC 超时 | 120 秒 |
| 客户端事件重放 | 256 事件 / 8 MiB |
| 客户端事件等待者 | 256 |
| 嵌入服务 attachment | 16，可配置 1–64 |

`turn.interrupt`、`approval.respond`、`clarify.respond`、`shell.stop`、`shell.stop_all`、`shutdown` 有预留控制容量。接受写入保持顺序，Shell 输出可按下文合并。普通请求饱和时执行前返回 `gateway_overloaded`、`data.dispatched=false`。协调器恢复期间新请求同样拒绝，`shutdown` 仍可用；不向替代 Worker 自动重放。

`transcript.load` 默认最多 500 项，可能为字节预算返回更少。应沿 `next_before` 到 null，短页不代表历史结束。后端使用原游标重读更小页面，让存储返回准确 continuation。单项超页预算返回 `gateway_message_too_large`，连接仍可用。

Worker 输入容量在消费确认时释放，不依赖 RPC 完成；输出等待确认后才发下一写入，可含多个换行分隔帧。确认带 generation 和序号，旧 Worker 不能释放当前容量。流写入遇背压暂停，在 `drain` 恢复，优雅关闭也如此。Stdio 入口还等待最终目标写入，排空限 15 秒；仅结束内部流不等于交付。

RPC 服务在一个事件循环周期内批量写相邻未发送通知，最多 64 KiB，或较小的配置帧上限加换行。更大单帧独立发送。批处理保持每个帧字节、标识、运行序号及直接/封装对的顺序；RPC 回复先刷新已接受前缀，并保留自己的写确认。这避免细小推理/文本 delta 在 Worker 等确认时耗尽写次数。字节上限和停滞期限仍涵盖未完成批次。

背压时，同会话、generation、轮次、Shell、call 的未发送 `shell.output` 可合并，`runtime.event` 镜像独立合并。更新保留最多 10,000 字符、最新序号/游标和明确 `omitted_output_chars`。通过游标范围避免重复追加。运行序号可有间隙但递增，Shell 完成事件排在待发输出之后，持久输出块采集不变。

超大输入在组帧时拒绝，即使片段没有换行。超大输出、队列耗尽、客户端无效响应/通知或消费者停滞会使连接失败，不静默丢审批和终态事件腾空间。一个 attachment 失败不影响其他客户端和后端；上游后端失败关闭整服务。Stdio 宿主拥有后端生命周期，传输失败退出 1；已分发工作的结果通过持久状态恢复。

进程内传输可通过 `diagnostic()` 暴露后端稳定失败码，协调 Worker 跨完成与清理保留它。TUI 意外断连优先报告该码，并将原始客户端错误、会话 ID 和代码写入私有脱敏 `~/.mycli/logs/tui-errors.log`，不复制对话内容。

`GatewayClient` 接受 `limits`、`requestTimeoutMs`、`eventReplayLimit`、`eventReplayBytes`、`eventWaiterLimit`，客户端设置不能提高服务端上限。本地准入错误为 `GatewayRequestError`，帧和写停滞为 `GatewayFlowControlError`。`gateway_request_timeout` 关闭连接，不证明修改失败或取消；不自动重试，传输所有者仍需关闭连接/后端。服务除每 attachment 限制外，还有一个共享请求预算的上游客户端；上游超时因结果未知使服务失败。

重放缓存按条数和字节淘汰最旧项，超过字节预算的单事件不缓存。实时 `log` 和已注册等待者在缓存前接收事件。长期订阅使用 `log`，重放缓存不是持久历史。

远程传输、多个同时活动会话、订阅过滤和持久事件游标属于独立后续工作。

<a id="session-goals"></a>

## 会话目标

`goal.get` 返回 `{ session_id, generation, goal }`，`goal` 为 null 或标准 `SessionGoal` 快照。`goal.update` 接受 `action`（`create`、`edit`、`pause`、`resume`、`clear`）、可选 `objective` / `token_budget`（null 移除预算），以及常规会话 ID/generation。编辑器可用 `expected_goal_id`、`expected_revision` 拒绝过期操作。

`status.changed` 和 bootstrap `status` 携带同一 `goal` 快照。`turn.started.source = "goal"` 标记自动工作，对话重放将其呈现为系统提示。目标变化先持久化再通知。审查和无界面单轮执行不提供这些操作。
