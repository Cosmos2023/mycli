<a id="node-agent-runtime"></a>

# Node Agent 运行时

[English](../node-agent-runtime.md) | **简体中文** | [中文目录](README.md)

Node 运行时将根 Agent 和每个子 Agent 建模为独立持久线程。显示名只是元数据，不可变线程 ID 和标准路径才用于路由与关联。

<a id="architecture"></a>

## 架构

`AgentSupervisor` 是唯一生命周期修改边界，管理创建、加载、启动、等待、空闲、卸载、后续任务、中断、终态结算和运行时释放。`AgentScheduler` 预留驻留容量，`AgentRuntimePool` 保存已加载句柄，`AgentMailbox` 将 Agent 间通信持久化到接收者会话输入队列。

```text
coordination tool
  -> prompt-driven coordination adapter
  -> AgentSupervisor or AgentMailbox
  -> SQLite durable transition
  -> canonical agent event
  -> parent mailbox, artifacts, gateway, usage, and TUI projections
```

协调适配器不拥有子句柄或发布生命周期更新。投影在所属存储转换后消费标准事件；可读投影缺失/过期时仍以 SQLite 为准。

每个 Agent 有：

- 不可变 `thread_id`。
- `root_thread_id` 和可选 `parent_thread_id`。
- `/root/reviewer` 等标准路径。
- 独立对话、provider continuation 状态、取消边界、队列和运行时 generation 租约。
- 冻结的创建配置和持久生命周期状态。

兄弟路径冲突通过唯一后缀解决。调用方必须按返回线程 ID 或标准路径路由，不能由昵称自行重建路径。

<a id="execution-adapter-rollout"></a>

## 执行适配器推广

Agent 循环在轮次前统一选择内部执行适配器。兼容开关为 `MYCLI_AGENT_EXECUTION_ADAPTER`，`MYCLI_ROOT_AGENT_EXECUTION_ADAPTER` 和 `MYCLI_SUBAGENT_EXECUTION_ADAPTER` 可分别覆盖，用于分阶段推广。三者只接受 `in_process` 或 `worker`，有效默认值是 `worker`。任一路径使用 worker 时，都使用协调器拥有的同一池，另一路仍可进程内执行。两种模式都不改变持久身份；会话、轮次、队列、邮箱、审批、工具、产物和 gateway 发布仍归协调器。

选择遵循以下约束：

- 预留 Worker 租约、发起 provider 或工具尝试前，解析并冻结适配器。
- 完整持久轮次使用同一适配器。根审批/澄清等待时可释放租约，用户响应后为同一轮次标识获取另一 Worker 租约。
- Worker 初始化或外部尝试开始后，不切换到进程内适配器。
- 无法安全启动 Worker 时返回类型化启动/容量失败。
- 修改推广默认值前，对比标准 provider 清单、对话、生命周期行、用量、邮箱投递和终态发布顺序。
- 后端启动时只解析一次分路覆盖。缺失/空白继承兼容开关；无效值使启动失败，不静默选择其他适配器。

回退设置 `MYCLI_AGENT_EXECUTION_ADAPTER=in_process`，排空已有 Worker 租约，仅为后续轮次选择进程内模式，不删除/重写 Worker 时代元数据。在文档兼容窗口内，根/子 Worker 的对齐、中断、恢复和内存验收通过前，进程内适配器仍受支持。

Worker 中断由后端协调器定向执行。监督清理时限 12 秒，包含协作取消、副作用清理、定向终止及替换。外层后端看门狗为 15 秒，因此普通定向中断保留协调器 generation；只有失去响应且超过更长期限才终止并整体恢复协调器。

根和子硬中断双向隔离：替换根 Worker 不改活动子 Worker 标识，替换一个子 Worker 不改根或兄弟。因此一个子 Agent 中断时，兄弟仍可完成报告，根继续同一持久轮次。

<a id="root-and-subagent-worker-acceptance-evidence"></a>

### 根与子 Agent 的 Worker 验收证据

Worker 默认值的自动化覆盖包括：

