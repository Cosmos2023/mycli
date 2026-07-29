# mycli 与 Hermes-agent 差距分析

本文档基于 `feature/mycli-tool-foundation-hardening` 分支，对照本仓库内
`hermes-agent/` 源码，整理 mycli 当前距离 Hermes-agent 较远的能力面。

对比口径：

- Hermes-agent 只作为语义、产品成熟度和工程完整度参考。
- 不以复制 Hermes 代码为目标。
- 重点判断 mycli 下一阶段应该优先补哪些“底座能力”和“产品化能力”。

## 0. 总体判断

mycli 现在已经具备本地 coding agent 的核心骨架：runtime、session、trace、
doctor、Node TUI gateway、基础工具、approval/clarify/tool lifecycle 等底座
能力已经开始成形。

但 Hermes-agent 已经是完整工具平台和多入口 agent 产品。二者差距主要不在
某一个文件或某一个工具，而在这些方面：

- 工具生态规模和成熟度
- 多执行环境与安全沙箱
- 插件、MCP、skills、subagent、多 agent 产品化
- 多平台 gateway 和 ACP 对外协议
- CLI 管理面、profiles、provider/auth 管理
- 观测、诊断、安全审计、发布和测试矩阵

粗略规模证据：

| 项目 | Hermes-agent | mycli 当前分支 |
| --- | ---: | ---: |
| Python 文件 | 约 1958 | 约 404 |
| 测试文件 `test_*.py` | 约 1258 | 约 121 |
| 工具测试文件 | 约 231 | 约 10 |
| 静态注册工具数 | 约 66 | 约 19 |
| GitHub workflow | 约 16 | 0 |
| `SKILL.md` 数量 | 约 82 | 约 21，且多为开发工作流 |

这些数字不是质量判断本身，但能说明 Hermes-agent 已经覆盖了大量真实产品场景，
而 mycli 仍处在底座和核心能力打磨阶段。

## 1. Tools 体系差距

### Hermes-agent 现状

Hermes-agent 的工具通过 `tools.registry.register(...)` 自注册。每个工具声明：

- tool name
- toolset
- schema
- handler
- availability check
- result size limit
- emoji/display metadata
- dynamic schema override

核心 toolsets 包括：

- `file`
- `terminal`
- `web`
- `browser`
- `vision`
- `image_gen`
- `skills`
- `memory`
- `session_search`
- `clarify`
- `code_execution`
- `delegation`
- `cronjob`
- `messaging`
- `computer_use`
- `kanban`
- MCP 和插件注册工具

### mycli 现状

mycli 当前工具主要由 `default_tools()` 手工装配，核心包括：

- `Read`
- `Edit`
- `Write`
- `Grep`
- `Glob`
- `LS`
- `Bash`
- `BashOutput`
- `KillShell`
- `WebSearch`
- `WebFetch`
- `Lint`
- `AskUserQuestion`
- `Plan`
- `enter_plan_mode`
- `exit_plan_mode`
- `Task`
- `Skill`

mycli 已经有 contributed tool / MCP foundation，但还没有完整产品化的
toolset registry、availability check、enable/disable、plugin 动态发现与冲突策略。

### 差距

| 能力 | 差距 |
| --- | --- |
| 工具注册 | mycli 偏静态，Hermes 是自注册和动态 registry |
| Toolset | mycli 缺完整 toolset enable/disable/alias/distribution |
| 动态工具 | mycli 有基础，但没有 Hermes 的插件/MCP 动态刷新成熟度 |
| 工具测试 | mycli 覆盖远少于 Hermes |
| 工具安全 | mycli 有 approval/hook 基础，但具体工具级策略较弱 |

### 建议

优先补 `ToolsetRegistry` 和工具 manifest：

1. 本地工具按 toolset 分组。
2. 支持 enable/disable。
3. 支持 availability check。
4. 支持 contributed/MCP/plugin 工具统一注册。
5. doctor 能检查工具注册冲突、缺失依赖和 schema drift。

## 2. File Tools 差距

### Hermes-agent 现状

Hermes 文件工具是完整闭环：

- `read_file`
- `write_file`
- `patch`
- `search_files`

