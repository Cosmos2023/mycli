# mycli vs Claude Code 差距清单

> 逐子系统对比。mark=✅ mycli已有 / ⚠️ 有骨架但未完成 / ❌ 缺失。

## 当前执行批次

已批准的第一批不覆盖全部 85 项，只聚焦 P0 上下文稳定化：13K auto-compact buffer、reactive compact、L4 recent-file rehydration、L4 TEXT ONLY prompt guard。对应 spec：`docs/superpowers/specs/2026-05-18-p0-context-stability.md`；对应 plan：`docs/superpowers/plans/2026-05-18-p0-context-stability.md`。

截至 2026-05-18，本 worktree 已完成：L4 summarizer 真实 LLM 调用、summary model 配置 fallback、summary 调用禁用 tools/thinking、skill body 走 tool_result、provider input token 统计、切 session 后从 `model_usage` 恢复窗口用量、`/resume` 与 `/fork` 基础命令。因此下方原始 gap 中涉及这些内容的状态应按当前代码修正，不再列入第一批。

## 1. 上下文管理

| 序号 | 特性 | 状态 | Claude Code 细节 | mycli 现状 |
|---|---|---|---|---|
| 1.1 | L0（预判是否该跑工具） | ❌ | 工具执行前评估预期输出大小，选择不跑大输出工具 | 无 |
| 1.2 | L1 工具结果截断 | ✅ | 按工具类型差异化上限 | ToolResultBudget 已实现 + append_only guard |
| 1.3 | L2/L3 中间层压缩 | ⚠️ | Microcompact 双路径（热缓 cache_edits / 冷缓本地改） | ContextWindowAnalyzer 纯观测，不做修改 |
| 1.4 | L4 LLM 摘要 | ⚠️ | Fork 子 agent，9段summary，复水(rehydrate) | 真实 LLM 摘要、summary model 配置、禁用 tools/thinking 已完成；复水仍只有 reminder |
| 1.5 | L4 compact prompt 反工具调用 | ❌ | "CRITICAL: Respond with TEXT ONLY. Do NOT call any tools." | summary prompt 无此约束 |
| 1.6 | Context Collapse（L4.5） | ❌ | 读时投影，可逆，存于 collapse store | 无 |
| 1.7 | Reactive Compact | ❌ | API 返回 prompt_too_long 时应急压缩 | 无 |
| 1.8 | tool_result 三分区 | ⚠️ | mustReapply / frozen / fresh | 只有 append_only guard，缺 mustReapply |
| 1.9 | 缓存稳定 14 个 breakpoint | ❌ | sticky latch 防止 mode switch 破缓存 | 依赖 frozen_fingerprint |
| 1.10 | Beta header latching | ❌ | feature flag mid-session 不变 | 无 |
| 1.11 | 预热请求 | ❌ | 真正干活前发 2-3 次"空"请求填 KV cache | 无 |
| 1.12 | defer_loading MCP tools | ❌ | stub 注册，完整 schema 首次使用才加载 | 工具 schema 全量注入 |
| 1.13 | 13K auto-compact buffer | ❌ | 压缩操作本身的预留空间 | 无预留，直接打满；P0 批次处理 |
| 1.14 | Compaction 断路器 | ⚠️ | 3 次连续失败停止，经 telemetry 调优（省 250K API calls/day） | 断路器在，未经调优 |
| 1.15 | /context 实时可视化 | ❌ | 彩色条形图 + 分类占比 | /status 文本 |
| 1.16 | /usage 会话费用追踪 | ❌ | 实时 token 费用 | 无 |
| 1.17 | Microcompact 时间路径 | ❌ | 缓存过期(>60min)后本地清旧 tool_result(keep recent 5) | 无 |

## 2. Agent Loop & 错误恢复

| 序号 | 特性 | 状态 | Claude Code 细节 | mycli 现状 |
|---|---|---|---|---|
| 2.1 | 7个Continue点 | ❌ | PTL drain / reactive compact / OTK escalate / OTK recovery×3 / model fallback / Ctrl+C / stop hook | 0 个 |
| 2.2 | AsyncGenerator 流式 + 反压 | ❌ | generator.return() 级联关闭所有嵌套 | 同步阻塞 |
| 2.3 | 流式工具执行 | ❌ | SSE 收到 content_block_stop 立刻派发，不等待整个响应 | 收到完整响应后执行 |
| 2.4 | hasAttemptedReactiveCompact 防死循环 | ❌ | 单布尔值防 compact→retry→compact 死循环 | 无 |
| 2.5 | OTK 三层升级 | ❌ | 8K→64K 静默升级，后续 recovery message，最后才 surface error | 直接 fail |
| 2.6 | 529 fallback 机制 | ❌ | 3 次 529 → Opus→Sonnet 降级 | 无 |
| 2.7 | 401 OAuth token 刷新 + 重试 | ❌ | 401 → refresh → retry once | 无 |
| 2.8 | Persistent mode heartbeat | ❌ | 30s heartbeat yield "I'm still here" 防 K8s kill | 无 |
| 2.9 | cch attestation | ❌ | Bun/Zig 层客户端认证，JS 代码绕不过 | 无 |