- 进程内/Worker 子请求、持久清单、用量、终态任务状态和父 gateway 投递一致。
- 通过 `interactive/root` 租约执行根 provider，根清单、工具调用/结果、队列、审批、事件、终态记录仍由协调器拥有。
- 两种适配器执行同一两步根 `update_plan`，对比标准对话、请求结构/清单拓扑、生命周期、用量、报告、对话和终态 gateway 顺序。
- 默认 Worker 完成后，重启后端并显式回退 `in_process`，确认可读取旧清单、重放 continuation、完成下一轮且不重复工具副作用。
- Worker 根会话 new/resume/fork、无需 provider 的 slash、执行中补充指令及后续队列、真实压缩/重启、Responses continuation、冻结权限工具暴露、实时/持久 TUI 对齐，以及后台 MCP 刷新到后续步骤。
- 前台/后台子 Agent、审批/澄清继续、邮箱后续任务、`send_message`、`wait_agent`、卸载/重载和定向中断。
- 活动根轮次中两个重叠子 Worker 流，其上下文、工具、用量和终态报告隔离。
- Provider RPC 按协调器 epoch、Worker generation、lease/job/session/turn、时间线窗口/版本及单调命令/响应序列完整隔离，包括旧帧零分发测试。
- 源码解析和编译后的 Worker 入口。

真实 provider 运行器未指定适配器时使用生产默认，不注入开关；还支持旧 `--adapter` 和独立 `--root-adapter`、`--subagent-adapter`，摘要不含凭据。2026-08-13 本地 DeepSeek `chat_completions` 完成 worker 根/in_process 子以及全 worker 两种拓扑。每次覆盖两次创建、send、follow-up、两次 wait、定向中断、list、子文件读取、完成投递、邮箱/树持久化及会话/后端重载，不启动 Python。这是 Worker 默认值的真实服务证据。

同日，环境配置的 OpenAI 兼容 Responses 端点完成扩展默认 Worker 流程：四次后台创建、两个重叠子 Agent、三次等待、根补充指令、send/follow-up、定向中断、持久列表、子读取和重载。前台兼容路径通过 `SubagentController.start(mode="foreground")`，使用 Worker 租约和持久清单单独完成。M7/M4 实测提供两次审批继续、MCP/插件/工具执行和持久文件修改。摘要均排除凭据、端点详情、提示词、响应及本地路径。不可用或跳过不算验收证据。

<a id="worker-memory-limits-and-diagnostics"></a>

### Worker 内存限制与诊断

每个 Worker 的实测 V8 默认限制为：老生代 192 MiB、新生代 16 MiB、代码区 64 MiB、栈 4 MiB。池在创建前验证内部覆盖。这些限制约束 isolate 堆，不代替进程 RSS 管理；原生 provider 库和结构化克隆缓冲可能位于老生代之外。

生产最多保留四个 Worker，空闲 30 秒后回收。内存紧张时可在启动前降低两个上限：

```bash
MYCLI_AGENT_WORKER_MAX=2 \
MYCLI_AGENT_WORKER_IDLE_TIMEOUT_MS=5000 \
npm run mycli
```

`MYCLI_AGENT_WORKER_MAX` 接受 2–4 整数，`MYCLI_AGENT_WORKER_IDLE_TIMEOUT_MS` 接受 1,000–600,000 毫秒。空值使用默认，无效非空值启动失败且不回显内容。最少两个，因为根 Worker 等待前台子 Agent 时可能保留一个租约。低容量降低驻留峰值但更早排队；短空闲超时更快回收内存，但安静期后增加启动延迟。

协调器到 Worker 的消息在 `postMessage` 前序列化并检查字节。本文记录的共享传输上限为 2 MiB；内部协调协议每封装 1 MiB、每 payload 512 KiB。Provider 命令和响应两端都解析。不可变指令/工具缓存默认八项、合计 512 KiB，验证内容哈希并确定性 LRU 淘汰。

`AgentWorkerPool.metrics()` 通过协调器侧 Node Worker API 采样，仅返回不透明 Worker 标识/generation、线程 ID、状态、资源限制、堆已用/总量/上限/external 字节、数字消息监听器数和事件循环 active/idle/utilization。正常释放防御性清空监听器，即使执行器已退订。不含 lease/job/session/turn ID、路径、凭据、提示词、对话或工具输出，也不进入对话/模型输入。

复用 Worker 默认四个软回收条件：100 个完成任务、存活 30 分钟、单任务最大消息 1 MiB，或相对启动后基线保留堆增长 32 MiB。仅在 Worker 确认释放、协调器清除租约后评估，绝不中断/回收活动租约；终止空闲 generation，恢复预热容量后才分配新任务。无效/超大协议流量是正确性失败，不是软内存信号，立即隔离租约并替换 Worker。

