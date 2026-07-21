# mycli

`mycli` 是一个本地优先的终端 coding agent。它把模型对话、工具调用、仓库分析、文件编辑、Shell 执行、subagent、记忆和 session 持久化放在同一个运行时里，目标是成为一个可长期使用的个人开发助手。

当前分支重点是让体验更接近 Claude Code / Codex：

- 默认启动 Node TUI，保留终端原生文字选择和 scrollback。
- 工具调用以 `Read`、`Write`、`Edit`、`Shell`、`Task` 等紧凑块展示。
- Shell 命令、写文件内容和 diff 默认折叠成可扫描预览。
- approval 使用选择器，不再只是把确认文本打在 transcript 里。
- subagent 默认后台运行，完成后通过 `<task-notification>` 回到主对话。
- 支持 Claude-style file memory，可按 workspace 保存长期记忆。
- 支持 Codex-compatible command hooks，可在 tool、prompt、session 和 stop 生命周期中插入本地命令。

## 快速开始

### 环境要求

- Python `3.13`
- `uv`
- Node.js `>=22.19.0`，用于默认 Node TUI
- `npm`
- Windows 原生支持 PowerShell 7、Windows PowerShell 5.1 和 `cmd.exe`；Git Bash 可选
- 一个支持的模型 provider API key

### 安装

```bash
uv venv
uv sync --dev
npm ci --prefix tui/mycli-shell
```

Linux 和 macOS 从源码启动：

```bash
uv run mycli
```

Windows 可在 PowerShell 中启动：

```powershell
uv run mycli
```

Windows 默认依次选择 PowerShell 7、Windows PowerShell 5.1、`cmd.exe`。识别出的 `shell_path` 也可以显式选择 Bash、zsh、sh、PowerShell 或 CMD；无效或未知 override 会被忽略，并由 `mycli doctor` 报告。完整规则见 [Windows 源码运行指南](docs/windows.md)。

### 配置模型

首次启动时，如果没有检测到 API key，`mycli` 会进入交互式 setup wizard。也可以手动运行：

```bash
uv run mycli setup
```

setup 默认采用 TypeScript TUI，交互风格参考 pi-agent：先选择认证方式，再通过 provider 列表选择要配置的 provider，然后进入 `Login to <Provider>` 输入 API key，并补充 API base URL 和 model。完成前会展示配置摘要。模型配置默认写入用户级配置 `~/.mycli/config.toml`，API key 单独写入 `~/.mycli/auth.json`。API key 输入不会回显；如果 Node TUI 不可用，会自动回退到纯文本 setup。

setup 还会准备 mycli 自用的 `rg`，安装位置为：

```text
~/.mycli/vendor/ripgrep/<platform>/rg
```

也可以手动执行：

```bash
uv run python scripts/prepare_ripgrep.py
```

进入 TUI 后，也可以运行 `/login` 打开同样的认证方式选择、provider 选择和 `Login to <Provider>` API key 输入界面。

也可以手动把用户级模型配置写到 `~/.mycli/config.toml`。新配置使用标准 TOML section；旧版顶层 key 仍会兼容读取，下一次 setup 或 TUI 设置保存时会被规范化：

```toml
[model]
provider = "openai"
protocol = "responses"
name = "gpt-5"
api_base_url = "https://api.openai.com/v1"
supports_images = true

[request]
max_prompt_tokens = 12000
max_output_tokens = 2048

[reasoning]
enabled = true
effort = "medium"

[memory]
enabled = true
extraction_interval_turns = 5
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

- 用户级：`~/.mycli/config.toml`
- 项目级覆盖：`<workspace>/.mycli/config.toml`
- 用户凭证：`~/.mycli/auth.json`
- 旧用户级 fallback：`~/.config/mycli/config.toml`

读取优先级是命令行参数和环境变量最高，其次是 `~/.mycli/config.toml`，再到项目级 `.mycli/config.toml`，最后才读取旧的 `~/.config/mycli/config.toml`。API key 优先级是环境变量、`~/.mycli/auth.json`，然后才兼容读取 config 中旧式 `api_key`；新配置不要把密钥写进 `config.toml`。

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
```

