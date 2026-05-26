# mycli vs Claude Code 差距清单

> 逐子系统对比。mark=✅ mycli已有 / ⚠️ 有骨架但未完成 / ❌ 缺失。

## 当前状态

本清单最初写于 P0 之前。此后已完成三批：

- P0 上下文稳定化：13K L4 buffer、reactive compact、L4 recent-file rehydration、L4 TEXT ONLY prompt guard、provider input token 统计与 session rebind 恢复。
- P1 工具安全与可观测性：`/context`、`/usage`、Bash safety 第一批、专用工具 reroute、Read snapshot、Edit pre-read/stale snapshot/no-op/size/secret-like guard。
- P2 capability pack：chat-completions/Anthropic provider stream、BashOutput + `/bashes`、session file history + `/changes`、permission precedence v1、CLI diff activity rendering。
- P3 sub-agent follow-up：child transcript sidechain、`/subagents <child_session_id>` inspection、显式 in-process background `Task` mode、background concurrency cap、model request lock、sidechain write lock、shutdown failed-state cleanup。
- P4 agent loop recovery：provider failure taxonomy、retry backoff evidence、explicit fallback model、configurable output token recovery、loop-boundary heartbeat、interrupted stop reason。
- P5 CLI experience：line-oriented statusline/context%、view modes、workspace `@path` autocomplete、diff folding、`/status` 与 `/view`。
- P6 TUI shell：Textual full-screen shell、Claude-like transcript、bottom workspace/model/context status、slash/@path suggestions、temporary overlays、plain-mode fallback。

当前决策：

- Microcompact 主动改写历史会影响 provider prompt cache hit，近期暂缓；保留 `ContextWindowAnalyzer` 作为观测面。
- MCP defer loading 先放一批，不进入下一轮优先级。
- `sed` 不做 Bash -> Edit 自动 reroute；P1 只 reroute `cat/head/tail -> Read`、`grep/rg -> Grep`、`ls -> LS`、简单 `find -> Glob`。

## 1. 上下文管理

| 序号 | 特性 | 状态 | Claude Code 细节 | mycli 现状 |
|---|---|---|---|---|
| 1.1 | L0（预判是否该跑工具） | ❌ | 工具执行前评估预期输出大小，选择不跑大输出工具 | 无 |
| 1.2 | L1 工具结果截断 | ✅ | 按工具类型差异化上限 | ToolResultBudget 已实现 + append_only guard |
| 1.3 | L2/L3 中间层压缩 | ⚠️ | Microcompact 双路径（热缓 cache_edits / 冷缓本地改） | 仅观测，不主动改写历史；为保护 cache hit 近期暂缓 |
| 1.4 | L4 LLM 摘要 | ⚠️ | Fork 子 agent，9段summary，复水(rehydrate) | 真实 LLM 摘要、summary model 配置、禁用 tools/thinking、recent-file rehydration 已完成；缺 Claude 式 fork/9段结构 |
| 1.5 | L4 compact prompt 反工具调用 | ✅ | "CRITICAL: Respond with TEXT ONLY. Do NOT call any tools." | summary prompt 已加 TEXT ONLY / no tools / no JSON/XML / do not continue task 约束 |
| 1.6 | Context Collapse（L4.5） | ❌ | 读时投影，可逆，存于 collapse store | 无 |
| 1.7 | Reactive Compact | ✅ | API 返回 prompt_too_long 时应急压缩 | provider context window exceeded 后同 turn 最多 reactive compact 一次并 retry |
| 1.8 | tool_result 三分区 | ⚠️ | mustReapply / frozen / fresh | 只有 append_only guard，缺 mustReapply |
| 1.9 | 缓存稳定 14 个 breakpoint | ❌ | sticky latch 防止 mode switch 破缓存 | 依赖 frozen_fingerprint |
| 1.10 | Beta header latching | ❌ | feature flag mid-session 不变 | 无 |
| 1.11 | 预热请求 | ❌ | 真正干活前发 2-3 次"空"请求填 KV cache | 无 |
| 1.12 | defer_loading MCP tools | ❌ | stub 注册，完整 schema 首次使用才加载 | 工具 schema 全量注入；MCP defer 近期暂缓 |
| 1.13 | 13K auto-compact buffer | ✅ | 压缩操作本身的预留空间 | L4 触发阈值已纳入 `compaction_l4_buffer_tokens`，默认 13K |
| 1.14 | Compaction 断路器 | ⚠️ | 3 次连续失败停止，经 telemetry 调优（省 250K API calls/day） | 断路器在，未经调优 |
| 1.15 | /context 实时可视化 | ⚠️ | 彩色条形图 + 分类占比 | 文本版 `/context` 已有；P5 statusline 增加 context%；未做 rich/TUI 条形图 |
| 1.16 | /usage 会话费用追踪 | ✅ | 实时 token 费用 | `/usage` 已按 session 汇总 provider usage/cache tokens；价格未配置时显示 unavailable |
| 1.17 | Microcompact 时间路径 | ❌ | 缓存过期(>60min)后本地清旧 tool_result(keep recent 5) | 近期不做，避免主动改写历史破坏 cache hit |

