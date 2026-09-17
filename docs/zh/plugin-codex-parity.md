<a id="plugin-behavior-compared-with-codex"></a>

# 插件行为与 Codex 的对照

[English](../plugin-codex-parity.md) | **简体中文** | [中文目录](README.md)

对照来源为 2026-09-12 检查的本地 `codex-main` 源码快照。下载快照没有 Git 修订元数据，本文描述检查到的代码，不代表每个 Codex 版本。下文说明 mycli 支持的包格式子集。

<a id="architecture"></a>

## 架构

Codex 插件是由 `.codex-plugin/plugin.json` 描述的 bundle，通过现有能力体系提供 skills、MCP 服务器、apps 和 hooks。相关源码为 `codex-rs/core-plugins/src/manifest.rs`、`codex-rs/core-plugins/src/loader.rs`。插件 MCP 工具使用 MCP 客户端和连接管理器，并复用服务器/工具错误上下文。

mycli 通过已有 skill、MCP 和配置 hook 体系加载 Codex 风格 bundle，同时保留进程隔离的 Plugin API v2：`plugin.yaml`、编译 ESM，以及通过 JSON-lines 验证的工具/hook/命令注册。这是两种独立编写格式。

<a id="tui-entry-points"></a>

## TUI 入口

所检查的 Codex TUI 有独立 `/mcp`、`/plugins`、`/skills`、`/hooks`，没有公开 `/tools` 目录（`codex-rs/tui/src/slash_command.rs` 和 `chatwidget/slash_dispatch.rs`）。mycli 同样按领域分开：`/mcp [verbose]` 检查服务器状态和工具；`/plugins` 浏览包，Enter 查看能力与管理操作。MCP 资源和插件命令不是插件包，不作为单独插件行。

mycli 保留 `/tools [list|sets]` 作为仅搜索可见的实际工具诊断清单。旧 `/tools plugins`、`/tools hooks`、`/tools extensions` 返回替代提示。`/skills` 支持搜索调用和持久启用；所选 skill 在输入框及排队输入中保留来源标识。`/hooks` 按事件分组、显示命令和来源，并区分启用与精确命令信任；插件 hook 的信任属于包。

Codex 插件浏览器有 All Plugins、Installed 和市场标签、搜索、能力详情、安装/启用操作（`chatwidget/plugins.rs`）。mycli 对已注册本地/Git 市场采用相同交互：Left/Right 切换标签，输入搜索，Enter 看详情，空搜索时 Space 启用/禁用。详情包含来源、版本、声明能力名、问题、安装/更新/卸载和 Back。Ctrl+A 查看全文，Ctrl+R 刷新。卸载和移除市场需要确认。

Ctrl+N 打开本地/Git 插件安装；Add Marketplace 审查并注册来源。每个具名市场有 Manage marketplace 行，可刷新/移除。新注册市场自动选中；移除市场保留已安装包。操作复用 CLI 包管理器，不需要模型调用。

目录检查只读元数据。Enabled/disabled 表示配置，不代表进程健康；运行时状态仍由 `/mcp` 和资源诊断反映。不受信任仓库插件隐藏。坏市场保留可见问题，其他目录仍可用。缺少本地清单的远程包安装后才显示能力详情。

目录响应最多 2,048 项、6 MiB，过大时明确报告省略，可选具名市场缩小范围。能力详情按需加载，最多 1,024 行并明确省略。关闭、切换会话或退出会取消待决包工作并忽略迟到 UI 结果。如果原子提交先于取消完成，仍视为成功。活动轮次在已有安全刷新边界采用变化。

<a id="install-and-manage"></a>

## 安装与管理

安装包含插件的本地目录或 Git 仓库：

```sh
mycli plugins add ./my-plugin
mycli plugins add owner/repository --ref stable
mycli plugins list
mycli plugins inspect my-plugin --json
mycli plugins disable my-plugin
mycli plugins enable my-plugin
mycli plugins update my-plugin
mycli plugins remove my-plugin
```