## 3. 工具执行

| 序号 | 特性 | 状态 | Claude Code 细节 | mycli 现状 |
|---|---|---|---|---|
| 3.1 | Bash 安全 23 项检查 | ❌ | 元字符注入、Unicode 混淆、IFS 变量、brace expansion、zsh-specific 黑名单 | 7 条简单正则 |
| 3.2 | Bash 禁止命令重定向 | ❌ | cat→Read, grep→Grep, find→Glob, sed→Edit, ls→LS | 无 |
| 3.3 | Bash 后台运行 + 管理 | ❌ | BashOutput + KillShell 三工具生命周期，`/bashes` 命令 | Bash + KillShell 有骨架，未实现后台 |
| 3.4 | YOLO classifier | ❌ | 独立 Claude 实例评估 tool call 安全性 | 无 |
| 3.5 | Fake tools | ❌ | review_file 占位符——强制模型在写入前停顿 | 无 |
| 3.6 | 并行工具执行 | ✅ | 连续 safe 工具 → parallel batch，unsafe 截断 | CONCURRENCY_SAFE_TOOLS + ThreadPoolExecutor |
| 3.7 | 编辑乐观并发控制 | ❌ | timestamp check + old_string check，先写者赢 | 无 |
| 3.8 | 文件历史 | ❌ | fileHistoryTrackEdit / makeSnapshot / rewind | 无 |
| 3.9 | Edit 14 步校验管道 | ❌ | secret detection、no-op、文件>1GiB OOM 保护、pre-read要求 | 基本 check |
| 3.10 | Write 自动创建父目录 | ✅ | parent.mkdir(parents=True) | 已实现 |

## 4. 权限 & 安全

| 序号 | 特性 | 状态 | Claude Code 细节 | mycli 现状 |
|---|---|---|---|---|
| 4.1 | 6 层权限防线 | ❌ | useCanUseTool.tsx | 3 级分类(low/medium/high) |
| 4.2 | 权限继承链 | ❌ | 父→子 agent 不可降级 | 无 |
| 4.3 | Sandbox | ❌ | Bubblewrap(linux) / Seatbelt(macOS) / Windows Restricted Tokens | 无 |
| 4.4 | Sandbox 域名过滤 | ❌ | allowedDomains / deniedDomains + allowManagedDomainsOnly | 无 |
| 4.5 | 注入防护 | ❌ | 反蒸馏陷阱 + frustration regex | 无 |
| 4.6 | 脱敏 | ❌ | 无内置，靠 CLI 不输出 | 无 |

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
| 5.8 | Transcript sidechain | ❌ | 子 agent 对话独立记录 | 无 |

## 6. Prompt 工程

| 序号 | 特性 | 状态 | Claude Code 细节 | mycli 现状 |
|---|---|---|---|---|
| 6.1 | `__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__` | ❌ | 静态/动态分割 → Blake2b hash 全局缓存 | 靠 Fragment.cache_policy |
| 6.2 | 反蒸馏陷阱 | ❌ | 注入虚假 tool definition 毒化训练数据 | 无 |
| 6.3 | frustration regex | ❌ | 自我监控 refusal 语言 → meta-reasoning layer | 无 |
| 6.4 | system prompt 分层缓存 | ❌ | 静态→global scope; 动态→org/ephemeral scope | 无 |
| 6.5 | 模型切换缓存隔离 | ❌ | Opus cache ≠ Sonnet cache; 切换→全量重写 | 无机制 |

## 7. Sub-agent & 多代理

