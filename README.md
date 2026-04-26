# mycli

`mycli` 是一个运行在终端里的本地优先 ReAct 个人 Agent。当前版本聚焦 CLI 对话、仓库分析、文件读写、Shell 执行、风险决策、基础记忆与 skill 加载，适合作为个人 coding assistant 的 v1 骨架。

## 运行时架构

当前版本已经切换到新的 Phase 1 runtime 主链：

- CLI 负责承载交互，不再直接承担 agent 主循环
- 内部主链由 message-driven runtime 驱动
- tools 通过 schema-first registry 暴露
- runtime 会把工具结果作为 `tool` transcript message 重新注入后续推理
- planning 已经从静态字段升级为内建能力，当前提供 `update_plan` 工具
- skill runtime 已支持 metadata 索引与正文按需加载，匹配到的 skill 会以独立指令消息注入当前 turn
- 高风险工具调用会挂起当前 turn，待确认后恢复执行
- 默认协议已切换到 OpenAI 兼容 `responses`，运行时主链按 block 驱动
- `chat_completions` 兼容路径用于 DeepSeek 等不支持 `responses` 的 provider
- `anthropic_messages` 原生路径用于 Anthropic Messages API，支持 tool use、tool result replay 和 extended thinking

## 内部运行时协议

`mycli` 不把任何 provider 的 wire format 当作内部运行时契约。OpenAI Responses、chat completions 以及未来的 Anthropic / MCP / skill 接入都应该先转换到内部协议：

- provider transport 负责解析自己的请求与响应格式
- transport 输出统一的 `ModelEvent` 事件，例如 message delta、reasoning delta、tool call 和 turn completed
- 共享 turn aggregator 把事件流转换成 `RuntimeItem`、`RuntimeBlock` 和 `ModelTurnResult`
- native tool、MCP tool 和 skill 都统一表示为 tool call / tool result，只通过 source 区分来源
- thinking 控制统一为 `thinking_enabled` 与 `thinking_effort`，再由 transport 映射到 provider 支持的请求字段

## 当前能力

- 对话式 CLI REPL
- grounded tool-result reinjection：搜索结果、文件内容和 diff 会被压缩后重新注入后续推理
- task-aware planning：`update_plan` 可维护 `pending` / `in_progress` / `completed` 任务状态
- 结构化 workspace / git 工具：文件创建、移动、删除、目录创建、`git status`、`git diff`、`git log`
- runtime trace：工具执行事件会写入 trace，并可通过 `/trace` 查看
- Agent 自主调用工具：`list_directory`、`read_file`、`read_file_range`、`search_text`、`append_file`、`replace_in_file`、`edit_file`、`create_file`、`mkdir`、`move_path`、`delete_path`、`git_status`、`git_diff`、`git_log`、`run_shell`
- 会话持久化、项目记忆、用户偏好记忆
- 内置 skills 与用户自定义 skills 加载
- 风险操作数字决策流与会话级 allowlist
- Responses-first provider 适配，provider 错误会尽量归一化输出

## 环境要求

- Python `3.13`
- `uv`
- 可用的 OpenAI 兼容 `responses` 接口（主路径）
- 提供 `api_key` 的方式二选一：环境变量或配置文件

## 快速开始

### 1. 安装依赖

如果仓库里还没有虚拟环境：

```bash
uv venv
uv sync --dev
```

如果你已经创建好了 `.venv`，直接同步依赖即可：

```bash
uv sync --dev
```

### 2. 配置模型与 API

你可以用环境变量快速启动：

```bash
export MYCLI_API_KEY="your-api-key"
export MYCLI_MODEL="gpt-5"
export MYCLI_BASE_URL="https://api.openai.com/v1"
# 可选：显式协议，默认就是 responses
export MYCLI_PROTOCOL="responses"
```

也可以写进项目级配置文件 `<workspace>/.mycli/config.toml`：

```toml
model = "gpt-5"
provider = "openai"
protocol = "responses"
api_base_url = "https://api.openai.com/v1"
api_key = "your-api-key"
max_steps = 4
max_prompt_tokens = 12000
max_output_tokens = 2048
compression_threshold_tokens = 8000
recent_message_count = 6
thinking_enabled = true
thinking_effort = "medium"
```

说明：

- `mycli` 实际读取的是 `<workspace>/.mycli/config.toml`
- 仓库根目录下单独的 `config.toml` 默认不会被当前实现读取

如果环境变量和配置文件里都没有 `api_key`，启动时会直接报错：

```text
RuntimeError: MYCLI_API_KEY is required
```

### 3. 启动 CLI

推荐使用 `uv`：

```bash
uv run mycli
```

也可以直接使用虚拟环境里的可执行文件：

```bash
./.venv/bin/mycli
```

带上会话名或模型覆盖：

```bash
uv run mycli --session demo
uv run mycli --session demo --model gpt-5
```

## 运行时配置

`mycli` 会从以下位置读取配置：

- 用户级配置：`~/.config/mycli/config.toml`
- 项目级配置：`<workspace>/.mycli/config.toml`

支持的配置项：

