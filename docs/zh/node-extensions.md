<a id="node-extensions"></a>

# Node 扩展

[English](../node-extensions.md) | **简体中文** | [中文目录](README.md)

M8 仅 Node 运行时在轮次前发现 skills、MCP 服务器、Plugin API v2 Worker 和配置 hooks。管理及 doctor 命令使用同一发现服务，不构造 provider 或启动交互运行时。

<a id="discovery-and-precedence"></a>

## 发现与优先级

| 能力 | 用户路径 | 仓库路径 | 优先级 |
| --- | --- | --- | --- |
| Hooks | `~/.mycli/hooks.json` | `<workspace>/.mycli/hooks.json` | 两个来源都加载；每个文件内 hook ID 必须唯一 |
| MCP | `~/.mycli/mcp_servers.toml` | `<workspace>/.mycli/mcp_servers.toml` | 仓库服务器 ID 覆盖用户 ID |
| Plugins | `~/.mycli/plugins/<id>/` | `<workspace>/.mycli/plugins/<id>/` | 用户插件 ID 覆盖仓库 ID；禁用优先 |
| Skills | `~/.mycli/skills/` | 先 `<workspace>/.agents/skills/`，再 `<workspace>/.mycli/skills/` | 后加载来源覆盖同名 skill |

工作区信任为 `unknown` 或 `untrusted` 时，不发现仓库路径，包括 hooks、MCP、插件、skills、项目 `config.toml` 中的插件启用配置和执行规则。用户级集成仍可用。授予信任会在报告成功前重载仓库来源；撤销信任会在请求完成前移除相应工具、hooks、命令和资源并关闭项目 MCP/插件宿主，无需重启。

每个解析器都限制文件大小、条目数量、名称和诊断输出。无效条目保留为诊断，不阻止无关条目加载。

<a id="tool-discovery-and-session-reuse"></a>

## 工具发现与会话复用

允许的 MCP/插件目录少于 100 个工具且序列化 schema 不超过 128 KiB 时直接提供；更大目录使用 `tool_search`，其有界来源目录包含配置的 MCP 服务器指令和插件描述。模型可根据任务主动选择能力，无需用户明确点名服务。资源工具与可执行工具发现分开。

成功搜索向后续 provider 步骤暴露最多 16 个匹配 schema，并在 SQLite 保存有界工具标识与定义指纹。后续用户轮次（包括重开会话）可在 128 KiB 预算内保留最多 64 个已发现 schema。保留要求与当前允许的工具标识、模型工具名和完整定义精确匹配；缺指纹的旧历史不授予保留暴露，变化、移除或禁用工具必须与新目录重新核对。

当前执行冻结目录与执行路由，后台刷新由后续执行采用。搜索控制发送给模型的 schema；冻结允许目录成员资格、参数验证、审批和 hooks 决定执行。已注册的延迟工具不会仅因新用户轮次开始就必须重新搜索才能调用。

工具集合未变时跨轮次保持顺序与来源描述稳定。成功发现还标记工具首次可用的准确历史位置。mycli 将指纹与已授权请求匹配，再把加载点传给 pi-ai。受支持 Responses 路由产生带 schema 的 `tool_search_call`/`tool_search_output` 或 `additional_tools` 历史；Anthropic 使用 `tool_reference` 和延迟 schema。兼容检测与序列化由 pi-ai 负责，其他路由继续用普通函数 schema。搜索仍由本地 `tool_search` 执行，mycli 不重写传输 payload 或再实现一套 provider。重开、Worker 转移和保留的压缩历史保持加载点，旧历史不能加载已删除/变化的 schema。规则在 provider 支持时保留稳定前缀，不保证缓存命中。

<a id="management-commands"></a>

## 管理命令

以下命令无需 TTY，可在后端/provider/TUI 启动前使用。OAuth 登录例外，需要交互终端显示授权链接。