## TUI 交互

默认 Node TUI 使用主屏幕渲染，但不捕获鼠标，因此终端原生复制和 scrollback 仍然可用。它也维护一个内部 transcript viewport，用于在不破坏底部输入框的情况下滚动历史。

如果当前模型支持视觉输入，可以在 TUI 输入中使用 `@/path/to/image.png`、`@/path/to/image.jpg`、`@/path/to/image.webp` 或 `@/path/to/image.gif` 附加本地图片。发送时输入里的路径会替换为 `[image #1]` 占位文本，图片本体作为结构化 image block 传给 provider。

`supports_images` 默认随 provider 选择：OpenAI、Codex、Qwen、Anthropic 和 compatible 默认开启，DeepSeek 默认关闭。如果 compatible endpoint 实际不支持多模态，可以在 `[model]` 中设为 `false`。

常用按键：

| 按键 | 行为 |
| --- | --- |
| `enter` | 发送当前输入 |
| `tab` | 当前 turn 运行中追加 follow-up |
| `esc` | 请求中断当前 turn |
| `option+up` / `shift+left` | 取回 queued/follow-up 输入 |
| `ctrl+p` | 打开命令面板 |
| `ctrl+l` | 打开模型选择器 |
| `ctrl+o` | 切换工具详情显示 |
| `ctrl+c` | 空输入时清空/退出；运行中不会直接杀掉后台 subagent |
| 鼠标滚轮 | 滚动会话历史 |

TUI 中的工具展示默认偏紧凑：

- `Read` / `Glob` / `Grep` / `LS` 等上下文工具会折叠成同类分组。
- `Write` 会展示写入内容预览和行数。
- `Edit` / mutation 工具优先展示 diff 预览。
- `Shell` 只展示命令摘要，长命令默认折叠，并在详情中显示当前 shell profile。
- `Task` / subagent 会在输入框附近显示运行状态和进度。

## 常用命令

在 TUI 或 `--plain` REPL 中输入 slash command：

| 命令 | 说明 |
| --- | --- |
| `/help` | 查看命令列表 |
| `/status` | 查看当前 session、模型、provider、context 状态 |
| `/status usage` | 查看当前 session token/usage |
| `/status context` | 查看 context window 诊断 |
| `/status stats` | 查看 runtime 聚合统计 |
| `/model <model> [--thinking-effort low\|medium\|high\|xhigh]` | 切换模型或 thinking effort |
| `/view [default\|verbose\|focus]` | 切换 transcript 展示密度 |
| `/tools` | 查看当前工具 |
| `/tools permissions` | 查看 approval 和命令 allowance |
| `/tools sets` | 查看 toolset 状态 |
| `/tools hooks` | 查看 hook 状态 |
| `/tools extensions` | 查看 extension runtime |
| `/tools plugins` | 查看或执行 plugin command |
| `/tools skills` | 查看 skills |
| `/plan` | 查看并进入 plan 协作模式 |
| `/mode [default\|plan]` | 查看或切换协作模式 |
| `/sandbox [next\|read-only\|workspace-write\|danger-full-access]` | 查看或切换当前 session sandbox |
| `/permissions allow <command-pattern>` | 为当前 session 添加 shell 命令 allowlist |
| `/permissions revoke <command-pattern>` | 移除当前 session 命令 allowlist |
| `/permissions clear` | 清空当前 session 命令 allowlist |
| `/memory` | 查看 memory 摘要 |
| `/memory path` | 查看 file memory 目录 |
| `/memory search <query>` | 搜索 file memory |
| `/memory add <type> <name> :: <content>` | 手动添加 file memory |
| `/memory forget <filename-or-query>` | 删除匹配的 file memory |
| `/agents` | 查看 subagent profile 配置 |
| `/agents inspect <profile_id>` | 查看单个 subagent profile |
| `/agents runs [child_session_id]` | 查看 subagent run 或其 transcript |
| `/tasks` | 查看后台 task |
| `/tasks agents [child_session_id]` | 查看后台 subagent 或其 transcript |
| `/tasks agents kill <child_session_id>` | 停止指定后台 subagent |
| `/tasks bashes` | 查看后台 shell |
| `/changes` | 查看文件变更 |
| `/changes undo` | 撤销最近一次可恢复文件变更 |
| `/trace` | 查看最近 runtime trace |
| `/trace export` | 导出 trace JSONL |
| `/trace logs` | 查看 workspace log |
| `/session` | 查看当前 session |
| `/session list` | 列出当前 workspace 的 sessions |
| `/session resume <session>` | 恢复 session |
| `/session fork [source] <new-session> [message-index]` | 从 session fork |
| `/session search <query>` | 搜索 saved sessions |
| `/session maintenance [--apply-empty\|--apply-orphans\|--apply-vacuum]` | 检查或执行 session 存储维护 |
| `/quit` | 退出 |

