# Plan: mycli Production-Grade Transformation

> Execute with: Claude Code `/plan` or Codex plan mode.
> Reference: `docs/superpowers/specs/2026-05-06-agent-context-management-engineering-handbook.md`

## Summary

Transform mycli from MVP agent to production-grade, targeting Claude Code parity in architecture. 20 tasks across 4 phases. Each task is a self-contained implementation unit with explicit file paths, code patterns, and acceptance criteria.

## Phase 1: Stop the Bleeding (5 tasks)

Fix fatal bugs in the existing context management pipeline before building anything new.

### Task 1.1: Token Counter

**Why**: Current `len(text)//4` is off by 2-3x for Chinese/code/JSON. All budget decisions are unreliable.

**Delete**: `src/mycli/services/context/window_service.py`

**Create**: `src/mycli/services/context/token_counter.py`
- `TokenCounter` class with `tiktoken` `o200k_base` encoding
- LRU cache, max 10k entries
- Methods: `count(text: str) -> int`, `count_fragment(f: Fragment) -> int`, `count_all(fragments: list[Fragment]) -> int` (includes +4 per-message overhead)

**Modify**: `src/mycli/services/context/compaction/budget.py`
- `ContextBudget.record(api_usage: dict)` — replace `len//4` estimate with real `api_usage["input_tokens"]`
- `ContextBudget.usage_ratio` — use `TokenCounter` internally

**Acceptance**: Local count vs API response count < 10% deviation. No `len//4` in any file.

---

### Task 1.2: Fix Cache Zone Boundaries

**Why**: `cache_zones.py` uses "first user message" as frozen boundary, creating a dead zone between frozen_boundary and fresh_start where messages are never compacted. A 100-turn session sends ALL intermediate tool results to the model untouched.

**Rewrite**: `src/mycli/services/context/compaction/cache_zones.py`

New logic:
```
frozen_boundary = index of first message where metadata["cache_policy"] ∈ {"DYNAMIC", "EPHEMERAL"}
fresh_start = frozen_boundary  # no dead zone
```

The `cache_policy` metadata is set on Message during conversation construction:
- System prompt messages → `"STATIC"`
- Tool definition messages → `"STATIC"`
- User/assistant/tool messages → `"DYNAMIC"` or `"EPHEMERAL"`

Add methods:
- `CacheZones.validate(previous: CacheZones) -> bool` — verify frozen zone unchanged between turns
- `CacheZones.advance_frozen(new_boundary: int) -> CacheZones` — move boundary forward after turn completes

**Acceptance**: In a 3-turn session, tool_results from turns 1-2 are covered by the compaction pipeline. No dead zone exists.

---

### Task 1.3: Implement ToolResultBudget (L1 was a no-op)

**Why**: `ToolResultBudget.apply()` is an empty function. L1 truncation only runs at render time in `ToolResultFormatter`, not during compaction. Results stored in SQLite at full size.

**Modify**: `src/mycli/services/context/compaction/pipeline.py` (lines 23-37)

```python
class ToolResultBudget:
    def __init__(self, formatter: ToolResultFormatter):
        self.formatter = formatter
    
    def apply(self, conversation, zones, budget) -> Conversation:
        compacted = copy.deepcopy(conversation)
        for i in range(zones.fresh_start, len(compacted.messages)):
            msg = compacted.messages[i]
            if msg.role == "tool" and not msg.metadata.get("cache_frozen"):
                tool_name = msg.metadata.get("tool_name", "default")
                result = ToolResultV2(summary=msg.content, raw_payload={})
                msg.content = self.formatter.format(tool_name, result)
                msg.metadata["l1_truncated"] = True
                msg.metadata["cache_frozen"] = True
        return compacted
```

**Acceptance**: Tool results in Fresh Zone are truncated by ToolResultFormatter during compaction. Processed messages are marked `cache_frozen=True`.

---

### Task 1.4: Implement LLMSummarization (L4 was a no-op)

**Why**: `LLMSummarization.apply()` is an empty function. L4 is the final defense line when other compaction layers fail to free enough tokens.

**Modify**: `src/mycli/services/context/compaction/pipeline.py` (lines 134-156)

Implementation requirements:
- Trigger at `budget.usage_ratio >= 0.9`
- Split fresh zone messages in half; summarize the first half
- Structured summary prompt: must preserve decisions, file edits, errors, key findings
- Circuit breaker: max 3 consecutive failures, then stop trying
- Continuation message appended after summary
- Use lightweight model (separate from main model, e.g. `deepseek-lite`)