```bash
mycli doctor
mycli doctor --json
mycli doctor --fix --json
mycli doctor --support-bundle --json
mycli sandbox status
mycli sandbox status --json
mycli sandbox setup
mycli sandbox setup --confirm --json
mycli sandbox reset
mycli sandbox reset --confirm --json
mycli sandbox repair
mycli sandbox repair --confirm --json
mycli sandbox uninstall
mycli sandbox uninstall --confirm --json
mycli hooks list --json
mycli hooks inspect <identity> --json
mycli hooks approve <identity>
mycli hooks revoke <identity>
mycli plugins list --json
mycli plugins inspect <plugin-id> --json
mycli plugins run <plugin-id> <command> --json-args '{"enabled":true}' --json
mycli mcp list --json
mycli mcp inspect <server-id> --json
mycli mcp add docs --url https://mcp.example.com/mcp
mycli mcp add files --cwd /path/to/workspace -- node /path/to/server.js
mycli mcp remove <server-id>
mycli mcp approvals --json
mycli mcp revoke <server-id>
mycli mcp login <server-id>
mycli mcp logout <server-id>
```

人类可读和 JSON 输出来自同一类型化响应，不包含 hook 命令、环境值、插件输出、凭据、请求头或 provider 数据。

<a id="configured-hooks"></a>

## 配置 Hooks

Hook 使用 JSON 文件，接受有界 argv 数组或 Shell 命令字符串。数组更容易审查，优先使用：

```json
{
  "hooks": [
    {
      "id": "check-write",
      "hook_point": "pre_tool_use",
      "command": ["node", "scripts/check-write.mjs"],
      "matcher": {"tool_name": "Write"},
      "timeout_seconds": 3,
      "working_directory": "workspace",
      "env_policy": "minimal",
      "enabled": true
    }
  ]
}
```

支持 `pre_tool_use`、`post_tool_use`、`user_prompt_submit`、`stop`、`pre_compact`、`session_start`、`session_end`。配置 hook 只有当前命令摘要获批后才运行；修改命令会使审批失效。`inherit_safe`、禁用、缺审批和摘要不匹配显示为 doctor 警告，格式错误为失败检查。

Hook 使用正常沙箱/进程树控制器，最多 30 秒超时，有界 stdin/stdout/stderr 和选定安全环境。诊断不含命令参数、hook payload、输出正文或环境值。

## MCP

MCP 配置支持 `stdio`、`http` 和 `streamable_http`。新远程集成应使用 Streamable HTTP。

```toml
[servers.files]
transport = "stdio"
command = "node"
args = ["dist/server.js"]
startup_timeout_sec = 10
tool_timeout_sec = 60
enabled = true
required = false
enabled_tools = ["read_file", "search"]
disabled_tools = ["delete_file"]
default_tools_approval_mode = "auto"

[servers.files.sandbox]
mode = "workspace-write"
network = "enabled"

[servers.files.tools.read_file]
approval_mode = "approve"

[servers.catalog]
transport = "streamable_http"
url = "https://mcp.example.invalid/api"
bearer_token_env_var = "MCP_TOKEN"
startup_timeout_sec = 20
tool_timeout_sec = 60
default_tools_approval_mode = "prompt"
```

环境占位符按名称解析，值只传给 MCP 客户端，不由 list、inspect、doctor 或运行时诊断返回。工具 ID 为 `mcp:<server>:<tool>`；模型别名会清理，冲突使用确定性标识后缀，协议调用保留原始 MCP 名称。无论直接提供还是搜索发现，MCP 工具都使用当前审批策略。

根别名支持 `servers`、`mcp_servers`、`mcpServers`。URL 未指定传输时使用 Streamable HTTP。旧 `timeout_ms` / `timeout_seconds` 仍作为两个超时的兜底，缺省 30 秒。`startup_timeout_sec` 分别约束连接建立和每次发现操作，`tool_timeout_sec` 约束工具调用或资源读取；均为最大 300 秒的正数，不是启动总预算。