旧入口仍兼容：`/usage`、`/context`、`/stats`、`/sessions`、`/resume`、`/fork`、`/search`、`/permissions`、`/hooks`、`/toolsets`、`/jobs`、`/bashes`、`/subagents`、`/trace-jsonl`、`/logs`、`/undo` 会映射到上面的分组命令。

## 模型 Provider

`mycli` 用 `provider` 和 `protocol` 组合描述模型访问方式。

支持的 provider：

- `openai`
- `codex`
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
[model]
provider = "openai"
protocol = "responses"
name = "gpt-5"
api_base_url = "https://api.openai.com/v1"
```

### Codex-style Responses

Use `codex` for OpenAI-compatible Responses gateways that support Codex/OpenAI
Responses parameters such as `parallel_tool_calls`.

```toml
[model]
provider = "codex"
protocol = "responses"
name = "gpt-5.4"
api_base_url = "https://your-codex-compatible-gateway.example/v1"
```

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

如果 `api_base_url` 包含 `dashscope.aliyuncs.com`，未显式配置 provider 时会自动推断为 `qwen`。Qwen 默认走 OpenAI-compatible Chat Completions，并使用 DashScope 兼容的 cache-control 上下文缓存策略。

### DeepSeek

DeepSeek 走 OpenAI-compatible chat completions：

```toml
[model]
provider = "deepseek"
protocol = "chat_completions"
name = "deepseek-v4-flash"
api_base_url = "https://api.deepseek.com"

[reasoning]
enabled = true
effort = "medium"
```

DeepSeek 的 reasoning metadata 会进入 activity、trace、workspace log 和 session turn history，便于调试工具调用链路。

### Anthropic

Anthropic 使用原生 Messages API：

```toml
[model]
provider = "anthropic"
protocol = "anthropic_messages"
name = "claude-sonnet-4-6"
api_base_url = "https://api.anthropic.com"

[request]
max_output_tokens = 4096