协调器每秒采样 RSS，默认软限 1.5 GiB、硬限 2 GiB。软压力回收空闲 Worker、禁用预热与崩溃替代，后台请求留在有界队列，交互仍可复用/创建容量。硬压力还禁用所有扩容，拒绝新/排队后台工作；没有空闲 Worker 时拒绝交互请求。类型化结果为 `agent_worker_pool_memory_pressure`；`hard_capacity` 表示硬压力无容量，`soft_queue_timeout` 表示后台排队达到默认 30 秒，均只含压力状态、RSS 和相关字节限制。压力不打断活动租约，不截断已提交上下文。RSS 降到软限下，周期监控恢复队列和预热容量。

脱敏 `metrics()` 压力块报告 `normal`、`soft`、`hard`、RSS/限制字节、是否允许预热，以及数字回收/拒绝计数，不含会话、轮次、提示词、provider、输出、路径或凭据。

可恢复状态及可再生产物使用 SQLite 尾部投影，最多 2,000 原始历史行、2,000 rollout 行、500 对话投影项。兼容 schema v8 的 `(session_id, sequence_no)` 索引支持查询，缺失时添加一次，不改版本标记。原始边界切穿轮次时省略最早不完整轮次，避免显示没有调用的工具结果。

`transcript.load` 不受 500 项快照限制，而是过滤完整权威历史，支持不透明带版本 `before` 游标，请求 `limit` 最大 500，因此反复压缩前的历史仍可读，内部替换隐藏。完整轮次不跨页，特殊工具密集轮次可超出请求的投影项目标。TUI 初始只请求一页，完整查看器到顶部才取旧页，前插后保持可见行。只有 `conversation_messages` 的旧可写会话首屏仍用旧投影，权威历史页不混入该回退。

Provider 重建独立选择最新完成替换及后续对话行；清单、账本重建、`promptCacheKey`、`previousResponseId` 使用有效压缩窗口，不受对话分页影响。启用记忆时会话摘要只读最近八条索引摘要，再应用已有 5,000-token 总预算。

<a id="worker-memory-benchmark"></a>

### Worker 内存基准

运行 `npm run benchmark:agent-workers -- --output agent-worker-memory.jsonl` 测量十个隔离场景：零/一/四个空闲 Worker，一/四个活动 Worker，大历史，协调器大工具输出与有界 Worker 投影，120 个测试租约，对回环 SSE 的生产 Responses 入口执行 1,000 租约耐久测试，以及空闲后恢复。耐久测试每 25 轮强制 GC，前八个检查点视为预热，验证释放租约监听器为零，并检查稳定期协调器 heap/external 和 Worker heap 斜率。RSS 只观察，因为 V8/系统分配器可能保留页。每场景新进程，只输出一行带 schema 版本的 JSONL，包含平台/运行时元数据、数字内存/计数/时间样本和场景维度。跨平台流程在 Node 24 上传独立 Linux/macOS/Windows 产物。

一次本地 macOS arm64、Node 24.14.1 测得 RSS 增量：一空闲约 9.0 MiB，四空闲 51.7 MiB，一活动 9.6 MiB，四活动 50.4 MiB。1.2 MB 历史场景约 10.2 MiB；8 MiB 协调器输出及 480 KiB Worker 投影约 18.1 MiB。释放四个 256 KiB 活动 payload 并等待空闲期限后，驻留 Worker 为零。数字仅是单机证据，不是跨平台阈值；调参前应比较 CI 产物。同环境完整 29 用例后端集成序列达到约 1.79 GiB RSS，仍在软压力策略下完成，硬限为累积开发/测试负载保留空间。应根据完整协调器负载调参，不只乘算微基准。

本地耐久测试约四秒完成 1,000 次 Responses，跨 10 个 Worker generation。40 个释放检查点监听器均为零。预热后协调器堆每 25 轮增长约 12.8 KiB，external 不变，Worker 堆回归斜率为负，关闭池后 Worker 为零。这排除了该有界负载下明显的逐轮线性泄漏，不能证明所有长期负载或原生 provider 实现无泄漏。

