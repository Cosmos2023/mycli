# mycli

`mycli` 是一个本地优先的终端 coding agent。它把模型对话、工具调用、仓库分析、文件编辑、Shell 执行、subagent、记忆和 session 持久化放在同一个运行时里，目标是成为一个可长期使用的个人开发助手。

当前分支重点是让体验更接近 Claude Code / Codex：

- 默认启动 Node TUI，保留终端原生文字选择和 scrollback。
- 工具调用以 `Read`、`Write`、`Edit`、`Bash`、`Task` 等紧凑块展示。
- Bash 命令、写文件内容和 diff 默认折叠成可扫描预览。
- approval 使用选择器，不再只是把确认文本打在 transcript 里。
- subagent 默认后台运行，完成后通过 `<task-notification>` 回到主对话。
- 支持 Claude-style file memory，可按 workspace 保存长期记忆。

## 快速开始

### 环境要求

- Python `3.13`
- `uv`
- Node.js `>=22.19.0`，用于默认 Node TUI
- 一个支持的模型 provider API key

### 安装

```bash
uv venv
uv sync --dev
```

Node TUI 依赖位于 `tui/mycli-shell`：

```bash
cd tui/mycli-shell
npm install
cd ../..
```

### 配置模型

首次启动时，如果没有检测到 API key，`mycli` 会进入交互式 setup wizard。也可以手动运行：

```bash
uv run mycli setup
```

setup 会询问 provider、API base URL、model 和 API key。模型配置默认写入用户级配置 `~/.config/mycli/config.toml`，API key 单独写入 `~/.mycli/auth.json`。API key 输入不会回显。

也可以手动把项目配置写到当前 workspace 的 `.mycli/config.toml`：

```toml
provider = "openai"
protocol = "responses"
model = "gpt-5"
api_base_url = "https://api.openai.com/v1"

max_prompt_tokens = 12000
max_output_tokens = 2048
thinking_enabled = true
thinking_effort = "medium"
memory_enabled = true
```

也可以使用环境变量：

```bash
export MYCLI_API_KEY="your-api-key"
export MYCLI_PROVIDER="openai"
export MYCLI_PROTOCOL="responses"
export MYCLI_MODEL="gpt-5"
export MYCLI_BASE_URL="https://api.openai.com/v1"
```

配置读取位置：

- 用户级：`~/.config/mycli/config.toml`
- 项目级：`<workspace>/.mycli/config.toml`
- 用户凭证：`~/.mycli/auth.json`

项目级配置优先于用户级配置，命令行参数和环境变量优先级更高。API key 优先级是环境变量、项目/用户 config 中的旧式 `api_key`、再到 `~/.mycli/auth.json`；新配置推荐使用 setup 或环境变量，避免把密钥写进项目文件。

### 启动

```bash
uv run mycli
```

常用启动方式：

```bash
# 指定 session
uv run mycli --session demo

# 覆盖模型
uv run mycli --model gpt-5

# 行式 REPL，不启动 TUI
uv run mycli --plain

# 显式启动 Node TUI
uv run mycli --node-tui

# 使用旧 Textual TUI
MYCLI_TUI_BACKEND=textual uv run mycli
```

## TUI 交互

默认 Node TUI 使用主屏幕渲染，但不捕获鼠标，因此终端原生复制和 scrollback 仍然可用。它也维护一个内部 transcript viewport，用于在不破坏底部输入框的情况下滚动历史。

常用按键：

| 按键 | 行为 |
| --- | --- |
| `enter` | 发送当前输入 |
| `option+enter` | 当前 turn 运行中追加 follow-up |
| `esc` | 请求中断当前 turn |
| `option+up` | 取回 queued/follow-up 输入 |
| `ctrl+p` | 打开命令面板 |
| `ctrl+l` | 打开模型选择器 |
| `ctrl+o` | 切换工具详情显示 |
| `ctrl+c` | 空输入时清空/退出；运行中不会直接杀掉后台 subagent |
| 鼠标滚轮 | 滚动会话历史 |

TUI 中的工具展示默认偏紧凑：

- `Read` / `Glob` / `Grep` / `LS` 等上下文工具会折叠成同类分组。
- `Write` 会展示写入内容预览和行数。
- `Edit` / mutation 工具优先展示 diff 预览。
- `Bash` 只展示命令摘要，长命令默认折叠。
- `Task` / subagent 会在输入框附近显示运行状态和进度。

