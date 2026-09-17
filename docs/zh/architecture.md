<a id="mycli-architecture"></a>

# mycli 架构

[English](../architecture.md) | **简体中文** | [中文目录](README.md)

mycli 是 Node.js npm workspace。交互 CLI、gateway、运行时、工具、provider、存储、扩展、契约和 TUI 均有明确包边界。所有生产资源、生成声明、测试门禁和发布包由 Node 体系管理。

<a id="package-ownership"></a>

## 包职责

| 路径 | 职责 |
| --- | --- |
| `backend/apps/mycli` | CLI 入口、管理路由、Node 组装根、运行时到 TUI 的 gateway、slash 命令服务 |
| `backend/packages/contracts` | JSON schema、生成的 TypeScript 传输类型、验证和 gateway 目录 |
| `backend/packages/gateway` | 与客户端无关的 Node 传输接口、共享 RPC 客户端、通知解码和客户端生命周期 |
| `backend/packages/core` | 运行时事件和共享领域类型，不管理 provider/存储 |
| `backend/packages/config` | 用户/项目配置、认证、信任、模型目录、Shell 设置和执行策略 |
| `backend/packages/providers` | Pi-ai 传输边界、provider 目录、数据适配、标准化和重放 |
| `backend/packages/runtime` | 轮次循环、继续执行、审批、澄清、队列、压缩、记忆和会话协调 |
| `backend/packages/storage` | SQLite 会话存储、对话快照、持久状态与恢复 |
| `backend/packages/tools` | 工具清单、文件工具、审批、进程策略、PTY 传输和 Shell 生命周期 |
| `backend/packages/integrations` | Skills、MCP、hooks、plugins、子 Agent、发现和管理 |
| `tui/mycli-shell` | 终端渲染、输入、弹层、reducer 状态和 gateway 客户端 |
| `native/windows-sandbox-helper` | 与语言无关的 Windows 受限 token 进程辅助程序 |
| `tests/fixtures` | Node 测试使用的固定、语言无关 M2–M7 回归数据 |

依赖从组装包指向职责专一的库。`core` 和 contracts 不依赖 app 基础设施。Provider、文件系统、进程启动和 SQLite 都在类型化边界之后，因此运行时流程可以使用模拟实现测试。

普通 Responses、Chat Completions、DeepSeek、Qwen/compatible 和 Anthropic 流量通过 mycli `ModelProvider` 边界使用精确固定版本的 `@earendil-works/pi-ai`。mycli 仍负责配置、凭据、指令角色、标准事件、重放状态、错误分类、取消和重试时序；每次 pi-ai 调用均设置 `maxRetries: 0`。

Responses 流在协议终态事件结束，不等待 HTTP 正文 EOF。Provider 内部 SSE 适配器在终态帧后关闭呈现给 pi-ai 的流并取消剩余输入，最终内容、工具、用量和状态仍由 pi-ai 解释。标准适配器也在 pi-ai `done` 或 `error` 后停止读取。缺失或格式错误的完成事件仍属于流失败。运行时可继续工具或下一模型步骤，TUI 只在轮次正常终结后停止计时。

当前轮次已有可见工作后，新助手文本前由 TUI 派生暗色横分隔线。它们是纯显示对话块，实时渲染和历史查看共用。稳定消息 ID 与缓存的源边界状态保证流式输出、工具分组和窗口缩放时位置稳定；用户消息和已完成轮次标记重置工作边界。

Shell 块之间空一行，显示时只裁剪视觉为空的输出边界行，保留内部空白和存储输出。实时轮次活动位于输入框上方状态区，有明确间距和一条受宽度限制的标题，不进入对话滚动或终端历史；状态更新不使对话内容缓存失效。已完成轮次耗时属于对话。

实时 OpenAI Responses 搜索使用同一 pi-ai 传输。mycli 通过 payload hook 插入原生 `web_search`，其他协议在发流量前拒绝此能力。本文原始架构基线中的 pi-ai 集成消费搜索生命周期和心跳帧，但不将它们作为助手事件，因此新轮次保留最终助手输出，不显示标准搜索进度行或保留原生搜索调用重放；历史已保存搜索活动仍可读。