直接配置的 `cwd` 相对工作区解析，bundle 定义相对插件安装目录解析；不同 cwd 不授予该处写权限。`env_vars` 继承指定环境变量，显式 `env` 覆盖。`headers`、`http_headers` 接受字面值或 `${ENV_NAME}`，`env_http_headers` 将请求头名映射到环境变量名，`bearer_token_env_var` 设置 Authorization。缺失引用变量是配置错误，管理输出不打印值。

`enabled_tools` 是**原始 MCP 工具名**允许列表：缺省允许全部，空列表允许零个。`disabled_tools` 优先。过滤在路由和模型暴露前同时作用于缓存/实时目录。标准 annotation hint 保留，只读 hint 允许并行调度，但不授权执行。

已启用且 `required = true` 的服务器必须在运行时就绪前完成实时发现，缓存元数据不够。启动或 tools-list 失败阻塞就绪并关闭已启动客户端；单个不兼容工具和可选资源失败仍隔离。可选服务器后台发现，不延迟启动。插件提供的 MCP 服务器使用相同设置。

<a id="oauth-authentication"></a>

### OAuth 认证

需要 OAuth 的 Streamable HTTP 服务器：

```bash
mycli mcp add service --url https://mcp.example.com/mcp
mycli mcp login service
# Open the displayed authorization link, then return to the terminal.
mycli mcp logout service
```

相同命令支持已启用插件提供的服务器。使用 `mycli mcp list` 和 `/mcp` 显示的 `plugin-id/server-name`，如 `mycli mcp login my-plugin/docs` 或 `mycli mcp login my-plugin@personal/docs`，也接受内部 ID。登录/退出解析与运行时相同的有效配置，不启动插件 Worker、hooks、模型或无关 MCP 客户端。禁用或不受信任仓库插件不贡献服务器；相同内部 ID 的显式独立 MCP 配置优先。

登录使用 MCP SDK 的受保护资源/授权服务器发现、动态客户端注册、授权码和 PKCE。回调只监听 `127.0.0.1`，验证 state，并在完成、取消或五分钟期限后关闭。mycli 不自动开浏览器。认证请求遵循服务器配置及托管网络限制；HTTP 仅允许回环开发端点，重定向拒绝。

可在 `mcp_servers.toml` 设置预注册公开客户端和固定回调：

```toml
[servers.service.oauth]
client_id = "my-public-client" # omit to use dynamic registration
scopes = ["read", "write"]
callback_port = 8765 # omit for an automatically allocated loopback port
```

凭据存于 `~/.mycli/mcp-auth/` 私有文件，Unix 目录 `0700`、文件 `0600`，按服务器/来源、端点、请求头和 OAuth 设置隔离。这是私有文件存储，不是系统钥匙串。Code、state 和 PKCE verifier 只在当前登录期间保留。运行时读取 token，跨进程串行刷新并保留轮换后的 refresh token；刷新不打开浏览器。缺失/过期授权提示 `mycli mcp login <server-id>`。登录后空闲打开 `/mcp` 或下一轮触发发现刷新；共享执行仍活动或挂起时等待。退出删除当前配置凭据，影响后续请求，不撤销远端 token 或已发请求。

配置的 `Authorization` 及 `bearer_token_env_var` 独立于 OAuth 且优先；OAuth 登录拒绝此类配置，不静默换身份。旧独立 `http` 和 stdio 不使用此 OAuth 流程。Codex bundle 将 `type: "http"` 规范化为 Streamable HTTP，接受 `clientId` / `callbackPort` 别名，标准 `client_id` / `callback_port` 优先。逐服务器回调端口是 mycli 扩展，检查的 Codex 使用全局设置。