## 常用命令

在 TUI 或 `--plain` REPL 中输入 slash command：

| 命令 | 说明 |
| --- | --- |
| `/help` | 查看命令列表 |
| `/status` | 查看当前 session、模型、provider、context 状态 |
| `/model <model> [--thinking-effort low\|medium\|high\|xhigh]` | 切换模型或 thinking effort |
| `/view [default\|verbose\|focus]` | 切换 transcript 展示密度 |
| `/tools` | 查看当前工具 |
| `/permissions` | 查看 approval 和命令 allowance |
| `/plan` | 查看并进入 plan 协作模式 |
| `/mode [default\|plan]` | 查看或切换协作模式 |
| `/memory` | 查看 memory 摘要 |
| `/memory path` | 查看 file memory 目录 |
| `/memory search <query>` | 搜索 file memory |
| `/memory add <type> <name> :: <content>` | 手动添加 file memory |
| `/memory forget <filename-or-query>` | 删除匹配的 file memory |
| `/subagents [child_session_id]` | 查看后台 subagent 或其 transcript |
| `/trace` | 查看最近 runtime trace |
| `/trace-jsonl` | 导出 trace JSONL |
| `/logs` | 查看 workspace log |
| `/sessions` | 列出当前 workspace 的 sessions |
| `/resume <session>` | 恢复 session |
| `/fork [source] <new-session> [message-index]` | 从 session fork |
| `/quit` | 退出 |

## 模型 Provider

`mycli` 用 `provider` 和 `protocol` 组合描述模型访问方式。

支持的 provider：

- `openai`
- `qwen`
- `deepseek`
- `anthropic`
- `compatible`

支持的 protocol：

- `responses`
- `chat_completions`
- `anthropic_messages`

### OpenAI / compatible Responses

```toml
provider = "openai"
protocol = "responses"
model = "gpt-5"
api_base_url = "https://api.openai.com/v1"
```

### Qwen

```toml
provider = "qwen"
protocol = "responses"
model = "qwen3.6-plus"
api_base_url = "https://dashscope.aliyuncs.com/compatible-mode/v1"
```

如果 `api_base_url` 包含 `dashscope.aliyuncs.com`，未显式配置 provider 时会自动推断为 `qwen`。

### DeepSeek

DeepSeek 走 OpenAI-compatible chat completions：

```toml
provider = "deepseek"
protocol = "chat_completions"
model = "deepseek-v4-flash"
api_base_url = "https://api.deepseek.com"
thinking_enabled = true
thinking_effort = "medium"
```

DeepSeek 的 reasoning metadata 会进入 activity、trace、workspace log 和 session turn history，便于调试工具调用链路。

### Anthropic

Anthropic 使用原生 Messages API：

```toml
provider = "anthropic"
protocol = "anthropic_messages"
model = "claude-sonnet-4-6"
api_base_url = "https://api.anthropic.com"
max_output_tokens = 4096
thinking_enabled = true
thinking_effort = "medium"
```

开启 thinking 时，`thinking_effort` 会映射到 Anthropic `budget_tokens`，并要求预算小于 `max_output_tokens`。当前映射：

- `low = 1024`
- `medium = 1536`
- `high = 3072`
- `xhigh = 6144`

## 工具与安全

常用内置工具：

- 文件工具：`Read`、`Write`、`Edit`、`Glob`、`Grep`、`LS`
- Shell 工具：`Bash`、`BashOutput`、`KillShell`
- Git 工具：`GitStatus`、`GitDiff`、`GitLog`、`GitShow`
- 工作流工具：`Plan`、`update_plan`、`Task`、`SubagentOutput`
- 交互工具：`AskUserQuestion`
- 外部工具：MCP、skills、plugins 可贡献额外工具

安全模型：

- 低风险读取和搜索默认自动执行。
- 常规 workspace 内编辑默认可执行。
- Shell、跨 workspace、策略命中或高风险操作会进入 approval。
- approval 支持一次允许、拒绝、session allowlist。
- plan mode 是只读模式，会阻止 mutating tools。

File memory 目录会被加入允许根目录，因此 Agent 可以读写自己的 memory 文件；其他 workspace 外路径仍会被 filesystem runtime 拦截。

## Subagents

`Task` 工具用于启动 subagent。当前默认模型侧语义接近 Claude Code background task：