```toml
model = "gpt-5"
provider = "openai"
protocol = "responses"
api_base_url = "https://api.openai.com/v1"
api_key = "your-api-key"
max_steps = 4
max_prompt_tokens = 12000
max_output_tokens = 2048
compression_threshold_tokens = 8000
recent_message_count = 6
```

配置优先级：

- `model`：`--model` > `MYCLI_MODEL` > 项目配置 > 用户配置 > 默认值 `gpt-5`
- `provider`：`MYCLI_PROVIDER` > 项目配置 > 用户配置 > 根据 `api_base_url` 推断 > 默认值 `openai`
- `protocol`：`MYCLI_PROTOCOL` > 项目配置 > 用户配置 > 默认值 `responses`
- `api_base_url`：`MYCLI_BASE_URL` > 项目配置 > 用户配置 > 默认值 `https://api.openai.com/v1`
- `api_key`：`MYCLI_API_KEY` > 项目配置 > 用户配置
- `session_id`：`--session` > 默认值 `default`
- `max_prompt_tokens`：`MYCLI_MAX_PROMPT_TOKENS` > 项目配置 > 用户配置 > 默认值 `12000`
- `max_output_tokens`：`MYCLI_MAX_OUTPUT_TOKENS` > 项目配置 > 用户配置 > 默认值 `2048`
- `thinking_enabled`：`MYCLI_THINKING_ENABLED` > 项目配置 > 用户配置 > 默认值 `true`
- `thinking_effort`：`MYCLI_THINKING_EFFORT` > `MYCLI_REASONING_EFFORT` > 项目配置 > 用户配置 > 默认值 `medium`
- `compression_threshold_tokens`：`MYCLI_COMPRESSION_THRESHOLD_TOKENS` > 项目配置 > 用户配置 > 默认值 `8000`
- `recent_message_count`：`MYCLI_RECENT_MESSAGE_COUNT` > 项目配置 > 用户配置 > 默认值 `6`

## Model Providers

`mycli` 通过 provider 和 protocol 组合来解析模型访问方式：

```toml
provider = "openai"
protocol = "responses"
```

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

`legacy_chat` 不是支持的协议名，请使用 `chat_completions`。

### Qwen

Qwen 使用 DashScope OpenAI-compatible endpoint，默认走 `responses` 协议：

```bash
export MYCLI_API_KEY="your-qwen-key"
export MYCLI_PROVIDER="qwen"
export MYCLI_BASE_URL="https://dashscope.aliyuncs.com/compatible-mode/v1"
export MYCLI_MODEL="qwen3.6-plus"
export MYCLI_PROTOCOL="responses"
uv run mycli --session qwen-demo
```

也可以写入配置文件：

```toml
provider = "qwen"
protocol = "responses"
model = "qwen3.6-plus"
api_base_url = "https://dashscope.aliyuncs.com/compatible-mode/v1"
```

如果没有显式配置 `provider`，`mycli` 会从 `dashscope.aliyuncs.com` 自动推断为 `qwen`。

### DeepSeek

DeepSeek 使用 OpenAI-compatible chat completions 协议：

```bash
export MYCLI_API_KEY="your-deepseek-key"
export MYCLI_PROVIDER="deepseek"
export MYCLI_BASE_URL="https://api.deepseek.com"
export MYCLI_MODEL="deepseek-v4-flash"
export MYCLI_PROTOCOL="chat_completions"
export MYCLI_THINKING_ENABLED="true"
uv run mycli --session deepseek-demo
```

也可以写入配置文件：

```toml
provider = "deepseek"
protocol = "chat_completions"
model = "deepseek-v4-flash"
api_base_url = "https://api.deepseek.com"
thinking_enabled = true
thinking_effort = "medium"
```

当 DeepSeek thinking mode 在工具循环中返回 provider-private `reasoning_content` 时，`mycli` 会默认完整展示为 `[activity] Thinking: ...`，同时把它保存为内部 metadata，并在工具结果 follow-up 请求里传回 DeepSeek。它不会作为 assistant 最终回答文本写入，但会进入 activity、trace、workspace log 和 session turn history，方便调试 DeepSeek 的工具调用推理链路。

对于不支持 thinking metadata 的 provider，可以关闭 thinking：

```toml
thinking_enabled = false
```

### Anthropic

Anthropic 使用原生 Messages API，不走 OpenAI-compatible shim：

```bash
export MYCLI_API_KEY="your-anthropic-key"
export MYCLI_PROVIDER="anthropic"
export MYCLI_BASE_URL="https://api.anthropic.com"
export MYCLI_MODEL="claude-sonnet-4-6"
export MYCLI_PROTOCOL="anthropic_messages"
export MYCLI_THINKING_ENABLED="true"
export MYCLI_THINKING_EFFORT="medium"
uv run mycli --session anthropic-demo
```

也可以写入配置文件：

```toml
provider = "anthropic"
protocol = "anthropic_messages"
model = "claude-sonnet-4-6"
api_base_url = "https://api.anthropic.com"
api_key = "your-anthropic-key"
max_output_tokens = 4096
thinking_enabled = true
thinking_effort = "medium"
```

