# mycli 生产级改造方案

> 从当前 MVP 状态 → 对标 Claude Code 的生产级 Agent。
> 参考：`2026-05-06-agent-context-management-engineering-handbook.md`
> 基线：`2026-05-07-mycli-production-roadmap.md`（20 项清单）

---

## 总体策略

**先固基，后盖楼。** 当前的管道、budget、cache_zones 结构是对的，但具体实现有致命 bug（死区、空操作、假计数）。先把这些修到能跑，再往上加钩子、子 agent、MCP。

**总工期**：11-16 周。分 4 个 Phase，每个 Phase 独立可验收。

---

## Phase 1：止血（2-3 周）

**目标**：上下文不再爆炸，token 计数可信，L1-L4 全部真实运行。

### 1.1 Token 计数器

**删除**：`src/mycli/services/context/window_service.py`（`len(text)//4`）

**新建**：`src/mycli/services/context/token_counter.py`

```
class TokenCounter:
    _encoder: tiktoken.Encoding          # o200k_base
    _cache: dict[str, int]              # LRU, max 10K entries
    
    count(text: str) -> int             # tiktoken 精确计数 + LRU cache
    count_fragment(f: Fragment) -> int  # 从 fragment.content 计数
    count_all(fragments: list[Fragment]) -> int  # 总计 + per-message overhead
```

**修改**：`src/mycli/services/context/compaction/budget.py`

```python
class ContextBudget:
    def record(self, api_usage: dict) -> None:
        """用 API 返回的真实 usage 校准。"""
        actual_input = api_usage.get("input_tokens", 0)
        self.conversation_tokens = actual_input  # 取代 len//4 估算
```

**验收**：本地 token 计数与 API 返回值偏差 ≤10%。

### 1.2 Cache Zone 修正

**重写**：`src/mycli/services/context/compaction/cache_zones.py`

```python
@dataclass
class CacheZones:
    frozen_boundary: int   # 第一个 cache_policy ∈ {DYNAMIC, EPHEMERAL} 的 fragment
    fresh_start: int       # 同 frozen_boundary（Fresh Zone 从这里开始）
    
    @classmethod
    def from_conversation(cls, conversation: Conversation) -> CacheZones:
        """不再用"第一条 user 消息"。按 cache_policy 计算。"""
        for i, msg in enumerate(conversation.messages):
            policy = msg.metadata.get("cache_policy", "DYNAMIC")
            if policy in ("DYNAMIC", "EPHEMERAL"):
                return cls(frozen_boundary=i, fresh_start=i)
        return cls(frozen_boundary=len(conversation.messages), 
                   fresh_start=len(conversation.messages))
    
    def validate(self, previous: "CacheZones") -> bool:
        """验证 Frozen Zone 跨 turn 未变。"""
        return self.frozen_boundary == previous.frozen_boundary
```

**关键变更**：`fresh_start == frozen_boundary`，不存在中间"死区"。compaction 对所有 Fresh Zone 生效。

**修改**：`src/mycli/services/context/compaction/pipeline.py` 所有策略的迭代范围从 `range(zones.fresh_start, len(messages))` 改为 `range(zones.fresh_start, len(messages))`——代码不变，但 fresh_start 含义正确了，所以覆盖范围自然正确。

**验收**：3-turn 会话中，turn 1-2 的 tool_result 被 L3 滑动窗口正确归档。

### 1.3 ToolResultBudget 实现

**文件**：`src/mycli/services/context/compaction/pipeline.py:23-37`

**当前**：`apply()` 是空函数。

**改造**：

```python
class ToolResultBudget:
    def __init__(self, formatter: ToolResultFormatter):
        self.formatter = formatter
    
    def apply(self, conversation, zones, budget) -> Conversation:
        """对 Fresh Zone 中所有 TOOL_RESULT 做预算感知截断。"""
        compacted = copy.deepcopy(conversation)
        for i in range(zones.fresh_start, len(compacted.messages)):
            msg = compacted.messages[i]
            if msg.role == "tool" and not msg.metadata.get("cache_frozen"):
                tool_name = msg.metadata.get("tool_name", "default")
                result = ToolResultV2(summary=msg.content, raw_payload={})
                msg.content = self.formatter.format(tool_name, result)
                msg.metadata["l1_truncated"] = True
                msg.metadata["cache_frozen"] = True  # 处理后标记 frozen
        return compacted
```

