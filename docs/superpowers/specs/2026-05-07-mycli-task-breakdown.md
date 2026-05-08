# mycli 生产级改造：任务拆分

> 从 `2026-05-07-mycli-implementation-plan.md` 拆出。每项 = 一个独立可执行的任务。

---

## Phase 1：止血（P0）

### T01 — Token 计数器

**状态**：待开始 | **优先级**：P0 | **依赖**：无 | **估时**：3d

**前置**：删除 `src/mycli/services/context/window_service.py`

**工作内容**：
- [ ] 新建 `src/mycli/services/context/token_counter.py`
- [ ] 实现 `TokenCounter`：tiktoken `o200k_base` + LRU cache（10K entries）
- [ ] 实现 `count(s: str) -> int`、`count_fragment(f: Fragment) -> int`、`count_all(list[Fragment]) -> int`
- [ ] 修改 `src/mycli/services/context/compaction/budget.py:record()` → 接受 API usage dict，用真实值校准
- [ ] 全局搜索 `len(text)//4` 替换为 `TokenCounter`
- [ ] 更新 `ContextBudget.usage_ratio` 使用 TokenCounter 而非字符数

**验收**：本地计数与 API 返回值偏差 ≤10%。`len//4` 不出现在任何代码中。

---

### T02 — Cache Zone 重算

**状态**：待开始 | **优先级**：P0 | **依赖**：无 | **估时**：2d

**工作内容**：
- [ ] 重写 `src/mycli/services/context/compaction/cache_zones.py`
- [ ] `_find_frozen_boundary` → 不再用"第一条 user 消息"。改为：遍历 messages，检查 `metadata["cache_policy"]`，第一个 DYNAMIC/EPHEMERAL 的索引 = frozen_boundary
- [ ] `fresh_start = frozen_boundary`（消除死区）
- [ ] 新增 `validate(previous: CacheZones) -> bool`
- [ ] 新增 `advance_frozen(new_boundary: int) -> CacheZones`（turn 结束后前移)
- [ ] 更新所有调用方

**验收**：3-turn 会话中，turn 1-2 的 tool_result 被 compaction 覆盖。不再出现"中间消息从不被处理"。

---

### T03 — ToolResultBudget 从 No-op 到真实实现

**状态**：待开始 | **优先级**：P0 | **依赖**：T02 | **估时**：2d

**工作内容**：
- [ ] 修改 `src/mycli/services/context/compaction/pipeline.py:23-37`
- [ ] `ToolResultBudget.apply()` 调用 `ToolResultFormatter.format()` 对 Fresh Zone 中所有 `role=tool` 消息截断
- [ ] 跳过 `metadata["cache_frozen"]=True` 的消息
- [ ] 处理后的消息标记 `cache_frozen=True`
- [ ] 更新 `agent_runtime.py` 中 `CompactionPipeline` 初始化参数

**验收**：L1 截断在 compaction pipeline 中真实执行。截断后消息标记 cache_frozen。

---

### T04 — LLMSummarization 从 No-op 到真实实现

**状态**：待开始 | **优先级**：P0 | **依赖**：T02 | **估时**：3d

**工作内容**：
- [ ] 修改 `src/mycli/services/context/compaction/pipeline.py:134-156`
- [ ] `LLMSummarization.apply()` 实现真实 LLM 调用
- [ ] 结构化 summary prompt（保留：决策、文件编辑、错误、关键发现）
- [ ] 断路器：`_consecutive_failures >= 3` → 返回原样
- [ ] Summary 后追加 continuation message
- [ ] 使用轻量模型（`deepseek-lite`），与主模型分离

**验收**：50-turn session 在 90% 预算时触发摘要。连续 3 次失败后断路器熔断。

---

### T05 — 消除双代码路径

**状态**：待开始 | **优先级**：P0 | **依赖**：T01,T02,T03 | **估时**：3d

**工作内容**：
- [ ] 删除 `src/mycli/agents/react_loop.py` 中 `ReactAgent.run()` 的旧逻辑
- [ ] `ReactAgent` 保留为兼容性包装器，转发到 `TurnExecutor`
- [ ] 修改 `src/mycli/application/turn_service.py:338`：`_runtime is None` 时构建 runtime 而非走旧路径
- [ ] 全量回归测试