或注册本地/Git 市场并选择包：

```sh
mycli plugins marketplace add ./personal-marketplace
mycli plugins marketplace add owner/plugin-marketplace
mycli plugins marketplace list
mycli plugins list --available --marketplace personal
mycli plugins add my-plugin@personal
mycli plugins marketplace upgrade personal
mycli plugins update my-plugin@personal
mycli plugins marketplace remove personal
```

`list --marketplace personal` 过滤已安装/发现包，加 `--available` 包含未安装市场条目。市场 upgrade 刷新目录，插件 update 需显式执行。移除市场保留已安装包，从该市场更新前需重新注册。所有管理命令支持 `--json`，不调用模型。Git 来源支持 HTTPS、SSH、`owner/repository`、`#ref` 和 `--ref`。拒绝带凭据 URL、本地 Git transport 和任意 transport helper；私有仓库使用 SSH 认证。Git 执行禁用用户 Git 配置、模板和 hooks，不运行包安装脚本、不下载子模块，依赖需事先可用。

包变化在下一轮前或空闲集成刷新时应用。Skill/hook 管理只读元数据，不启动扩展宿主。活动或挂起轮次保留原集成内容；各会话独立刷新，等待中的子 Agent 不阻塞父 Agent。配置变化需先完成 MCP 发现，再让新执行捕获工具；未变的轮次复用客户端。`/plugins` 显示包状态，`/skills` 选择或配置带命名空间的 skill，MCP 工具按直接/延迟暴露和会话发现复用进入集成目录。

插件 MCP 服务器使用共用管理和 OAuth 流程：

```sh
mycli mcp list
mycli mcp inspect my-plugin/docs
mycli mcp login my-plugin/docs
mycli mcp logout my-plugin/docs
mycli mcp revoke my-plugin/docs
```

市场限定插件使用 `my-plugin@personal/docs`。可读选择器和不透明内部服务器 ID 指向同一有效配置。`/mcp` 标识所属插件，`/plugins` 显示其 MCP 选择器；精确独立服务器 ID 覆盖优先。登录/退出不启动插件 Worker、hooks 或无关 MCP 连接。登录后打开空闲 `/mcp` 或开始下一轮以重新发现。退出只移除存储凭据，不撤销远程 token 或已发请求。

插件标识/来源、声明服务器名、端点、请求头和 OAuth 设置不变时，凭据可跨包缓存更新复用。工具审批包含包快照与 schema，因此变化内容不能复用旧审批。认证状态 `not_logged_in` 只表示没有存储凭据，匿名服务器仍可能可用。

<a id="package-format"></a>

## 包格式

```text
my-plugin/
  .codex-plugin/plugin.json
  skills/review/SKILL.md
  .mcp.json
  hooks/hooks.json
```

```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "description": "Repository review helpers",
  "skills": "./skills",
  "mcpServers": "./.mcp.json",
  "hooks": "./hooks/hooks.json"
}
```

也识别 `.claude-plugin/plugin.json`。省略组件字段时发现 `skills/`、`.mcp.json`、`hooks/hooks.json` 和 `.app.json`。声明路径必须以 `./` 开头、存在且位于真实包根内。Skills 接受单路径或数组；MCP 接受 JSON 路径或内联服务器表；hooks 接受 JSON 路径、内联表或这些值的数组。声明文件无效时，在替换旧包前安装失败；个别 MCP/hook 条目损坏产生有界问题，有效项继续可用，bundle 显示 `partial`。