具备：

- line-numbered read
- offset/limit pagination
- binary/device path guard
- internal credential/path guard
- 大文件字符上限
- secret redaction
- read dedup
- 多次重复读取 hard block
- read/write/patch staleness 检测
- cross-agent file state registry
- per-path lock
- patch fuzzy matching
- patch failure escalation
- V4A patch
- write/patch 后语法检查和 diff
- cross-profile 写入保护

### mycli 现状

mycli 已有：

- text/CSV/TSV `Read`
- `offset` / `limit`
- CSV/TSV model-visible content
- CSV/TSV numeric profile
- duplicate read hint
- `Edit` snapshot guard
- `Write` backup
- `Grep` / `Glob` / `LS`
- `Lint`

### 差距

| 能力 | mycli 缺口 |
| --- | --- |
| patch 工具 | 仍以 `Edit` old/new string 为主，没有 Hermes-like patch tool |
| fuzzy patch | 缺多策略 fuzzy matching |
| patch 失败恢复 | 缺失败计数、did-you-mean、重读/整文件写入建议 |
| 写入诊断 | 有基础 lint/diagnostics，但没有 Hermes 的完整写后检查闭环 |
| 文件状态 | 缺跨 subagent 文件状态 registry 和 per-path lock |
| 安全路径 | 缺设备路径、内部凭据路径、跨 profile 路径完整 guard |
| 大文件 | 有 token/line 限制基础，但没有 Hermes 那种 read output guard 成熟度 |

### 建议

下一刀高优先级做 File Tools Hardening：

1. 新增 `Patch` 工具，支持 replace mode 和 patch mode。
2. `Write/Edit/Patch` 统一 diff、diagnostics、staleness、file history。
3. 加设备路径、敏感路径、binary guard。
4. 加 patch failure tracking 和 actionable hints。
5. 加工具级 trace/doctor 汇总。

## 3. Terminal / Sandbox 差距

### Hermes-agent 现状

Hermes `terminal` 支持多后端：

- local
- Docker
- Modal
- SSH
- Singularity
- Daytona

并且支持：

- background process
- process registry
- interrupt cleanup
- foreground timeout cap
- sudo callback/password scope
- compound background command rewrite
- environment lifecycle
- idle cleanup
- container/persistent filesystem 配置
- cloud sandbox fallback

### mycli 现状

mycli 当前：

- `Bash` 本地 subprocess
- `BashOutput`
- `KillShell`
- shell safety / approval 基础
- background shell registry
- dedicated tool reroute

### 差距

| 能力 | mycli 缺口 |
| --- | --- |
| 多后端 | 无 Docker/Modal/SSH/云沙箱 |
| 进程生命周期 | 有基础 background，但不够完整 |
| interrupt cleanup | runtime 有 interrupt 基础，shell 子进程治理仍弱 |
| sudo/权限 | 无 Hermes-like sudo prompt/cache/scope |
| shell guard | 有基础，缺 Hermes 的复杂命令治理和测试矩阵 |
| 环境隔离 | 本地执行为主，安全和复现弱 |

### 建议

优先做 Terminal Foundation，而不是马上全量上云沙箱：

1. 明确 foreground/background 状态机。
2. shell output cap、timeout、interrupt cleanup。
3. process registry 持久诊断。
4. Docker backend 作为第一个 sandbox backend。
5. doctor 检查 Docker/shell/backend 可用性。

## 4. Runtime / Agent Loop 差距

### Hermes-agent 现状

Hermes agent runtime 覆盖：

- 多 provider adapter
- context compression
- context engine
- prompt caching
- credential pool
- rate limit tracker
- retry utils
- iteration budget
- tool guardrails
- tool result classification
- trajectory
- background review
- memory manager
- skill preprocessing
- shell hooks
- stream diagnostics
- error classifier

### mycli 现状

mycli runtime 已经补了不少底座：

- turn lifecycle
- session/resume/fork/compaction foundation
- runtime event contract
- tool lifecycle events
- approval/clarify
- trace/doctor/logs
- request shape diagnostics
- Node TUI gateway contract

### 差距