**验收**：所有测试通过。不再存在"有 compaction 的路径"和"没有的路径"。

---

## Phase 2：架构补齐（P1）

### T06 — 钩子系统

**状态**：待开始 | **优先级**：P1 | **依赖**：T05 | **估时**：5d

**工作内容**：
- [ ] 新建 `src/mycli/services/hooks/types.py`：`HookPoint`、`HookAction`、`HookResult`、`HookContext`
- [ ] 新建 `src/mycli/services/hooks/manager.py`：`HookManager` 注册/执行
- [ ] 新建 `src/mycli/services/hooks/builtin/permission_guard.py`
- [ ] 集成到 `ToolExecutionService.execute_tool_call()`：调用前 PreToolUse，调用后 PostToolUse
- [ ] 集成到 `CompactionPipeline.compact()`：压缩前 PreCompact
- [ ] 集成到 `SessionService`：SessionStart、SessionEnd
- [ ] 钩子从 `.mycli/hooks/` 目录加载

**验收**：PreToolUse hook 能拦截工具调用并返回 DENY。PostToolUse hook 能记录工具执行结果。

---

### T07 — 错误恢复（Continue 点）

**状态**：待开始 | **优先级**：P1 | **依赖**：T05 | **估时**：5d

**工作内容**：
- [ ] 修改 `src/mycli/application/runtime/turn_executor.py`：将当前 try-except 改为 6 个 Continue 点
- [ ] Continue ①：Collapse drain（PTL 第一层）
- [ ] Continue ②：Reactive Compact（PTL 第二层）
- [ ] Continue ③：OTK Escalate（输出预算从 8K→64K）
- [ ] Continue ④：OTK Recovery message（最多 3 次）
- [ ] Continue ⑤：Model fallback（主模型失败→fallback 模型）
- [ ] Continue ⑥：KeyboardInterrupt（追加 notice + 保留已发 fragments）
- [ ] 新增 `LoopState` 追踪 has_attempted_reactive_compact、otk_recovery_count

**验收**：PTL 错误自动 drain→compact 恢复。OTK 自动 escalate。Ctrl+C 追加 interrupt notice。

---

### T08 — 预算反压

**状态**：待开始 | **优先级**：P1 | **依赖**：T01,T02 | **估时**：2d

**工作内容**：
- [ ] 修改 `src/mycli/application/runtime/turn_executor.py`：每次 tool_result 追加后检查 budget
- [ ] `usage_ratio >= 0.60` → 注入温和提醒到 runtime_reminders
- [ ] `usage_ratio >= 0.85` → 注入强制警告："MUST respond now"
- [ ] 每个 tool_result 末尾追加 `<token_budget_remaining>`
- [ ] 连续 3 次预算检查增量 <500 tokens → 强制停止继续

**验收**：模型在 token 紧张时收到预算提醒。连续小额增量自动终止。

---

### T09 — 并行工具执行

**状态**：待开始 | **优先级**：P1 | **依赖**：T05 | **估时**：3d

**工作内容**：
- [ ] 修改 `src/mycli/application/runtime/tools/tool_execution_service.py`
- [ ] 定义 `CONCURRENCY_SAFE_TOOLS`（read_file, search_text, list_directory, grep 等）
- [ ] `execute_tool_calls()` 分组：并发安全 → ThreadPoolExecutor 并行；不安全 → 串行
- [ ] 结果按 `sequence_number` 排序后追加
- [ ] 每个 tool call 携带序号元数据

**验收**：5 个 read_file 并行执行。结果按序号正确排序。写操作不会并行。

---

### T10 — 子 Agent 上下文隔离

**状态**：待开始 | **优先级**：P1 | **依赖**：T05 | **估时**：5d

**工作内容**：
- [ ] 新建 `src/mycli/agents/sub_agent.py`
- [ ] 实现 `SubAgentContext`：独立 Fragment 列表 + 独立工具集 + 独立 TokenBudget + TurnGuard
- [ ] 工具集排序（缓存稳定）
- [ ] `run(task) -> Fragment`：内部工具调用不进入父上下文
- [ ] `extract_report()` → 最终报告的 Fragment
- [ ] 父 agent 接收 report 后追加到自己的对话中