另一次源码入口生命周期采样使用相同 5 秒空闲期限，对比四并发租约增加约 153.1 MiB RSS、两并发约 67.5 MiB，减少约 85.6 MiB。空闲后两池 Worker 都为零。macOS 在终止后仍保留分配器页，因此即时 RSS 只部分恢复；Worker 数才是确定性回收断言。

<a id="long-history-resume-benchmark"></a>

### 长历史恢复基准

运行 `npm run benchmark:long-history -- --profile heavy --storage-schema v9`，或选择 `v10` 比较旧规范化。Schema v10/v11 内容 blob 检查用 `--profile blob_tool_heavy --storage-schema paired`；500 次压缩物理大小检查改用 `blob_compact_stress`。`paired` 模式隔离运行 v10/v11，存储、语义、迁移空间、启动/恢复延迟或内存门禁失败即非零退出。小型 `blob_smoke` 使用同一框架，但不检查两项规模相关缩减阈值。

`heavy`、`extreme`、`compact_stress` 构建隔离 SQLite 测试库，前两者含三个完成压缩边界，后者 500 个。通过真实后端 RPC 恢复，读取完整过滤对话，再对回环 Responses SSE 提交首个 Worker 轮次。最新边界保留 20 个工具密集轮次。若首轮再次压缩、包含最新边界前历史、遗漏旧可见轮次、暴露边界替换 payload 或工具调用/结果数错误，基准失败。

数据生成与请求解析在独立进程，避免分配器状态抬高后端基线。报告数据库/WAL/freelist、首页和全页成本、provider 分发时序、请求大小、进程内存、空闲后 Worker 数、测量轮次行/字节增量，不输出数据正文。v10 测试库通过同一 v9 数据真实有界暂存/切换，再显式执行仅测试用 vacuum 创建；分开记录 vacuum 前后字节，不将逻辑规范化称为物理缩小。`compact_stress` 使用 500 个完成边界和约 8,000 字符摘要，启用记忆；最旧摘要进入 provider 则失败，验证最近八摘要读取有界。`heavy`、`extreme` 保留三边界对照。

v11 验收用确定性重复源码/日志同时测压缩与内容寻址复用。输出 schema 5 记录内联封装、唯一原始/存储内容、逻辑/去重引用字节、引用元数据、模型输入行、数据库/WAL/SHM/journal、迁移耗时/临时峰值、显式 GC/vacuum、语义投影摘要和相对基线 RSS。对比语义摘要前规范化临时路径和 prompt-cache key，不输出正文。

2026-08-15 macOS arm64、Node 24.14.1 的 `blob_tool_heavy` 对照保存 600 轮、3,600 可见项。对话加账本 payload 从 v10 的 17,774,277 字节降到 v11 的 2,162,355 字节，减少 88%，超过 35% 门禁。迁移为 1,800 引用安装 16 个唯一对话 blob，代表 13,915,200 去重引用字节；暂存切换约 1.1 秒，GC 零孤儿，显式 vacuum 后 v11 为 7,180,288 字节，v10 为 21,991,424。v10/v11 后端就绪 64.1/62.1 ms，`session.resume` 71.0/69.1 ms，八页对话 131.8/127.5 ms，provider 轮次 608.9/667.1 ms，基线到恢复 RSS 49.1/21.4 MB，空闲后两个 Worker 均回收。

`blob_compact_stress` 保存 520 轮、500 边界、1,560 工具调用和结果、3,120 可见项，payload 减少 90%。显式 vacuum 后 v11 为 7,946,240 字节，v10 为 32,411,648，物理减少 75%，超过 30% 门禁。后端就绪 62.6/68.3 ms，恢复 85.6/99.1 ms，七页历史 140.4/189.7 ms，轮次 786.8/912.6 ms。两者只用最新边界加 20 轮，可读/搜索/provider 语义摘要一致，重建持久请求，在迁移空间及延迟/RSS 限制内，并回收空闲 Worker。

2026-08-14 同平台的 `heavy` v9/v10 对照保存 600 轮、3,600 可见项。v10 显式 vacuum 后文件为 70.8/35.9 MB。就绪 58.5/63.8 ms，恢复 57.7/69.2 ms，八页 82.7/118.7 ms，Worker 轮次 734.3/711.7 ms。测量轮次从 v9 的 5 行/1,644 对话 payload 字节降至 v10 的 3 行/462 字节，减少 71.9%。就绪到恢复 RSS 增长 48.8/50.9 MB；加载全部历史并执行后的峰值 585.3/708.9 MB，v10 更高峰值明确保留，不称作恢复内存改善。