插件凭据还绑定插件 ID、来源和声明服务器名。不可变包快照更新时，端点、请求头和 OAuth 设置不变则保留登录；身份变化不继承凭据。工具审批包含包/配置和工具定义指纹，因此包更新仍可能需要新审批。`mcp list` 报告 `oauth`、`configured_header`、`not_logged_in`、`unsupported` 或 `unavailable`；`not_logged_in` 只表示没有保存的 OAuth 凭据，不代表服务器必需认证。

<a id="server-initiated-questions-elicitation"></a>

### 服务器发起的提问（Elicitation）

工具调用期间，MCP 可请求表单或让用户访问 HTTPS URL。TUI 显示服务器身份和消息，逐项展示字段，最后必须明确提交。支持字符串、数字、布尔、单选和多选，包括带标题枚举、可选/默认值。答案按原始 schema 验证，不做类型强转；无效答案继续等待修改。Escape 取消，Decline 拒绝。URL 模式显示链接和 Continue，不自动打开，也不将确认当作服务器登录成功。

请求与工具审批共用可见交互队列。答复后原调用继续，无需新模型调用或持久轮次挂起。用户等待时间不计入服务执行时限，每个提示限五分钟。Full Access 不自动答表单或确认 URL。mycli 不将表单答案或 URL 请求写入对话，也不通过 gateway 通知发布答案；服务器后续工具结果可能自行包含相关信息，按普通工具输出保存。

响应器仅实时有效，绑定服务器、连接代、会话和轮次。取消、所属调用完成、连接关闭或 UI 退出会取消待决请求，恢复会话不能复活。没有交互消费者的无界面请求立即取消。共享连接仅在活动调用具有唯一明确会话/轮次所有者时接受提问；启动/资源阶段主动请求或并发所有者有歧义时取消，不猜测对话。不支持 sampling 和 task-augmented elicitation。

<a id="mcp-process-and-network-permissions"></a>

### MCP 进程与网络权限

Stdio 服务器默认作为普通本地子进程运行，使用当前用户文件系统和网络访问，与 Codex 本地 MCP 启动一致。因此 Playwright 等可使用浏览器 profile、缓存和系统服务，无需先更改 Shell 权限。浏览器自身沙箱由浏览器/服务器配置控制。

长驻进程使用集成启动时解析、受托管执行策略限制的权限，不继承临时 Shell 授权或轮次权限选择变化。工具审批、hook 权限和 Plugin API v2 能力声明仍独立。逐服务器 `[servers.<id>.sandbox]` 可设 `mode = "workspace-write"`、`mode = "read-only"` 和/或 `network = "disabled"`。平台沙箱无法落实限制时拒绝执行；配置 `cwd` 不新增可写根。只读控制文件写入，网络为独立设置。

受域名限制的 stdio 在 macOS 使用已有代理。Linux/Windows 尚未实现代理强制路由，因此网络启用且域名限制非空时在启动前拒绝；空列表离线。任意托管只读根限制同样在启动前拒绝，因为当前进程沙箱无法落实。代理流量与平台限制见[网络策略](network-policy.md)。

两种 HTTP 传输在每次请求前检查网络禁用/域名边界。网络无限制时允许配置的回环端点。拒绝重定向，避免其他端点收到认证头、会话 ID 或工具参数；应直接配置最终 MCP URL。

<a id="tool-approval"></a>

### 工具审批

工具级 `[servers.<id>.tools.<raw-tool>].approval_mode` 覆盖 `default_tools_approval_mode`：

| 模式 | 行为 |
| --- | --- |
| `auto`（默认） | 普通权限下询问；Full Access 或现有工具授权允许执行 |
| `prompt` | 即使 Full Access 也询问，除非匹配明确会话/记忆授权 |
| `approve` | 配置明确授权该工具 |