如果没有显式配置 `provider`，`mycli` 会从 `anthropic.com` 自动推断为 `anthropic`。开启 thinking 时，`mycli` 会把 `thinking_effort` 映射为 Anthropic `budget_tokens`，并要求该预算小于 `max_output_tokens`；如果你使用 `high` 或 `xhigh`，需要相应提高 `max_output_tokens`。

## 直接上手示例

启动后会进入交互模式：

```text
> 请先分析这个仓库的入口和主要模块
> 帮我查找所有包含 OpenAIChatClient 的文件
> 把 README 补成中文的快速上手说明
```

如果 Agent 需要执行需要用户决策的风险操作，会先展示操作信息和数字选项：

```text
[decision] 发现需要确认的操作：
[decision] Tool: run_shell
[decision] Preview: git push origin main
[decision] Reason: publish branch
[1] 仅本次允许
[2] 拒绝
[3] 本次会话内始终允许同类命令
> 1
[decision] approved
Approved run_shell: ...
```

注：英文提示文案（例如 “A risky action is waiting for your decision...”）可能在同一轮输出中出现，也可能在后续交互中出现，不保证紧跟在选项后面。

## 当前可用控制命令

- `/help`：查看帮助
- `/skill`、`/skills`：查看当前可用 skills
- `/memory`：查看已保存的偏好、项目记忆和近期 session 摘要
- `/plan`：查看当前 session 的计划状态
- `/trace`：查看当前 session 最近的 runtime trace 事件
- `/tools`：查看当前可用工具
- `/session`：查看当前 session 概况
- `/sessions`：查看当前 workspace 最近的 session 列表
- `/quit`：退出 CLI

## 工具与安全模型

当前内置工具：

- `create_file`
- `mkdir`
- `move_path`
- `delete_path`
- `list_directory`
- `read_file`
- `read_file_range`
- `search_text`
- `git_status`
- `git_diff`
- `git_log`
- `append_file`
- `replace_in_file`
- `edit_file`
- `run_shell`
- `update_plan`

当前风险分级：

- 低风险：`list_directory`、`read_file`、`read_file_range`、`search_text`、`git_status`、`git_diff`、`git_log`
- 中风险：`create_file`、`mkdir`、`move_path`、`delete_path`、`append_file`、`replace_in_file`、`edit_file`
- 高风险：`run_shell`

当前默认行为：

- 中风险编辑会自动执行
- 工作区内的常规安全操作会自动执行
- 需要决策的风险操作会展示 `1/2/3` 选项
- `3` 表示“本次会话内始终允许同类命令”，后续命中同一命令模式时会自动放行
- 当存在待决策动作时，普通输入会被拦下，直到你输入有效选项

## Skills 与记忆

内置 skills 位于：

- `src/mycli/prompts/skills/code-review.md`
- `src/mycli/prompts/skills/repository-analysis.md`

用户自定义 skills 放在：

- `~/.mycli/skills/*.md`

内置工具包括：

- `list_directory`：列出 workspace 相对目录中的文件与目录
- `read_file`：读取整个 UTF-8 文本文件
- `read_file_range`：读取文件的指定行区间
- `search_text`：进行类似 `rg` 的关键词搜索，支持 `path`、`glob`、`case_sensitive`、`max_matches`
- `append_file`：向文本文件末尾追加内容，父目录存在时可自动创建文件
- `replace_in_file`：在文本文件内做精确字符串替换，并可约束命中次数
- `edit_file`：整文件覆盖写入，作为专用编辑工具之外的兜底
- `run_shell`：结构化 shell 执行兜底工具
- `update_plan`：更新当前任务计划

## Sessions and Persistence

`mycli` 现在使用全局 SQLite 数据库保存 session 状态：

- Session 数据库：`~/.mycli/sessions.db`
- 指定 session：`uv run mycli --session demo`
- 查看当前 session：`/session`
- 查看当前 workspace 最近的 sessions：`/sessions`

SQLite session store 当前会持久化：

- conversation messages
- structured history items
- context baselines
- turn rollouts 与 continuation state
- pending decisions 与 suspended turns
- plan state
- per-session summaries

Legacy JSON session 文件 `~/.mycli/sessions/*.json` 已不再作为 runtime 主链的一部分。

记忆与文件位置：

- 用户偏好：`~/.mycli/preferences.json`
- Session 持久化：`~/.mycli/sessions.db`
- 项目记忆：`<workspace>/.mycli/project_memory.json`

## 开发命令

```bash
uv run pytest -q
uv run ruff check .
uv run mypy src
```

## 已知限制

- OpenAI 主路径默认请求 `POST /responses`，不支持 Responses API 的 provider 需要配置 `protocol = "chat_completions"`。
- `chat_completions` 兼容模式依赖 provider 的 OpenAI-compatible 行为，工具调用和 thinking metadata 的一致性取决于 provider 支持程度。
- 当前上下文窗口使用的是轻量级近似 token 估算与压缩摘要，不是 provider 原生 tokenizer。
- 当前版本重点是把 Agent 骨架跑通，不是完整复刻 Claude Code 或 Codex 的全部交互能力。