<a id="package-module-layout"></a>

## 包内模块布局

每个后端包的 `src/` 按职责分组，`test/` 对应这些分组。`src/index.ts` 保持包门面。已有包名和公开子路径（包括 `@mycli/config/profile`、`@mycli/config/paths`、`@mycli/tools/ripgrep-runtime`）保持稳定。

| 包 | 查找位置 |
| --- | --- |
| config | `configuration/` 管理分层、schema 和编辑；`providers/` 管理认证和模型；`policy/` 管理信任；`terminal/` 管理 Shell/TUI 设置 |
| contracts | `gateway/` 为共享 UI/运行时数据；`generated/` 为 schema 生成类型；根目录为 schema 加载和验证 |
| gateway | `client.ts` 负责 RPC 关联和通知消费；`transport.ts` 为客户端无关流接口 |
| core | `conversation/` 管理模型输入和投影；`lifecycle/` 管理 Agent、轮次和队列状态；`policy/` 为纯策略规则 |
| integrations | `foundation/`、`hooks/`、`mcp/`、`plugins/`、`skills/`、`subagents/` 为扩展子系统 |
| providers | `registry/` 负责路由发现和 provider 构建；`pi-ai/` 负责传输、payload、重放和失败适配 |
| runtime | `turns/` 管理轮次所有权；`workers/` 管理 Worker 执行；`agents/` 负责调度；`providers/`、`context/`、`memory/`、`sessions/`、`hooks/`、`tools/` 为协调流程 |
| storage | `sessions/` 为 SQLite 会话状态；`transcript/` 为事件持久化；`projections/` 为派生视图和模型输入；`artifacts/` 为内容 blob；`agents/` 为子状态；`migrations/v9/`、`migrations/v10/` 为版本迁移 |
| tools | `files/`、`shell/`、`sandbox/`、`ripgrep/` 为执行适配器；`policy/` 为权限；`registry/` 为发现和路由；`interaction/` 为提问和计划 |
| mycli-shell-tui | `application/` 组装会话；`state/` 为 reducer 和恢复；`transcript/` 为显示投影；`components/` 分为对话、选择器、输入框和共享组件；`transport/`、`platform/`、`interaction/`、`theme/`、`tui-core/` 各负责相应边界 |

包级基础组件保留在源码根目录。共享测试辅助函数位于 `test/support/`，数据位于 `test/fixtures/`。内部模块直接导入所属文件；目录分组不增加公开 API 或依赖层。

[TUI 架构指南](tui.md) 说明状态到渲染的流水线、缓存所有权和导入规则。TUI 架构测试拒绝反向依赖和循环；静态输出与交互更新共用对话单元工厂。

<a id="interactive-flow"></a>

## 交互流程

```text
terminal input
  -> TUI gateway request
  -> backend/apps/mycli Node gateway
  -> runtime coordinator
  -> provider and/or tool adapter
  -> durable SQLite commit
  -> canonical lifecycle events
  -> TUI reducer and transcript
```

Gateway 只在完成必需的持久预留后确认接受工作。用户消息提交后发出标准条目生命周期事件。审批和澄清先保存待决状态，再通知 UI 等待，从而支持重启恢复而不重放工具副作用。

<a id="composition-root"></a>

## 组装根

`backend/apps/mycli/src/cli.ts` 在 TTY 验证前路由管理、exec/review 和 stdio app-server 命令。Agent 使用 `startSupervisedNodeBackend` 启动；协调 Worker 为每个客户端组装同一个 `startNodeBackend` 运行时。Node 后端负责 provider 构建、存储、信任、工具、集成、Shell 管理、gateway 传输、信号和关闭。

管理命令（`setup`、`doctor`、hooks、plugins、MCP 和 subagents）不启动模型运行时，因此无需 TTY 或 provider 请求也可自动化。

<a id="runtime-and-durability"></a>

## 运行时与持久性