交互审批提供 Approve once、Reject、Allow for session、Always allow。会话授权仅当前运行时会话有效；记忆授权保存在私有 `~/.mycli/integration-tool-approvals.json`，跨重启保留。每项授权绑定集成 ID 与服务器配置（含有效 stdio cwd）、工具定义和 annotation hint 的哈希，变化需重新审批。文件只含标识与哈希，不含端点凭据或参数，也不创建 Shell 规则。恢复审批执行前验证原范围；存储失败不能静默授予权限或启动工具。

`mycli mcp approvals` 查看记忆工具 ID，`mycli mcp revoke <server-id>` 删除该服务器记忆授权。已运行会话在后续调用看到撤销，但独立会话授权和已批准执行不受影响；重启会话清除会话授权。显式 `approve` 配置持续授权直到配置改变。

`mcp add` / `mcp remove` 通过私有原子写入器仅修改**用户配置**。Add 拒绝已有用户 ID，编辑保留无关 TOML 值（注释可能重新格式化），不启动客户端就验证并报告活动仓库覆盖。变化在下一空闲轮次或目录检查前应用。移除不删除记忆授权，需要时单独撤销。环境、超时、过滤、审批和沙箱参数见 `mycli mcp add --help`；`--` 保留服务器参数，包括其自身 `--json`。

原文中的 `mcp list`、`mcp inspect` 和 doctor 发现流程可连接已启用服务器验证发现，复用启动时的超时、沙箱、取消和清理路径，返回前关闭客户端。

Schema 在工具进入可用目录前检查，调用时验证 `uri`、`date-time`、`uuid` 等标准格式。不兼容工具以 `schema_error` 隔离，健康兄弟工具仍可用。工具与资源发现独立失败；有可用能力又有发现失败时服务器报告 `partial` 和限定范围详情。本地策略阻止与用户拒绝审批保持区别。

发现使用原生分页，检查 cursor 循环，最多 100 页、10,000 项、合计 8 MiB。重复刷新重新查询活动客户端，并发调用共享待决发现；单个取消不取消其他等待者。管理器为每个配置服务器拥有一个客户端，缓存和刷新注册复用它。

本地 stdio 调用取消/超时会废弃该代进程。进程自行退出时立即释放代理，后续明确调用可新建连接。取消/超时操作不自动重放；因进程废弃受影响的兄弟调用报告结果未知的连接失败。关闭管理器会永久停止发现并关闭客户端。

工具和资源失败包含有界诊断：操作、连接/请求阶段、HTTP 状态、JSON-RPC 代码和可用时允许的传输原因码。版本 1 错误上下文将证据保存到工具结果和会话历史，不包含 URL、会话 ID、认证头或原始上游错误体。

Streamable HTTP 中，携带 MCP 会话 ID 的 POST 收到 404，会重新初始化并最多重试被拒操作一次。ModelScope 401 携带精确 JSON 代码 `SessionExpired`，且发送过会话 ID 时也采用此恢复；普通 401 不触发会话重建。已保存 OAuth 身份可刷新并重试一次明确拒绝的 401，这与会话恢复独立。并发失败共享替代连接，旧连接上已运行请求可完成。取消或关闭停止后续恢复。无会话 ID 的 404、普通 HTTP 错误、超时和不明确断连不自动重放。无法确认执行时记录未知结果，调用者应先查远端状态再重试可能有副作用的操作。可选 GET 流不支持（405）仍兼容基于 POST 的服务器。

<a id="images-and-mcp-resources"></a>

## 图片与 MCP 资源

`view_image` 接受本地 `path`，按实际内容解码 PNG、JPEG、GIF、WebP，检查文件读取权限，将大图缩放到 2048 × 2048 内。模型支持原始细节时暴露 `detail: "high" | "original"`，`original` 保留原尺寸。不裁剪、不渲染 SVG、不做 OCR 或调用 Quick Look。图片字节和 detail 跨会话恢复保留。输入/输出文件最多 10 MB，解码最多 6400 万像素。平台解码二进制由 npm 可选依赖安装，仅查看图片时加载；缺少它们仍可启动和使用其他工具。