[reasoning]
enabled = true
effort = "medium"
```

开启 thinking 时，`thinking_effort` 会映射到 Anthropic `budget_tokens`，并要求预算小于 `max_output_tokens`。当前映射：

- `low = 1024`
- `medium = 1536`
- `high = 3072`
- `xhigh = 6144`

## 工具与安全

常用内置工具：

- 文件工具：`Read`、`Write`、`Edit`、`Glob`、`Grep`、`LS`
- Shell 工具：`Shell`、`ShellOutput`、`KillShell`；`Bash`/`BashOutput` 仅用于旧会话兼容
- Git 工具：`GitStatus`、`GitDiff`、`GitLog`、`GitShow`
- 工作流工具：`Plan`、`update_plan`、`Task`、`SubagentOutput`
- 交互工具：`AskUserQuestion`
- 外部工具：MCP、skills、plugins 可贡献额外工具

安全模型：

- sandbox 支持 `read-only`、`workspace-write`、`danger-full-access`，可通过 `/sandbox` 查看或切换。
- 低风险读取和搜索默认自动执行；`read-only` 下 mutating tools 会被阻止。
- `workspace-write` 下常规 workspace 内编辑默认可执行。
- Shell、跨 workspace、策略命中或高风险操作会进入 approval。
- approval 支持一次允许、拒绝、session allowlist。
- `/permissions allow <pattern>` 可以为当前 session 放行匹配的 shell 命令。
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

自定义 subagent 推荐使用 Claude Code 风格 Markdown profile：

```text
.mycli/agents/<profile-id>.md
~/.mycli/agents/<profile-id>.md
```

示例：

```md
---
name: security-reviewer
description: Review security-sensitive changes.
tools: Read, Grep, Glob, LS
disallowedTools: Shell, Write
model: gpt-5.4-mini
maxTurns: 5
---
You are a security review sub-agent. Focus on concrete vulnerabilities,
unsafe trust boundaries, and missing regression tests.
```

Markdown frontmatter 中 `name` 和 `description` 必填，正文会作为该 subagent 的 system prompt。旧版 TOML profile 仍兼容：
`.mycli/subagents/*.toml` 和 `~/.mycli/subagents/*.toml`。

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
[memory]
enabled = false
```

完全关闭后台 memory extraction：

```toml
[memory]
extraction_interval_turns = -1
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
| User config | `~/.mycli/config.toml` |
| Workspace config | `<workspace>/.mycli/config.toml` |
| Hook config | `<workspace>/.mycli/hooks.json`、`~/.mycli/hooks.json` |
| Hook allowlist | `~/.mycli/hook-allowlist.json` |
| Plugins | `<workspace>/.mycli/plugins/`、`~/.mycli/plugins/` |
| MCP config | `<workspace>/.mycli/mcp_servers.toml` |

SQLite session store 会保存：

- conversation messages
- structured history items
- context baselines
- turn rollouts 和 continuation state
- pending decisions 和 suspended turns
- plan state
- per-session summaries

旧 JSON session 文件 `~/.mycli/sessions/*.json` 已不再作为主运行时存储。

SQLite 默认使用 WAL journal mode，因此运行中可能看到 `sessions.db-wal` 和 `sessions.db-shm`。这是 SQLite 的正常写入日志文件；checkpoint 后可能变小或保留为空文件，不需要手动删除。

## MCP、Skills 与 Plugins

### Skills

内置 skills 位于：

```text
src/mycli/prompts/skills/
```

新 skills 推荐使用 Agent Skills 目录格式：

```text
<workspace>/.agents/skills/<skill-name>/SKILL.md
<workspace>/.mycli/skills/<skill-name>/SKILL.md
~/.mycli/skills/<skill-name>/SKILL.md
```

`.agents/skills` 适合放入仓库并与其他 coding agent 共享；`.mycli/skills` 适合
mycli 专属 skill。每个 skill 目录可以包含自己的 `scripts/`、`references/` 和
`assets/`。标准 `SKILL.md` 使用 YAML frontmatter；原有 TOML frontmatter 继续兼容。

为兼容已有配置，以上目录及内置目录中的扁平 `<skill-name>.md` 文件仍会加载。
同名 skill 按以下顺序覆盖，右侧优先级更高：

```text
builtin < user ~/.mycli < workspace .agents < workspace .mycli
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

### Hooks

`mycli` 支持一个 Codex-compatible command hook subset。主路径对齐 Codex 的五个事件：

- `PreToolUse`
- `PostToolUse`
- `SessionStart`
- `UserPromptSubmit`
- `Stop`

推荐使用 Codex grouped 配置，放在项目级 `<workspace>/.mycli/hooks.json` 或用户级 `~/.mycli/hooks.json`：

```json
{
  "PostToolUse": [
    {
      "matcher": "*",
      "hooks": [
        {
          "type": "command",
          "command": "python3 .mycli/hooks/post_tool_reminder.py",
          "timeoutSec": 2
        }
      ]
    }
  ]
}
```

hook command 从 stdin 读取 JSON，并向 stdout 写 JSON。`PostToolUse` 追加上下文示例：

```python
import json

print(json.dumps({
    "hookSpecificOutput": {
        "hookEventName": "PostToolUse",
        "additionalContext": (
            "The previous tool call has completed. Use its result above; "
            "do not repeat the same tool call unless the result is missing, "
            "stale, or insufficient for the current task."
        )
    }
}))
```

阻断示例：

```python
import json
import sys

payload = json.load(sys.stdin)
prompt = payload.get("prompt", "")

if "rm -rf" in prompt:
    print(json.dumps({
        "decision": "block",
        "reason": "Prompt contains a high-risk delete command."
    }))
else:
    print("{}")
```

也可以用 exit code `2` 阻断，并把原因写到 stderr。

matcher 规则：

- `PreToolUse` / `PostToolUse` matcher 匹配 tool name。
- `SessionStart` matcher 匹配 source，例如 `startup`。
- `UserPromptSubmit` / `Stop` 忽略 matcher。
- 空 matcher 或 `*` 匹配全部；其他字符串按正则匹配。

配置文件 hook 是本地命令，默认需要 allowlist。先查看 identity：

```bash
uv run mycli hooks list
```

然后批准：

```bash
uv run mycli hooks approve repo:PostToolUse-0-0:post_tool_use
```

如果使用 mycli 旧 flat 格式，可以指定稳定 id：

```json
{
  "hooks": [
    {
      "id": "post-tool-reminder",
      "hook_point": "post_tool_use",
      "command": ["python3", ".mycli/hooks/post_tool_reminder.py"],
      "timeout_seconds": 2
    }
  ]
}
```

对应 approve：

```bash
uv run mycli hooks approve repo:post-tool-reminder:post_tool_use
```

内置 `post_tool_context` 已默认注册，会在每次 tool 完成后生成防重复调用 reminder。这个 built-in hook 不走 allowlist；allowlist 只保护配置文件里的 command hook。

### Plugins

插件和 hook 管理命令：

```bash
uv run mycli plugins list
uv run mycli hooks list
uv run mycli mcp list
uv run mycli subagents list
```

这些命令支持 `--json` 输出，方便脚本调用。常用管理命令：

```bash
uv run mycli hooks inspect repo:post-tool-reminder:post_tool_use
uv run mycli hooks approve repo:post-tool-reminder:post_tool_use
uv run mycli hooks revoke repo:post-tool-reminder:post_tool_use

uv run mycli plugins inspect <plugin_id>
uv run mycli plugins run <plugin_id> <command_name> --json-args '{"key":"value"}'

uv run mycli mcp inspect <server_id>
uv run mycli subagents inspect <profile_id>
```

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

## 致谢

`mycli` 的设计和实现参考了多个优秀 agent 项目、产品和实验思路。特别感谢 hermes-agent、pi-agent、Codex、Claude Code 等项目带来的启发，包括 Responses/工具调用运行时、append-only 上下文组织、subagent/background task、hook 生命周期、终端交互体验、登录配置流程和 session/memory 管理等方向。

这些致谢只表示工程和产品思路上的学习与借鉴，不表示上述项目或其维护者对 `mycli` 的背书或关联。

## 已知限制

- OpenAI 主路径默认使用 `POST /responses`；不支持 Responses API 的 provider 需要配置 `protocol = "chat_completions"`。
- `chat_completions` 兼容模式依赖 provider 的 OpenAI-compatible 行为，tool call replay 的严格程度因 provider 而异。
- 当前 context token 估算和压缩摘要不是 provider 原生 tokenizer。
- Node TUI 已尽量靠近 Claude Code 的交互语义，但不是完整复刻。
- background subagent 通知依赖主 runtime 队列；如果 provider 对 tool-call/result 顺序特别严格，仍需要专项兼容测试。