### 1.4 LLMSummarization 实现

**文件**：`src/mycli/services/context/compaction/pipeline.py:134-156`

**当前**：`apply()` 是空函数。

**改造**：

```python
class LLMSummarization:
    def __init__(self, trigger_ratio=0.9, summarizer_model="deepseek-lite"):
        self.trigger_ratio = trigger_ratio
        self.model = summarizer_model
        self._consecutive_failures = 0
        self._max_failures = 3  # 断路器
    
    def apply(self, conversation, zones, budget) -> Conversation:
        if budget.usage_ratio < self.trigger_ratio:
            return conversation
        if self._consecutive_failures >= self._max_failures:
            return conversation
        
        # 取前半段对话历史做摘要
        fresh_messages = conversation.messages[zones.fresh_start:]
        split = len(fresh_messages) // 2
        to_summarize = fresh_messages[:split]
        
        try:
            summary = self._call_summarizer(to_summarize)
            self._consecutive_failures = 0
        except Exception:
            self._consecutive_failures += 1
            return conversation
        
        # 构造新 conversation：summary + 后半段保留
        summary_msg = Message(
            role="assistant",
            content=summary,
            metadata={"compaction": True, "compressed_turns": len(to_summarize)}
        )
        continuation = Message(
            role="assistant", 
            content="[Conversation summarized. All key decisions preserved. Continue naturally.]",
            metadata={"compaction_continuation": True}
        )
        
        compacted = copy.deepcopy(conversation)
        compacted.messages = (
            compacted.messages[:zones.fresh_start] +
            [summary_msg, continuation] +
            fresh_messages[split:]
        )
        return compacted
    
    def _call_summarizer(self, messages: list[Message]) -> str:
        """结构化摘要 prompt。保留决策、文件编辑、错误、关键发现。"""
        # 构造 prompt + 调用轻量 LLM
```

**验收**：50-turn session 在 90% 预算时触发 L4 摘要，断路器正常工作。

### 1.5 消除双代码路径

**删除**：`src/mycli/agents/react_loop.py` 中 `ReactAgent.run()` 的旧逻辑

**修改**：`src/mycli/application/turn_service.py`

```python
class TurnService:
    def handle_user_turn(self, user_message: str) -> TurnResponse:
        # 统一走 TurnExecutor。ReactAgent 仅用作兼容性包装器。
        if self._runtime is None:
            self._runtime = self._build_runtime()
        return cast(TurnResponse, self._runtime.handle_user_turn(user_message))
```

**验收**：所有测试通过，无功能回归。

---

## Phase 2：架构补齐（4-6 周）

**目标**：钩子系统、正确的错误恢复、并行工具、子 agent 上下文隔离。

### 2.1 钩子系统

**新建**：`src/mycli/services/hooks/`

```
src/mycli/services/hooks/
├── __init__.py
├── manager.py          # HookManager：注册、执行、生命周期调度
├── types.py            # HookPoint, HookResult, HookContext
└── builtin/
    ├── __init__.py
    └── permission_guard.py  # 内置：PreToolUse 权限门控
```

**`types.py`**：

```python
from enum import Enum

class HookPoint(Enum):
    PRE_TOOL_USE = "pre_tool_use"
    POST_TOOL_USE = "post_tool_use"
    PRE_COMPACT = "pre_compact"
    SESSION_START = "session_start"
    SESSION_END = "session_end"

class HookAction(Enum):
    ALLOW = "allow"       # 允许继续
    DENY = "deny"         # 拒绝（带原因）
    MODIFY = "modify"     # 修改参数后继续

@dataclass
class HookResult:
    action: HookAction
    message: str = ""
    modified_args: dict | None = None

@dataclass
class HookContext:
    hook_point: HookPoint
    tool_name: str | None = None
    tool_args: dict | None = None
    session_id: str | None = None
    metadata: dict = field(default_factory=dict)
```

**`manager.py`**：