- `NodeTurnRuntime` 管理 provider 步骤与工具执行。
- `AgentSupervisor` 是唯一子 Agent 生命周期修改者；`AgentScheduler`、`AgentRuntimePool` 和 `AgentMailbox` 提供容量、驻留管理和持久通信。
- 会话、队列、压缩、审批、澄清协调器各自管理持久状态转换。
- `SQLiteTranscriptEventRepository` 通过原子操作实现幂等性、副作用执行权和会话变化。
- `TranscriptSnapshotStore` 保存有界 UI 投影，不是 provider 历史。
- 会话 generation 在恢复/分叉后阻止旧回调生效。
- 关闭时中止工作、等待结算、排空生命周期持久化，并关闭拥有的扩展和 Shell 进程。

运行时没有固定 provider 步骤或工具调用上限，由取消、provider 限制、上下文限制和明确终态约束执行。

Provider 请求跨 Worker 边界有 32 MiB 上限，包含对话 token 统计未完整覆盖的原生重放状态和图片。分发前的字节超限产生明确本地上下文溢出诊断并进入响应式压缩。被拒绝请求不消耗传输序号，压缩后时间线可继续使用同一租约。Worker 内存限制和格式错误响应隔离是独立控制。

兼容工具阶段内，`ParallelApprovalCoordinator` 分别保存每个调用的审批并独立唤醒。Gateway 一次展示一个提示，决定后继续下一个，活动轮次和 Worker 租约保持占有。已批准 Shell 仍使用普通输出等待，因此另一调用可在前一个返回前启动并完成。实时完成按执行顺序显示，持久结果和下一模型请求按 provider 顺序排列。文件修改等顺序工具保留执行屏障。

审批决定和冻结调用保存在挂起批次中。现有副作用账本以稳定会话/轮次/调用 ID 申领执行权。冷激活保留已完成结果，原子中断未完成轮次并清除未答审批和提问。未知副作用只记录不重放。连接仍在运行的后端保留待决请求和进程。某调用失败时，对话终结保留已完成兄弟结果。

TUI 与无界面流程共用 `@mycli/gateway` 客户端。后端传输接口不依赖 TUI，由 lint 强制依赖方向。Contracts 中逐方法 schema 生成请求/结果类型，在分发和交付前验证。对话投影使用共享传输记录并保持版本 1 元数据兼容。安装应用公开 `/backend` 和 `/gateway` API，见 [Gateway API](gateway.md)。

<a id="layered-model-input"></a>

## 分层模型输入

主 Agent 和子 Agent 的每个 provider 步骤共用与 provider 无关的指令契约，区分会话冻结产品指令、developer 策略、上下文参考、权威对话和当前用户请求。工作区指引、环境事实、记忆、普通 hook 输出、压缩恢复和已加载 skill 正文属于上下文用户数据。协作模式、权限/沙箱策略、工具暴露、有界 skill 目录、受信任策略 hook 和子 Agent 委派约束使用 developer 权限。不受信任内容不能自行提升为 developer。

Provider 步骤顺序固定：

```text
collect -> assemble -> budget -> persist -> commit -> reconstruct -> provider dispatch
```

完整逻辑请求先计算预算再持久化。保留必需产品指令、权限策略、工具 schema 和当前用户请求，确定性裁剪可选内容。不可变请求清单及所有引用的模型可见值提交成功前，不调用传输。请求从已提交记录重建，不读取当前文件或可变运行状态。

SQLite 分开保存对话行和内部模型上下文。模型输入账本包含内容寻址 blob、指令快照、工具集快照、上下文事件、有序 provider 输入时间线事件、请求清单和步骤生命周期事件，均为只追加权威记录。一个时间线窗口内，普通请求将完整先前逻辑输入保留为精确前缀，只追加新对话或变化上下文。上下文变化追加完整替代项，移除追加墓碑；工具结果连续排列在工具生成上下文前。可变 `session_state` 仅是可重建投影。

`bootstrap`、`legacy_bootstrap`、`compaction` 和 `source_reset` 明确开始新 provider 输入窗口，不重写旧记录。清单 v2 记录窗口和有序事件 ID，以及独立请求配置、引导前缀、完整时间线和相邻公共前缀诊断。诊断只含哈希和数量，不含原始提示词或工具输出。