**验收**：子 agent 内部 20 次工具调用，父 agent 上下文只看到一个 report Fragment。

---

## Phase 3：用户体验（P2）

### T11 — 文件历史 / 撤销

**状态**：待开始 | **优先级**：P2 | **依赖**：T06 | **估时**：4d

**工作内容**：
- [ ] 新建 `src/mycli/services/file_history.py`
- [ ] `track_edit(path)` → Edit/Write 前创建 v1 备份
- [ ] `make_snapshot(message_id)` → 每 turn 结束检查变化，创建新版本
- [ ] `rewind(message_id)` → 恢复文件到指定 turn 的状态
- [ ] 备份目录：`~/.mycli/file-history/{sessionId}/`
- [ ] 文件命名：`{sha256(path)[:16]}@v{version}`
- [ ] 三级变更检测：stat → mtime → 全内容比较
- [ ] `/undo` 命令注册

**验收**：edit_file 后可用 `/undo` 恢复文件。跨 turn 快照正确追踪。

---

### T12 — MCP 客户端

**状态**：待开始 | **优先级**：P2 | **依赖**：T06 | **估时**：5d

**已有设计文档**：`docs/superpowers/plans/2026-04-27-mycli-mcp-host.md`

**工作内容**：
- [ ] 新建 `src/mycli/services/mcp/client.py`（JSON-RPC over stdio/HTTP）
- [ ] 新建 `src/mycli/services/mcp/tool_adapter.py`（MCP Tool → mycli ToolDefinition）
- [ ] 新建 `src/mycli/services/mcp/resource_adapter.py`（MCP Resource → FragmentSource）
- [ ] 新建 `src/mycli/services/mcp/prompt_adapter.py`（MCP Prompt → SlashCommand）
- [ ] 配置：`.mycli/mcp_servers.toml`
- [ ] 工具注册到 `ToolRegistryV2`（延迟加载：stub 注册，完整 schema 按需加载）

**验收**：MCP server 连接成功。工具在 agent 中可用。资源作为上下文来源注入。

---

### T13 — CLI 流式输出

**状态**：待开始 | **优先级**：P2 | **依赖**：T05 | **估时**：4d

**工作内容**：
- [ ] 修改 `src/mycli/cli/rendering.py`
- [ ] 模型响应：`rich.live.Live` 实时渲染（替换缓冲 → 一次性输出）
- [ ] Tool call 进度：`rich.status.Status` 展示当前工具名称 + spinner
- [ ] Diff 展示：`rich.syntax.Syntax` 带行号
- [ ] 语法高亮：`pygments`

**验收**：模型输出逐 token 出现。工具调用时展示 spinner + 名称。

---

### T14 — 会话 Resume / Fork

**状态**：待开始 | **优先级**：P2 | **依赖**：T05 | **估时**：3d

**工作内容**：
- [ ] 修改 `src/mycli/cli/main.py`：`/resume <session-id>` 命令
- [ ] 修改 `src/mycli/cli/main.py`：`/fork <session-id>` 命令
- [ ] 修改 `src/mycli/infrastructure/sqlite_session_store.py`：`load_session_messages()`
- [ ] 修改 `Conversation` 模型：新增 `parent_id`、`fork_point` 字段

**验收**：`/resume` 恢复最后一轮对话。`/fork` 创建独立分支。

---

### T15 — Plan Mode

**状态**：待开始 | **优先级**：P2 | **依赖**：T06 | **估时**：4d

**工作内容**：
- [ ] 新建 `src/mycli/services/planning/plan_mode.py`
- [ ] 新建 `EnterPlanMode` / `ExitPlanMode` 作为内置工具（不切换运行时，不破坏工具集缓存）
- [ ] Plan 状态序列化到 `docs/tasks/current.md`（checkbox 进度：`[x]`/`[~]`/`[ ]`）
- [ ] Plan 文件作为 crash 恢复锚点
- [ ] 现有 `PlanningService` 扩展为支持 plan mode 的 plan 存储