```python
class LLMSummarization:
    def __init__(self, trigger_ratio=0.9, summarizer_model="deepseek-lite"):
        self.trigger_ratio = trigger_ratio
        self.model = summarizer_model
        self._consecutive_failures = 0
        self._max_failures = 3
    
    def apply(self, conversation, zones, budget) -> Conversation:
        if budget.usage_ratio < self.trigger_ratio:
            return conversation
        if self._consecutive_failures >= self._max_failures:
            return conversation
        
        fresh = conversation.messages[zones.fresh_start:]
        split = len(fresh) // 2
        to_summarize = fresh[:split]
        
        try:
            summary = self._summarize(to_summarize)
            self._consecutive_failures = 0
        except Exception:
            self._consecutive_failures += 1
            return conversation
        
        return self._rebuild_conversation(conversation, zones, summary, fresh[split:])
```

**Acceptance**: 50-turn session triggers L4 at 90% budget. Circuit breaker opens after 3 consecutive failures.

---

### Task 1.5: Eliminate Dual Code Paths

**Why**: `turn_service.py:338` branches: if `_runtime is not None` use TurnExecutor (has compaction), else use ReactAgent (no compaction). Tests and some entry points silently get degraded behavior.

**Delete**: Old `ReactAgent.run()` logic in `src/mycli/agents/react_loop.py`

**Modify**: `src/mycli/application/turn_service.py`
- When `_runtime is None`, construct a runtime instead of falling back to `_run_agent()`
- `ReactAgent` becomes a thin compatibility wrapper forwarding to `TurnExecutor`

**Acceptance**: All existing tests pass. No code path bypasses the compaction pipeline.

---

## Phase 2: Core Architecture (5 tasks)

Build the infrastructure that connects everything together.

### Task 2.1: Hooks System

**Why**: No lifecycle hooks exist. Without hooks, permission customization, automatic verification, and PreCompact state-saving are impossible to implement as extensions.

**Create directory**: `src/mycli/services/hooks/`

**Create**: `src/mycli/services/hooks/types.py`
- `HookPoint` enum: `PRE_TOOL_USE`, `POST_TOOL_USE`, `PRE_COMPACT`, `SESSION_START`, `SESSION_END`
- `HookAction` enum: `ALLOW`, `DENY`, `MODIFY`
- `HookResult` dataclass: `action`, `message`, `modified_args`
- `HookContext` dataclass: `hook_point`, `tool_name`, `tool_args`, `session_id`, `metadata`

**Create**: `src/mycli/services/hooks/manager.py`
- `HookManager` class
- `register(point, callback)` — add hook
- `execute(point, ctx) -> list[HookResult]` — run hooks in order; DENY stops chain
- Hook loading from `.mycli/hooks/` directory (Python files)

**Create**: `src/mycli/services/hooks/builtin/permission_guard.py`
- Built-in PreToolUse hook that checks tool risk level against user's allowlist

**Integrate hooks into**:
- `ToolExecutionService.execute_tool_call()` — PreToolUse before, PostToolUse after
- `CompactionPipeline.compact()` — PreCompact before
- `SessionService` — SessionStart, SessionEnd

**Acceptance**: A PreToolUse hook registered in `.mycli/hooks/` can intercept a tool call and return DENY. PostToolUse hook can log results.

---

### Task 2.2: Error Recovery with Continue Points

**Why**: Current error handling is fail-and-exit. No retry, no graceful degradation. A single PTL error kills the entire turn.

**Modify**: `src/mycli/application/runtime/turn_executor.py`

Add `LoopState` dataclass to track recovery state across continue points:
```python
@dataclass
class LoopState:
    fragments: list[Fragment]
    max_output_tokens_override: int | None = None
    has_attempted_reactive_compact: bool = False
    otk_recovery_count: int = 0
    fallback_model: str | None = None
    transition: str = ""
```

Implement 6 continue points in the main while loop:

1. **Collapse drain** (PTL layer 1): Zero-cost drain of redundant tool results
2. **Reactive compact** (PTL layer 2): LLM summarization, attempted once per turn
3. **OTK escalate**: Increase `max_tokens` from 8K to 64K, retry same request
4. **OTK recovery**: Inject recovery message ("Continue directly, no apology"), max 3 times
5. **Model fallback**: Switch to fallback model on error
6. **KeyboardInterrupt**: Append interrupt notice, exit gracefully

**Acceptance**: PTL errors automatically drain → compact → retry. OTK auto-escalates. Ctrl+C adds interrupt notice and exits cleanly.

---

### Task 2.3: Budget Backpressure

