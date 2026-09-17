<a id="command-reference"></a>

# 命令参考

[English](../commands.md) | **简体中文** | [中文目录](README.md)

受域名限制的 Shell 网络、平台支持和托管策略配置见[网络策略](network-policy.md)。

<a id="provider-failures-and-recovery"></a>

## Provider 失败与恢复

临时上游失败（包括 `upstream request failed`）和响应流断连，会在 `request.request_max_retries` 与 `request.stream_max_retries` 配置上限内重试。HTTP 200 响应也可能在流式输出时失败。两条重试路径都遵循上游 Retry-After 延迟；pi-ai 不执行额外隐藏重试。

重试时 TUI 显示 `Reconnecting... n/max` 和安全处理后的上游原因。Esc 可中断等待。恢复后临时状态清除；重试耗尽产生一条持久错误，保留最后安全原因，`/resume` 后也可见。只重试失败的模型步骤，不重试已经执行的工具。认证、权限、配额、上下文上限和无效请求错误不进入普通重试循环；上下文上限可能转入已有压缩流程。

本地 Worker 请求大小上限使用相同压缩恢复路径，并在详情中说明本地执行限制。重复同样的长输入无法解决；自动压缩无法减小时，应使用 `/compact` 或减少附加输入。Provider RPC 上限为 32 MiB，与模型 token 窗口独立。

`/trace export` 保留大小受限的逐次尝试分类和重试证据，不包含凭据、原始错误体、本地异常堆栈或模型输出。历史错误未记录的上游详情无法事后补回。

<a id="noninteractive-coding-commands"></a>

## 非交互式编程命令

App-server 连接、协议和关闭行为见 [Gateway API](gateway.md)。

| 命令 | 用途 | 执行行为 |
| --- | --- | --- |
| `mycli app-server [--session id] [--model model] [--profile name]` | 提供 Agent 协议服务 | 通过 stdio 使用 JSON-RPC，沿用同一受监督后端和审批策略 |
| `mycli exec [options] [prompt\|-]` | 执行一项编程任务 | 无需 TTY，使用受监督运行时；支持 stdin、JSONL 事件和经过验证的输出文件 |
| `mycli review [--uncommitted\|--base ref\|--commit ref] [instructions]` | 审查 Git 改动 | 使用只读 Agent 返回经过验证的发现；无改动时不调用 provider |

```bash
mycli exec "Fix the failing parser test"
mycli exec --json - < task.txt
mycli exec --output-schema result.schema.json -o result.json "Inspect the repository"
mycli exec --session <id> "Continue the task"
mycli review --uncommitted
mycli review --base main --json
mycli review --commit HEAD -o findings.json
```

两个命令都支持 `--model`、`--profile`/`-p`、`--json`、`--timeout <seconds>`（默认 600，最大 86400）和 `--output-last-message`/`-o`。Exec 还支持 `--session` 和 `--output-schema`。以连字符开头的提示词前加 `--`。没有提示词或使用 `-` 时，exec 从非 TTY stdin 读取最多 1 MiB。不提供交互回退。Provider 和凭据必须已就绪，工作区必须已通过 mycli 交互式信任选择器获信任；这些命令不授予或保存信任。

普通 stdout 只包含最终答案或审查结果，诊断走 stderr。带 `--json` 时，每个 stdout 行都是含 `version: 1` 和 `type` 的 JSON 对象：`session.started`、`turn.started`、`message.delta`、`tool.started`、`tool.completed`、`interaction.required` 或最终 `exec.result`。结果包含 `status`、`exit_code`、可选 `code`、会话/轮次 ID、`final_message`、provider 报告的 `usage`，以及启用 schema 时验证过的 `structured_output`。流式 delta 是临时内容，只有完成的 `exec.result` 才确认验证成功。事件投影不包含工具参数预览、提问正文或审批命令文本。

退出码：完成为 `0`，执行/验证失败为 `1`，无效输入为 `2`，需要交互为 `3`，超时为 `124`，SIGINT 为 `130`，SIGTERM 为 `143`。审批、澄清或待处理会话恢复返回 `3`。使用报告的会话重启会恢复历史并中断此前未答复的轮次；新提示词开始新工作。无界面客户端不会自动回答决定。正常运行时权限仍适用于 exec，也可以授权工作区编辑。

`--output-schema` 接受本地 JSON Schema（draft-07，最多 64 KiB）。mycli 向提示词添加格式指引，并用 Ajv 验证最终 JSON，不是 provider 原生受限解码。异步 schema、无法解析的引用和不支持的格式会被拒绝。验证失败不替换输出文件。最终文件以私有权限原子写入，最大 4 MiB。