插件 skill 使用 `my-plugin:review` 或 `my-plugin@personal:review`，用于激活、持久上下文和对话显示。指令携带包根和源文件以解析相对引用。MCP 服务器 ID 稳定且按插件隔离，描述保留插件来源。除普通 MCP 字段外，MCP JSON 支持 `mcpServers`、根替换 `${CODEX_PLUGIN_ROOT}` / `${CLAUDE_PLUGIN_ROOT}`、`env_vars`、`http_headers`、`bearer_token_env_var`、`cwd` 和 `tool_timeout_sec`。OAuth `clientId` 规范化为 `client_id`。mycli 还将 `callbackPort` 接受为 `callback_port`，保留逐服务器回调配置；检查的 Codex 实现使用全局回调设置。两种拼写同时出现时标准键优先。缺失环境值产生配置问题，诊断不打印值。

命令 hook 支持现有 `PreToolUse`、`PostToolUse`、`SessionStart`、`UserPromptSubmit`、`Stop` 分组。环境包含 `CODEX_PLUGIN_ROOT` 与 `CLAUDE_PLUGIN_ROOT`，Shell 命令中应引用这些变量。启用/安装插件授权声明的 hooks，但仍在现有工作区沙箱执行。不支持 prompt/agent hook 类型和其他 Codex 事件。OpenAI 托管 Apps 无法在 mycli 执行；声明 Apps 会产生 `plugin_apps_unavailable`，其他组件仍可用。

<a id="marketplace-format"></a>

## 市场格式

默认清单为 `.agents/plugins/marketplace.json`，也识别 `.agents/plugins/api_marketplace.json` 和 `.claude-plugin/marketplace.json`。

```json
{
  "name": "personal",
  "plugins": [{ "name": "my-plugin", "source": "./plugins/my-plugin" }]
}
```

来源也可使用对象：`{ "source": "local", "path": "./plugins/my-plugin" }`、`{ "source": "url", "url": "https://example.com/repo.git", "ref": "stable" }` 或 `{ "source": "git-subdir", "url": "https://example.com/repo.git", "path": "plugins/my-plugin" }`。Git 条目可选固定 40 字符提交 `sha`。`policy.installation = "NOT_AVAILABLE"` 的条目仍可见但不能安装。

<a id="storage-and-activation"></a>

## 存储与激活

私有 `~/.mycli/plugin-registry.json` 跟踪安装和市场来源，不可变快照放在 `~/.mycli/plugin-cache/`。安装只复制验证文件，不执行插件代码。暂存限制为 10,000 项/128 MiB，拒绝越界符号链接、循环和特殊文件，省略 `.git`。注册表更新有锁且原子；失败或取消保留原安装，并发安装不能静默覆盖。首次成功安装默认启用，除非配置禁用。

启用/禁用原子更新用户 `[plugins] enabled/disabled`，保留其他设置，包括首次写入时的旧用户配置。仓库 `disabled` 仍优先。非托管目录插件仍需主动启用；不受信任仓库不贡献插件。已安装用户包独立于仓库信任。

更新和移除保留旧快照，因为活动会话可能仍读包文件。尚无自动快照垃圾回收，重复更新会增加磁盘占用。注册表决定下一安全刷新时激活哪些包，缓存目录存在本身不决定。替换同时发布工具、skills、hooks、命令和资源，再废弃关闭旧客户端/宿主。必需 MCP 或组装失败会保留原内容，并阻止刷新直到修正配置。并发准备/检查共享串行替换；关闭取消发现并阻止迟到发布。显式工作区信任变化仍立即执行原有门禁。

<a id="applied-behaviors"></a>

## 已采用的行为

| 事项 | 检查到的 Codex 行为 | mycli 行为 |
| --- | --- | --- |
| 能力发现 | 只有启用且无错误插件贡献能力，描述规范化且有上限 | 禁用/无效插件不注册；延迟工具发现限制描述大小 |
| 失败隔离 | 插件加载和 MCP 配置保留逐插件/服务器错误 | 某插件失败不阻止其他插件加载或破坏其调用 |
| 并发生命周期 | 串行加载、重查缓存，只为当前缓存代发布 | 新调用共享一次替换；已废弃/关闭内容不能发布旧状态 |
| 诊断 | 加载和 MCP 调用错误保留所属插件/服务器上下文 | 标准集成错误保留插件、操作、阶段、超时、退出/信号和一次前序失败 |
| 状态 | 配置启用与成功激活分开 | 目录分别跟踪实际进程状态和配置启用 |
| MCP 认证 | 登录/退出解析合并的独立及插件 MCP 配置 | 共用服务器发现服务运行时、list/inspect、登录/退出和审批撤销 |
| 包激活 | 有效插件变化清缓存，并在后续轮次前排队刷新 MCP | 包/配置/认证变化在目录捕获或空闲检查前按会话独立刷新 |