**Why**: `ContextBudget.usage_ratio` is calculated but never communicated to the model. The model has no idea it's running out of context and keeps calling tools.

**Modify**: `src/mycli/application/runtime/turn_executor.py`

After each tool result is appended, check budget:
- `usage_ratio >= 0.60` → inject mild reminder into `runtime_reminders`
- `usage_ratio >= 0.85` → inject stern warning: "You MUST respond now based on available information. Do NOT call more tools unless absolutely necessary."
- Append `<token_budget_remaining>` hint to each tool result
- Track incremental budget gains: if 3 consecutive checks each gain < 500 tokens, force stop

**Acceptance**: Model receives budget warnings at 60% and 85% thresholds. Continuous low-gain loops are auto-terminated.

---

### Task 2.4: Parallel Tool Execution

**Why**: All tools execute sequentially. Reading 5 files takes 5x longer than necessary.

**Modify**: `src/mycli/application/runtime/tools/tool_execution_service.py`

Define concurrency-safe tools:
```python
CONCURRENCY_SAFE = {
    "read_file", "read_file_range", "search_text",
    "list_directory", "grep", "git_diff", "git_status"
}
```

Implement `execute_tool_calls(calls: list[ToolCall]) -> list[ToolResultV2]`:
- Group calls: concurrency-safe → ThreadPoolExecutor; unsafe → sequential
- Each call carries a `sequence_number` for correct ordering of results
- Flush parallel groups before executing any sequential call

**Acceptance**: 5 `read_file` calls execute in parallel. Results are ordered correctly by sequence_number. Write tools never execute concurrently.

---

### Task 2.5: Sub-Agent Context Isolation

**Why**: All tool calls share the main agent's conversation. A sub-task that requires 20 tool calls pollutes the main context with 20 tool results.

**Create**: `src/mycli/agents/sub_agent.py`

```python
class SubAgent:
    def __init__(self, name, system_prompt, tools, model, budget, max_tool_calls=25):
        self.name = name
        self.system_prompt = system_prompt
        self.tools = sorted(tools, key=lambda t: t.name)  # cache stability
        self.model = model
        self.budget = budget
        self.max_tool_calls = max_tool_calls
    
    def run(self, task: str) -> Fragment:
        # Build isolated context with own Frozen Zone
        # Run independent turn loop
        # Return only the final report as a single Fragment
        # Internal tool calls DO NOT enter the parent context
```

The parent agent receives a single `Fragment(kind=TOOL_RESULT, content="[Sub-agent report]: ...")` that it appends to its own conversation.

**Acceptance**: Sub-agent makes 20 internal tool calls. Parent agent context shows only 1 report Fragment. Sub-agent crash does not corrupt parent state.

---

## Phase 3: User Experience (5 tasks)

Features that users directly see and interact with.

### Task 3.1: File History & Undo

**Create**: `src/mycli/services/file_history.py`

Core API:
- `track_edit(file_path)` — before Edit/Write, create v1 backup (original content)
- `make_snapshot(message_id)` — after each turn, check tracked files for changes, create new version
- `rewind(message_id)` — restore all tracked files to the state at that message

Storage: `~/.mycli/file-history/{sessionId}/`  
File naming: `{sha256(path)[:16]}@v{version}`

Change detection (3 layers, from cheapest to most expensive):
1. `stat()` — compare file size and permissions
2. Compare `mtime` vs backup time — skip if file older than backup
3. Full byte-by-byte content comparison

Register `/undo` command in CLI.

**Acceptance**: After `edit_file`, `/undo` restores the file. Cross-turn snapshots correctly track versions.

---

### Task 3.2: MCP Client

**Design doc reference**: `docs/superpowers/plans/2026-04-27-mycli-mcp-host.md`

**Create directory**: `src/mycli/services/mcp/`

**Create**: `src/mycli/services/mcp/client.py`
- JSON-RPC over stdio (spawn server process) and HTTP (connect to remote)
- `list_tools()`, `call_tool()`, `list_resources()`, `read_resource()`, `list_prompts()`

**Create**: `src/mycli/services/mcp/tool_adapter.py`
- Convert MCP tool schema → mycli `ToolDefinition`
- Deferred loading: register stub (name + description only), load full schema on first use

**Create**: `src/mycli/services/mcp/resource_adapter.py`
- MCP resource → `FragmentSource` for context injection

**Create**: `src/mycli/services/mcp/prompt_adapter.py`
- MCP prompt → SlashCommand

**Configuration**: `.mycli/mcp_servers.toml`
```toml
[servers.filesystem]
command = "npx"
args = ["-y", "@anthropic/mcp-filesystem", "/path/to/allowed/dir"]

[servers.postgres]
command = "uvx"
args = ["mcp-postgres", "--connection", "..."]
```