`list_mcp_resources` 和 `list_mcp_resource_templates` 接受可选 `server`、`cursor`。省略 server 聚合配置服务器；指定服务器返回一页原生 MCP 结果。将 `nextCursor` 作为 `cursor` 与同一 server 传回。模板返回 `uriTemplate`（如 `data:///notes/{name}`），实例化后交给 `read_mcp_resource({server, uri})`，不需要激活 MCP 工具。

资源结果为有界 JSON，明确标记截断。图片资源作为图片附加，不是 base64 文本。历史 `offset` 调用仍通过仅分发兼容 schema 执行；新 provider 请求采用 Codex 风格参数。范围差异见 [Codex 对照](../parity/2026-09-09-image-resource-tools.md)。

## Skills

Skill 为 `<root>/<name>.md` 或 `<root>/<name>/SKILL.md`，含 TOML 或 YAML frontmatter：

```markdown
---
name: repository-review
description: Review repository changes for correctness and risk.
trigger_hints: [review, regression]
workspace_dependencies: [.git]
guardrails: [Do not modify files.]
---

Inspect the requested change and report findings before summaries.
```

默认 provider schema 只有一个稳定 `Skill` 工具，单个 skill 文件不增加工具。成功调用将有界、明确隔离的指令追加到持久对话。管理/doctor 只显示数量和问题分类，不暴露正文。

<a id="subagents"></a>

## 子 Agent

子 Agent 由提示词驱动。父 Agent 提供 `task_name`、`message` 和可选 `fork_turns`，没有 profile 文件或专属提示词、模型、工具、预算。子 Agent 继承父 Agent 已解析 provider/模型、执行策略和暴露工具。运行时预算可选，省略不会引入隐藏轮次/调用上限。

每个子 Agent 是独立持久 Node 线程，拥有不可变标识、标准路径、冻结最小权限策略、provider 状态、队列、取消边界和会话产物。父所有权控制路由、中断、恢复和关闭清理。

协调工具为 `spawn_agent`、`send_message`、`followup_task`、`wait_agent`、`interrupt_agent`、`list_agents`。`spawn_agent` 是唯一创建入口；不注册或导出 `Task`、旧 `SendMessage`、`SubagentOutput`。

终态报告自动、幂等进入持久父邮箱。每个子会话拥有自己的 `session.json`、`events.jsonl`、任务输出、子 Agent 投影、对话状态和用量投影。父任务/子 Agent 文件只是可读索引；SQLite 为权威来源并修复派生文件。仅对 provider 可见的邮箱内容不会渲染为用户消息。

只有没有独立工作时才使用 `wait_agent`。它订阅邮箱、生命周期、用户补充指令、取消和超时，不轮询或创建进程。`WriteStdin` 仅用于已有持久 Shell 会话。完整配置、权限、产物、恢复和 TUI 契约见 [node-agent-runtime.md](node-agent-runtime.md)。

<a id="plugins"></a>

## 插件

可通过 `mycli plugins add <directory|Git-source|name@marketplace>` 安装 Codex 风格 bundle，经现有体系提供命名空间 skills、MCP 和命令 hooks。用 `mycli plugins marketplace add <source>` 注册目录，再 `mycli plugins list --available` 浏览。安装/更新/启用/禁用/移除在下一轮或空闲检查前生效，安装不执行代码。活动/挂起执行保留原工具、skills、hooks 和连接，直到所有者完成；其他会话独立刷新，包括有等待子 Agent 的父会话。新执行捕获目录前完成新配置发现，未变配置复用连接。必需服务器/组装失败保留原内容并拒绝刷新，修正后重试。Apps 声明报告不可用。格式、命令和限制见 [plugin-codex-parity.md](plugin-codex-parity.md)。

