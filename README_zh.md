# mycli

[![npm version](https://img.shields.io/npm/v/%40cosmos2023%2Fmycli)](https://www.npmjs.com/package/@cosmos2023/mycli)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22.19.0-339933)](https://nodejs.org/)

[English](README.md) | **简体中文**

面向代码仓库和日常工作的终端 coding agent。

mycli 可以读取文件、排查问题、修改代码、执行命令，并使用你选择的模型提供商协助完成任务。
它提供交互式终端界面、持久化会话、明确的权限控制，以及可扩展的 Skills、MCP 服务器、Hooks 和插件。

基于 Node.js 和 TypeScript 构建，支持 macOS、Linux 和 Windows。会话与配置保存在本机；
模型请求和外部工具调用会发送到你配置的服务。

[快速开始](#快速开始) |
[安装](#安装) |
[功能](#功能) |
[使用方法](#使用方法) |
[Provider 与模型](#provider-与模型) |
[配置](#配置) |
[扩展](#扩展) |
[文档](#文档)

## 快速开始

需要 **Node.js 22.19.0 或更新版本**、npm、终端，以及模型服务的 API Key 或受支持的 OAuth 登录。
也支持 Node 24。

```bash
npm install -g @cosmos2023/mycli
cd /path/to/your/project
mycli setup
mycli
```

安装向导可以选择内置 provider、模型、接口地址和凭据，API Key 输入会被遮蔽。
兼容接口可以选择 **OpenAI Compatible**；其他 provider 或独立账号请参考
[自定义 provider 示例](#其他与自定义-provider)。
首次交互式启动时，请确认工作区信任和执行权限。可选的连接检查会发送一次测试请求；
跳过该检查仍可离线完成配置。

然后在输入框中描述任务：

```text
找到测试失败的原因，修复问题，并运行相关检查。
```

也可以从这些任务开始：

```text
解释这个仓库的身份认证流程。
审查当前 diff，检查正确性问题和缺失的测试。
总结 logs/app.log 中的错误，并建议下一步排查方向。
```

使用 `/model` 切换模型，使用 `/permissions` 查看执行权限，使用 `/help` 查看命令和快捷键。

## 安装

### npm

```bash
npm install -g @cosmos2023/mycli
mycli --version
```

更新已有安装：

```bash
npm install -g @cosmos2023/mycli@latest
```

`mycli update check` 会检查新版本并给出安装说明，不会自动安装。

### 从源码运行

```bash
git clone https://github.com/Cosmos2023/mycli.git
cd mycli
npm ci
npm run build
npm run mycli -- setup
npm run mycli
```

`npm run mycli` 使用编译后的生产入口。修改源码后，需要重新构建，或使用
`npm run dev` 通过 `tsx` 直接运行源码。CLI 参数放在 `--` 后，例如
`npm run mycli -- --session demo` 或 `npm run dev -- --session demo`。

本文档描述当前源码版本。npm 安装的是最新已发布版本；尚未发布的改动需要从源码运行。
更新源码目录不会更新通过 npm 全局安装的 `mycli` 命令，请使用源码目录中的 npm 脚本启动。

### 平台要求

SQLite、终端进程和图像解码使用原生依赖。如果没有适用的预编译二进制文件，安装时需要准备
[node-gyp 编译环境](https://github.com/nodejs/node-gyp#installation)。
请保留 npm 可选依赖，以安装打包的 ripgrep 和图像支持组件。

| 平台 | 受限 Shell 执行 |
| --- | --- |
| macOS | 使用系统的 `/usr/bin/sandbox-exec` |
| Linux | 需要 Bubblewrap（`bwrap`）和可用的用户命名空间 |
| Windows | 使用随包提供的 Windows 沙箱辅助程序；`mycli sandbox setup` 可预览配置操作 |

运行 `mycli sandbox status` 查看沙箱是否就绪。详细配置和策略见
[沙箱与网络指南](docs/zh/network-policy.md)。

## 功能

- **仓库开发：** 读取源码和文本文件，使用 ripgrep 搜索，编辑文件和应用补丁，检查改动并运行项目检查。
- **模型选择：** 在 TUI 中切换 provider、模型和受支持的推理强度，配置兼容接口及各 provider 的模型目录。
- **交互式终端：** 流式回复、diff 渲染、分组展示读取和搜索活动、工具详情、审批对话框，以及可搜索的命令和设置菜单。
- **会话持久化：** 保存、恢复、搜索和分叉会话；在执行中补充指令或排队后续消息；查看上下文用量并压缩长对话。
- **会话导出：** 使用 `/export` 将完整对话保存为 JSONL，包含已记录的上下文、明文思考、图片、工具调用和结果。
  每条消息只出现一次，也包含压缩之前的对话。
- **会话目标：** 明确设置目标后跨轮次继续执行，查看用量、暂停或恢复，并可设置 token 预算；沿用正常审批流程。
- **Shell 工作流：** 执行前台或后台命令，与终端交互，查看或停止后台任务。
- **图片与网络：** 向具备相应能力的模型附加图片或查看本地图片，抓取网页，并在受支持的 Responses 服务上使用原生网络搜索。
- **扩展能力：** 加载仓库指令和 Skills，连接 MCP 服务器，安装插件包，配置生命周期 Hooks。
- **任务委派：** 使用独立 agent 线程，各自拥有持久化状态、协作机制和完成通知。
- **自动化：** 无需 TTY 即可执行任务或审查代码，输出 JSONL 事件、校验结构化答案，或通过 app-server 协议接入应用。
- **执行控制：** 工作区信任、权限配置、命令审批、进程沙箱，以及可选的管理员策略限制。
- **可选记忆：** 启用后可跨任务保留有用信息，默认关闭。

## 使用方法

### 交互式使用

在希望 mycli 工作的目录中启动：

```bash
mycli
mycli --session demo
mycli --model gpt-5.5
mycli --profile work
```

`--session` 打开或创建指定名称的会话；`--model` 覆盖模型选择；
`--profile`（或 `-p`）为本次启动选择配置档案。

执行期间提交新消息，会尽可能作为补充指令加入当前任务；按 Tab 则将草稿排为后续消息。
TUI 会分别展示对话、工具活动、后台终端和待处理的交互请求。

粘贴内容超过 1,000 个 Unicode 字符或 10 行时，会折叠成简短标记。
提交或排队时发送的是完整文本，折叠不会减少上下文用量。未发送的内容仅保存在内存中，
同一次 TUI 运行期间切换会话会保留各自草稿，重启后输入框为空。
对于大型文档，可以将内容保留在文件中，再让 mycli 读取。

常用命令：

| 命令 | 用途 |
| --- | --- |
| `/model` | 选择 provider、模型和推理强度 |
| `/goal [objective]` | 创建或查看持久化目标；使用 `pause`、`resume`、`edit`、`budget` 或 `clear` 控制目标 |
| `/plan [task]` | 进入 Plan 模式，也可直接开始规划指定任务 |
| `/permissions` | 查看或修改执行权限 |
| `/settings` | 修改外观和运行时设置 |
| `/new` | 新建会话 |
| `/resume` | 浏览并恢复已保存的会话 |
| `/fork` | 从已保存的会话创建分支 |
| `/export` | 将完整对话导出到当前工作区中的新 JSONL 文件 |
| `/status`、`/usage`、`/context` | 查看运行状态、token 用量和上下文 |
| `/compact` | 压缩当前模型上下文 |
| `/diff`、`/review` | 查看 Git 改动或开始只读代码审查 |
| `/changes`、`/undo` | 查看会话文件历史，或撤销可恢复的修改 |
| `/rename [title]`、`/clear` | 重命名会话，或新建会话并清空终端 |
| `/init` | 创建 AGENTS.md 仓库指引，保留已有文件 |
| `/agents`、`/ps` | 查看后台 agent 和终端 |
| `/mcp`、`/plugins`、`/skills`、`/hooks` | 分别浏览各类扩展 |
| `/help`、`/quit` | 打开帮助或退出 |

默认菜单优先展示常用命令。`/tools`、`/resources` 和 `/trace` 等诊断入口仍可通过搜索找到。
参数、执行期间的可用性和已移除命令的替代方式，见[完整命令参考](docs/zh/commands.md)。

默认快捷键：

| 按键 | 操作 |
| --- | --- |
| `Ctrl+P` | 搜索命令和设置 |
| `Ctrl+O` | 展开或折叠工具详情 |
| `Ctrl+T` | 打开对话记录查看器 |
| `Shift+Tab` | 空闲时切换 Default 和 Plan 模式 |
| `Tab` | 执行期间排队一条后续消息 |
| `Esc` | 在选择器中返回，或中断当前工作 |
| `Ctrl+C` | 中断当前工作或暂停活跃目标；空闲时的行为见下文 |
| 审批界面中的 `Ctrl+A` | 查看完整命令或权限请求 |

空闲且没有活跃目标时，Ctrl+C 会清空非空草稿。输入框为空时，在两秒内连续按两次 Ctrl+C 退出。
中断目标执行会暂停自动继续。选择器打开时优先使用自身的按键逻辑。
快捷键和终端无障碍选项均可配置，详见[终端控制](docs/zh/terminal-accessibility.md)。

### 会话与后台任务

会话会在本地保留消息、工具结果、模型设置和用量。可以使用 `/resume` 浏览，也可以在普通终端中管理：

```bash
mycli session list --last
mycli session list --all --json
mycli session resume <session-id>
mycli session fork <session-id> investigation
mycli session export <session-id> --json
```

`session export --json` 返回可读的会话快照。完整对话请使用下文的 [JSONL 导出](#会话导出)。

在新的运行时中恢复会话，会保留已完成的工作，并将之前未完成的轮次标记为中断；
不会重放旧工具调用、恢复未回答的审批或重新启动后台进程。
重新连接到仍在运行的后端时，则保留该后端当前的请求和进程。
恢复和修复行为见[会话管理](docs/zh/sessions.md)。

运行期间，`/ps` 列出后台终端，`/ps stop-all` 停止所有后台终端，`/agents` 打开 agent 视图。

### 会话导出

会话空闲时输入：

```text
/export
```

mycli 会在当前工作区创建新的 `session-<timestamp>-<random suffix>.jsonl`，
并显示绝对路径以及消息、工具、思考和图片数量。重复执行会生成另一个文件，导出过程不会调用模型。

一个会话对应一条 JSONL 记录，按顺序保存完整的已存储对话，包括压缩之前的消息、已记录的指令、
明文思考、图片、工具调用和结果。失败和中断的工作也会保留，已知凭据和本地路径会被脱敏。
导出无法还原加密的思考内容，也无法补回运行时从未记录的数据。

在普通终端中，需要明确指定会话和新的输出路径：

```bash
mycli session export <session-id> --training --output ./conversation.jsonl
```

数据格式、脱敏规则和旧会话数据的限制，见[对话格式与训练用途](docs/zh/sessions.md#training-data-export)。

### 目标

使用 `/goal <objective>` 创建需要跨轮次持续执行的目标，直到验证完成。普通任务不会自动创建目标。

```text
/goal 修复解析器并验证回归测试
/goal
/goal pause
/goal resume
/goal edit 修复解析器并记录兼容性行为
/goal budget 50000
/goal clear
```

创建时可使用 `/goal --tokens 50000 <objective>` 设置 token 预算。
预算统计提供商报告的未缓存输入和输出 token，也包含归属于该目标的子任务和上下文压缩用量；
已经发出的请求可能使最终用量超过预算。`/goal budget off` 可以移除预算限制。

输入框上方的工作摘要显示状态和用量，自动继续的轮次有独立标记。
执行时按 Ctrl+C 会暂停目标。重启后恢复会话或创建会话分支时，可以查看目标，
但需要显式执行 `/goal resume` 才会自动继续。

目标沿用当前权限和审批流程，仅在交互式后端存活期间执行。
`mycli exec` 和 `mycli review` 仍只执行一轮。状态、用量统计和恢复规则，见[目标生命周期](docs/zh/goals.md)。

### 非交互式任务与代码审查

`exec` 无需交互式终端即可执行任务，`review` 对 Git 改动进行只读审查：

```bash
mycli exec "Explain the main modules in this repository"
mycli exec --json - < task.txt
mycli exec --output-schema result.schema.json -o result.json "Inspect the repository"
mycli review --uncommitted
mycli review --base main --json
mycli review --commit HEAD -o findings.json
```

请先通过交互流程配置凭据和工作区信任。两种命令都沿用正常执行策略；
如果需要审批或用户输入，会报告情况并以退出码 `3` 退出，不会打开交互式审批框。
使用 `--timeout <seconds>` 限制执行时间。

`--json` 输出带版本的 JSONL 事件，包括最终结果。`--output-schema` 会在写入前校验最终 JSON 答案。
`review` 只报告发现，不修改文件或运行测试。详见[非交互式命令](docs/zh/commands.md#noninteractive-coding-commands)。

应用可以通过 `mycli app-server` 使用基于 stdio 的 JSON-RPC，或导入已发布的 backend 和 gateway 包 API。
详见 [Gateway API](docs/zh/gateway.md)。

## Provider 与模型

内置产品路由包括 OpenAI、Codex、Anthropic、DeepSeek、Qwen/DashScope、OpenRouter、
Groq、Together、Moonshot AI、NVIDIA 和 Cerebras。`mycli setup` 可以覆盖这些配置的接口地址、模型和 API Key，
设置期间各 provider 保持其默认协议。其他 provider 和模型元数据来自锁定版本的 pi-ai 目录。

`qwen-token-plan`、`qwen-token-plan-cn` 和 `qwen-token-plan-individual` 三个 Qwen Token Plan 路由也已开放。
它们与普通 `qwen` DashScope 路由使用不同的接口和凭据，仍属于实验性支持。

打开 `/model` 浏览当前 provider 的模型。使用 `[` 和 `]` 切换已启用的 provider，或按 Esc 返回 provider 列表。
Enter 将选择应用于当前会话；Tab 打开推理强度和生效范围选项。
路由根据其凭据显示 `ready` 或 `login required`。`/model <name>` 只搜索当前 provider。

### 其他与自定义 Provider

在 `~/.mycli/models.json` 中声明其他路由。如果已有 version 2 格式的目录，请将条目合并到现有 `providers` 对象。
模型选择器会读取这些声明，目前没有创建任意 provider 或编辑接口地址的表单。

例如，使用目录中的地址和模型启用 MiniMax 中国区、Z.ai 和 xAI：

```json
{
  "version": 2,
  "providers": {
    "minimax-cn": {
      "source": "pi_ai_builtin",
      "protocol": "anthropic_messages",
      "auth_ref": "minimax-cn"
    },
    "zai": {
      "source": "pi_ai_builtin",
      "protocol": "chat_completions",
      "auth_ref": "zai"
    },
    "xai": {
      "source": "pi_ai_builtin",
      "protocol": "responses",
      "auth_ref": "xai"
    }
  }
}
```

重启 mycli，打开 `/model`，必要时按 Esc 返回 provider 列表。搜索路由 ID 并选择。
如果缺少凭据，会打开遮蔽输入的 API Key 界面；Key 保存到 `~/.mycli/auth.json` 中 `auth_ref` 对应的位置。
只保留你打算使用的服务条目即可。

其他目录路由包括使用 `anthropic_messages` 的 `kimi-coding` 和 `minimax`，以及使用
`chat_completions` 的 `zai-coding-cn`、`xiaomi`、`huggingface` 和 `baseten`。
不同地区和订阅计划的路由可能使用不同的地址和凭据。Azure 和 Cloudflare 路由需要明确填写接口地址；
包含多种协议的目录还需要选定要使用的协议。

如果希望沿用某个 provider 的目录，同时保留独立地址或账号，可以创建命名别名。
下面是另一份完整的 `models.json` 示例：

```json
{
  "version": 2,
  "providers": {
    "my-minimax": {
      "source": "pi_ai_builtin",
      "catalog_provider": "minimax-cn",
      "protocol": "anthropic_messages",
      "base_url": "https://relay.example/anthropic",
      "auth_ref": "my-minimax"
    }
  }
}
```

将 `base_url` 替换为服务提供的 API 基础地址，然后在 `/model` 中搜索 `my-minimax`。
该别名使用独立保存的凭据。默认包含目录中的模型；如果希望明确限制模型列表，
可以同时设置 `model_policy: "subset"` 和 `models` 对象。

对于目录之外的服务和模型，需要声明协议与模型能力：

```json
{
  "version": 2,
  "providers": {
    "my-provider": {
      "source": "pi_ai_declared",
      "protocol": "chat_completions",
      "base_url": "https://api.example/v1",
      "auth_ref": "my-provider",
      "capabilities": { "images": false },
      "models": {
        "your-model-id": {
          "limits": {
            "context_window_tokens": 64000,
            "max_output_tokens": 8192
          }
        }
      }
    }
  }
}
```

请将接口地址、模型 ID、图片能力和示例 token 上限替换为服务的实际值。
完整声明必须包含接口地址、凭据引用、模型上限和图片能力，随后沿用相同的 `/model` 登录与选择流程。

目前支持 OpenAI Responses、Chat Completions 和 Anthropic Messages 协议系列，
Azure Responses 通过其原生适配器接入。Google Gemini、Vertex AI、Amazon Bedrock 和 Mistral 的原生协议尚未接入 mycli。
如果服务提供受支持的兼容 API，可以使用显式声明接入。目录中存在某个模型，不代表当前账号一定拥有访问权限。

### 身份认证与网络工具

对于支持的原生 provider，使用 `mycli login --oauth --provider <provider-id>` 启动其 OAuth 流程。
API Key 配置、OAuth 可用性、自定义路由、接口覆盖、图片支持和模型策略，见 [provider 支持说明](docs/zh/providers.md)。

原生 `web_search` 取决于所选 Responses 模型和接口，启用后会在对话中展示搜索活动。
`web_fetch` 按本地执行策略获取已知的公开网址。搜索类 MCP 服务器可以为支持函数调用的不同 provider 提供搜索工具。
支持普通工具调用的 provider 不一定支持原生搜索。

## 配置

使用 `mycli setup` 配置第一个 provider 和凭据，使用 `/model` 选择模型，使用 `/settings` 修改交互偏好。

未配置模型时，OpenAI 和 Codex 默认使用 `gpt-5.5`；已有的显式模型选择优先。
未填写的设置使用内置默认值，启动时不会生成一份完整默认配置文件。
`mycli setup` 保存选择的 provider 设置，凭据单独写入 `auth.json`。

常用配置命令不需要调用模型：

```bash
mycli config validate
mycli config show
mycli config get model.name
mycli config set tui.theme light
mycli config set tui.reduced_motion true
mycli config set memory.enabled true
mycli config unset memory.enabled
mycli config path
```

`config set` 和 `config unset` 修改用户配置文件中受支持的标量设置。
结构化表格和自定义模型目录需要在对应文件中编辑。`config validate --strict` 遇到警告也会判定失败。
`config show` 不会打印凭据。

### 配置文件

| 路径 | 用途 |
| --- | --- |
| `~/.mycli/config.toml` | 模型、请求、运行时、记忆、Shell 和 TUI 的用户默认设置 |
| `~/.mycli/auth.json` | 保存的 API Key 和受支持的 OAuth 凭据 |
| `~/.mycli/models.json` | Provider 启用、自定义接口、模型元数据或模型子集 |
| `~/.mycli/<name>.config.toml` | 通过 `mycli --profile <name>` 选择的配置档案 |
| `<workspace>/.mycli/config.toml` | 受信任仓库的配置 |
| `~/.mycli/managed_config.toml` | 可选的管理员执行权限限制 |
| `~/.mycli/sessions.db` | 会话与对话记录的权威存储 |
| `~/.mycli/sessions/` | 可读的会话投影和保留的任务输出 |
| `~/.mycli/plugin-registry.json`、`~/.mycli/plugin-cache/` | 插件安装记录、市场和包快照 |

`~/.mycli/config.toml` 示例：

```toml
tui_reduced_motion = false

[model]
provider = "openai"
protocol = "responses"
name = "gpt-5.5"
api_base_url = "https://api.openai.com/v1"
auth_ref = "openai"

[reasoning]
enabled = true
effort = "medium"

[request]
request_max_retries = 4
stream_max_retries = 5
cache_retention = "short"

[memory]
enabled = false
```

CLI 设置名称可能与 TOML 路径不同。例如，`config set tui.reduced_motion false` 写入的是顶层字段 `tui_reduced_motion`。
修改设置时，可以使用 `config set` 或带注释的配置参考。

`auth_ref` 是已保存凭据的名称，不是 API Key 本身。建议使用遮蔽输入的配置或登录流程。
自动化场景可以通过标准输入传入已准备好的 Key，避免将其放入命令行参数：

```bash
printf '%s\n' "$MYCLI_API_KEY" | \
  mycli setup --non-interactive --provider openai --with-api-key --json
```

配置优先级从高到低为：会话或 CLI 覆盖、环境变量、受信任仓库配置、选定的配置档案、用户配置、系统默认值和内置默认值。
管理员执行策略另外施加权限上限。仓库配置和指令只有在工作区受信任后才会生效。

环境变量覆盖包括 `MYCLI_API_KEY`、`MYCLI_PROVIDER`、`MYCLI_MODEL`、`MYCLI_PROTOCOL` 和 `MYCLI_BASE_URL`。
完整字段、默认值和示例见[配置参考](docs/zh/reference/configuration.md)与[带注释的 TOML 示例](docs/zh/reference/config.example.toml)。
旧配置可以先运行 `mycli config migrate --dry-run`，详见[配置迁移](docs/zh/commands.md#configuration-management)。

### 仓库指令

在仓库中放置 `AGENTS.md`，描述项目约定、测试命令和约束。
mycli 会从工作区根目录到当前目录加载适用的指引，更靠近当前目录的指引优先。也支持 `.mycli.md`。

这些指引提供上下文，不授予执行权限。别名和回退规则见[工作区指引](docs/zh/commands.md#workspace-guidance)。

## 扩展

Tools、MCP、Skills、Hooks 和插件承担不同职责：

| 能力 | 用途 | TUI 入口 |
| --- | --- | --- |
| Tools | 模型可调用的操作，例如读取文件或执行 Shell 命令 | `/tools [list\|sets]` |
| MCP | 提供工具和资源的外部服务器 | `/mcp [verbose]` |
| Skills | 可复用的任务指令 | `/skills` |
| Hooks | 与运行时生命周期事件关联的命令 | `/hooks` |
| 插件 | 提供 Skills、MCP 服务器、Hooks 或 Plugin API v2 能力的包 | `/plugins` |

查看界面支持筛选和键盘导航，Enter 打开详情，Esc 返回。
查看包或工具不会调用它。MCP 服务器有独立的加载中、已禁用、失败和缓存状态，不会作为插件包列出。

模型可以根据任务上下文选择相关 MCP 和插件工具。较小的目录直接提供给模型，较大的目录通过 `tool_search` 发现工具。
后续轮次可以复用已发现且定义仍与当前允许目录一致的工具，执行时遵循审批和沙箱策略。
MCP 资源与模板通过 `list_mcp_resources`、`list_mcp_resource_templates` 和 `read_mcp_resource` 使用。
工具暴露和保留上限见[扩展运行说明](docs/zh/node-extensions.md)。

### Skills

在 `.agents/skills/repository-review/SKILL.md` 中添加可复用的 skill：

```markdown
---
name: repository-review
description: Review repository changes for correctness and risk.
---

Inspect the diff, identify behavioral regressions, and report findings with file references.
```

用户级 skill 放在 `~/.mycli/skills/`，受信任仓库也可以使用 `.mycli/skills/`。
打开 `/skills` 可以搜索目录、将选中的 `$skill` 插入草稿，或启用和禁用 skill。
排队消息和会话恢复会保留所选 skill 的来源身份。文件和可用性变化会在后续轮次生效，
也可以直接要求 agent 在适用任务中使用相应 skill。

### MCP 服务器

用户服务器配置在 `~/.mycli/mcp_servers.toml`，仓库服务器配置在 `.mycli/mcp_servers.toml`：

```toml
[servers.local]
transport = "stdio"
command = "node"
args = ["/absolute/path/to/mcp-server.js"]
enabled = true
startup_timeout_sec = 10
tool_timeout_sec = 60

[servers.docs]
transport = "streamable_http"
url = "https://mcp.example.com/mcp"
bearer_token_env_var = "MCP_TOKEN"
startup_timeout_sec = 20
tool_timeout_sec = 60
default_tools_approval_mode = "auto"
```

将示例命令或地址替换为你的服务器，并设置引用的环境变量。仓库服务器仅在受信任工作区中加载。
也可以在不启动服务器的情况下管理用户配置：

```bash
mycli mcp add docs --url https://mcp.example.com/mcp
mycli mcp add local -- node /absolute/path/to/mcp-server.js
mycli mcp remove docs
mycli mcp approvals
mycli mcp revoke docs
mycli mcp login docs
mycli mcp logout docs
```

Stdio MCP 服务器默认作为普通本地子进程运行，具有当前用户的文件系统和网络访问权限，独立于 Shell 权限预设。
显式的服务器沙箱设置和管理员文件系统、网络限制仍然生效。可以配置服务器与工具的审批模式、工具允许与拒绝列表、
独立的启动和调用超时，以及必需服务器的就绪要求。交互审批可允许一次调用、允许当前会话，
或记住对未发生变化的服务器及工具定义的授权。

`mycli mcp list` 和 `mycli mcp inspect <server-id>` 会验证发现结果，可能启动或联系已启用的服务器。
在 TUI 中使用 `/mcp verbose` 查看当前目录。浏览器授权、结构化 MCP 表单和 URL 请求，
见 [OAuth 与服务器提问指南](docs/zh/node-extensions.md#oauth-authentication)。
受支持的 provider 通过 pi-ai 将发现的工具 schema 放在对应的历史位置；其他 provider 继续使用普通函数调用。
传输方式、资源分页和恢复行为见 [MCP 配置](docs/zh/node-extensions.md#mcp)。

### 通过 MCP 自动化浏览器

Playwright 等浏览器服务器使用相同的 MCP 配置接入：

```bash
mycli mcp add playwright -- npx -y @playwright/mcp@latest
mycli mcp inspect playwright
```

空闲时打开 `/mcp` 刷新发现结果，然后让 mycli 导航页面、查看页面内容或测试浏览器操作流程。
检查命令会启动配置的服务器，因此首次运行可能下载 npm 包。浏览器选择和安装方式以
[Playwright MCP 服务器的选项](https://github.com/microsoft/playwright-mcp)为准。

浏览器控制由该服务器提供的工具实现。浏览器自身的沙箱与 mycli 的 Shell 沙箱独立；
MCP 进程限制和工具审批遵循上文的服务器策略。

### 插件与市场

安装本地插件包或 Git 仓库：

```bash
mycli plugins add ./my-plugin
mycli plugins add owner/repository --ref stable
mycli plugins list
mycli plugins inspect my-plugin --json
mycli plugins disable my-plugin
mycli plugins enable my-plugin
mycli plugins update my-plugin
mycli plugins remove my-plugin
```

也可以注册一个清单名称为 `personal` 的插件市场：

```bash
mycli plugins marketplace add ./personal-marketplace
mycli plugins list --available --marketplace personal
mycli plugins add my-plugin@personal
```

Codex 风格的插件包使用 `.codex-plugin/plugin.json` 或 `.claude-plugin/plugin.json`，
可以提供 Skills、MCP 服务器和受支持的命令型 Hooks。
Plugin API v2 使用 `plugin.yaml` 和编译后的 ESM，在独立进程中提供工具、Hooks 和命令。

插件包变更会在下一轮开始前或空闲时查看目录时生效。正在执行的轮次，包括等待审批的轮次，
会保留原来的工具和连接直到结束。各会话独立刷新，等待中的子任务不会阻止父会话更新。

`/plugins` 打开可搜索的浏览器，包含 All Plugins、Installed 和市场标签。
Enter 查看能力和操作；搜索框为空时，空格切换启用状态。可以在 TUI 中安装、更新、卸载插件和管理市场。
Ctrl+N 从本地或 Git 来源安装，Ctrl+R 刷新，Esc 返回或取消待处理操作。
插件提供的 MCP 服务器使用相同的登录命令，并支持可读的选择名称：

```bash
mycli mcp inspect my-plugin/server-name
mycli mcp login my-plugin/server-name
mycli mcp logout my-plugin/server-name
```

目前不支持 OpenAI 托管的 Apps，也不支持 prompt/agent 类型的 Hooks。
包格式、市场和支持的 Codex 子集，见[插件安装与兼容性](docs/zh/plugin-codex-parity.md)。

### Hooks

用户和仓库的 hook 配置分别位于 `~/.mycli/hooks.json` 和 `.mycli/hooks.json`。
`/hooks` 按事件分组，展示命令、来源、可用性和信任状态。启用或禁用 hook 与信任其具体命令是独立操作，
变更在后续轮次生效。插件 hook 会显示所属插件，并继承已启用插件的信任。

使用 `mycli hooks list` 查找 hook 标识，使用 `mycli hooks inspect <identity>` 查看详情，
使用 `mycli hooks approve <identity>` 授权当前配置的命令。命令改变后需要重新审批。

安装或启用插件会授权其声明的 Hooks，Hooks 仍在工作区沙箱中运行。
启用前请参考 [hook 配置](docs/zh/node-extensions.md#configured-hooks)。

## 权限与数据

`/permissions` 可以选择 Read-only、Workspace 或 Full Access 权限配置。
Shell 审批框展示待执行命令和可用的申请原因，Ctrl+A 查看完整详情。
默认 Workspace 配置允许 Shell 和网络工具联网，同时将写入限制在工作区内。
Read-only 默认离线，管理员网络与域名限制对所有配置生效。

`Write`、`Edit` 和 `Patch` 在有效的可写目录范围内自动执行。可写列表为空时禁止文件修改，
仅授权一个子目录不会开放整个工作区。越界修改会在写入之前失败，对该具体操作提权重试需要审批。
批准后仍需遵守管理员配置的可写目录限制。Patch 在提交整个变更集之前，会检查每个源路径和目标路径。

受限 Shell 执行依赖平台沙箱，隔离不可用时会报错，不会静默转为无限制执行。
管理员可以通过托管策略限制可读路径、可写路径、网络访问和允许的域名。

对话历史、工具结果、附件和凭据保存在本地。使用时，相关内容会发送给所选模型服务或外部集成。
处理敏感工作时请查看相应服务和集成的政策，不要将密钥写入仓库配置。

执行边界和数据保留详情，见[执行策略](docs/zh/network-policy.md)、[会话存储](docs/zh/sessions.md)和
[诊断说明](docs/zh/diagnostics-and-updates.md)。

## 故障排查

先运行 `mycli doctor` 和 `mycli config validate`。

| 问题 | 优先检查 |
| --- | --- |
| 找不到 `mycli` | 检查 npm 全局可执行文件目录是否在 `PATH` 中 |
| 原生依赖安装失败 | 检查 Node 版本和当前平台的 node-gyp 编译环境 |
| `mycli` 中没有源码里的新功能 | 在更新后的源码目录运行 `npm run dev`，或重新构建后运行 `npm run mycli`；确认终端实际启动的是哪个安装版本 |
| 凭据缺失或被拒绝 | 运行 `mycli login status`，然后使用 `mycli setup` 或 `/login` |
| `/model` 中缺少模型 | 检查当前 provider、路由是否启用，以及 `models.json` 中的模型策略 |
| 自定义 provider 没有出现 | 检查 `models.json` 版本、路由 ID、协议和必需的模型字段，然后重启；协议必须受支持 |
| 执行期间 `/export` 不可用 | 等待完成或中断当前轮次，再导出已存储的对话 |
| Shell 报沙箱初始化失败 | 运行 `mycli sandbox status` 并检查平台配置 |
| 文本、颜色或输入异常 | 检查 `/settings`、`NO_COLOR` 和终端无障碍设置 |
| MCP 服务器或插件不可用 | 查看 `/mcp` 或 `/plugins`，然后运行 `mycli doctor` |
| 已保存的会话无法恢复 | 使用 `/resume` 并查看修复预览 |

排查启动耗时时，`MYCLI_STARTUP_PROFILE=1 mycli` 会将本地报告写入 `~/.mycli/logs/startup-profile.json`。
`mycli doctor --support-bundle` 生成经过大小限制和脱敏的诊断数据。
[提交问题](https://github.com/Cosmos2023/mycli/issues)前，请检查准备分享的内容。

更多帮助见[故障排查](docs/zh/troubleshooting.md)、[错误码与恢复](docs/zh/errors.md)和[升级或回退](docs/zh/upgrading.md)。
迁移或降级前请备份 `~/.mycli`，旧版本可能无法识别新的会话存储格式。

## 开发

本项目使用 npm workspace，请先按上文[从源码运行](#从源码运行)准备环境。

```text
backend/
  apps/mycli/       CLI、运行时组装、管理命令和 gateway
  packages/        核心、协议契约、运行时、provider、工具、存储和集成
tui/mycli-shell/    终端 UI 和 gateway 客户端
native/            平台辅助程序源码
npm/ripgrep/       各平台的 ripgrep 包
tests/fixtures/    共享回归数据
scripts/           构建、测试、发布和冒烟检查工具
docs/              用户指南与架构文档
```

运行仓库检查：

```bash
npm run contracts:check
npm run config:check
npm run lint
npm run test:ci
npm run typecheck
npm run smoke:m8
npm run smoke:package
```

`test:ci` 会构建所有工作区，并运行单元、契约、集成、平台和发布测试。
`npm run test:list` 查看测试分类。打包冒烟检查会安装 npm 产物并验证生产入口。
CI 配置覆盖 Linux、macOS、Windows，以及 Node 22.19.0 和 Node 24。

参与贡献前请阅读 [AGENTS.md](AGENTS.md)，保持改动聚焦，为行为变化补充测试，并更新相关文档。
另见[测试指南](docs/zh/testing.md)、[架构](docs/zh/architecture.md)和[发布准备](docs/zh/releasing.md)。

## 文档

详细中文指南统一收录在 [docs/zh/](docs/zh/README.md)：

| 指南 | 内容 |
| --- | --- |
| [命令](docs/zh/commands.md) | CLI、slash 命令、无界面执行和补全 |
| [Provider](docs/zh/providers.md) | 模型、凭据、推理和兼容接口 |
| [配置](docs/zh/reference/configuration.md) | 支持的设置、默认值和覆盖规则 |
| [终端 UI](docs/zh/terminal-accessibility.md) | 外观、快捷键、输入、审批和无障碍功能 |
| [会话](docs/zh/sessions.md) | 历史、恢复、修复、分叉和导出 |
| [目标](docs/zh/goals.md) | 目标、自动继续、token 预算、审批和恢复 |
| [扩展](docs/zh/node-extensions.md) | Skills、MCP、资源、Hooks 和工具发现 |
| [插件](docs/zh/plugin-codex-parity.md) | 安装、市场、格式和兼容性 |
| [Agent 线程](docs/zh/node-agent-runtime.md) | 委派、协作、权限、产物和恢复 |
| [Gateway API](docs/zh/gateway.md) | App-server 和嵌入式集成 |
| [故障排查](docs/zh/troubleshooting.md) | 运行时、provider、终端和沙箱问题 |
| [错误](docs/zh/errors.md) | 错误码、TUI 展示、重试行为和恢复 |

[浏览全部文档](docs/zh/README.md)。