Review 默认审查暂存、未暂存和未忽略的未跟踪改动，也支持尚无提交的仓库。`--base` 比较 merge base 与已提交 HEAD；`--commit` 比较指定提交与第一父提交（初始提交则与空树比较）。目标选项互斥。上下文限 256 KiB、300 个路径，过量改动明确失败；二进制内容会标为限制。Review 在发现前禁用 hooks、plugins、MCP、skills 和子 Agent，只暴露本地 `Read`。历史读取使用选定 Git 修订，而非当前工作树文件。Review 不运行测试或修改文件；`-o` 是明确的输出文件写入。

发现项包含 `severity`（`P0` 到 `P3`）、`title`、包含证据和影响的 `body`，以及 `location`（`path`、`start_line`、`end_line`）。位置必须属于已改变路径，且范围出现在提供的 diff 中，最多十行。输出 schema 内置。退出 `0` 表示审查完成，即使有发现也如此；自动化应检查 `structured_output.findings`。

固定任务集和主动启用的模型评估运行器见 [coding-evaluation.md](coding-evaluation.md)。

<a id="workspace-guidance"></a>

### 工作区指引

受信任工作区内，mycli 从 Git/工作区根目录到当前工作目录逐级加载指引。每层依次提供 `AGENTS.md`（或 `agents.md`）和 `.mycli.md`（或 `MYCLI.md`）；两种格式均可贡献内容，更局部的指引在其目录范围内优先。使用首个存在的别名，并按规范路径去重。从嵌套目录启动仍继承仓库上层指引。

没有主指引文件时，先回退到 `CLAUDE.md`/`claude.md`，再到 `.cursorrules`，先搜索 cwd 再搜索工作区根目录。各层共享 24,000 个 Unicode 字符预算，截断有可见标记。被阻止的指令劫持/控制内容及指向搜索边界外的符号链接会被排除，不影响其他有效层。指引文件是参考上下文，不授予权限。

<a id="provider-free-cli-commands"></a>

## 无需 Provider 的 CLI 命令

以下命令不启动模型轮次或模型 provider 请求，并在注明的非交互 Shell 中可用。`login --oauth` 联系 provider 认证服务且需要终端；`update check` 可能联系 npm 注册表；`setup` 可能准备包内 ripgrep 辅助程序，但都不向模型 provider 发送内容。

| 命令 | 用途 | 执行行为 |
| --- | --- | --- |
| `mycli setup` | 配置一个 provider、模型、端点和凭据引用 | 终端使用 TUI，否则使用普通提示；取消不写入 |
| `mycli login status [--json]` | 检查所选 provider 的凭据来源 | 只读本地配置、环境元数据和凭据存储，不联系 provider |
| `mycli logout [--json]` | 删除一个存储的 API Key 或 OAuth 授权 | 保留无关凭据引用，不能删除环境凭据 |
| `mycli config <action> [arguments]` | 验证、查看、定位、迁移或修改配置 | 支持 `validate`、`show`、`get`、`set`、`unset`、`path`、`migrate`；均支持 `--json` |
| `mycli doctor [--json] [--verbose] [--fix [--confirm <plan-id>] \| --support-bundle]` | 检查健康状态、预览/应用安全修复或导出有界诊断数据 | 不依赖 provider；默认及修复预览只读，应用绑定显示的计划 ID |
| `mycli update [action]` | 读取缓存更新状态、显式刷新或忽略一个精确版本 | 只有 `check` 联系 npm 注册表，绝不安装包 |
| `mycli sandbox status\|setup\|reset\|repair\|uninstall [--confirm] [--json]` | 检查、恢复或移除平台沙箱状态 | status 只读；其他操作默认预览，仅 `--confirm` 执行 |
| `mycli hooks <action> [identity]` | 列出、检查、批准或撤销配置的 hook | 操作本地 hook 元数据，支持 `--json` |
| `mycli plugins <action> [arguments]` | 安装、管理、检查或运行插件；管理市场 | 包操作使用本地或 Git 来源；执行前验证声明命令和 JSON 参数 |
| `mycli mcp <action> [server-id]` | 列出或检查配置的 MCP 服务器 | 可能启动或联系已启用服务器验证发现，不启动模型轮次 |
| `mycli session <action> [arguments]` | 列出、恢复、分叉、重命名、归档、还原、删除或导出会话 | 管理操作无需 provider；`session resume <id>` 进入交互 TUI |
| `mycli completion <bash\|zsh\|fish\|powershell>` | 生成一个受支持 Shell 的补全 | 向 stdout 写静态脚本，不加载管理服务、provider、后端或 TUI |