## 2. Agent Loop & 错误恢复

| 序号 | 特性 | 状态 | Claude Code 细节 | mycli 现状 |
|---|---|---|---|---|
| 2.1 | 7个Continue点 | ⚠️ | PTL drain / reactive compact / OTK escalate / OTK recovery×3 / model fallback / Ctrl+C / stop hook | reactive compact retry、transport/rate-limit backoff evidence、configurable OTK recovery、explicit fallback model、Ctrl+C interrupted stop reason、loop-boundary heartbeat 已有；stop hook 与 Claude 式完整 continue lattice 仍缺 |
| 2.2 | AsyncGenerator 流式 + 反压 | ❌ | generator.return() 级联关闭所有嵌套 | 同步阻塞 |
| 2.3 | 流式工具执行 | ❌ | SSE 收到 content_block_stop 立刻派发，不等待整个响应 | 收到完整响应后执行 |
| 2.4 | hasAttemptedReactiveCompact 防死循环 | ✅ | 单布尔值防 compact→retry→compact 死循环 | reactive compact 同 turn 最多一次 |
| 2.5 | OTK 三层升级 | ⚠️ | 8K→64K 静默升级，后续 recovery message，最后才 surface error | output token limit taxonomy + configurable escalation/retry + restore default max output tokens 已有；不是 Claude 固定三层策略 |
| 2.6 | 529 fallback 机制 | ⚠️ | 3 次 529 → Opus→Sonnet 降级 | 529/provider overload 已分类为 retryable，retry budget exhausted 后可尝试显式 `fallback_model`；不做自动 Opus/Sonnet 选择 |
| 2.7 | 401 OAuth token 刷新 + 重试 | ⚠️ | 401 → refresh → retry once | 401/403 已分类为 `auth_error` / `AUTH_FAILED`，便于上层 hook；尚无 OAuth refresh 实现 |
| 2.8 | Persistent mode heartbeat | ⚠️ | 30s heartbeat yield "I'm still here" 防 K8s kill | loop-boundary heartbeat progress/stream event 已有且不进模型上下文；blocking HTTP in-flight timer 仍缺 |
| 2.9 | cch attestation | ❌ | Bun/Zig 层客户端认证，JS 代码绕不过 | 无 |

## 3. 工具执行