| 能力 | mycli 缺口 |
| --- | --- |
| prompt caching | 有 request-shape 诊断，但产品化 cache 策略弱 |
| context engine | 有 context manager，但缺 Hermes-like context engine/plugin |
| error classifier | 有错误收束，分类和恢复策略仍薄 |
| rate/usage | 缺完整 account usage、pricing、rate guard |
| background review | 缺后台审查/长任务复核 |
| tool result classification | 有 formatter，缺系统性分类策略 |

### 建议

runtime 下一阶段不应再只补事件字段，应补“任务完成质量”：

1. error taxonomy 到恢复策略。
2. iteration budget 和 loop recovery。
3. context compression 质量评估。
4. tool result classification。
5. usage/rate diagnostics。

## 5. MCP / Plugin / Extension 差距

### Hermes-agent 现状

Hermes 有：

- MCP dynamic discovery
- MCP OAuth
- MCP SSE transport
- MCP circuit breaker
- plugin discovery
- plugin hook
- plugin dashboard/auth
- model provider plugin
- browser/web/image/video/memory/security plugins
- plugin registered tools

### mycli 现状

mycli 有：

- MCP client/provider/tool adapter 基础
- contributed tool descriptor/registry 基础
- runtime contract manifest 基础

### 差距

| 能力 | mycli 缺口 |
| --- | --- |
| MCP 产品化 | client 有基础，但 OAuth、dynamic discovery、reconnect、tool lifecycle 不完整 |
| Plugin manifest | 缺统一插件 manifest/install/enable/disable |
| Plugin hooks | 有 hook manager，但不是完整插件生态 |
| Provider plugins | 缺 model provider plugin 产品化 |
| 安全边界 | 缺插件权限、隔离、冲突处理成熟策略 |

### 建议

先补 Extension Foundation：

1. plugin manifest schema。
2. plugin discovery/install/enable/disable。
3. contributed tools 与 plugin/MCP 共用 registry。
4. doctor 检查插件和 MCP。
5. 再做 MCP OAuth / SSE / reconnect。

## 6. Skills 生态差距

### Hermes-agent 现状

Hermes 有大量内置和 optional skills，覆盖：

- software-development
- data-science
- research
- devops
- security
- media
- productivity
- smart-home
- social-media
- MCP
- domain-specific skills

并且有：

- `skills_list`
- `skill_view`
- `skill_manage`
- skill provenance
- skill guard
- skill sync
- size limit
- path traversal guard

### mycli 现状

mycli 有 `SkillTool` 和 skills domain/service 基础，但更多是能力入口，不是完整技能生态。

### 差距

| 能力 | mycli 缺口 |
| --- | --- |
| skills 数量 | 缺产品内置技能库 |
| skill 管理 | 缺完整 create/edit/delete/list/view/sync |
| provenance | 缺来源和信任记录 |
| safety | 缺 path traversal、大小限制、内容 guard |
| activation | 与 runtime/toolset 的联动仍不够产品化 |

### 建议

等 plugin/toolset 稳定后补：

1. skills manifest。
2. skill manager tool。
3. skill activation trace。
4. built-in skills 小集合。
5. skill safety tests。

## 7. Subagent / Multi-agent 差距

### Hermes-agent 现状

Hermes 有：

- `delegate_task`
- `mixture_of_agents`
- kanban toolset
- child context isolation
- toolset scope
- subagent timeout diagnostics
- multi-agent file staleness
- task heartbeat/block/unblock/comment/link

### mycli 现状

mycli 有：

- subagent domain/application foundation
- `TaskTool`
- subagent profiles
- tool scope 基础

### 差距

| 能力 | mycli 缺口 |
| --- | --- |
| delegate 产品化 | TaskTool 还不是 Hermes-like delegate_task |
| 并发协调 | 缺 kanban/heartbeat/blocking/task graph |
| 子任务隔离 | 有基础，缺完整上下文和文件冲突治理 |
| 诊断 | 缺 timeout、失败、handoff 可观察性 |
| toolset scope | 有雏形，缺真实任务验证 |

### 建议

先做一个最小闭环：