500 边界的 `compact_stress` 保存 520 轮、1,560 调用/结果、3,120 可见项；v9/v10 文件 78.1/43.6 MB，就绪 59.8/53.9 ms，恢复 73.8/78.9 ms，七页 91.8/123.5 ms，轮次 874.2/912.4 ms。两请求只含最新摘要加 20 轮、60 调用和 60 结果，排除第零轮和最旧摘要，不额外压缩并回收空闲 Worker，写增量同为 5 行/1,644 与 3 行/462。全页加执行峰值 574.9/727.1 MB。`/resume` 自身有界，但 v10 分页/provider 后峰值仍需追踪。这些是本地证据，调参前比较跨平台产物。

2,000 轮 extreme 数据包含 6,000 调用、6,000 结果、12,000 可见项、三个边界，数据库 331.9 MiB。存储分页后恢复 105.72 ms，首个 500 项页 14.35 ms，全部 24 页 273.20 ms。恢复后 RSS 389.0 MiB，首页后 397.5，全部后 412.0，旧单 RPC 全量方式约 805 MiB。首请求在 786.98 ms 开始，轮次 816.09 ms 完成，最新窗口计数不变。随后 Worker provider 执行时峰值约 796.8 MiB，并非分页期间；空闲后 Worker 为零。已加载页面按设计留在 TUI，内存随用户主动加载增长，但初始恢复和首屏有界。

进行中的压缩检查点只保存标识、数量、哈希和空替换列表；完成的原子边界仍保存真实替换。这样避免将未压缩历史复制到最多 4,096 消息字段，也允许超过该项数的工具密集历史压缩。

<a id="prompt-driven-spawn-configuration"></a>

## 提示词驱动的创建配置

父 Agent 通过 `task_name`、`message`、可选 `fork_turns` 直接分配工作，不存在 Agent profile 发现、目录、专属模型、提示词或预算。子 Agent 继承已解析 provider/模型、执行策略和当前暴露工具。`spawn_agent` 是唯一向 provider 暴露的创建入口。

当前后端总共允许四个驻留 Agent（含根），默认只允许一层子 Agent。最久未用的空闲子 Agent 可卸载释放槽位，持久标识和历史仍保留。省略的运行预算保持无限制。

创建冻结有效工作区、cwd、选定环境、执行策略、provider/模型、产品指令正文、工具范围、预算和上下文分叉模式。子 Agent 根据继承产品内容创建自己的不可变指令快照，使用与父相同的分层输入账本、预算、重建和投影管线。运行时追加一个 developer `subagent_context`，包含标准路径、任务、工具范围、冻结权限/沙箱/文件/网络策略及报告契约。父消息仍为 user 任务，没有子专用基础提示词或 profile 分支。

子环境是允许列表，不是整个进程环境。可选值仅在非空、无 NUL、最多 32,768 字符时保存，否则省略，避免空 `COLORTERM` 等宿主终端元数据使创建快照无效。

旧 SQLite `profile_id` 列仍可读。新 Node 子 Agent 写固定兼容值 `subagent`，仅用于显示/存储，不影响路由、提示词、模型、工具、权限或预算。

`fork_turns` 接受 `none`、`all` 或正整数字符串，默认 `none`。只复制已提交、可共享对话轮次，不复制待决输入、内部通知、工具传输记录或 provider continuation ID。

<a id="coordination-tools"></a>

## 协调工具

新 provider 请求优先使用：

| 工具 | 行为 |
| --- | --- |
| `spawn_agent` | 创建持久子 Agent，返回线程 ID、任务名和标准路径。 |
| `send_message` | 排入有序持久消息，不启动新轮次。 |
| `followup_task` | 排入消息并加载/启动符合条件的空闲或已卸载接收者。 |
| `wait_agent` | 等待邮箱、生命周期、用户补充指令、取消或超时，不轮询。 |
| `interrupt_agent` | 中止活动 provider/工具/等待工作，并持久中断目标。 |
| `list_agents` | 读取持久根树，包括已卸载和终态后代。 |

目标可为不可变线程 ID、标准路径或无歧义的许可别名，路由限制在调用者根树内。不注册/导出 `Task`、旧 `SendMessage`、`SubagentOutput`，应使用创建、消息、自动终态投递和等待工具。