| 序号 | 特性 | 状态 | Claude Code 细节 | mycli 现状 |
|---|---|---|---|---|
| 3.1 | Bash 安全 23 项检查 | ⚠️ | 元字符注入、Unicode 混淆、IFS 变量、brace expansion、zsh-specific 黑名单 | P1 第一批已覆盖 rm 根目录、fork bomb、Unicode 控制、curl/wget pipe shell、sudo/dd/递归权限/重定向等；未达 Claude 全量 23 项 |
| 3.2 | Bash 禁止命令重定向 | ⚠️ | cat→Read, grep→Grep, find→Glob, sed→Edit, ls→LS | P1 已做 cat/head/tail→Read、grep/rg→Grep、ls→LS、简单 find→Glob；sed 因语义歧义不自动 reroute |
| 3.3 | Bash 后台运行 + 管理 | ⚠️ | BashOutput + KillShell 三工具生命周期，`/bashes` 命令 | P2 已有共享 shell registry、BashOutput、KillShell、`/bashes`；缺 PTY stdin、跨进程恢复、长期清理策略 |
| 3.4 | YOLO classifier | ❌ | 独立 Claude 实例评估 tool call 安全性 | 无 |
| 3.5 | Fake tools | ❌ | review_file 占位符——强制模型在写入前停顿 | 无 |
| 3.6 | 并行工具执行 | ✅ | 连续 safe 工具 → parallel batch，unsafe 截断 | CONCURRENCY_SAFE_TOOLS + ThreadPoolExecutor |
| 3.7 | 编辑乐观并发控制 | ✅ | timestamp check + old_string check，先写者赢 | EditTool 要求 Read snapshot，并校验 sha256/mtime/size；变更后拒绝写入 |
| 3.8 | 文件历史 | ⚠️ | fileHistoryTrackEdit / makeSnapshot / rewind | P2 已有 session-aware snapshot、`/changes` 列表、`/undo` rewind；缺多 snapshot 事务回滚和更完整 history UI |
| 3.9 | Edit 14 步校验管道 | ⚠️ | secret detection、no-op、文件>1GiB OOM 保护、pre-read要求 | P1 已有 pre-read/stale snapshot/no-op/size/secret-like 静态 guard；非完整 14 步 |
| 3.10 | Write 自动创建父目录 | ✅ | parent.mkdir(parents=True) | 已实现 |

## 4. 权限 & 安全

| 序号 | 特性 | 状态 | Claude Code 细节 | mycli 现状 |
|---|---|---|---|---|
| 4.1 | 6 层权限防线 | ⚠️ | useCanUseTool.tsx | P2 v1 已有 deny 优先于 session allowance、workspace write boundary hook、SafetyPolicy + ApprovalService + Bash analyzer；仍不是完整 6 层权限模型 |
| 4.2 | 权限继承链 | ❌ | 父→子 agent 不可降级 | 无 |
| 4.3 | Sandbox | ❌ | Bubblewrap(linux) / Seatbelt(macOS) / Windows Restricted Tokens | 无 |
| 4.4 | Sandbox 域名过滤 | ❌ | allowedDomains / deniedDomains + allowManagedDomainsOnly | 无 |
| 4.5 | 注入防护 | ❌ | 反蒸馏陷阱 + frustration regex | 无 |
| 4.6 | 脱敏 | ⚠️ | 无内置，靠 CLI 不输出 | Bash preview 对 token/password/key 等参数做静态 redaction；未形成全局脱敏层 |

## 5. 记忆 & 持久化

| 序号 | 特性 | 状态 | Claude Code 细节 | mycli 现状 |
|---|---|---|---|---|
| 5.1 | autoDream | ❌ | 后台 24h/5 session 记忆整合 | 无 |
| 5.2 | KAIROS daemon | ❌ | 24/7 后台待命，订阅 GitHub webhook | 无 |
| 5.3 | Session 恢复 | ⚠️ | JSONL 回放 + Recall/claude-baton 第三方工具 | SQLite 持久化 + `/resume` 已有；缺完整 JSONL sidechain/第三方 recall |
| 5.4 | Session 分叉 | ⚠️ | /fork 创建分支 + prompt cache 共享 | `/fork` 已有；缺 prompt cache 共享策略 |
| 5.5 | 三层记忆 | ⚠️ | 语义/情节/工作记忆 + embedding 检索 | 子字符串匹配 |
| 5.6 | CLAUDE.md 逐级合并 | ❌ | 全局 → 项目 → 本地，支持 @path 导入 | 无 |
| 5.7 | autoMemory | ❌ | /memory 自动写入， compaction 保留 | 无 |
| 5.8 | Transcript sidechain | ⚠️ | 子 agent 对话独立记录 | Child sub-agent history 已按 child session id 持久化并可用 `/subagents <child_session_id>` 检查；不是 Claude-style 完整 JSONL sidechain |