1. `Task` 升级为 `delegate_task` 风格。
2. 子 agent scoped tools。
3. 子任务 trace/summary。
4. timeout/cancel。
5. 文件 mutation 冲突诊断。

## 8. Browser / Web Automation 差距

### Hermes-agent 现状

Hermes 有完整 browser toolset：

- navigate
- snapshot
- click
- type
- scroll
- back
- press
- get_images
- vision
- console
- CDP
- dialog

### mycli 现状

mycli 只有：

- `WebSearch`
- `WebFetch`

### 差距

Hermes 能处理登录态网页、交互式页面、网页截图/视觉、console/debug。
mycli 当前只能搜索和抓取静态页面。

### 建议

中高优先级补：

1. browser session manager。
2. snapshot/click/type/scroll。
3. screenshot/vision 可选后补。
4. URL/SSRF safety。
5. browser scripted smoke。

## 9. 多模态 / 媒体 / Computer Use 差距

### Hermes-agent 现状

Hermes 有：

- `vision_analyze`
- `computer_use`
- `image_generate`
- `video_generate`
- `video_analyze`
- `text_to_speech`
- transcription

### mycli 现状

mycli 基本没有多模态产品线。

### 建议

这块不建议马上补，除非产品目标从 coding agent 转向通用个人助手。
优先级低于 file/terminal/toolset/plugin/subagent。

## 10. Multi-platform Gateway 差距

### Hermes-agent 现状

Hermes gateway 支持多平台：

- Telegram
- Discord
- Slack
- Email
- Matrix
- WhatsApp
- Feishu
- WeCom
- SMS
- Webhook
- Home Assistant
- Yuanbao

并且有 platform registry、delivery、pairing、status、memory monitor、
slash access、session hygiene 等配套。

### mycli 现状

mycli 目前主要是本地 CLI 和 Node TUI gateway。

### 差距

mycli 缺真实消息平台接入，也缺多平台 session/channel/topic 映射和权限模型。

### 建议

这块可后置。等 runtime/tools/plugin 稳定后，先做一个最小 HTTP/Webhook gateway，
再逐步接 Telegram/Slack 等。

## 11. ACP 差距

### Hermes-agent 现状

Hermes 有完整 `acp_adapter`：

- server
- session
- auth
- permissions
- edit approval
- event mapping
- tools bridge
- registry manifest

### mycli 现状

mycli runtime contract 为 ACP 做了部分铺垫，但没有 ACP adapter 产品化实现。

### 建议

ACP 依赖 runtime event contract、tool contract、approval/edit safety 稳定。
建议排在 toolset/plugin/MCP 之后。

## 12. CLI 管理面差距

### Hermes-agent 现状

Hermes CLI 覆盖：

- auth
- models/providers
- profiles
- plugins
- tools config
- gateway
- mcp
- cron
- doctor/logs/dump
- backup/migrate
- security audit
- portal/dashboard
- relaunch/runtime switch

### mycli 现状

mycli CLI 有：

- main/bootstrap/repl/rendering
- Python TUI
- Node TUI gateway
- doctor/logs/trace/session/eval 等基础命令

### 差距

mycli 的 CLI 更像开发者入口；Hermes 的 CLI 是完整产品管理面。

### 建议

中期补：

1. `mycli tools` 管理。
2. `mycli plugins` 管理。
3. `mycli mcp` 管理。
4. `mycli profiles` 管理。
5. `mycli doctor --strict` / `mycli doctor --json`。

## 13. Profiles / Provider / Auth 差距

### Hermes-agent 现状

Hermes 有：

- profile system
- provider profiles
- model catalog
- OAuth
- credential pool
- credential sources
- secret prompt
- fallback config
- model switch/runtime switch

### mycli 现状

mycli 有 provider config 和多 provider adapter，但 profile/auth/credential 管理仍轻量。

### 建议

如果 mycli 要长期使用，多 provider/profile 必须补：

1. profile schema。
2. credential storage/redaction。
3. provider availability doctor。
4. model catalog。
5. runtime profile switch。

## 14. Cron / 后台任务差距

Hermes 有 cron scheduler/jobs/tool，可创建、暂停、恢复、触发定时任务。
mycli 当前没有等价能力。