```python
class HookManager:
    def __init__(self):
        self._hooks: dict[HookPoint, list[Callable]] = {
            hp: [] for hp in HookPoint
        }
    
    def register(self, point: HookPoint, callback: Callable) -> None:
        self._hooks[point].append(callback)
    
    def execute(self, point: HookPoint, ctx: HookContext) -> list[HookResult]:
        results = []
        for callback in self._hooks[point]:
            try:
                result = callback(ctx)
                results.append(result)
                if result.action == HookAction.DENY:
                    break  # 拒绝即停，不执行后续钩子
            except Exception as e:
                logger.error(f"Hook {callback.__name__} failed: {e}")
        return results
```

**集成点**：

- `ToolExecutionService.execute_tool_call()`：调用前 `PRE_TOOL_USE`，调用后 `POST_TOOL_USE`
- `CompactionPipeline.compact()`：压缩前 `PRE_COMPACT`
- `SessionService.start_session()`：启动时 `SESSION_START`
- `SessionService.end_session()`：结束时 `SESSION_END`

### 2.2 错误恢复——Continue 点

**修改**：`src/mycli/application/runtime/turn_executor.py`

```python
class TurnExecutor:
    def _run_turn_loop(self, ...) -> TurnRecord:
        state = LoopState(
            fragments=...,
            max_output_tokens_override=None,
            has_attempted_reactive_compact=False,
            otk_recovery_count=0,
        )
        
        while True:
            try:
                response = self._request_model_turn(...)
                # ... process response ...
                
            except PromptTooLongError:
                # Continue ①: Collapse drain
                if self._try_collapse_drain(state):
                    state.transition = "collapse_drain_retry"
                    continue
                
                # Continue ②: Reactive Compact
                if not state.has_attempted_reactive_compact:
                    state.fragments = self._reactive_compact(state.fragments)
                    state.has_attempted_reactive_compact = True
                    state.transition = "reactive_compact_retry"
                    continue
                
                return self._finalize_error("prompt_too_long")
            
            except OutputTokenLimitError:
                # Continue ③: Escalate output budget
                if state.max_output_tokens_override is None:
                    state.max_output_tokens_override = 65536
                    state.transition = "max_output_tokens_escalate"
                    continue
                
                # Continue ④: Recovery message
                if state.otk_recovery_count < 3:
                    state.fragments = self._inject_otk_recovery(state.fragments)
                    state.otk_recovery_count += 1
                    state.transition = "max_output_tokens_recovery"
                    continue
                
                return self._finalize_completed(state)
            
            except ModelFallbackError:
                # Continue ⑤: Model fallback
                if state.fallback_model:
                    state.model = state.fallback_model
                    state.transition = "model_fallback"
                    continue
                raise
            
            except KeyboardInterrupt:
                # Continue ⑥: User interrupt
                state.fragments = self._append_interrupt_notice(state.fragments)
                return self._finalize_interrupted(state)
```

### 2.3 并行工具执行

**修改**：`src/mycli/application/runtime/tools/tool_execution_service.py`

```python
CONCURRENCY_SAFE_TOOLS = {
    "read_file", "read_file_range", "search_text",
    "list_directory", "grep", "git_diff", "git_status"
}

class ToolExecutionService:
    def execute_tool_calls(
        self, tool_calls: list[ToolCall]
    ) -> list[ToolResultV2]:
        """
        执行一组工具调用。并发安全的工具并行执行。
        """
        results: list[ToolResultV2 | None] = [None] * len(tool_calls)
        
        # 分组：并发安全的并行执行，不安全的串行执行
        parallel_group: list[tuple[int, ToolCall]] = []
        
        for i, call in enumerate(tool_calls):
            tool_name = call.tool_name
            
            if tool_name in CONCURRENCY_SAFE_TOOLS:
                parallel_group.append((i, call))
            else:
                # 先排空并行组
                if parallel_group:
                    self._execute_parallel(parallel_group, results)
                    parallel_group = []
                # 串行执行不安全的
                results[i] = self.execute_tool_call(call)
        
        # 排空剩余并行组
        if parallel_group:
            self._execute_parallel(parallel_group, results)
        
        return [r for r in results if r is not None]
    
    def _execute_parallel(
        self, group: list[tuple[int, ToolCall]], results: list
    ) -> None:
        from concurrent.futures import ThreadPoolExecutor, as_completed
        with ThreadPoolExecutor(max_workers=len(group)) as executor:
            futures = {
                executor.submit(self.execute_tool_call, call): idx
                for idx, call in group
            }
            for future in as_completed(futures):
                idx = futures[future]
                results[idx] = future.result()
```