## 6. Prompt 工程

| 序号 | 特性 | 状态 | Claude Code 细节 | mycli 现状 |
|---|---|---|---|---|
| 6.1 | `__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__` | ⚠️ | 静态/动态分割 → Blake2b hash 全局缓存 | 靠 Fragment.cache_policy / frozen fingerprint，未实现 Claude 式动态边界 |
| 6.2 | 反蒸馏陷阱 | ❌ | 注入虚假 tool definition 毒化训练数据 | 无 |
| 6.3 | frustration regex | ❌ | 自我监控 refusal 语言 → meta-reasoning layer | 无 |
| 6.4 | system prompt 分层缓存 | ❌ | 静态→global scope; 动态→org/ephemeral scope | 无 |
| 6.5 | 模型切换缓存隔离 | ❌ | Opus cache ≠ Sonnet cache; 切换→全量重写 | 无机制 |

## 7. Sub-agent & 多代理

| 序号 | 特性 | 状态 | Claude Code 细节 | mycli 现状 |
|---|---|---|---|---|
| 7.1 | 5 种 agent 模式 | ⚠️ | sync / async / fork / worktree / remote | P3 覆盖 sync in-process `Task`；P3 follow-up 增加显式 in-process background mode；fork/worktree/remote 仍开放 |
| 7.2 | Fork 缓存共享 | ❌ | fork agent 复用父 cache 前缀，1/10 价格 | 仍开放；P3 明确延后到 P4，因为需要字节级一致 prompt 前缀验证 |
| 7.3 | 权限隔离 | ⚠️ | 子 agent 权限最小化，不能绕过父权限 | P3 覆盖工具 scope denylist 和无 nested approval UI；OS/process sandbox 仍开放 |
| 7.4 | 工具集隔离 | ✅ | 子 agent 独立工具子集 | P3 通过 parent exposure / requested / profile / denylist / policy resolver 落地 |
| 7.5 | Context 隔离 | ✅ | 单通道 prompt + file handoff | P3 父上下文只接收 final XML report；async notification 仍开放 |
| 7.6 | Agent Teams | ❌ | 共享 task list + 依赖图 + 并行 worktree | 无 |
| 7.7 | /batch 命令 | ❌ | 采访→扇出到数百个 worktree 隔离 agent | 无 |

## 8. MCP & 扩展性

| 序号 | 特性 | 状态 | Claude Code 细节 | mycli 现状 |
|---|---|---|---|---|
| 8.1 | MCP 客户端 | ⚠️ | JSON-RPC stdio/HTTP, tools/resources/prompts | 已有 MCP client/tool adapter/provider 基础；权限、defer loading、resources/prompts 完整度不足 |
| 8.2 | MCP server 权限管理 | ❌ | allowedMcpServers / deniedMcpServers | 无 |
| 8.3 | Hooks 系统 | ⚠️ | 8 个事件类型 + command/prompt/agent/http/mcp_tool 5种 hook | 框架在(types/manager/builtin)，集成不全 |
| 8.4 | Plugin/Marketplace 系统 | ❌ | PluginMarketplace + extraKnownMarketplaces | 无 |
| 8.5 | Skills 三层渐进披露 | ⚠️ | L1 元数据→L2 body→L3 资源 | 两层(缺 L3)，body 已对齐 tool_result 模式 |
| 8.6 | 85+ Slash Commands | ⚠️ | Git、code review、memory、multi-agent 编排 | 已有 `/context`、`/usage`、session/approval/memory 等基础命令；远少于 Claude Code |

## 9. CLI 体验