建议后置。个人助手方向有价值，coding agent 方向不是第一优先级。

## 15. Observability / Security / Diagnostics 差距

### Hermes-agent 现状

Hermes 有：

- agent/gateway logs
- stream diagnostics
- shutdown forensics
- memory monitor
- security audit
- tool output limits
- tool result storage
- credential file guard
- command guards
- plugin security guidance
- extensive doctor/status commands

### mycli 现状

mycli 已有：

- workspace/global logs 基础
- model events
- trace JSONL
- doctor
- tool execution diagnostics
- approval/clarify diagnostics
- runtime contract doctor

### 差距

mycli 最近补了很多底座，但 Hermes 的诊断覆盖更面向真实线上问题：
gateway、多平台、插件、沙箱、OAuth、provider、cron、browser、MCP 都有对应检查。

### 建议

继续把 doctor 从“本地 runtime 检查”扩展为：

1. tools/toolset health。
2. plugin/MCP health。
3. terminal backend health。
4. browser backend health。
5. provider/profile/auth health。
6. machine-readable JSON 输出。

## 16. 发布 / 安装 / 运维差距

Hermes 有：

- Dockerfile
- docker-compose
- Homebrew packaging
- Nix flake
- GitHub workflows
- release notes
- website/docs
- security policy

mycli 目前还是开发仓库形态，缺正式发布链。

建议后期补。能力未稳定前不要过早产品化 packaging。

## 17. 测试矩阵差距

Hermes 测试覆盖：

- gateway
- hermes_cli
- tools
- agent
- run_agent
- plugins
- cron
- ACP
- docker
- skills
- stress
- providers
- TUI gateway

mycli 当前测试主要集中在 unit，integration 较少，真实 eval 已开始建立但还不够系统。

建议：

1. 每补一个 Hermes parity 能力，都增加 unit + integration + real smoke。
2. 扩大聚焦的 smoke 与回归测试，覆盖工具、session、approval、subagent、browser。
3. Node TUI scripted smoke 保持常态化。
4. 引入 CI 后再扩大 full suite。

## 18. 推荐推进顺序

不要同时补所有差距。建议按底座收益排序：

### P0：先补会阻塞所有上层能力的底座

1. File tools hardening
2. Terminal foundation
3. Toolset registry / tool manifest
4. Tool diagnostics / doctor 扩展

### P1：补可扩展生态入口

5. Plugin/extension foundation
6. MCP productization
7. Skills manager foundation
8. Subagent/delegate foundation

### P2：补实战场景能力

9. Browser/web automation
10. Session search / memory tools
11. Provider/profile/auth 管理
12. Output/eval contract hardening

### P3：补产品外延

13. ACP adapter
14. Multi-platform gateway
15. Cron/background tasks
16. Multi-modal/media/computer-use
17. Packaging/website/release CI

## 19. 下一步建议

下一刀建议不要继续泛泛 audit，而是选一个完整闭环：

### 推荐切片 A：File + Patch Tools Hardening

目标：让 mycli 文件工具接近 Hermes coding agent 的实战可靠性。

范围：

- 新增 `Patch` 工具。
- `Edit/Write/Patch` 统一 diff 和 diagnostics。
- staleness / per-path lock / patch failure hint。
- binary/device/sensitive path guard。
- tests + real coding smoke。

### 推荐切片 B：Terminal Foundation

目标：把 Bash 从本地 subprocess 提升为可诊断、可中断、可扩展 backend 的终端工具。

范围：

- process registry 强化。
- foreground/background 状态机。
- timeout/output/interruption cleanup。
- shell approval 策略。
- doctor 检查。
- Docker backend 可作为后续子切片。

### 推荐切片 C：Toolset Registry Foundation

目标：为 MCP、plugins、skills、subagent tool scope 打统一地基。

范围：

- toolset schema。
- enable/disable。
- availability check。
- manifest。
- contributed/MCP/local tools 统一暴露。
- doctor + tests。

如果只选一个，建议先做 **A：File + Patch Tools Hardening**。它最直接提升
coding agent 成功率，也最容易用真实任务验证。