终态完成自动、幂等投递到父邮箱。有界通知含状态、报告预览和可用时输出引用。仅 provider 可见的邮箱记录不伪装成用户消息。

<a id="permissions-and-isolation"></a>

## 权限与隔离

子 Agent 可以缩小但不能扩大权限。有效权限为父冻结权限、平台策略和明确创建限制的交集。

- 受信任 `full-access` 父 Agent 默认产生不询问的 full-access 子 Agent，除非创建明确缩小。
- Workspace/read-only 父不能创建拥有更广文件、网络、Shell、审批或工具权限的子 Agent。
- 重载使用冻结创建快照，不读取当前环境默认值。
- 子工具仍经过 schema、策略、沙箱、审批、hook 和执行边界。

审批或澄清不使子 Agent 终结。线程进入 `waiting`，持久任务仍 `running`，请求携带子会话 ID 和 runtime generation 到 TUI。响应回到同一子运行时，恢复后线程回到 `running`。

<a id="durable-state-and-readable-artifacts"></a>

## 持久状态与可读产物

权威状态位于 `~/.mycli/sessions.db`，包括线程、创建边、任务、邮箱项、队列、运行租约、检查点、对话和用量源数据。

每个子 Agent 还有独立可读会话目录：

```text
~/.mycli/sessions/<child-thread-id>/
  session.json
  events.jsonl
  tasks/<task-id>/output.txt
  subagents/
```

父会话包含自己的任务输出及子 Agent 索引/快照投影。标准事件包括 `agent.lifecycle`、`agent.progress`、`agent.usage`、`agent.communication`；通信只记录有界路由元数据，不记消息正文。产物写入串行并在 SQLite 关闭前排空；投影失败不回滚已提交权威状态。

不要从 `session.json`、`events.jsonl`、任务输出或子 Agent JSON 恢复 provider 历史。可写会话准备会从 SQLite 重建派生投影。

<a id="fresh-only-schema-v12"></a>

### 仅支持新建的 schema v12

本文记录的 v12 切换规则是：生产启动仅在数据库缺失/为空时创建 v12。已有 v9/v10/v11 在打开可写存储前失败，启动不扫描、暂存、转换或修复这些数据库，也没有 v11 到 v12 的迁移路径。

从 v11 切换前，停止所有 mycli，整组归档 `sessions.db`、`sessions.db-wal`、`sessions.db-shm`，移出活动位置后重启创建 v12。回退需要支持 v11 的程序和完整文件集；两存储之间不转换轮次/会话。

V12 保留 v11 内容寻址对话叶节点、确定性 raw-DEFLATE/identity 编码、类型化还原和无内容 FTS。模型输入快照、上下文/时间线事件及清单继续使用验证过的不可变内容行。

V12 改变请求所有权：`provider_request_manifests` 保留 `logical_request_sha256`，不含 `logical_request_blob_id`。固定大小 V3 清单保存窗口、事件数、前缀哈希、投影时间线哈希、provider 配置和快照标识。存储精确选择窗口前缀，验证全部承诺，调用共享 core 投影器，分发/恢复前与关系哈希比对。后续追加/压缩窗口不能改变旧步骤。

V12 的规范化和内容 blob apply 分别返回 `already_normalized`、`already_blob_backed`。维护报告包括可达原始/存储字节、逻辑引用、去重字节、孤儿数量/字节及 `freelist_count * page_size`。显式 `--apply-content-blob-gc` 仅删除两张引用表都不可达的内容，可重复执行，只报告逻辑删除及可复用页，不声称文件变小。只有独立 `--apply-vacuum` 重写 SQLite 并可能物理收缩。

<a id="recovery"></a>

## 恢复

空闲/卸载子 Agent 按需从持久历史和冻结创建配置恢复。启动协调使用 generation 租约与已提交检查点：

- 已提交空闲工作可重载。
- 队列邮件保持有序持久。
- 丢失终态投递通过确定性去重修复。
- 过期 provider 工作或未提交修改工具变为可恢复中断。
- 未提交副作用不自动重放。
- 显式 `followup_task` 可恢复符合条件的可恢复中断子 Agent。

终态 Agent 不会因为仅排队消息而重启。关闭运行时释放驻留资源，不删除持久历史。