| 序号 | 特性 | 状态 | Claude Code 细节 | mycli 现状 |
|---|---|---|---|---|
| 9.1 | 流式输出 | ⚠️ | SSE token-by-token 渲染 | P2 已有 chat-completions/Anthropic provider token/event 流式输出和 `[stream]` CLI 渲染；Responses 路径和 async backpressure 仍缺 |
| 9.2 | Diff 展示 | ⚠️ | 带行号 diff | P2 已把 Edit diff 提升到 turn item；P5 增加编号 diff、折叠省略计数和 rich syntax helper；P6 TUI transcript 复用折叠摘要，缺交互式 `/diff` overlay |
| 9.3 | 语法高亮 | ⚠️ | pygments/rich | P6 final answer 使用 Rich Markdown 渲染并支持 fenced code；仍不是完整 editor-grade highlighting |
| 9.4 | spinner 可定制 | ❌ | spinnerVerbs / spinnerTips / spinnerTipsOverride | 无 |
| 9.5 | voice mode | ❌ | hold-to-talk 语音输入 | 无 |
| 9.6 | statusLine 可定制 | ⚠️ | command 类型，可显示 context% | P5 有内置文本 statusline/context%；P6 TUI bottom status 显示 workspace/model/context used-total tokens；还不是 Claude 式可定制 command |
| 9.7 | viewMode | ⚠️ | default/verbose/focus | P5 有 default/verbose/focus 渲染模式；P6 TUI 消费现有 view state；不是 Claude Code 完整模式体系 |
| 9.8 | editorMode | ❌ | normal/vim | 禅模式输入 |
| 9.9 | 自动补全 | ⚠️ | 文件路径 @ 补全 | P5 有 workspace `@path` readline 补全；P6 TUI 增加 slash prefix popup、arrow selection、Tab accept 与 `@path` popup；仍非通用补全框架 |
| 9.10 | /rename 终端标题 | ❌ | 自动或手动更新终端 tab 标题 | 无 |

## 10. 生产基础设施

| 序号 | 特性 | 状态 | Claude Code 细节 | mycli 现状 |
|---|---|---|---|---|
| 10.1 | Telemetry | ⚠️ | 838 event types(tengu_*)，结构化日志 | 有 JSONL trace/observability metrics；没有 Claude 级事件体系 |
| 10.2 | Undercover mode | ❌ | 剥离 AI 痕迹：提交中不出现 "Claude Code" | 无 |
| 10.3 | 44 个未发布 feature flags | ❌ | GrowthBook 动态开关 | 无 |
| 10.4 | DO_NOT_TRACK 忽略 | ❌ | 使用 CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC 替代 | 无 |
| 10.5 | 后台 Haiku 调用 ×40 | ❌ | 终端标题、bash 前缀提取、auto-memory、compact 等 | 无 |
| 10.6 | Managed settings | ❌ | MDM/Group Policy 企业管控 | 无 |
| 10.7 | Cleanup 自动清理 | ❌ | 30 天后自动删除旧 transcript | 无 |

---

## 汇总

| 类别 | 总数 | ✅ 有 | ⚠️ 半 | ❌ 缺 |
|---|---|---|---|---|
| 上下文管理 | 17 | 5 | 5 | 7 |
| Agent Loop | 9 | 1 | 1 | 7 |
| 工具执行 | 10 | 3 | 5 | 2 |
| 权限 & 安全 | 6 | 0 | 2 | 4 |
| 记忆 & 持久化 | 8 | 0 | 3 | 5 |
| Prompt 工程 | 5 | 0 | 1 | 4 |
| Sub-agent | 7 | 2 | 2 | 3 |
| MCP & 扩展 | 6 | 0 | 4 | 2 |
| CLI 体验 | 10 | 0 | 2 | 8 |
| 生产基础设施 | 7 | 0 | 1 | 6 |
| **总计** | **85** | **9** | **27** | **49** |

**下一步候选（MCP 与 Microcompact 暂缓后）：**

1. Sub-agent 后续增强：补 async mailbox、fork cache sharing、worktree/remote agent、coordinator/team 与 `/batch`。
2. CLI experience：statusline/context%、路径补全、viewMode、交互式 diff。
3. Agent loop recovery：stop hook、OAuth refresh、blocking HTTP in-flight heartbeat、Claude 式完整 continue lattice。
4. Prompt cache 稳定性：动态边界、beta header latch、模型切换缓存隔离。
5. MCP resources/prompts/permission 管理：defer loading 继续暂缓，先补可观测与权限边界。