### 2.4 子 Agent 上下文隔离

**新建**：`src/mycli/agents/sub_agent.py`

```python
class SubAgent:
    """
    子 agent 有独立的 Fragment 列表、工具集、缓存前缀。
    父 agent 只接收最终报告。
    """
    
    def __init__(
        self,
        name: str,
        system_prompt: str,
        tools: list[ToolDefinition],
        model: str,
        budget: ContextBudget,
        max_tool_calls: int = 25,
    ):
        self.name = name
        self.system_prompt = system_prompt
        self.tools = sorted(tools, key=lambda t: t.name)  # 缓存稳定
        self.model = model
        self.budget = budget
        self.max_tool_calls = max_tool_calls
        self._messages: list[Message] = []
    
    def run(self, task: str) -> Fragment:
        """
        执行子任务，返回最终报告的 Fragment。
        
        父 agent 拿到这个 Fragment 后直接追加到自己的对话中，
        子 agent 内部的 40 次工具调用不进入父上下文。
        """
        # 构建独立上下文
        messages = []
        messages.append(Message(role="system", content=self.system_prompt,
                                metadata={"cache_policy": "STATIC"}))
        for t in self.tools:
            messages.append(Message(role="system", content=t.render_schema(),
                                    metadata={"cache_policy": "STATIC", 
                                              "tool_name": t.name}))
        messages.append(Message(role="user", content=task))
        
        # 运行子 agent 的独立 turn loop
        for _ in range(self.max_tool_calls):
            response = self._call_model(messages, self.tools)
            if response.is_final:
                return Fragment(
                    id=f"sub_report:{self.name}",
                    kind=FragmentKind.TOOL_RESULT,
                    priority=Priority.HIGH,
                    cache_policy=CachePolicy.DYNAMIC,
                    content=f"[Sub-agent '{self.name}' report]:\n{response.content}",
                    metadata={"source": "sub_agent", 
                              "tool_calls": len([m for m in messages if m.role == "tool"])}
                )
            # 工具调用继续...
        
        return Fragment(...)  # timeout
```

---

## Phase 3：用户体验（3-4 周）

### 3.1 文件历史 / 撤销

**新建**：`src/mycli/services/file_history.py`

```python
class FileHistory:
    """
    编辑前快照 + 按 turn 回滚。
    
    快照粒度 = 主对话 turn。
    备份在 ~/.mycli/file-history/{sessionId}/
    文件命名: {sha256(path)[:16]}@v{version}
    """
    
    def track_edit(self, file_path: str) -> None:
        """Edit/Write 工具调用前：创建 v1 备份（修改前的原始内容）。"""
        if not self._is_tracked(file_path):
            backup = self._backup_path(file_path, version=1)
            shutil.copy2(file_path, backup)
            self._tracked[file_path] = 1
    
    def make_snapshot(self, message_id: str) -> None:
        """每个 turn 结束后：检查追踪文件的变化，创建新版本备份。"""
        for file_path in list(self._tracked.keys()):
            if not os.path.exists(file_path):
                continue
            if self._content_changed(file_path):
                self._tracked[file_path] += 1
                backup = self._backup_path(file_path, self._tracked[file_path])
                shutil.copy2(file_path, backup)
    
    def rewind(self, message_id: str) -> None:
        """恢复到指定 turn 的文件状态。"""
        snapshot = self._snapshots.get(message_id)
        if snapshot:
            for file_path, backup_version in snapshot.items():
                backup = self._backup_path(file_path, backup_version)
                shutil.copy2(backup, file_path)
```

### 3.2 MCP 客户端

**新建**：`src/mycli/services/mcp/`

**已有完整设计文档**：`docs/superpowers/plans/2026-04-27-mycli-mcp-host.md`

按设计文档实现，不重新设计。核心文件：