**Acceptance**: Connect to an MCP server. Its tools appear in agent conversation. Resources are injectable as context.

---

### Task 3.3: CLI Streaming Output

**Modify**: `src/mycli/cli/rendering.py`

Replace buffered-then-dump with streaming:
- Model response: `rich.live.Live` for real-time token-by-token rendering
- Tool call progress: `rich.status.Status` with spinner + current tool name
- Diff display: `rich.syntax.Syntax` with line numbers
- Syntax highlighting: `pygments` integration for code blocks

**Acceptance**: Model output appears token-by-token. Tool execution shows spinner with tool name. Code blocks are syntax-highlighted.

---

### Task 3.4: Session Resume & Fork

**Modify**: `src/mycli/cli/main.py`
- `/sessions` — list past sessions (already exists)
- `/resume <session-id>` — load conversation from SQLite, continue from last turn (new)
- `/fork <session-id>` — create new branch from existing session (new)

**Modify**: `src/mycli/infrastructure/sqlite_session_store.py`
- `load_session_messages(session_id) -> list[Message]`
- `fork_session(session_id, new_session_id, fork_point) -> str`

**Modify**: `src/mycli/domain/conversation.py`
- Conversation: add `parent_id: str | None` and `fork_point: int | None` fields

**Acceptance**: `/resume` restores conversation state. `/fork` creates independent branch. Both work across process restarts.

---

### Task 3.5: Plan Mode

**Why**: Claude Code's plan mode is a tool, not a separate runtime mode. This preserves the tool set (cache stability) while adding planning capability.

**Create**: `src/mycli/services/planning/plan_mode.py`

Two built-in tools:
- `EnterPlanMode` — agent switches to planning-only behavior, writes plan to `docs/tasks/current.md`
- `ExitPlanMode` — agent exits planning, plan file serves as execution guide

Plan file format (checkbox progress):
```markdown
# Plan: User's Task
- [x] Step 1: completed
- [~] Step 2: in progress  
- [ ] Step 3: pending
- [ ] Step 4: pending
```

Extend existing `PlanningService` to:
- Persist plan state to `docs/tasks/current.md`
- Read plan file as crash recovery anchor (Task 1.5 in Phase 1 crash recovery covers this)

**Acceptance**: Agent can enter/exit plan mode without changing tools. Plan file persists to disk. Crash recovery reads plan file.

---

## Phase 4: Differentiation (5 tasks)

Features that separate production agents from basic ones.

### Task 4.1: Memory System Upgrade

**Modify**: `src/mycli/services/memory/service.py`

Replace current substring-search memory with 3-tier architecture:

| Tier | TTL | Capacity | Storage | Retrieval |
|---|---|---|---|---|
| Transient | Session | Unlimited | dict | Direct |
| Short-term | 24h | ~100 | SQLite | Embedding + cosine |
| Long-term | 1y | ~1000 | ChromaDB or SQLite-vec | Embedding + cosine |

- Embedding: `sentence-transformers` (all-MiniLM-L6-v2 or similar small model)
- Dedup: keyword overlap < 50% with last 20 conversation messages
- Async encoding: `threading.Thread(daemon=True)`, does not block user input

**Acceptance**: Cross-session memory retrieval returns relevant results. Results are deduplicated against current conversation. Encoding does not block.

---

### Task 4.2: Injection Prevention & Privacy

**Create**: `src/mycli/services/security/injection_guard.py`

`InjectionGuard`:
- Wrap all low-trust content (tool output, MCP response, file content) in `<tool_output><![CDATA[...]]></tool_output>` before entering context
- Escape `</tool_output>` and `<![CDATA[` within the content first
- Integrate as PostToolUse hook

`PrivacyFilter`:
- Regex patterns for: API keys (`sk-...`), auth tokens (`Bearer ...`), emails
- Replace matches with `[REDACTED]`
- Runs BEFORE L1 truncation
- Integrate as PreToolUse hook

**Acceptance**: Tool output containing `sk-abc123` is redacted in context. `</tool_output>` within tool output does not break XML boundaries.

---

### Task 4.3: Conversation Forking

**Why**: Currently a flat `list[Message]`. Cannot explore alternative approaches without losing the current path.

**Modify**: `src/mycli/domain/conversation.py`