Codex 加载/缓存证据位于 `codex-rs/core-plugins/src/manager.rs`（`plugins_for_config` 和缓存 generation 检查）。逐服务器 MCP 配置错误位于 `codex-rs/codex-mcp/src/plugin_config.rs`，调用使用 `codex-rs/codex-mcp/src/connection_manager.rs`。OAuth 管理使用 `core/src/mcp.rs::McpManager::configured_servers` 和 `cli/src/mcp_cmd.rs`。激活证据在 `app-server/src/request_processors/plugins.rs::on_effective_plugins_changed`、`app-server/src/mcp_refresh.rs`、`core/src/session/handlers.rs`、`core/src/session/mcp.rs`。两者均按会话拥有 MCP 连接，在安全边界刷新。本地快照无已验证发布修订，只能作为源码对照。

切走再切回时，mycli 复用会话的活动运行时。仅检查历史不启动插件进程或 MCP 连接。待决轮次保留原工具、Skill、hooks 和资源服务，其他会话可以立即采用包更新。Agent 调度仍由后端拥有，关闭一个子 Agent 不关闭兄弟或父 Agent 集成客户端。

子 Agent 继承捕获的配置，使用独立客户端。持久权限记录只含配置/工具指纹，不含 MCP 凭据。卸载后的子 Agent 重载时如果配置已变化，旧权限下集成不可用；应从更新后的父 Agent 新建子 Agent。没有指纹的旧子 Agent 保留内置工具。托管 Apps/账号同步、操作系统钥匙串和包缓存 GC 属于后续工作。

<a id="mycli-process-recovery"></a>

## mycli 进程恢复

进程替换属于 mycli ESM 宿主，不代表 Codex 插件协议。崩溃、调用超时或取消终止旧宿主；后续新调用可替换一次，与并发调用者共享初始化，并验证完整原注册集。关闭或取消最后等待者会停止初始化和后续分发。

已分发调用不自动重放，因为结果未知且可能有副作用。替代启动失败意味着新调用未开始。协议损坏和注册不匹配需修正并重载。普通处理器错误不影响健康进程继续使用。这与 MCP 会话过期恢复不同：后者具有类型化、携带会话的 POST 404，可确认拒绝执行后允许一次有界重放。

<a id="verification"></a>

## 验证

原文记录的验证环境为 2026-09-12 macOS、Node 24：生产构建、lint、类型检查、契约/配置一致性和错误发出点清单检查通过。全部五个 CI 套件共 437 文件通过：346 单元、30 契约、52 集成、8 平台、1 发布。

回归使用临时主目录、回环 OAuth/MCP 服务、确定性 provider 和本地插件进程，覆盖限定登录/退出、配置优先级及脱敏、不可变更新间凭据复用、审批失效、目录刷新、活动/挂起执行保留、并发刷新、准备失败/取消和关闭。浏览器测试还覆盖只读元数据发现、具名能力、来源修订竞争、有界目录、显式安装/移除、提交后取消、会话切换、延迟详情、草稿保留、Unicode/窄布局和无颜色输出。真实 SDK/gateway 流程在审批期间更新插件，并在同一后端执行新旧两个版本。

远程 Git 认证、OpenAI 托管 Apps 和真实 provider 缓存命中不在验证范围内。托管市场/账号同步、操作系统钥匙串和自动包快照 GC 仍不支持。