1. 主 agent 发起 `Task` 后立即继续，不同步等待子 agent 完成。
2. 子 agent 在独立 child session 中运行，有自己的 transcript。
3. TUI 会显示 subagent 进度，包括 tool call、tool result 和 final 状态。
4. 子 agent 完成后，runtime 将 `<task-notification>` 放回主对话队列。
5. 主 agent 下一次模型请求会看到该 notification。

`SubagentOutput` 只用于用户明确要求查看后台任务进度/结果时。模型不应该主动轮询它；完成结果会自动通知。

## Memory

主线长期记忆采用 Claude-style file memory。

File memory 保存在：

```text
~/.mycli/projects/<workspace-key>/memory/
```

其中：

- `MEMORY.md` 是索引文件。
- 具体记忆保存在独立 Markdown 文件中。
- 支持的类型是 `user`、`feedback`、`project`、`reference`。
- runtime 会按当前请求选择相关 memory 注入上下文。
- 用户明确要求“记住/忘记”时，Agent 可以写入或删除 memory 文件。
- 成功 turn 之后会后台尝试提取值得长期保留的偏好或反馈。
- dream/consolidation 会定期尝试整理 memory。

关闭 memory：

```toml
memory_enabled = false
```

或：

```bash
export MYCLI_MEMORY_ENABLED=false
```

关闭后，runtime 不再注入 file memory，也不会启动后台 memory extraction/dream。

## Sessions、Trace 与持久化

主要数据位置：

| 数据 | 路径 |
| --- | --- |
| Session DB | `~/.mycli/sessions.db` |
| Auth store | `~/.mycli/auth.json` |
| File memory | `~/.mycli/projects/<workspace-key>/memory/` |
| Workspace trace | `~/.mycli/traces/` |
| Workspace config | `<workspace>/.mycli/config.toml` |

SQLite session store 会保存：

- conversation messages
- structured history items
- context baselines
- turn rollouts 和 continuation state
- pending decisions 和 suspended turns
- plan state
- per-session summaries

旧 JSON session 文件 `~/.mycli/sessions/*.json` 已不再作为主运行时存储。

## MCP、Skills 与 Plugins

### Skills

内置 skills 位于：

```text
src/mycli/prompts/skills/
```

用户自定义 skills 位于：

```text
~/.mycli/skills/*.md
```

Skill metadata 会被索引，正文按需加载。匹配到的 skill 会作为独立指令注入当前 turn。

### MCP servers

项目级 MCP 配置文件：

```text
<workspace>/.mycli/mcp_servers.toml
```

stdio server 示例：

```toml
[servers.filesystem]
enabled = true
transport = "stdio"
command = "npx"
args = ["-y", "@modelcontextprotocol/server-filesystem", "."]
timeout_seconds = 30
```

HTTP server 示例：

```toml
[servers.search]
enabled = true
transport = "http"
url = "http://127.0.0.1:8765/mcp"
timeout_seconds = 30
```

环境变量可以用 `${NAME}` 引用：

```toml
[servers.github]
enabled = true
transport = "stdio"
command = "uvx"
args = ["mcp-server-github"]
env = { GITHUB_TOKEN = "${GITHUB_TOKEN}" }
```

### Plugins

插件和 hook 管理命令：

```bash
uv run mycli plugins list
uv run mycli hooks list
uv run mycli mcp list
uv run mycli subagents list
```

这些命令支持 `--json` 输出，方便脚本调用。

## 开发命令

Python：

```bash
uv run pytest -q
uv run ruff check .
uv run mypy src
```

Node TUI：

```bash
cd tui/mycli-shell
npm run typecheck
npm test
./node_modules/.bin/tsc --noEmit --noUnusedLocals --noUnusedParameters
```

## 已知限制

- OpenAI 主路径默认使用 `POST /responses`；不支持 Responses API 的 provider 需要配置 `protocol = "chat_completions"`。
- `chat_completions` 兼容模式依赖 provider 的 OpenAI-compatible 行为，tool call replay 的严格程度因 provider 而异。
- 当前 context token 估算和压缩摘要不是 provider 原生 tokenizer。
- Node TUI 已尽量靠近 Claude Code 的交互语义，但不是完整复刻。
- background subagent 通知依赖主 runtime 队列；如果 provider 对 tool-call/result 顺序特别严格，仍需要专项兼容测试。