`mycli session export <id> --training --output <new-file.jsonl>` 导出一份完整对话，包含已保存指令、消息、明文推理、工具调用/结果和图片。用 `--json` 获取报告。格式见[对话导出](sessions.md#training-data-export)。

`mycli login --oauth [--provider <id>] [--auth-ref <ref>]` 使用受支持原生 provider 的 pi-ai OAuth 流程。凭据私有存储，秘密输入隐藏，取消不会保存迟到授权。`login status` 和 `logout` 都按所选凭据引用处理 API Key 和 OAuth；退出后原生环境凭据发现仍可用。

标准 CLI 目录拥有上述命令名、操作、选项、帮助摘要和固定值候选。UX 契约检查会核对目录、解析器、根 `mycli --help`、此表及四种补全脚本的一致性。

`mycli login --with-api-key` 只从非 TTY stdin 接受 API Key。可选 `--provider <id>` 和 `--auth-ref <ref>` 选择保存位置；没有受支持命令接受 argv 中的秘密值。`mycli setup --non-interactive --provider <id> --with-api-key` 使用相同 stdin 边界，要求明确 provider 选项；不完整调用返回可操作用法错误，不启动 TUI。

<a id="shell-completion"></a>

### Shell 补全

通过以下任一命令为当前 Shell 会话加载补全：

```bash
source <(mycli completion bash)
```

```zsh
autoload -Uz compinit && compinit
source <(mycli completion zsh)
```

```fish
mycli completion fish | source
```

```powershell
mycli completion powershell | Out-String | Invoke-Expression
```

将对应命令加入 Shell 启动文件，可在后续会话启用。生成脚本只含静态命令目录，支持管道 stdout，不读凭据、不启动 provider，也不输出终端控制序列。

Doctor 修复和诊断包操作是显式管理命令：

```bash
mycli doctor --fix [--json]
mycli doctor --fix --confirm <plan-id> [--json]
mycli doctor --support-bundle [--json]
```

第一种只返回不含配置值的准确操作和影响。确认必须携带计划 ID；并发配置变化会在应用任何新计划前以 `version_conflict` 失败。当前修复通过已有迁移备份事务规范化/导入标准用户配置，不编辑凭据、不提权、不安装包或联系 provider。诊断包写入私有 `~/.mycli/support/` 下的 `0600` JSON 文件，只包含允许的运行时版本、诊断条目、配置层元数据和汇总就绪状态，不含提示词、命令、工具内容、provider 数据、原始日志、堆栈、凭据、会话 ID 或不必要的绝对路径。

沙箱恢复同样不依赖 provider，也无需交互终端：

```bash
mycli sandbox status [--json]
mycli sandbox setup [--json]
mycli sandbox setup --confirm [--json]
mycli sandbox reset [--json]
mycli sandbox reset --confirm [--json]
mycli sandbox repair [--confirm] [--json]
mycli sandbox uninstall [--confirm] [--json]
```

未确认的 setup/reset/repair/uninstall 返回所需权限和有界影响，不修改状态。Windows 确认 setup 后可能打开 UAC，并在提权后验证辅助程序握手。取消 UAC 变为 `operation_canceled`，不暴露辅助程序输出。确认 reset 要求没有活动沙箱 helper，清理已记录的文件 ACL、mycli 凭据和安装标记，保留受限账号及防火墙/WFP 限制。repair 会停止沙箱进程、清理记录的 ACL、重建安装并验证就绪状态。uninstall 还会移除已确认归属的专用账户、账户系统配置目录、网络规则、已记录的 WFP 授权和已知状态文件，详见 [Windows 维护](windows.md)。macOS/Linux 报告缺失系统依赖并提供手动包管理指引，不自动安装。人类可读和 JSON 输出来自相同类型化响应。

<a id="configuration-management"></a>

### 配置管理

配置管理不依赖 provider 或 TTY。`config validate` 将未知和弃用设置视为警告；`config validate --strict` 存在任何警告就返回 `1`。致命语法、凭据位置和已知值错误在两种模式中都返回 `1`。诊断只含有界的层、键和源位置元数据。

```bash
mycli config path [user|project|profile|system|legacy_user] [--json]
mycli config path profile --profile <name> [--json]
mycli config show [--json]
mycli config get <key> [--json]
mycli config set <key> <value> [--json]
mycli config unset <key> [--json]
```

`path` 默认为用户文件，并仅将该范围标为可写。`show` 和 `get` 报告有效值、获胜层及被覆盖层。`set` 和 `unset` 仅接受允许列表中的标准标量设置，原子更新基础用户文件；profile、项目、系统和旧用户文件对此仍只读。

将迁移作为绑定版本的事务使用：

```bash
mycli config migrate --dry-run [--json]
mycli config migrate --apply --expected-version <version> [--json]
mycli config migrate --rollback <backup-id> [--json]
```

预览不含配置值且不写入。应用在用户配置锁内重新检查预览版本，验证最终有效配置栈，创建私有备份，最多执行一次原子替换。只有应用后的用户版本仍是当前版本时才能回退；恢复准确原字节或原先不存在的文件状态，不触及凭据存储。旧文件仍是只读迁移来源。版本冲突后需重新预览。

标准设置列表和带注释 TOML 示例分别生成于 [`reference/configuration.md`](reference/configuration.md) 与 [`reference/config.example.toml`](reference/config.example.toml)。

<a id="slash-command-reference"></a>

## Slash 命令参考

Node 运行时统一管理解析、发现、分发和错误的标准注册表。原文在此记录 38 个受支持命令，每个拥有一个标准名。TUI 命令面板通常只显示常用子集；下表仅搜索时出现的命令仍受支持并有测试覆盖。

`Ctrl+P` 首先显示当前运行时可用的常用命令。输入查询还会搜索描述、设置术语和当前设置值，显示匹配的仅搜索命令；不可用命令显示原因且不能执行。废弃名称不出现在面板、帮助或补全中。

面板打开期间可用性会更新。扩展变化刷新命令发现和补全；打开 `/resume` 刷新会话列表。已注册名称和多词命令允许空格、Tab 或换行分隔。废弃名称保留用于本地拒绝和替代提示，不能执行或进入模型输入。未注册的绝对路径仍作为聊天输入。

`/clear` 先创建新后端会话，再清除终端视图和回滚历史；保存消息仍可通过 `/resume` 访问。切换失败保留原对话。`/view` 仅改变本地显示设置，不写用户配置，且跨 gateway 更新和设置重载保留。在 `/settings` 更改视图会替换本地选择；显式保存默认值也会清除临时覆盖，让保存值生效。

| 命令 | 参数 | TUI 行为 | 执行期间可用 | 发现方式 |
| --- | --- | --- | --- | --- |
| `/model` | 可选 `[model] [--thinking-effort level]` | 无参数打开 provider/模型选择器；行内参数执行经过验证的会话级选择 | 是 | 常用 |
| `/goal` | 可选 `[objective\|pause\|resume\|edit <objective>\|budget <tokens\|off>\|clear]` | 控制持久会话目标；`--tokens <n> <objective>` 明确设置创建预算 | 是 | 常用 |
| `/plan` | 可选 `[task]` | 进入 Plan 模式；行内任务及附件启动一个轮次 | 否 | 常用 |
| `/mode` | 可选 `[default\|plan]` | 由后端处理 | 否 | 仅搜索时显示 |
| `/permissions` | 可选 `[allow\|revoke\|clear]` | 无参数打开弹层；行内参数由后端处理 | 是 | 常用 |
| `/sandbox` | 可选 `[read-only\|workspace-write\|danger-full-access\|next]` | 由后端处理 | 否 | 仅搜索时显示 |
| `/settings` | 无 | 打开分类设置中心 | 是 | 常用 |
| `/new` | 无 | 创建并切换到新后端会话 | 否 | 常用 |
| `/resume` | 可选 `[session-id]` | 无参数打开选择器；行内参数由后端处理 | 否 | 常用 |
| `/fork` | 可选 `[source] [new-session] [message-index]` | 由后端处理 | 否 | 常用 |
| `/export` | 无需必填参数 | 将当前完整对话导出为工作区内自动命名的 JSONL，显示路径和消息/工具/推理/图片数量 | 否 | 常用 |
| `/status` | 无 | 由后端处理 | 是 | 常用 |
| `/update` | 可选 `[check\|dismiss <version>]` | 缓存状态、显式注册表检查或忽略精确版本 | 是 | 常用 |
| `/usage` | 无 | 由后端处理 | 是 | 常用 |
| `/context` | 无 | 由后端处理 | 是 | 仅搜索时显示 |
| `/compact` | 无 | 由后端处理 | 否 | 常用 |
| `/stats` | 无 | 由后端处理 | 是 | 仅搜索时显示 |
| `/skills` | 无 | Skill 调用和持久启用/禁用选择器 | 是 | 常用 |
| `/mcp` | 可选 `[verbose]` | 服务器连接与工具；verbose 增加传输和资源信息 | 是 | 常用 |
| `/plugins` | 无 | 插件与市场浏览器、能力、安装和管理 | 是 | 常用 |
| `/hooks` | 无 | 事件分组、命令、启用状态和信任 | 是 | 常用 |
| `/tools` | 可选 `[list\|sets]` | 实际工具清单 | 是 | 仅搜索时显示 |
| `/resources` | 无 | 打开资源 | 是 | 仅搜索时显示 |
| `/memory` | 可选 `[list\|path\|search\|add\|forget]` | 弹层 | 是 | 仅搜索时显示 |
| `/agents` | 可选 `[child-session-id\|kill <child-session-id>\|kill-all]` | 无参数打开 Agent 视图；行内参数由后端处理 | 是 | 常用 |
| `/ps` | 可选 `[stop-all]` | 列出或停止后台终端 | 是 | 常用 |
| `/diff` | 无 | 可滚动的暂存、未暂存和未跟踪 Git diff | 是 | 常用 |
| `/review` | 无 | 只读审查未提交改动、基准分支、提交或自定义指令 | 否 | 常用 |
| `/rename` | 可选 `[title]` | 修改当前会话标题 | 否 | 常用 |
| `/init` | 无 | 仅在 AGENTS.md 不存在时请求 Agent 创建 | 否 | 常用 |
| `/changes` | 无 | 会话文件历史 | 是 | 常用 |
| `/undo` | 无 | 由后端处理 | 是 | 仅搜索时显示 |
| `/trace` | 可选 `[export\|logs]` | 弹层 | 是 | 仅搜索时显示 |
| `/details` | 无 | 切换精简工具详情 | 是 | 仅搜索时显示 |
| `/view` | 可选 `[default\|verbose\|focus]` | 改变对话显示密度，工具保持可见 | 是 | 仅搜索时显示 |
| `/hotkeys` | 无 | 打开快捷键帮助 | 是 | 仅搜索时显示 |
| `/copy` | 无 | 复制最后一条助手回复 | 是 | 仅搜索时显示 |
| `/clear` | 无 | 创建新会话后清除终端 | 否 | 仅搜索时显示 |
| `/login` | 无 | 打开隐藏输入的 provider 凭据设置 | 是 | 仅搜索时显示 |
| `/trust` | 无 | 打开工作区信任 | 是 | 仅搜索时显示 |
| `/help` | 无 | 打开统一快捷键和命令帮助 | 是 | 常用 |
| `/quit` | 无 | 退出 mycli | 是 | 常用 |
| `/session search` | 可选 `[query]` | 由后端处理 | 是 | 仅搜索时显示 |
| `/session maintenance` | 可选 `[--apply-empty\|--apply-payloads\|--apply-orphans\|--apply-vacuum\|--apply-transcript-normalization\|--apply-content-blobs\|--apply-content-blob-gc]` | 由后端处理 | 否 | 仅搜索时显示 |

TUI 空闲时，`Shift+Tab` 在 Default 与 Plan 模式之间循环。Plan 模式下页脚显示 `plan` 标记；弹层、选择器和运行中的轮次仍拥有此按键的处理权。`/help` 列出当前快捷键。

输入框上方显示工作摘要，下方显示会话上下文。页脚第一行显示模式、模型、推理和上下文用量；第二行显示工作区、分支和会话。`/settings` 中 Statusbar 的 `full` 显示两行，`compact` 只保留第一行，`off` 隐藏页脚。目标状态、排队输入、后台工作和待决事项仍可见。`/goal`、`/ps` 和 `/agents` 打开各自详情。

审批、权限、工作区信任、澄清、计划确认和会话修复共用底部决定面板。方向键或 `j`/`k` 导航，Enter 确认高亮项，有编号的选项也接受对应数字。审批编号保持稳定：`1` 允许一次，`2` 拒绝，`3` 会话内允许，`4` 保存始终允许规则（对应选项可用时）。禁用的权限配置不可选。

长命令保留换行，权限请求保留全部路径。终端放不下详情或选项时，`Ctrl+A` 打开全文。方向键、`j`/`k`、Page Up/Down 和 Home/End 滚动；Esc 或 `Ctrl+A` 返回决定界面。查看全文时确认键和数字键不会提交决定。决定界面的 Esc 会拒绝审批、中断澄清，或在其他流程中返回。导航和确认提示反映已配置按键。

权限和信任保存会保持待定，直到后端响应。保存期间忽略重复确认；失败在同一面板显示并允许重试。Full Access 保留独立确认步骤。

在新运行时加载历史会话会中断未完成轮次，移除旧审批/提问等待，保留完成的工具结果，不执行旧命令或恢复进程句柄。重新连接仍运行的后端保留当前请求和进程。浏览历史不会取消工作。

裸 `/resume` 打开共用选择器，不逐行扫描存储即可显示模型、强度、模式、权限、生命周期、所有者锁、分叉关系和 cwd。选择阻塞会话时先打开无需 provider 的修复预览；Enter 仅在预览元数据修订上应用所选修复，Esc 不改源会话。`/resume <session-id>` 使用相同后端切换。管理命令和恢复规则见 [sessions.md](sessions.md)。

`/skills` 提供 **List skills** 和 **Enable/Disable Skills**。调用选择器搜索完整已发现目录，将 `$name` 插入草稿，并保留所选文件标识与内容修订。删除提及也删除选择。排队输入、恢复草稿和会话恢复保留这些引用；禁用或变化的选择在模型请求前被拒绝。启用覆盖保存在 `~/.mycli/integration-enablement.json`，作用于后续轮次。刷新目录只读取配置和 skill 文件，不启动扩展宿主。

`/hooks` 按事件分组显示配置及插件提供的 hook。Enter 查看命令和来源。可用性与命令信任独立：启用不受信任的配置 hook 不等于授权执行。信任要求审查命令并明确确认，命令变化会使预览失效。插件处理器通过已启用插件标记为受信任。Ctrl+R 刷新 skill/hook 目录，Ctrl+A 查看全文。关闭选择器或切换会话丢弃迟到结果；活动轮次保持捕获的集成设置。

`/diff` 读取 Git 状态时禁用外部 diff 驱动，区分暂存和未暂存改动，包含未跟踪文本，并标注二进制与符号链接。视图上限 256 KiB，超大 Git 上下文明确显示加载失败。方向键/Page Up/Page Down 滚动，Ctrl+R 刷新。`/changes` 继续显示本会话记录的文件历史。

`/review` 使用现有监督运行时，只暴露 `Read`，也不包含原生网络搜索。分支和提交审查将读取固定到选定修订。自定义审查接受关注点及有界仓库文件清单，也适用于干净仓库。轮次结束释放审查运行时，后续普通轮次恢复常规工具。审查准备可取消。`/resume` 支持 Ctrl+P 按需预览对话，只有 Enter 才恢复所选会话。`/rename` 只改当前对话标题。

`/mcp` 和诊断 `/tools` 列表支持过滤和条目详情。Enter 打开描述，Esc 先返回列表再关闭。截断结果会显示已加载行数。

MCP 服务器、插件包和可调用工具分别有独立清单。`/mcp` 包括加载中、禁用、失败或使用缓存发现结果的服务器，也包含无资源服务器。Enter 显示工具；`/mcp verbose` 额外显示传输、超时和资源名，不输出环境变量值、请求头或命令参数。`/plugins` 浏览已安装及可用包；Enter 显示声明的 skills、MCP 服务器、hooks、tools、commands、问题和管理操作。插件的 MCP 服务器仍出现在 `/mcp`，加载的工具出现在诊断 `/tools`。打开视图不调用工具、插件命令或模型。

`/plugins` 内 Left/Right 选择 All Plugins、Installed 或某个市场；输入搜索当前列表，空查询时 Space 切换启用状态。Enter 打开安装/更新/卸载操作。Ctrl+N 打开本地/Git 来源安装；Add Marketplace 标签注册来源。具名市场的 Manage marketplace 行可刷新或移除市场。移除需要确认，并保留已安装包。Ctrl+R 重载，Ctrl+A 查看完整详情，Esc 返回或关闭；操作中关闭会取消待处理工作。浏览器关闭后输入草稿保留。对应 `mycli plugins` CLI 仍可用，见[插件兼容性](plugin-codex-parity.md)。

<a id="retired-names"></a>

### 已废弃名称

下列历史写法返回 `invalid_arguments` 和替代提示，不执行任何操作，轮次运行中也一样。参数不回显到诊断，也不转发给模型或插件。`/plugin:<id>:<command>` 等插件命令仍受支持。

| 已废弃名称 | 替代命令 |
| --- | --- |
| `/session`, `/session list`, `/sessions`, `/session resume` | `/resume` |
| `/session fork` | `/fork` |
| `/session show` | `/status` |
| `/status usage` | `/usage` |
| `/status context` | `/context` |
| `/status stats` | `/stats` |
| `/tools permissions` | `/permissions` |
| `/skill`, `/tools skills` | `/skills` |
| `/tools hooks` | `/hooks` |
| `/toolsets` | `/tools sets` |
| `/extensions`, `/tools extensions` | `/tools` |
| `/plugin`, `/tools plugins` | `/plugins` |
| `/tasks`, `/jobs`, `/tasks agents`, `/jobs subagents`, `/subagents`, `/agents runs`, `/agents agents` | `/agents` |
| `/tasks agents kill`, `/jobs subagents kill` | `/agents kill` |
| `/tasks kill-agents`, `/jobs kill-subagents`, `/agents kill-agents` | `/agents kill-all` |
| `/tasks bashes`, `/bashes`, `/jobs bashes` | `/ps` |
| `/stop` | `/ps stop-all` |
| `/changes undo` | `/undo` |
| `/trace-jsonl` | `/trace export` |
| `/logs` | `/trace logs` |
| `/search` | `/session search` |
| `/session-maintenance` | `/session maintenance` |

`/session search` 与 `/session maintenance` 是当前有效的多词命令。仅搜索时显示属于展示选择，不代表废弃。

<a id="settings-center"></a>

## 设置中心

`/settings` 可搜索和导航运行时投影的七类设置：模型/推理、provider/凭据、权限/沙箱、外观/无障碍、会话/上下文、集成，以及更新/诊断。操作行复用 slash 命令的模型、登录、权限、信任、会话、资源和诊断流程。Esc 逐级返回，并保留输入草稿。

外观变化应用前显示 `old -> new`。`Use for this session` 更新活动 TUI，不写配置；`Make user default` 使用原子用户配置写入器，保存失败则回退活动值。设置中心显示每个有效值及来源/范围；托管或不可用行保持锁定，并显示有界原因。

`/update` 读取 npm 缓存状态并提供手动包管理指引，不运行安装器或请求提权。只有 `/update check` 联系注册表。`/update dismiss <version>` 只忽略当前提示的精确版本，后续版本仍可在未来启动时通知。

所有外观设置也可通过无需 provider 的配置 CLI 使用：

```bash
mycli config get tui.theme
mycli config set tui.theme light
mycli config set tui.hide_thinking false
mycli config unset tui.statusbar_mode
```

允许的键为 `tui.statusbar_mode`、`tui.view_mode`、`tui.theme`、`tui.hide_thinking`、`tui.tool_details_default`、`tui.hardware_cursor`、`tui.clear_on_shrink`、`tui.terminal_progress`、`tui.terminal_notifications`、`tui.subagent_density`、`tui.color_mode`、`tui.reduced_motion`、`tui.glyph_mode` 和 `tui.high_contrast`，不接受任意 TOML 路径。

`/session maintenance` 默认只预览。`--apply-payloads` 压缩符合条件的旧终态 rollout，并移除非活动旧 continuation 快照，不删除权威对话、compact、summary 或活动恢复记录。报告的 payload 字节变为 SQLite 可复用空间；只有需要物理缩小文件时才另行运行 `--apply-vacuum`。

同一只读报告显示对话规范化状态、有界暂存进度、不透明行计数、排除的活动会话、临时峰值空间估算和可用磁盘空间。本文记录的生产启动基线为只接受全新 schema v12：缺失或空数据库创建 v12；v9、v10、v11 在打开可写连接前被拒绝并显示预期/实际版本。没有自动或手动的原地 v11 到 v12 迁移。

切换已有安装时，停止所有 mycli 进程，将 `~/.mycli/sessions.db` 与相邻 `sessions.db-wal`、`sessions.db-shm` 整组归档并移出活动位置，再启动创建全新 v12 数据库。回退需要支持 v11 的程序及完整归档文件集，不转换会话。

Schema v12 将对话叶节点和不可变模型输入记录保存为经过验证的内容 blob，搜索词存于无内容 FTS 索引。Provider 步骤保存精简 V3 清单和请求哈希，完整请求由指令/工具快照与精确的只追加时间线前缀重建，不逐步骤写完整请求 blob 或重复事件 ID 数组。v12 上对话规范化和内容 blob 应用命令分别返回 `already_normalized`、`already_blob_backed`，不改变存储。

`--apply-content-blob-gc` 仅显式删除从对话和模型输入引用表都无法到达的 blob，报告删除的原始/存储字节与可复用 freelist 字节，操作幂等且不执行 `VACUUM`。另行使用 `--apply-vacuum` 物理收缩前，应运行 doctor，并验证有代表性的恢复、分页、搜索和 provider 账本。

`/model` 合并固定 pi-ai 目录与用户 `~/.mycli/models.json` 声明。文件缺失时不会在发现阶段创建。选择时验证 provider/协议、端点、`auth_ref` 和推理强度兼容性。TUI 随后让用户选择当前会话或用户默认值。安全默认 `Use for this session` 跨恢复保留，不改变 `~/.mycli/config.toml` 或新会话；`Make user default` 原子更新用户配置，并将同一选择应用于活动会话。行内 `/model <name>` 始终为会话范围。传给 TUI 的目录数据不包含凭据或 `auth_ref`。

当前目录按 provider 分组，共享一个端点和凭据引用，避免重复：

```json
{
  "version": 2,
  "providers": {
    "openai": {
      "protocol": "responses",
      "base_url": "https://api.openai.com/v1",
      "auth_ref": "openai",
      "options": { "store": false },
      "models": {
        "gpt-5.6-sol": {
          "name": "GPT-5.6 Sol",
          "limits": {
            "context_window_tokens": 1050000,
            "max_output_tokens": 128000
          },
          "reasoning": {
            "default": "low",
            "efforts": ["low", "medium", "high", "xhigh", "max", "ultra"]
          }
        }
      }
    }
  }
}
```

`context_window_tokens` 为模型总窗口，`max_output_tokens` 为 provider 输出上限。没有明确 `max_prompt_tokens` 时，两者之差作为提示词预算；显式预算是较低的操作员上限，并限制在模型允许范围内。顶层 `models` 数组的旧目录仍可读取。API Key 只应放在 `~/.mycli/auth.json`；目录 `options` 是经过验证的请求设置，不是凭据存储。

交互启动时，在工作区信任检查后，本地检查当前 provider/模型凭据；缺失则打开相同 `/login` 流程。`MYCLI_API_KEY` 优先于存储密钥，后者通过活动 `auth_ref` 解析。后端在接受轮次前再次检查，因此 TUI 打开时删除凭据会恢复未发送草稿并重新打开登录，而不是创建失败轮次。恢复成功后草稿留在输入框，不自动重发。

<a id="error-contract"></a>

## 错误契约

- 直接对未知命令调用 `command.run`，本地返回 `unknown_command`。交互输入只将注册表已知名称路由为命令，`/tmp` 等根绝对路径仍为普通用户输入。
- 在错误入口使用命令返回 `unavailable_surface`。
- 活动轮次阻塞命令时返回 `unavailable_during_turn`。
- 缺少必需参数、无参数命令收到多余参数或子操作无效时，返回有界用法错误。
- 失败的 slash 命令不会变成 provider 可见的普通用户消息。
- 插件命令只能新增，不能覆盖内置名或占用废弃路由。

可执行权威来源为 `backend/apps/mycli/src/node-runtime/node-slash-command-registry.ts`。M8 能力审查测试固定其序列化矩阵和校验和。

<a id="operation-feedback"></a>

### 操作反馈

`/compact` 立即显示进度，支持 Esc 或 Ctrl+C 取消。取消保留原上下文，并与压缩失败分别报告。自动压缩使用独立计时器，完成后恢复普通 Working 计时。模型选择确认所选模型和范围，审批决定保留在实时对话视图。

本地压缩采用 Codex 的交接流程：保留原消息角色和基础指令，最后追加简洁检查点请求作为用户消息，不提供工具。使用所选模型当前推理强度和正常生成限制。已完成摘要没有单独 4096-token 上限，也不再调用另一个模型缩短。

输入超出模型窗口时，摘要请求逐步丢弃最旧项及配对工具结果，直到成功或无历史可删。每次变更输入使用配置的请求/流重试预算。发起前检查取消、所有权丢失和估算剩余 Goal 预算；每次尝试报告的用量都计入。

替换窗口包含最近用户消息文本，然后是交接摘要。用户文本默认保留预算为 20,000 token（`context.compaction_tail_max_tokens`），边界消息缩短时明确标记。轮次前压缩在替换窗口之后追加最新输入。更早的助手/工具输出和图片由摘要表示。下一次正常 provider 请求重新提供当前指令和运行时上下文。可读对话保留；失败或取消保留原窗口和上一次完成检查点，重新打开会话后仍能看到具体失败。

旧的完整轮次保留、摘要大小/经济性、节省比例和文件恢复设置仍为配置兼容而接受，但不再控制本地压缩。本地压缩不重读工作区文件，也不按估算节省量拒绝已完成摘要。

MCP 启动和 Hook 执行在主界面报告进度与失败，详情可看 `/mcp` 或 `/hooks`。`/settings` 提供 **Terminal notifications**，默认在未聚焦且支持 OSC 9 的终端启用；设置 `tui_terminal_notifications = false` 可关闭。Gateway 断连后，使用打印的 `mycli session resume <id>` 重新打开会话。