```
src/mycli/services/mcp/
├── __init__.py
├── client.py           # MCP 客户端（JSON-RPC over stdio/HTTP）
├── tool_adapter.py     # MCP Tool → mycli ToolDefinition
├── resource_adapter.py # MCP Resource → FragmentSource
└── prompt_adapter.py   # MCP Prompt → mycli SlashCommand
```

### 3.3 CLI 流式输出

**修改**：`src/mycli/cli/rendering.py`

- 模型响应：`rich.live.Live` 实时渲染
- Tool call 进度：`rich.status.Status` 展示当前工具名称
- Diff 展示：`rich.syntax.Syntax` + 行号
- 语法高亮：`pygments` 集成

### 3.4 会话 Resume

**修改**：`src/mycli/cli/main.py`、`src/mycli/infrastructure/sqlite_session_store.py`

- `/sessions` 列出历史会话（已有）
- `/resume <id>` 恢复指定会话的最后一轮（新增）
- `/fork <id>` 基于现有会话创建分支（新增）

### 3.5 Plan Mode

**新建**：`src/mycli/services/planning/plan_mode.py`

- `EnterPlanMode` / `ExitPlanMode` 作为内置工具（而非独立运行时模式）
- Plan 状态写入 `docs/tasks/current.md`（checkbox 进度）
- Plan 文件作为 crash 恢复锚点

---

## Phase 4：差异化（2-3 周）

### 4.1 记忆升级

**修改**：`src/mycli/services/memory/service.py`

- 三层记忆（Transient/Short-term/Long-term）替换当前简单 key-value
- 语义检索：sentence-transformers embedding + ChromaDB / SQLite-vec
- 去重：检索结果与对话历史交叉比对
- 异步编码：threading 后台写入

### 4.2 注入防护

**新建**：`src/mycli/services/security/injection_guard.py`

- 所有低信任内容（工具输出、MCP 响应）进入上下文前用 `<tool_output>` 包裹
- PrivacyFilter：正则匹配 API key、token、email 模式并脱敏
- 脱敏在 L1 截断前运行

### 4.3 对话分叉

**新建**：`src/mycli/services/conversation_tree.py`

- Conversation 从 `list[Message]` 改为树结构
- `parent_id` + `fork_point` 元数据
- 支持从任意消息 rewind 并创建替代分支

### 4.4 成本感知

**修改**：`src/mycli/services/context/compaction/pipeline.py`

- L4 触发前计算：摘要成本 vs 全量携带成本
- `trigger_ratio` 从静态 0.4/0.7/0.9 → 按模型动态
- 成本指标纳入 MetricsCollector

---

## 文件变更总览

| Phase | 新建 | 修改 | 删除 |
|---|---|---|---|
| P1 止血 | `token_counter.py` | `budget.py`, `cache_zones.py`, `pipeline.py`, `turn_service.py` | `window_service.py`, `react_loop.py` |
| P2 架构 | `services/hooks/`, `agents/sub_agent.py` | `turn_executor.py`, `tool_execution_service.py` | — |
| P3 体验 | `services/file_history.py`, `services/mcp/`, `services/planning/plan_mode.py` | `cli/rendering.py`, `cli/main.py`, `sqlite_session_store.py` | — |
| P4 差异化 | `services/security/`, `services/conversation_tree.py` | `services/memory/service.py`, `pipeline.py` | — |

---

## 验收标准

每个 Phase 结束时的验收条件：

**Phase 1**：
- 50-turn session（40 次工具调用）token 总数在预算内
- 缓存命中率 ≥ 85%（同 session 连续两轮）
- `len//4` 不再出现在任何代码中

**Phase 2**：
- PreToolUse hook 能拦截工具调用并返回 DENY
- PTL 错误自动 drain → reactive compact 恢复
- 5 个 read_file 并行执行，结果正确排序
- 子 agent 内部 20 次工具调用不进入父 agent 上下文

**Phase 3**：
- edit_file 后可用 `/undo` 恢复
- MCP server 连接成功，工具可用
- CLI 流式输出模型响应
- `/resume` 恢复上一 session

**Phase 4**：
- 跨 session 记忆检索正确去重
- 工具输出含 API key 时自动脱敏进入上下文
- L4 触发时打印成本对比