可执行 ESM 插件使用进程隔离 Plugin API v2，生产入口必须编译成 `.js` 或 `.mjs`，不执行原始 TypeScript/Python。作者契约见 [plugin-api-v2.md](plugin-api-v2.md)，Python 迁移见 [migration/python-plugins-to-v2.md](migration/python-plugins-to-v2.md)。

工具 ID 为 `plugin:<plugin-id>:<tool-name>`，共用上述直接/延迟暴露、标识规范化和目录发布规则，保留审批策略。命令无需 provider，hooks 加入正常有序管线。Worker 只接收最小环境及明确声明变量；每次调用受协议大小、超时、待处理请求和输出限制。

`/plugins` 反映实时进程状态：崩溃为 `error`，替代启动为 `loading`，初始化成功重新启用。成功调用不刷新目录；已废弃/关闭运行时不能发布旧状态。

失败标明插件、操作、阶段和退出码/超时等安全进程证据。崩溃、超时或取消后，运行时可为新调用启动一次替代进程；并发共享启动，取消调用不分发。未知结果不自动重放。注册变化或协议损坏需修正插件并重载。`mycli plugins run` 和 `/plugin:<id>:<command>` 仍无需 provider。Codex 对照范围见 [plugin-codex-parity.md](plugin-codex-parity.md)。

<a id="doctor-and-troubleshooting"></a>

## Doctor 与故障排查

`mycli doctor` 独立、顺序运行采集器。一次异常变为一次失败检查，后续继续。只有警告退出 `0`，任一失败退出 `1`。

`mycli doctor --fix` 只预览确定性修复。应用要求 `--confirm <plan-id>` 精确匹配显示计划；当前修复由配置模块执行标准用户配置迁移。`--support-bundle` 写私有允许列表 JSON，不含原始日志、扩展数据、命令、凭据、provider 数据，也不自动上传。

报告覆盖配置/认证是否存在、只读 SQLite/存储、日志/跟踪/脱敏、包和 gateway 契约、内置工具清单、沙箱/进程支持、所有扩展来源及 Python 插件迁移状态，不调用模型。SQLite 只读打开，不创建、迁移、修复、删除或 vacuum 本地状态。

`mycli sandbox status [--json]` 运行相同无副作用就绪检查，不加载扩展、启动后端/TUI、调用 provider、提权或安装。`sandbox setup`、`reset`、`repair` 和 `uninstall` 默认返回类型化预览，状态修改必须 `--confirm`。响应包含权限要求、有界影响、结果码和操作后就绪状态。Windows setup 可请求 UAC，reset 清理已记录的 ACL 和本地安装状态，保留账号与网络限制；repair 停止沙箱进程后重建安装，uninstall 还会移除已确认归属的专用账号和网络规则，详见 [Windows 维护](windows.md)。macOS/Linux 缺依赖仍手动恢复。原生输出和路径不进入响应。

常见处理方式：

- `config=failed`：修正 TOML 或 provider/协议兼容后重跑。
- `sessions_db=failed`：保留文件，检查 schema/恢复诊断；doctor 不修复。
- `process_sandbox=failed`：运行 `mycli sandbox status` 查看稳定代码和建议，再按 [node-runtime-rollout.md](node-runtime-rollout.md) 安装/修复平台依赖。
- `hooks=warning`：检查并批准当前 hook 标识/摘要。
- `plugins=failed`：构建声明的 ESM 入口，确认清单与注册匹配。
- `plugin_migration=warning`：迁移 Python 插件，Node 不导入它们。
- `mcp=failed`：检查传输及引用环境变量名，不把凭据值放入配置或输出。

Skills/hooks 也可用 `/skills`、`/hooks` 管理。用户启用覆盖按来源标识存于 `~/.mycli/integration-enablement.json`；命令信任仍在 `~/.mycli/hook-allowlist.json`。改变可用性不授予命令信任。文件/目录/信任变化作用于后续轮次，活动执行保持捕获的定义和审批；插件 hooks 保留插件权限来源。