<a id="events-and-tui"></a>

## 事件与 TUI

标准流覆盖预留、创建、加载、启动、等待、通信、进度、用量、中断、卸载、完成和失败。后端据此派生父投递、可读产物、`subagent.updated` 和 TUI 状态。

TUI 按不可变线程 ID 关联行，以标准路径渲染 Agent 树，同昵称保持区分。所有模型可见协调调用/结果保留在对话。进度/终态投影更新已有行，不重复新增；仅 provider 可见的邮箱内容不进入用户消息历史。

`/agents` 打开 Agent 视图，`/usage` 查看会话用量。子用量归属子线程，通过标准用量事件投影。

<a id="operational-checks"></a>

## 运行检查

真实调用前先做无需 provider 的诊断：

```bash
mycli doctor --json
```

开发时，在凭据服务冒烟前执行存储、运行时、集成、后端集成、TUI、契约一致性、lint 和类型检查。不要将凭据放入产物、日志、冒烟输出或测试数据。

`model_input_ledger` 通过只读连接验证内容哈希、不可变快照、清单/时间线引用、窗口索引/触发器、边界链和步骤生命周期顺序。失败应阻止受影响会话发 provider 请求，doctor 不修复/重写账本。

正常通过环境或认证存储配置 provider 后，运行完整真实协调冒烟：

```bash
npm run smoke:agents
```

子 Agent 优先验收阶段：

```bash
npm run smoke:agents -- --root-adapter in_process --subagent-adapter worker
```

命令使用临时主目录/工作区，覆盖子 `Read`、消息、后续任务、等待、重叠后台子 Agent、根补充指令、完成、中断、持久列表及重载，只打印一条脱敏 JSON。单独验证保留的前台兼容路径：

```bash
npm run smoke:agents-foreground
```

公开 `spawn_agent` 只支持后台，前台运行器通过同池和 broker 验证内部 `SubagentController.start(mode="foreground")`。未配凭据时两命令以 `77`、`status=unavailable` 退出。失败只包含允许的 `failure_stage`（如 `provider_dispatch`、`provider_stream`、`tool_execution`、`gateway_terminal`），不含原始错误、提示词、响应、路径、端点或凭据。

<a id="troubleshooting-agent-workers"></a>

## Agent Worker 故障排查

| 失败分类 | 可见结果 | 处理方式 |
| --- | --- | --- |
| 池队列满 | `agent_worker_pool_capacity` | 等待租约完成或减少并发，不创建部分轮次。 |
| Worker 启动/释放超时 | `agent_worker_startup_failed` 或 `worker release failed` | 隔离/替换该 Worker，只从协调器已提交状态重建。 |
| 持续软 RSS 压力 | 后台等待 30 秒后 `soft_queue_timeout` | 等活动轮次完成，检查数字指标后重试，不裁剪上下文。 |
| 硬 RSS 且无空闲可复用容量 | `hard_capacity` | 明确拒绝扩容/新工作，保留活动租约。 |
| 无效、过期、乱序或超大帧 | 协议/隔离失败并替换受影响 generation | 视为零副作用帧，不能放宽身份、哈希、大小或序号验证。 |
| Worker 崩溃或 V8 限制退出 | `worker_failed` 和定向恢复 | 按持久策略处理不明确副作用，仅替换受影响 Worker。 |
| 定向中断清理无法确认 | 中断按拒绝式安全规则失败 | 对准确轮次做持久恢复，不伪造终态成功。 |
| 协调器超过 15 秒看门狗 | 后端 Worker generation 变化 | 整体持久恢复，区别于普通 Agent Worker 替换。 |
| 回退后 Worker 时代清单失效 | 重建时 `persistence_error` | 保持会话不变，检查不可变时间线前缀引用，不重写历史迎合当前窗口。 |
| 真实服务运行器退出 77 | 脱敏 `status=unavailable` | 用环境提供凭据重跑，跳过不算推广证据。 |
| 真实服务运行器失败 | 单行摘要中的允许 `failure_stage` | 按本地持久状态诊断该边界，不在输出加入原始 provider/提示词内容。 |

`AgentWorkerPool.metrics()` 和基准 JSONL 只用于运维，不复制进提示词、对话、工具结果或会话历史。回退只在下一轮前改适配器，不将活动租约切换为进程内执行。
