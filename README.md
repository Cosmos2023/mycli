# mycli

`mycli` 是一个本地优先的终端 coding agent。它把模型对话、结构化工具调用、文件编辑、持久 Shell、session、compact、MCP、skills、subagent 和长期记忆放在同一个运行时中，并提供接近 Codex 的 Node TUI 交互。

当前主线具备以下能力：

- OpenAI Responses、OpenAI-compatible Chat Completions 和 Anthropic Messages 三条协议路径。
- append-only turn 历史、结构化 tool call/output、Responses continuation state 和 SQLite session 持久化。
- 可 steering 的运行中输入、follow-up queue、即时中断提示以及后台 worker 收尾。
- Codex 风格流重试状态，默认最多重试 5 次；context overflow 会尝试 compact/recovery。
- 结构化 compact：压缩模型会看到完整 conversation、tool call、参数、`call_id`、tool output 和当前工具 schema。
- 持久 PTY Shell、后台终端、`/ps`、stdin 续写、输出轮询和跨平台 shell profile。
- MCP、skills、plugins、hooks、ToolSearch 和后台 subagent。
- Node TUI 中的紧凑工具块、diff 高亮、全局详情折叠、响应式布局和原生终端 scrollback。

## 环境要求

- Python `3.13`
- [`uv`](https://docs.astral.sh/uv/)
- Node.js `>=22.19.0`
- npm
- 一个受支持 provider 的 API key

Windows 原生支持 PowerShell 7、Windows PowerShell 5.1 和 `cmd.exe`；Git Bash 可选。详细 shell 选择和 ConPTY 说明见 [docs/windows.md](docs/windows.md)。

## 安装与启动

```bash
uv venv
uv sync --dev
npm ci --prefix tui/mycli-shell
uv run mycli
```

首次启动没有可用凭证时会进入 setup wizard。也可以显式运行：

```bash
uv run mycli setup
```

setup 会写入：

- `~/.mycli/config.toml`：当前模型和运行时配置。
- `~/.mycli/auth.json`：按 `auth_ref` 保存的 API key。
- `~/.mycli/models.json`：`/model` 使用的模型目录。

setup 还会准备 mycli 自用的 ripgrep：

```text
~/.mycli/vendor/ripgrep/<platform>/rg
```

常用启动参数：

```bash
# 默认 Node TUI
uv run mycli

# 指定 session
uv run mycli --session demo

# 临时覆盖当前模型名
uv run mycli --model gpt-5.4

# 显式选择 Node TUI
uv run mycli --node-tui
```

交互式会话需要 Node.js 20+，并且 stdin/stdout 必须连接到终端。
`doctor`、`hooks`、`plugins`、`mcp`、`subagents` 和 `setup` 等管理命令仍可用于脚本和非 TTY 环境。

## 模型与认证

### 当前模型配置

推荐使用 sectioned TOML：

```toml
[model]
provider = "openai"
protocol = "responses"
name = "gpt-5.4"
api_base_url = "https://api.openai.com/v1"
auth_ref = "openai-primary"
supports_images = true

[request]
max_prompt_tokens = 120000
request_max_retries = 4
stream_max_retries = 5
prompt_cache_key_enabled = true

[reasoning]
enabled = true
effort = "medium"

[runtime]
collaboration_mode = "default"
sandbox_mode = "workspace-write"
heartbeat_enabled = true
heartbeat_interval_seconds = 30

[context]
compaction_l4_trigger_ratio = 0.9
compaction_l4_buffer_tokens = 13000
compaction_tail_turns = 2
compaction_tail_max_tokens = 8000

[memory]
enabled = true
extraction_enabled = true
extraction_interval_turns = 5
dream_enabled = true
dream_min_hours = 24
dream_min_sessions = 5

[tui]
view_mode = "default"
statusline_enabled = true
statusbar_mode = "full"
theme = "dark"
tool_details_default = "collapsed"
```

旧版顶层 key 仍可读取；setup 和 TUI 保存配置时会规范化为 sectioned TOML。

配置来源按以下优先级读取：

1. CLI 参数和 `MYCLI_*` 环境变量。
2. `~/.mycli/config.toml`。
3. `<workspace>/.mycli/config.toml`。
4. 旧路径 `~/.config/mycli/config.toml`。

API key 的优先级是 `MYCLI_API_KEY`、`~/.mycli/auth.json`，然后才兼容读取旧配置中的 `api_key`。不要把新凭证直接写进 `config.toml`。

常用环境变量：

```bash
export MYCLI_API_KEY="your-api-key"
export MYCLI_PROVIDER="openai"
export MYCLI_PROTOCOL="responses"
export MYCLI_MODEL="gpt-5.4"
export MYCLI_BASE_URL="https://api.openai.com/v1"
export MYCLI_AUTH_REF="openai-primary"
export MYCLI_REASONING_EFFORT="medium"
export MYCLI_STREAM_MAX_RETRIES=5
```

### 模型目录

`/model` 读取 `~/.mycli/models.json`。文件第一次创建时会写入内置预设和当前模型；之后不会自动补回、删除或重排用户条目。

每个条目可以使用独立 endpoint、协议、凭证和 reasoning effort：

```json
{
  "models": [
    {
      "model": "gpt-5.4",
      "provider": "openai",
      "protocol": "responses",
      "base_url": "https://api.openai.com/v1",
      "auth_ref": "openai-primary",
      "name": "GPT-5.4",
      "description": "Primary OpenAI endpoint",
      "reasoning_efforts": ["low", "medium", "high", "xhigh"],
      "default_reasoning_effort": "medium"
    },
    {
      "model": "deepseek-v4-flash",
      "provider": "deepseek",
      "protocol": "chat_completions",
      "base_url": "https://api.deepseek.com",
      "auth_ref": "deepseek",
      "reasoning_efforts": ["high", "xhigh"],
      "default_reasoning_effort": "high"
    }
  ]
}
```

`auth_ref` 对应 `~/.mycli/auth.json` 的顶层键：

```json
{
  "openai-primary": {"type": "api_key", "key": "sk-..."},
  "deepseek": {"type": "api_key", "key": "sk-..."}
}
```

模型切换成功后，当前选择会写回 `config.toml`；模型清单仍以 `models.json` 为准。

## Provider 与协议

`mycli` 用 `provider + protocol + model + base_url + auth_ref` 唯一描述模型连接。

支持的 provider：

- `openai`
- `codex`
- `deepseek`
- `qwen`
- `anthropic`
- `compatible`

支持的 protocol：

- `responses`
- `chat_completions`
- `anthropic_messages`

### OpenAI Responses

```toml
[model]
provider = "openai"
protocol = "responses"
name = "gpt-5.4"
api_base_url = "https://api.openai.com/v1"
auth_ref = "openai"
```

Responses 路径支持结构化 input items、并行工具、流事件、`previous_response_id` capability 检测、prompt cache key 和 provider-private replay state。兼容网关不支持某项能力时，client 会禁用对应 continuation 优化并回退到完整 append-only transcript。

### Codex-compatible Responses gateway

`codex` provider 用于接受 Codex/OpenAI Responses 参数的兼容网关，它不是本机 `codex` CLI，也不会读取 `codex login` 状态：

```toml
[model]
provider = "codex"
protocol = "responses"
name = "gpt-5.4"
api_base_url = "https://gateway.example/v1"
auth_ref = "codex-gateway"
```

### DeepSeek Chat Completions

```toml
[model]
provider = "deepseek"
protocol = "chat_completions"
name = "deepseek-v4-flash"
api_base_url = "https://api.deepseek.com"
auth_ref = "deepseek"

[reasoning]
enabled = true
effort = "high"
```

DeepSeek 使用 OpenAI-compatible Chat Completions。conversation 主线仍保持 append-only；provider adapter 负责将结构化 runtime items 转换为 chat messages，并维护 tool call/output 配对。

### Qwen

```toml
[model]
provider = "qwen"
protocol = "chat_completions"
name = "qwen3.6-plus"
api_base_url = "https://dashscope.aliyuncs.com/compatible-mode/v1"

[request]
cache_control_enabled = true
prompt_cache_key_enabled = false
```

DashScope URL 可以自动推断为 `qwen`。Qwen 默认使用 Chat Completions 和兼容的 cache-control 策略，也可以在 provider profile 允许时选择 Responses。

### Anthropic Messages

```toml
[model]
provider = "anthropic"
protocol = "anthropic_messages"
name = "claude-sonnet-4-6"
api_base_url = "https://api.anthropic.com"

[reasoning]
enabled = true
effort = "medium"
```

thinking effort 会映射为 Anthropic thinking budget。Anthropic client 使用内部输出上限，并确保 thinking budget 低于该上限。

## Node TUI

默认 TUI 保留终端原生复制和 scrollback，同时维护独立 transcript viewport。终端 resize 会重新计算 transcript、工具详情、diff 和 footer；主 transcript 不用于渲染临时 overlay。

### 按键

| 按键 | 行为 |
| --- | --- |
| `enter` | 空闲时发送；turn 可 steering 时向当前 turn 追加 steering message |
| `tab` | 将输入加入 follow-up queue |
| `esc` | 立即在 TUI 显示中断状态，并请求 backend 停止当前 turn |
| `ctrl+c` | 运行中中断；空输入时清空或退出 |
| `option+up` / `shift+left` | 取回最后一条 queued follow-up 继续编辑 |
| `ctrl+p` | 打开命令面板 |
| `ctrl+l` | 打开两阶段模型/思考强度选择器 |
| `ctrl+o` | 全局切换工具详情 |
| `ctrl+x` | 循环切换 sandbox |
| `shift+tab` | 循环切换协作模式 |
| `?` | 打开快捷键帮助 |
| `ctrl+v` | 粘贴图片 |
| `ctrl+d` | 退出 |

运行中按 `enter` 发送的消息会优先进入 steering queue；当前采样边界不可 steering 时会降级为 follow-up。被消费的 queued user message 会按真实消费顺序进入 transcript 和 session history。

### 图片输入

支持视觉输入的模型可以使用：

```text
分析这张截图 @/absolute/path/screenshot.png
```

支持 `.png`、`.jpg`、`.jpeg`、`.webp` 和 `.gif`。发送后路径会替换为 `[image #N]`，图片作为结构化 image block 进入 provider request。

### 工具展示

- `Read`、`LS` 等读取工具显示紧凑摘要。
- `Write` 显示新增内容和行数。
- `Edit`、`Patch` 和 mutation receipt 使用新增/删除颜色高亮。
- `Shell` 显示命令、状态、耗时和折叠输出。
- `Task` 显示后台 subagent 状态。
- `ctrl+o` 控制所有历史和当前工具详情，不把控制命令写入 transcript。
- `/resume` 恢复时沿用工具折叠策略，不全量展开旧 output。

## Slash commands

命令面板以 [slash command registry](src/mycli/cli/slash_command_registry.py) 为准。overlay 类命令不会覆盖最后一条 assistant 消息，也不会作为普通对话写进 session。

| 命令 | 说明 |
| --- | --- |
| `/help` | 打开命令帮助 |
| `/model [model] [--thinking-effort level]` | 选择模型和思考强度 |
| `/plan` | 进入 Plan 协作模式 |
| `/permissions [allow\|revoke\|clear]` | 查看或更新 session shell allowance |
| `/new` | 新建本地 transcript/session |
| `/resume [session-id]` | 选择或恢复 session |
| `/fork [source] [new-session] [message-index]` | fork session |
| `/status` | 当前 session、模型和 runtime 状态 |
| `/usage` | 当前窗口和累计 token usage |
| `/compact` | 手动压缩 active model context |
| `/skills` | 查看可用 skills |
| `/tools [list\|sets\|hooks\|extensions\|plugins]` | 查看工具和扩展 |
| `/tasks [agents\|kill-agents]` | 查看或停止后台 agent task |
| `/ps` | 查看后台终端 |
| `/changes` | 查看文件变更 |
| `/quit` | 退出 |

其他可用命令包括：

- `/settings`、`/sandbox`、`/context`、`/stats`、`/resources`
- `/memory`、`/agents`、`/stop`、`/undo`
- `/trace [export|logs]`
- `/details`、`/view`、`/hotkeys`、`/copy`、`/clear`
- `/login`、`/trust`
- `/session search`、`/session maintenance`

旧别名如 `/sessions`、`/search`、`/hooks`、`/toolsets`、`/jobs`、`/bashes`、`/subagents`、`/logs` 和 `/trace-jsonl` 仍兼容，但新文档和新交互应使用 canonical command。

## Turn、重试与中断

一个 turn 的主流程是：

```text
user input
  -> instruction/context assembly
  -> tool exposure planning
  -> provider request
  -> assistant text/reasoning/tool calls
  -> tool execution
  -> continuation request
  -> final assistant response
```

关键语义：

- 用户消息只在进入有效 turn 后持久化；未开始就被取消的输入不会伪装成已完成历史。
- 已完成的 assistant item、tool call 和 tool output 会按 append-only 顺序保存。
- 中断会补齐未完成工具所需的合成结果，避免 Responses/Chat replay 出现孤立 call/output。
- TUI 会立即显示 `Turn interrupted`，backend worker 在后台完成取消和资源回收。
- 可重试 transport/HTTP/SSE 错误默认最多重试 5 次，并显示 `Reconnecting... N/5`。
- retry 期间保留当前 turn 状态；恢复后回到 retry 前的 Thinking/Running 状态。
- context-window error 会先尝试确定性修复或 compact，再决定是否使用 fallback model。

## Context 与 compact

`mycli` 的 canonical conversation 是 provider-independent 的 append-only 时间线。每种协议只负责把它投影为自己的 wire format，不在 adapter 内重排语义历史。

自动和手动 compact 使用同一条主路径：

1. 根据 provider usage 或本地 token estimate 判断是否触发。
2. 选择要替换的历史与保留尾部。
3. 将完整结构化 conversation 交给 summarizer。
4. 保留 tool name、arguments、`call_id` 和 tool output；删除孤立 output，并为缺失 output 生成合成结果。
5. 单条超长 tool output 在 compact 输入边界使用 head-tail 截断。
6. summary 通过校验后，原子安装 `summary + exact tail + active in-flight suffix`。
7. summary 失败时保留原 conversation，不静默删除历史。

当前 model-visible 工具 schema 会提供给 summarizer，但 compact 请求强制禁止实际工具调用。compact 后旧 tool call/output 不原样保留在 replacement history 中；它们作为结构化证据参与 summary。

相关配置：

```toml
[context]
compaction_token_limit = 100000
compaction_reserved_output_tokens = 13000
compaction_tail_turns = 2
compaction_tail_max_tokens = 8000
compaction_l4_trigger_ratio = 0.9
compaction_l4_buffer_tokens = 13000
compaction_l4_summarizer_model = "gpt-5.4-mini"
```

## 工具系统

默认直接暴露给模型的内置工具：

- 文件与上下文：`Read`、`LS`、`Write`、`Edit`
- 终端：`Shell`、`WriteStdin`
- Web：`WebFetch`、`WebSearch`
- 交互与工作流：`AskUserQuestion`、`Plan`、`Task`、`SendMessage`、`Skill`

按需或兼容使用的内置工具包括 `Patch`、`ShellOutput`、`KillShell`、`Bash`、`BashOutput`、`GitStatus`、`GitDiff`、`GitLog`、`GitShow`、`Lint`、`SubagentOutput` 和 plan-mode 工具。

`Glob` 和 `Grep` 已从默认模型工具集中 retired；路径发现和文本搜索应使用 `Read`、`LS` 或 `Shell` 中的 `rg`。

当单轮 contributed tools 达到 100 项时，外部工具会转为 deferred，只直接暴露 `ToolSearch`。模型通过 ToolSearch 获得最多 8 个匹配工具定义后，可以在同一 turn 调用它们。

### WebSearch 的当前边界

当前 `WebSearch` 是 mycli 的 client-executed function tool：

- `provider="deepseek"` 分支返回 DeepSeek server-side search descriptor；它本身不是一次独立搜索 HTTP 调用。
- 非 DeepSeek 分支使用 `SERPAPI_API_KEY` 调用 SerpAPI，并规范化标题和 URL。
- OpenAI Responses hosted `web_search` 与 Codex standalone `web.run` 是不同能力，当前没有作为 mycli 的 raw search backend 接入。
- Responses hosted search 只向客户端暴露 `web_search_call`、最终模型 message，以及可选的 `web_search_call.action.sources`；它不暴露内部原始 tool output。

不要把 `provider="codex"` 理解成复用本机 Codex 搜索或 ChatGPT 登录态。

## Shell 与后台终端

`Shell` 使用持久 PTY transport：macOS/Linux 使用 Unix PTY，Windows 使用 ConPTY。环境来自启动 mycli 的进程，并经过 `shell_environment_policy` 过滤、覆盖和最小环境补全。

长时间运行的命令会返回 session ID，并进入后台终端注册表：

- `/ps` 查看后台终端。
- `ShellOutput` 获取新增输出。
- `WriteStdin` 向交互进程写入输入。
- `KillShell` 或 `/stop` 停止进程。
- TUI footer 显示后台终端数量。

HTTP server、watcher 和持续输出进程不会因为首次命令返回而被误判为已结束；runtime 根据 PTY/process 生命周期维护状态。

## Sandbox 与 approval

支持三种 sandbox：

- `read-only`
- `workspace-write`
- `danger-full-access`

默认是 `workspace-write`。安全策略结合 tool effect、目标路径、shell command 分析和 session allowance 决定自动执行、请求批准或拒绝。

- workspace 内常规读取和编辑通常可自动执行。
- workspace 外写入、危险 Shell、策略命中和高风险操作进入 approval。
- macOS 上，`read-only` 和 `workspace-write` 的 Shell、configured Hook 和 MCP stdio
  进程通过固定的 `/usr/bin/sandbox-exec` 进入 Seatbelt；文件写入和网络访问在 OS
  边界执行限制。
- Linux 上，受限模式通过固定的 `/usr/bin/bwrap` 或 `/bin/bwrap` 进入 Bubblewrap；
  根文件系统默认只读，仅重新挂载允许写入的目录，并按策略隔离网络 namespace。
  Bubblewrap 缺失时受限进程拒绝启动，不会静默降级到宿主机执行。
- Lint、Grep 和只读 Git 工具启动的本地进程复用同一 sandbox profile，不能作为
  Shell 之外的宿主机执行旁路。
- workspace-write 会在可写 workspace 内重新保护现有 `.git`、`.agents` 和 `.codex`
  元数据路径；Shell 可以修改项目文件，但不能直接改写这些控制目录。
- `danger-full-access` 不启用 OS sandbox，相关子进程直接继承当前系统用户权限。
- Windows 的 restricted-token helper 和进程内插件隔离仍在建设中。Windows
  受限模式当前 fail closed 并报告 `sandbox_unavailable`，不会静默降级到宿主机；
  需要直接继承当前用户权限时必须显式选择 `danger-full-access`。
- `/permissions allow <pattern>` 添加当前 session allowance。
- `/permissions revoke <pattern>` 撤销 allowance。
- Plan mode 阻止 mutation tools。
- memory 和当前 session task output 目录作为明确允许根目录加入 filesystem runtime。

## MCP、Skills、Hooks 与 Plugins

### MCP

配置位置：

```text
~/.mycli/mcp_servers.toml
<workspace>/.mycli/mcp_servers.toml
```

项目级同名 server 覆盖用户级配置。支持 `stdio`、`http` 和 `streamable_http`。

```toml
[servers.filesystem]
enabled = true
transport = "stdio"
command = "npx"
args = ["-y", "@modelcontextprotocol/server-filesystem", "."]
timeout_seconds = 30

[mcpServers.rail]
enabled = true
type = "streamable_http"
url = "https://mcp.example.test/mcp"
timeout_seconds = 30
```

MCP env 支持 `${NAME}` 插值。管理命令：

```bash
uv run mycli mcp list
uv run mycli mcp inspect <server-id>
```

### Skills

推荐目录：

```text
<workspace>/.agents/skills/<skill-name>/SKILL.md
<workspace>/.mycli/skills/<skill-name>/SKILL.md
~/.mycli/skills/<skill-name>/SKILL.md
src/mycli/prompts/skills/<skill-name>/SKILL.md
```

同名 skill 的优先级为：

```text
builtin < user ~/.mycli < workspace .agents < workspace .mycli
```

标准 `SKILL.md` 使用 YAML frontmatter，并可以包含 `scripts/`、`references/` 和 `assets/`。扁平 `<skill-name>.md` 与旧 TOML frontmatter 仍兼容。

### Hooks

支持以下 command hook：

- `PreToolUse`
- `PostToolUse`
- `SessionStart`
- `UserPromptSubmit`
- `Stop`

配置位置：

```text
<workspace>/.mycli/hooks.json
~/.mycli/hooks.json
```

```json
{
  "PostToolUse": [
    {
      "matcher": "*",
      "hooks": [
        {
          "type": "command",
          "command": "python3 .mycli/hooks/post_tool.py",
          "timeoutSec": 2
        }
      ]
    }
  ]
}
```

配置文件 hook 默认需要 allowlist：

```bash
uv run mycli hooks list
uv run mycli hooks inspect <hook-id>
uv run mycli hooks approve <hook-id>
uv run mycli hooks revoke <hook-id>
```

### Plugins

插件位于 `<workspace>/.mycli/plugins/` 或 `~/.mycli/plugins/`。管理命令：

```bash
uv run mycli plugins list
uv run mycli plugins inspect <plugin-id>
uv run mycli plugins run <plugin-id> <command-name> --json-args '{"key":"value"}'
```

utility command 支持 `--json`，便于脚本化调用。

插件模块不会导入到 mycli 主进程。注册探测以及 tool、hook、command callback 均在
独立的一次性 Python worker 中执行，并复用当前 session 的 OS sandbox；worker 崩溃、
超时或输出无效时会转换成有界插件错误。worker 只接收 `plugin.yaml` 的
`requires_env` 明确声明的环境变量，不继承其他 token、key 或 secret。

## Subagents

`Task` 启动独立 child session 中的后台 subagent：

1. 主 agent 发起 Task 后继续当前 turn，不同步等待。
2. child session 有独立 transcript、工具预算和状态。
3. TUI 显示后台进度。
4. 完成后 runtime 将 `<task-notification>` 送入主 session queue。
5. 主 agent 在后续采样边界消费 notification。

`SubagentOutput` 只用于用户明确请求查看后台进度；正常完成依赖 notification，不需要模型轮询。

推荐 profile：

```text
<workspace>/.mycli/agents/<profile-id>.md
~/.mycli/agents/<profile-id>.md
```

```md
---
name: security-reviewer
description: Review security-sensitive changes.
tools: Read, LS
disallowedTools: Shell, Write
model: gpt-5.4-mini
maxTurns: 5
---
Focus on concrete vulnerabilities, unsafe trust boundaries, and missing tests.
```

旧 `.mycli/subagents/*.toml` 和 `~/.mycli/subagents/*.toml` 仍兼容。

## Memory

长期记忆使用 workspace-scoped file memory：

```text
~/.mycli/projects/<workspace-key>/memory/
```

- `MEMORY.md` 是索引。
- 具体 memory 使用独立 Markdown 文件。
- 类型包括 `user`、`feedback`、`project` 和 `reference`。
- runtime 根据当前请求选择相关 memory。
- extraction 在成功 turn 后后台提取值得长期保存的信息。
- dream/consolidation 按时间和 session 数量阈值运行。

关闭全部 memory：

```toml
[memory]
enabled = false
```

仅关闭自动 extraction：

```toml
[memory]
enabled = true
extraction_enabled = true
extraction_interval_turns = -1
```

## Session 与数据目录

| 数据 | 路径 |
| --- | --- |
| SQLite session store | `~/.mycli/sessions.db` |
| Session snapshot/events | `~/.mycli/sessions/<session-id>/` |
| Background task output | `~/.mycli/sessions/<session-id>/tasks/` |
| Trace | `~/.mycli/traces/` |
| Runtime logs | `~/.mycli/logs/` |
| Auth store | `~/.mycli/auth.json` |
| Model catalog | `~/.mycli/models.json` |
| User config | `~/.mycli/config.toml` |
| File memory | `~/.mycli/projects/<workspace-key>/memory/` |
| Vendor tools | `~/.mycli/vendor/` |

SQLite 保存 conversation、structured history、context baseline、turn rollout、Responses continuation state、pending decision、suspended turn、queue 和 plan state。数据库使用 WAL，因此运行中出现 `sessions.db-wal` 和 `sessions.db-shm` 属于正常现象。

`session.json` 和 `events.jsonl` 用于 snapshot、诊断和兼容读取；SQLite 是当前主状态源。恢复 session 时 TUI 使用原子 transcript replacement，避免把已显示历史再次追加一遍。

## 代码结构

```text
src/mycli/cli/                    CLI、slash command、Node TUI gateway
src/mycli/application/runtime/    turn loop、request、tool、ledger、recovery
src/mycli/domain/                 conversation/runtime/tooling 领域类型
src/mycli/llms/                   provider clients 和 adapters
src/mycli/tools/                  内置工具、tool router、ToolSearch
src/mycli/services/context/       context、compact、token 与 tool output
src/mycli/state/                  session service 和序列化
src/mycli/memory/                 file memory、extraction、dream
src/mycli/services/mcp/           MCP transport 和 discovery
tui/mycli-shell/                  TypeScript Node TUI
```

更详细的模块边界见 [docs/architecture.md](docs/architecture.md)，当前上下文语义见 [docs/context/mycli-context-assembly-reference.md](docs/context/mycli-context-assembly-reference.md)。`docs/superpowers/` 中的 specs、plans 和 reports 是历史设计材料，不应覆盖当前源码与本 README 的产品说明。

## 开发与验证

Python：

```bash
uv run pytest -q
uv run ruff check .
uv run mypy src
```

Node TUI：

```bash
npm --prefix tui/mycli-shell run typecheck
npm --prefix tui/mycli-shell test
```

运行诊断：

```bash
uv run mycli doctor
uv run mycli hooks list --json
uv run mycli plugins list --json
uv run mycli mcp list --json
uv run mycli subagents list --json
```

## 已知限制

- OpenAI Responses gateway 的 hosted capabilities 取决于上游；支持 `/responses` 不代表支持 continuation、prompt cache、hosted web search 或 native compact。
- Responses hosted `web_search` 是一次完整模型调用，不是独立 raw search API；原始内部 tool output 不会返回客户端。
- 当前本地 `WebSearch` 尚未把 OpenAI hosted search 包装为跨 provider backend。
- Chat Completions provider 对严格 tool call replay、reasoning metadata 和 cache-control 的兼容程度不同。
- context token estimate 使用本地 tokenizer/估算，不等同于所有 provider 的计费 tokenizer。
- 中断提示可以立即显示，但不可取消的第三方 SDK、系统调用或子进程仍可能需要后台收尾。
- Node TUI 追求 Codex 风格的语义与布局，但不是 Codex UI 的逐像素复刻。

## 致谢

`mycli` 的设计参考了 Codex、Claude Code、Hermes Agent、pi-agent 等项目在 agent runtime、Responses、append-only history、工具生命周期、background task、hooks、memory 和终端交互方面的公开实现与产品思路。

这些参考不表示上述项目或维护者对 `mycli` 的背书或关联。