**验收**：EnterPlanMode 后 agent 进入规划模式。Plan 文件持久化。Crash 后可从 plan 文件恢复。

---

## Phase 4：差异化（P3）

### T16 — 记忆系统升级

**状态**：待开始 | **优先级**：P3 | **依赖**：T05 | **估时**：4d

**工作内容**：
- [ ] 修改 `src/mycli/services/memory/service.py`
- [ ] 三层记忆：Transient（dict, 单 session）→ Short-term（SQLite, 24h, ~100 条）→ Long-term（ChromaDB/SQLite-vec, 1y, ~1000 条）
- [ ] 检索：sentence-transformers embedding + 余弦相似度
- [ ] 去重：检索结果与当前对话历史交叉比对（关键词重叠 <50%）
- [ ] 异步编码：`threading.Thread(daemon=True)` 后台写入

**验收**：跨 session 记忆检索正确。不与对话内容重复。编码不阻塞用户输入。

---

### T17 — 注入防护与脱敏

**状态**：待开始 | **优先级**：P3 | **依赖**：T06 | **估时**：3d

**工作内容**：
- [ ] 新建 `src/mycli/services/security/injection_guard.py`
- [ ] 工具输出进入上下文前用 `<tool_output><![CDATA[...]]></tool_output>` 包裹
- [ ] 内容中的 `</tool_output>` 和 `<![CDATA[` 提前转义
- [ ] `PrivacyFilter`：正则匹配 API key、token、email 模式并替换为 `[REDACTED]`
- [ ] 脱敏在 L1 截断前运行
- [ ] PostToolUse hook 集成

**验收**：含 API key 的工具输出自动脱敏。含 `</tool_output>` 的内容不破坏 XML 结构。

---

### T18 — 对话分叉

**状态**：待开始 | **优先级**：P3 | **依赖**：T14 | **估时**：4d

**工作内容**：
- [ ] 新建 `src/mycli/services/conversation_tree.py`
- [ ] `Conversation` 从 `list[Message]` → 树结构（`parent_id` + `fork_point`）
- [ ] `fork_at(message_index)` → 创建新分支
- [ ] `get_branch_history()` → 从根到当前节点的消息链
- [ ] SQLite schema 扩展：`conversation_trees` 表

**验收**：可以从任意消息 fork 出新分支。两个分支独立演进。

---

### T19 — 成本感知 Compaction

**状态**：待开始 | **优先级**：P3 | **依赖**：T01,T04 | **估时**：2d

**工作内容**：
- [ ] 修改 `src/mycli/services/context/compaction/pipeline.py`
- [ ] L4 触发前计算成本对比（摘要调用成本 vs 全量携带成本）
- [ ] `trigger_ratio` 从静态常量 → `AgentConfig` 可配（仍保留默认值）
- [ ] 成本决策记录到 `ContextMetrics`

**验收**：L4 触发时日志输出成本对比。阈值可通过配置覆盖。

---

### T20 — 可观测性补齐

**状态**：待开始 | **优先级**：P3 | **依赖**：T01 | **估时**：3d

**工作内容**：
- [ ] 扩展 `ContextMetrics`：新增 cache_hit_rate、compaction_ratio、budget_curve
- [ ] 结构化日志（`structlog`）
- [ ] 告警规则：cache hit rate 突降、连续 L4 触发、PTL 错误率
- [ ] 延迟追踪：端到端 turn 时间、单 tool call 延迟
- [ ] `/stats` 命令展示当前 session 指标

**验收**：`/stats` 展示 cache hit rate、compaction 触发情况。告警规则可配置。

---

## 汇总

| Phase | 任务数 | 总估时 | 关键依赖 |
|---|---|---|---|
| P1 止血 | 5 (T01-T05) | 13d | 无 |
| P2 架构 | 5 (T06-T10) | 20d | T05 |
| P3 体验 | 5 (T11-T15) | 20d | T06 |
| P4 差异化 | 5 (T16-T20) | 16d | T01,T06,T14 |

**总估时**：69 工作日 ≈ **14 周**（单人）。如果有 2 人并行，P2/P3 可以并行执行，总时间可以压缩到 10-11 周。