Change Conversation from flat list to tree:
```python
@dataclass
class ConversationNode:
    id: str
    message: Message
    parent_id: str | None
    children: list[str]  # child node IDs

@dataclass  
class Conversation:
    session_id: str
    nodes: dict[str, ConversationNode]
    root_id: str
    current_id: str
    
    def get_path(self) -> list[Message]:  # root → current
    def fork(self) -> str:                # create branch at current
    def rewind_to(self, node_id: str):    # move to different node
```

**Modify**: `src/mycli/infrastructure/sqlite_session_store.py` — add `conversation_trees` table

**Acceptance**: Can fork at any message. Two branches evolve independently. Can rewind to any node.

---

### Task 4.4: Cost-Aware Compaction

**Modify**: `src/mycli/services/context/compaction/pipeline.py`

Before triggering L4 (LLM summarization):
- Estimate cost of summary call: `(tokens_to_compress / 1000) * INPUT_PRICE + (500 / 1000) * OUTPUT_PRICE`
- Estimate cost of carrying full tokens: `(tokens_to_compress / 1000) * INPUT_PRICE`
- Skip L4 if summary cost >= carrying cost
- Log decision with cost comparison

Make trigger ratios configurable per model in `AgentConfig`:
```python
@dataclass
class AgentConfig:
    compaction_dedup_ratio: float = 0.4    # was hardcoded
    compaction_eviction_ratio: float = 0.7 # was hardcoded
    compaction_llm_summary_ratio: float = 0.9  # was hardcoded
```

**Acceptance**: L4 triggers only when cost-effective. Thresholds are overridable per model.

---

### Task 4.5: Observability Completion

**Extend**: `src/mycli/services/context/metrics.py` (or wherever current metrics live)

Add:
- `ContextMetrics.cache_hit_rate` — from API response `cache_read_input_tokens / input_tokens`
- `ContextMetrics.compaction_ratio` — tokens saved / total tokens
- `ContextMetrics.budget_usage_curve` — list of (turn, usage_ratio) for trend tracking

**Add structured logging**: `structlog` with JSON output

**Add alert rules**:
- cache hit rate drops below 50% while input > 1000 tokens
- L4 triggered 3+ times in a single session
- PTL errors > 2% of turns

**Add CLI command**: `/stats` shows current session metrics

**Acceptance**: `/stats` displays cache hit rate, compaction triggers, budget curve. Alerts fire on threshold violations.

---

## Dependency Graph

```
Phase 1 (no dependencies):
  T1.1 ─┬─→ T2.3
        ├─→ T4.4, T4.5
        └─→ T1.5 ──→ T2.1 ──→ T3.1, T3.2, T3.5, T4.2
  T1.2 ──→ T1.3 ──→ T1.5
                   ├─→ T2.2 (error recovery needs unified loop)
                   ├─→ T2.4 (parallel tools need unified loop)
                   ├─→ T2.5 (sub-agent needs unified loop)
                   ├─→ T3.3 (streaming needs unified loop)
                   └─→ T3.4 ──→ T4.3 (forking builds on resume)

Phase 2:
  T2.1 (hooks) ──→ T3.1, T3.2, T3.5, T4.2
  T2.2 (error recovery) — independent after T1.5
  T2.3 (budget backpressure) — depends on T1.1
  T2.4 (parallel tools) — independent after T1.5
  T2.5 (sub-agent) — independent after T1.5

Phase 3:
  T3.1 (file history) — depends on T2.1
  T3.2 (MCP) — depends on T2.1
  T3.3 (streaming) — independent after T1.5
  T3.4 (resume/fork) — independent after T1.5
  T3.5 (plan mode) — depends on T2.1

Phase 4:
  T4.1 (memory) — independent after T1.5
  T4.2 (injection prevention) — depends on T2.1
  T4.3 (conversation forking) — depends on T3.4
  T4.4 (cost-aware) — depends on T1.1, T1.4
  T4.5 (observability) — depends on T1.1
```

## Execution Order

```
Step 1:  T1.1 + T1.2 (parallel, no dependencies)
Step 2:  T1.3 (after T1.2)
Step 3:  T1.4 (after T1.2)
Step 4:  T1.5 (after T1.1, T1.2, T1.3)
Step 5:  T2.1, T2.2, T2.4, T2.5, T3.3, T3.4 (parallel, all after T1.5)
Step 6:  T2.3 (after T1.1, T1.5)
Step 7:  T3.1, T3.2, T3.5, T4.1 (parallel, after T2.1)
Step 8:  T4.2 (after T2.1)
Step 9:  T4.3 (after T3.4)
Step 10: T4.4 (after T1.1, T1.4)
Step 11: T4.5 (after T1.1)
```

Estimated: 69 person-days sequential, ~50 days with 2 parallel workers.