Responses、Chat Completions、Anthropic Messages 投影同一持久逻辑契约。支持时使用原生 system/developer 通道；兼容回退只改传输表示，不改持久语义角色或时序。DeepSeek 将稳定 developer 指令映射到 system 前缀，动态 developer 上下文追加为 user 后缀，保留路由行为。Anthropic 通过顶层 system 保留 developer 权限，因此动态 developer 变化可能重置 system 前缀，普通上下文用户轮次仍保留消息前缀。Continuation 是独立、按能力启用的优化；提示词缓存稳定性依赖完整只追加输入，不依赖 `previous_response_id`，不支持的 HTTP 兼容端点使用标准重放。

禁止持久保存的内容也禁止进入 provider 输入。凭据、Authorization 请求头、传输配置和原始私有诊断不进入请求清单。无法清理为允许持久表示的来源在组装前排除，并替换为非敏感诊断。

旧 Node 会话仍可读，不重写其对话行和 v1 请求。首次时间线请求追加 `legacy_bootstrap` 边界及当前有界逻辑输入。已有冻结指令快照的会话在打包模板更新后继续用原快照；新会话使用新模板。`mycli doctor --json` 报告 `model_input_ledger` 完整性，不以迁移/写模式打开存储。

<a id="tool-and-process-boundaries"></a>

## 工具与进程边界

公开内置清单由 Node 管理。`Read` 负责有界发现；修改工具共用快照/历史运行时；Shell 适配器共用按所有者隔离的进程管理器。Provider 工具从确定性直接集合开始，同时作为执行授权集合。成功且持久保存的 `tool_search` 结果可仅向当前轮次追加选定 MCP/插件 schema，新轮次重新从直接集合开始。

`web_fetch` 是有界公网 HTTP(S) 获取边界：要求启用网络的执行策略，连接前拒绝本地/私有/保留地址，固定已验证 DNS，重新验证重定向，并限制耗时、重定向次数、传输字节、媒体类型和模型可见输出。页面内容明确隔离为不受信任外部数据。

受限 Shell 不能执行限制时拒绝运行。`native/` 下辅助程序与 `backend/packages/tools/native/` 打包资源属于 Node 运行时资源，不能作为语言清理的一部分删除。

macOS 受域名限制的 Shell 每进程使用一个不可变 HTTP/CONNECT 代理租约。Seatbelt 只允许租约的回环 TCP 端口，代理环境变量负责客户端路由。共享公网地址验证拒绝本地/私有地址，DNS 固定贯穿真实连接。Shell 让出执行后仍保留租约，退出、停止、超时、启动失败或关闭时释放。Linux/Windows 尚无原生代理路由时拒绝启用且非空的域名策略。CONNECT 过滤目的 authority，不检查加密内容。配置和限制见[网络策略](network-policy.md)。

<a id="extension-boundaries"></a>

## 扩展边界

Skills 提供指令和稳定工具路由。MCP 客户端和 hooks 使用有界进程生命周期契约。Plugin API v2 在隔离 Worker 中运行编译 ESM。子 Agent 创建独立持久 Node 线程，冻结最小权限策略、上下文、预算和工具范围。标准 Agent 事件驱动邮箱、产物、gateway、用量和 TUI 投影；兼容控制器不拥有运行时句柄或投影回调。插件声明不能覆盖内置工具或 slash 命令。另见 [node-agent-runtime.md](node-agent-runtime.md)。

<a id="contracts-and-tests"></a>

## 契约与测试

标准 schema 位于 `backend/packages/contracts/schemas`，只生成 TypeScript 声明。最终跨运行时对比数据作为脱敏历史证据保留在 `tests/fixtures/node_runtime_m2` 到 `node_runtime_m7`，哈希由 M8 Node 审查管理。

Node 发布检查覆盖构建、契约一致性、ESLint、TypeScript、Node 单元/集成测试、无需 provider 的 M8 冒烟、打包安装冒烟、原生进程检查，以及主动启用的 Responses 冒烟测试。