| 序号 | 特性 | 状态 | Claude Code 细节 | mycli 现状 |
|---|---|---|---|---|
| 7.1 | 5 种 agent 模式 | ❌ | sync / async / fork / worktree / remote | 1 个骨架(NotImplementedError) |
| 7.2 | Fork 缓存共享 | ❌ | fork agent 复用父 cache 前缀，1/10 价格 | 无 |
| 7.3 | 权限隔离 | ❌ | 子 agent 权限最小化，不能绕过父权限 | 无 |
| 7.4 | 工具集隔离 | ❌ | 子 agent 独立工具子集 | 骨架有 sorted tools |
| 7.5 | Context 隔离 | ⚠️ | 单通道 prompt + file handoff | 独立消息列表，骨架有 |
| 7.6 | Agent Teams | ❌ | 共享 task list + 依赖图 + 并行 worktree | 无 |
| 7.7 | /batch 命令 | ❌ | 采访→扇出到数百个 worktree 隔离 agent | 无 |

## 8. MCP & 扩展性

| 序号 | 特性 | 状态 | Claude Code 细节 | mycli 现状 |
|---|---|---|---|---|
| 8.1 | MCP 客户端 | ❌ | JSON-RPC stdio/HTTP, tools/resources/prompts | 零代码 |
| 8.2 | MCP server 权限管理 | ❌ | allowedMcpServers / deniedMcpServers | 无 |
| 8.3 | Hooks 系统 | ⚠️ | 8 个事件类型 + command/prompt/agent/http/mcp_tool 5种 hook | 框架在(types/manager/builtin)，集成不全 |
| 8.4 | Plugin/Marketplace 系统 | ❌ | PluginMarketplace + extraKnownMarketplaces | 无 |
| 8.5 | Skills 三层渐进披露 | ⚠️ | L1 元数据→L2 body→L3 资源 | 两层(缺 L3)，body 已对齐 tool_result 模式 |
| 8.6 | 85+ Slash Commands | ❌ | Git、code review、memory、multi-agent 编排 | 基础命令 |

## 9. CLI 体验

| 序号 | 特性 | 状态 | Claude Code 细节 | mycli 现状 |
|---|---|---|---|---|
| 9.1 | 流式输出 | ❌ | SSE token-by-token 渲染 | 缓冲一次性输出 |
| 9.2 | Diff 展示 | ❌ | 带行号 diff | 文本渲染 |
| 9.3 | 语法高亮 | ❌ | pygments/rich | 无 |
| 9.4 | spinner 可定制 | ❌ | spinnerVerbs / spinnerTips / spinnerTipsOverride | 无 |
| 9.5 | voice mode | ❌ | hold-to-talk 语音输入 | 无 |
| 9.6 | statusLine 可定制 | ❌ | command 类型，可显示 context% | 无 |
| 9.7 | viewMode | ❌ | default/verbose/focus | 无 |
| 9.8 | editorMode | ❌ | normal/vim | 禅模式输入 |
| 9.9 | 自动补全 | ❌ | 文件路径 @ 补全 | 无 |
| 9.10 | /rename 终端标题 | ❌ | 自动或手动更新终端 tab 标题 | 无 |

## 10. 生产基础设施

| 序号 | 特性 | 状态 | Claude Code 细节 | mycli 现状 |
|---|---|---|---|---|
| 10.1 | Telemetry | ❌ | 838 event types(tengu_*)，结构化日志 | JSONL trace |
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
| 上下文管理 | 17 | 2 | 4 | 11 |
| Agent Loop | 9 | 0 | 0 | 9 |
| 工具执行 | 10 | 2 | 0 | 8 |
| 权限 & 安全 | 6 | 0 | 0 | 6 |
| 记忆 & 持久化 | 8 | 0 | 1 | 7 |
| Prompt 工程 | 5 | 0 | 0 | 5 |
| Sub-agent | 7 | 0 | 2 | 5 |
| MCP & 扩展 | 6 | 0 | 2 | 4 |
| CLI 体验 | 10 | 0 | 0 | 10 |
| 生产基础设施 | 7 | 0 | 0 | 7 |
| **总计** | **85** | **4** | **9** | **72** |

**先做清单（最高 ROI 的 10 项）：**

1. 13K auto-compact buffer 预留
2. Reactive compact：provider context/prompt too long 后同 turn 压缩并 retry
3. L4 复水：recent files 从 reminder 升级为预算内内容注入
4. L4 compact prompt TEXT ONLY / no tools 约束
5. `/context` 文本版窗口分类可视化
6. `/usage` 会话费用追踪，基于 provider usage，不混入窗口占用
7. Bash 安全规则第一批：重定向、危险 shell 元字符、Unicode 混淆、`curl|sh`
8. Bash 命令重定向到专用工具：cat/grep/find/ls/sed
9. Edit optimistic concurrency + pre-read
10. Microcompact 时间路径（>60min 冷缓存清理）
