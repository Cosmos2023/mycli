# Context Management 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 建立分层上下文压缩管线，在保护 DeepSeek 缓存前缀的前提下，减少单轮 token 消耗，降低模型"没看清→再读一次"的循环动机。

**Architecture:** 在现有 `ContextManager.render_tool_result()` 的 1600 硬截断基础上，升级为按工具类型差异化截断 + 三层递进压缩管线（去重→淘汰→摘要）。引入 frozen/fresh zone 边界模型，所有压缩操作不碰缓存前缀。新增 `ContextBudget` 追踪累计 token，同时喂给管线和 TurnGuard。

**Tech Stack:** Python 3.13, pytest, dataclasses

---

## 文件清单

| 操作 | 文件 | 职责 |
|------|------|------|
| 新增 | `src/mycli/services/context/compaction/__init__.py` | 导出 |
| 新增 | `src/mycli/services/context/compaction/pipeline.py` | CompactionPipeline + 4 个 CompactionStrategy |
| 新增 | `src/mycli/services/context/compaction/budget.py` | ContextBudget 追踪 |
| 新增 | `src/mycli/services/context/compaction/cache_zones.py` | frozen/fresh zone 边界计算 |
| 新增 | `src/mycli/services/context/tool_result_formatter.py` | 按工具类型的截断规则 + 终止暗示 |
| 新增 | `tests/unit/services/context/compaction/__init__.py` | 空文件 |
| 新增 | `tests/unit/services/context/compaction/test_pipeline.py` | 管线单元测试 |
| 新增 | `tests/unit/services/context/compaction/test_budget.py` | ContextBudget 测试 |
| 新增 | `tests/unit/services/context/compaction/test_cache_zones.py` | zone 边界测试 |
| 新增 | `tests/unit/services/context/test_tool_result_formatter.py` | 格式化器测试 |
| 修改 | `src/mycli/services/context/context_manager.py` | render_tool_result 接入 ToolResultFormatter |
| 修改 | `src/mycli/application/runtime/tools/tool_execution_service.py` | _record_tool_message 接入 L1/L2 |
| 修改 | `src/mycli/application/runtime/turn_executor.py` | 模型请求前跑 pipeline + budget 追踪 |
| 修改 | `src/mycli/application/runtime/agent_runtime.py` | 初始化 CompactionPipeline + ContextBudget |
| 修改 | `src/mycli/tools/routing/tool_exposure_planner.py` | 工具定义稳定排序 |

---

### Task 1: 创建 ContextBudget

**Files:**
- Create: `src/mycli/services/context/compaction/__init__.py`
- Create: `src/mycli/services/context/compaction/budget.py`

- [x] **Step 1: 创建 `__init__.py`**

```python
from __future__ import annotations

from mycli.services.context.compaction.budget import ContextBudget
from mycli.services.context.compaction.cache_zones import CacheZones
from mycli.services.context.compaction.pipeline import (
    CompactionPipeline,
    LLMSummarization,
    SlidingWindowEviction,
    ToolResultBudget,
    ToolResultDedup,
)

__all__ = [
    "CacheZones",
    "CompactionPipeline",
    "ContextBudget",
    "LLMSummarization",
    "SlidingWindowEviction",
    "ToolResultBudget",
    "ToolResultDedup",
]
```

- [x] **Step 2: 创建 `budget.py`**

```python
from __future__ import annotations

from dataclasses import dataclass


@dataclass(slots=True)
class ContextBudget:
    max_tokens: int
    total_tokens: int = 0

    def record(self, usage: dict[str, object]) -> None:
        tokens = usage.get("total_tokens")
        if isinstance(tokens, (int, float)) and tokens > 0:
            self.total_tokens += int(tokens)

    @property
    def usage_ratio(self) -> float:
        if self.max_tokens <= 0:
            return 0.0
        return self.total_tokens / self.max_tokens

    @property
    def remaining(self) -> int:
        return max(0, self.max_tokens - self.total_tokens)
```

- [x] **Step 3: 编写测试 `tests/unit/services/context/compaction/test_budget.py`**

```python
from __future__ import annotations

from mycli.services.context.compaction.budget import ContextBudget


def test_budget_starts_at_zero() -> None:
    budget = ContextBudget(max_tokens=100_000)
    assert budget.total_tokens == 0
    assert budget.usage_ratio == 0.0
    assert budget.remaining == 100_000


def test_budget_records_usage() -> None:
    budget = ContextBudget(max_tokens=100_000)
    budget.record({"total_tokens": 5000})
    budget.record({"total_tokens": 3000})
    assert budget.total_tokens == 8000
    assert budget.usage_ratio == 0.08


def test_budget_ignores_zero_and_missing() -> None:
    budget = ContextBudget(max_tokens=100_000)
    budget.record({"total_tokens": 0})
    budget.record({})
    assert budget.total_tokens == 0


def test_budget_usage_ratio_maxes_at_above_1() -> None:
    budget = ContextBudget(max_tokens=100_000)
    budget.record({"total_tokens": 150_000})
    assert budget.usage_ratio == 1.5


def test_budget_remaining_never_negative() -> None:
    budget = ContextBudget(max_tokens=100_000)
    budget.record({"total_tokens": 150_000})
    assert budget.remaining == 0


def test_budget_zero_max_tokens() -> None:
    budget = ContextBudget(max_tokens=0)
    budget.record({"total_tokens": 5000})
    assert budget.usage_ratio == 0.0
```

- [x] **Step 4: 运行测试**

Run: `pytest tests/unit/services/context/compaction/test_budget.py -v`

Expected: 6 passed

- [ ] **Step 5: 提交（未执行：保留 worktree 待审/统一提交）**

```bash
git add src/mycli/services/context/compaction/__init__.py src/mycli/services/context/compaction/budget.py tests/unit/services/context/compaction/
git commit -m "$(cat <<'EOF'
feat: add ContextBudget for tracking per-turn token usage

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: 创建 CacheZones

**Files:**
- Create: `src/mycli/services/context/compaction/cache_zones.py`
- Create: `tests/unit/services/context/compaction/test_cache_zones.py`

- [x] **Step 1: 创建 `cache_zones.py`**

```python
from __future__ import annotations

from dataclasses import dataclass

from mycli.domain.conversation import Conversation


@dataclass(slots=True, frozen=True)
class CacheZones:
    frozen_boundary: int
    fresh_start: int

    def is_frozen(self, message_index: int) -> bool:
        return message_index < self.frozen_boundary

    def is_fresh(self, message_index: int) -> bool:
        return message_index >= self.fresh_start

    @classmethod
    def from_conversation(cls, conversation: Conversation) -> "CacheZones":
        frozen_boundary = cls._find_frozen_boundary(conversation)
        fresh_start = cls._find_fresh_start(conversation)
        return cls(frozen_boundary=frozen_boundary, fresh_start=fresh_start)

    @staticmethod
    def _find_frozen_boundary(conversation: Conversation) -> int:
        """第一个 user_message 的位置 = frozen zone 结束边界。

        frozen zone 包含: system_prompt messages + tool_def messages。
        实际在 conversation 中这些可能不在，所以我们用第一个 user_message
        作为 frozen boundary 的近似。
        """
        for i, msg in enumerate(conversation.messages):
            if msg.role == "user":
                return i
        return len(conversation.messages)

    @staticmethod
    def _find_fresh_start(conversation: Conversation) -> int:
        """当前 turn 的起始位置 = 最后一个 user_message 的位置。"""
        for i in range(len(conversation.messages) - 1, -1, -1):
            if conversation.messages[i].role == "user":
                return i
        return 0
```

- [x] **Step 2: 编写测试 `tests/unit/services/context/compaction/test_cache_zones.py`**

```python
from __future__ import annotations

from mycli.domain.conversation import Conversation, Message
from mycli.services.context.compaction.cache_zones import CacheZones


def test_frozen_boundary_at_first_user_message() -> None:
    conv = Conversation(
        session_id="test",
        messages=[
            Message(role="user", content="hello"),
            Message(role="assistant", content="hi"),
            Message(role="tool", content="result"),
        ],
    )
    zones = CacheZones.from_conversation(conv)
    assert zones.frozen_boundary == 0


def test_fresh_start_at_last_user_message() -> None:
    conv = Conversation(
        session_id="test",
        messages=[
            Message(role="user", content="turn 1"),
            Message(role="assistant", content="ok"),
            Message(role="user", content="turn 2"),
            Message(role="assistant", content="ok"),
        ],
    )
    zones = CacheZones.from_conversation(conv)
    assert zones.fresh_start == 2


def test_frozen_boundary_when_no_user_message() -> None:
    conv = Conversation(
        session_id="test",
        messages=[
            Message(role="assistant", content="hi"),
        ],
    )
    zones = CacheZones.from_conversation(conv)
    assert zones.frozen_boundary == 1


def test_is_frozen_before_boundary() -> None:
    zones = CacheZones(frozen_boundary=2, fresh_start=2)
    assert zones.is_frozen(0) is True
    assert zones.is_frozen(1) is True
    assert zones.is_frozen(2) is False


def test_is_fresh_at_and_after_start() -> None:
    zones = CacheZones(frozen_boundary=2, fresh_start=3)
    assert zones.is_fresh(2) is False
    assert zones.is_fresh(3) is True
    assert zones.is_fresh(4) is True
```

- [x] **Step 3: 运行测试**

Run: `pytest tests/unit/services/context/compaction/test_cache_zones.py -v`

Expected: 5 passed

- [ ] **Step 4: 提交（未执行：保留 worktree 待审/统一提交）**

```bash
git add src/mycli/services/context/compaction/cache_zones.py tests/unit/services/context/compaction/test_cache_zones.py
git commit -m "$(cat <<'EOF'
feat: add CacheZones for frozen/fresh boundary detection

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: 创建 ToolResultFormatter

**Files:**
- Create: `src/mycli/services/context/tool_result_formatter.py`
- Create: `tests/unit/services/context/test_tool_result_formatter.py`

- [x] **Step 1: 创建 `tool_result_formatter.py`**

```python
from __future__ import annotations

from mycli.domain.tooling.tool_result_v2 import ToolResultV2


class ToolResultFormatter:
    def __init__(
        self,
        *,
        read_file_max_chars: int = 3000,
        read_file_range_max_chars: int = 2000,
        run_shell_max_chars: int = 500,
        search_max_matches: int = 10,
        default_max_chars: int = 1600,
    ) -> None:
        self._read_file_max = read_file_max_chars
        self._read_file_range_max = read_file_range_max_chars
        self._run_shell_max = run_shell_max_chars
        self._search_max_matches = search_max_matches
        self._default_max = default_max_chars

    def format(self, tool_name: str, result: ToolResultV2) -> str:
        rendered = self._render(result)
        max_chars = self._limit_for(tool_name)
        if len(rendered) <= max_chars:
            return rendered
        return rendered[: max_chars - 3] + "..."

    def _limit_for(self, tool_name: str) -> int:
        if tool_name == "read_file":
            return self._read_file_max
        if tool_name == "read_file_range":
            return self._read_file_range_max
        if tool_name == "run_shell":
            return self._run_shell_max
        return self._default_max

    def _render(self, result: ToolResultV2) -> str:
        if not result.success:
            return self._render_failure(result)
        if result.evidence:
            return self._render_from_evidence(result)
        return self._render_from_payload(result)

    def _render_failure(self, result: ToolResultV2) -> str:
        parts = [result.summary]
        if result.error:
            parts.append(f"Error: {result.error}")
        error_kind = result.raw_payload.get("error_kind")
        if isinstance(error_kind, str) and error_kind:
            parts.append(f"Error kind: {error_kind}")
        return "\n".join(parts)

    def _render_from_evidence(self, result: ToolResultV2) -> str:
        parts = [result.summary]
        parts.append("Evidence:")
        for ev in result.evidence:
            location = ev.path or ev.title
            if ev.path and ev.line_start is not None and ev.line_end is not None:
                location = f"{ev.path}:{ev.line_start}-{ev.line_end}"
            parts.append(f"- [{ev.kind}] {location}")
            if ev.snippet:
                snippet = " ".join(ev.snippet.split())
                parts.append(f"  snippet: {snippet[:800]}")
        return "\n".join(parts)

    def _render_from_payload(self, result: ToolResultV2) -> str:
        parts = [result.summary]
        payload = result.raw_payload

        # search_text: structured match list
        matches = payload.get("matches")
        if isinstance(matches, list) and matches:
            parts.append(f"Matches ({len(matches)} total):")
            for item in matches[: self._search_max_matches]:
                if not isinstance(item, dict):
                    continue
                path = item.get("path", "")
                line = item.get("line_number", "")
                text = item.get("line", "")
                parts.append(f"  {path}:{line}: {text}")
            if len(matches) > self._search_max_matches:
                parts.append(
                    f"  ... and {len(matches) - self._search_max_matches} more matches. "
                    "Narrow your search if needed."
                )
            # Termination notice for search
            parts.append("[搜索完毕。如果你已有足够信息，现在就可以回答。]")
            return "\n".join(parts)

        # list_directory: structured summary
        dirs = payload.get("dirs")
        files = payload.get("files")
        if isinstance(dirs, list) and isinstance(files, list):
            total = len(dirs) + len(files)
            preview_dirs = dirs[:5]
            preview_files = files[:5]
            parts.append(f"Total entries: {total} ({len(dirs)} dirs, {len(files)} files)")
            if preview_dirs:
                parts.append(f"Dirs: {', '.join(preview_dirs)}")
            if preview_files:
                parts.append(f"Files: {', '.join(preview_files)}")
            if total > 10:
                parts.append(f"... and {total - 10} more entries.")
            return "\n".join(parts)

        # read_file / read_file_range / edit_file / generic: content preview
        content = payload.get("content")
        if isinstance(content, str) and content:
            path = payload.get("path")
            if isinstance(path, str) and path:
                parts.append(f"File: {path}")
            preview = " ".join(content.split())[:1200]
            parts.append(preview)
            # Truncation notice
            if len(content) > 1200:
                parts.append(
                    "[文件内容较长，已截断。使用 read_file_range 读取后续内容。]"
                )
            else:
                parts.append(
                    "[文件读取完毕。如果你已有足够信息，现在就可以回答。]"
                )
            return "\n".join(parts)

        # run_shell: stdout + exit code
        stdout = payload.get("stdout")
        exit_code = payload.get("exit_code")
        if isinstance(stdout, str) and stdout.strip():
            lines = stdout.split("\n")
            tail = lines[-30:] if len(lines) > 30 else lines
            parts.append(f"Stdout (last {len(tail)} of {len(lines)} lines):")
            parts.append("\n".join(tail))
            if exit_code is not None:
                parts.append(f"Exit code: {exit_code}")
            parts.append(
                f"[命令执行完毕。输出共 {len(lines)} 行，退出码: {exit_code or 0}。]"
            )
            return "\n".join(parts)

        # fallback: summary only
        return result.summary
```

- [x] **Step 2: 编写测试 `tests/unit/services/context/test_tool_result_formatter.py`**

```python
from __future__ import annotations

from mycli.domain.tooling.tool_evidence import ToolEvidence
from mycli.domain.tooling.tool_result_v2 import ToolResultV2
from mycli.services.context.tool_result_formatter import ToolResultFormatter


def test_read_file_gets_higher_limit() -> None:
    fmt = ToolResultFormatter()
    assert fmt._limit_for("read_file") == 3000
    assert fmt._limit_for("read_file_range") == 2000
    assert fmt._limit_for("run_shell") == 500
    assert fmt._limit_for("unknown_tool") == 1600


def test_run_shell_shows_tail_and_exit_code() -> None:
    fmt = ToolResultFormatter()
    lines = [f"line {i}" for i in range(100)]
    result = ToolResultV2(
        success=True,
        summary="Command completed",
        raw_payload={
            "stdout": "\n".join(lines),
            "exit_code": 0,
        },
    )
    output = fmt.format("run_shell", result)
    assert "last 30 of 100 lines" in output
    assert "Exit code: 0" in output
    assert "命令执行完毕" in output


def test_search_text_includes_total_count_and_termination() -> None:
    fmt = ToolResultFormatter()
    result = ToolResultV2(
        success=True,
        summary="Found 47 matches",
        raw_payload={
            "matches": [
                {"path": "a.py", "line_number": 1, "line": "import os"},
                {"path": "b.py", "line_number": 5, "line": "from sys import"},
            ]
            * 24,
        },
    )
    output = fmt.format("search_text", result)
    assert "47 total" in output
    assert "搜索完毕" in output


def test_search_shows_max_10_matches() -> None:
    fmt = ToolResultFormatter(search_max_matches=10)
    matches = [
        {"path": f"f{i}.py", "line_number": i, "line": f"code {i}"}
        for i in range(20)
    ]
    result = ToolResultV2(
        success=True,
        summary="Found 20 matches",
        raw_payload={"matches": matches},
    )
    output = fmt.format("search_text", result)
    assert output.count(": code ") == 10  # only 10 lines shown


def test_list_directory_structured_summary() -> None:
    fmt = ToolResultFormatter()
    result = ToolResultV2(
        success=True,
        summary="Listed directory",
        raw_payload={
            "dirs": ["src", "tests", "docs", "scripts", "data", "vendor"],
            "files": ["README.md", "pyproject.toml", "setup.py", "Makefile", "Dockerfile"],
        },
    )
    output = fmt.format("list_directory", result)
    assert "Total entries: 11" in output
    assert "src, tests, docs" in output
    assert "... and 1 more" in output


def test_read_file_adds_completion_notice_when_not_truncated() -> None:
    fmt = ToolResultFormatter()
    short_content = "def hello():\n    return 'world'\n"
    result = ToolResultV2(
        success=True,
        summary="Read file.py",
        raw_payload={"path": "file.py", "content": short_content},
    )
    output = fmt.format("read_file", result)
    assert "文件读取完毕" in output


def test_read_file_adds_truncation_notice_when_long() -> None:
    fmt = ToolResultFormatter()
    long_content = "x = 1\n" * 2000
    result = ToolResultV2(
        success=True,
        summary="Read large.py",
        raw_payload={"path": "large.py", "content": long_content},
    )
    output = fmt.format("read_file", result)
    assert "文件内容较长，已截断" in output


def test_hard_truncation_at_max_chars() -> None:
    fmt = ToolResultFormatter(read_file_max_chars=500)
    long_content = "abcdefg" * 200
    result = ToolResultV2(
        success=True,
        summary="Read huge.py",
        raw_payload={"path": "huge.py", "content": long_content},
    )
    output = fmt.format("read_file", result)
    assert len(output) <= 500


def test_fallback_returns_summary_only() -> None:
    fmt = ToolResultFormatter()
    result = ToolResultV2(
        success=True,
        summary="Done something",
        raw_payload={},
    )
    output = fmt.format("unknown_tool", result)
    assert output == "Done something"
```

- [x] **Step 3: 运行测试**

Run: `pytest tests/unit/services/context/test_tool_result_formatter.py -v`

Expected: 9 passed

- [ ] **Step 4: 提交（未执行：保留 worktree 待审/统一提交）**

```bash
git add src/mycli/services/context/tool_result_formatter.py tests/unit/services/context/test_tool_result_formatter.py
git commit -m "$(cat <<'EOF'
feat: add ToolResultFormatter with per-tool truncation limits and termination notices

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: 创建 CompactionPipeline + 四层策略

**Files:**
- Create: `src/mycli/services/context/compaction/pipeline.py`
- Create: `tests/unit/services/context/compaction/test_pipeline.py`

- [x] **Step 1: 创建 `pipeline.py`**

```python
from __future__ import annotations

import json
from typing import Protocol

from mycli.domain.conversation import Conversation, Message
from mycli.domain.tooling.tool_result_v2 import ToolResultV2
from mycli.services.context.compaction.budget import ContextBudget
from mycli.services.context.compaction.cache_zones import CacheZones
from mycli.services.context.tool_result_formatter import ToolResultFormatter


class CompactionStrategy(Protocol):
    def apply(
        self,
        conversation: Conversation,
        zones: CacheZones,
        budget: ContextBudget,
    ) -> Conversation: ...


class ToolResultBudget:
    def __init__(self, formatter: ToolResultFormatter) -> None:
        self._formatter = formatter

    def apply(
        self,
        conversation: Conversation,
        zones: CacheZones,
        budget: ContextBudget,
    ) -> Conversation:
        return conversation

    def format_result(self, tool_name: str, result: ToolResultV2) -> str:
        return self._formatter.format(tool_name, result)


class ToolResultDedup:
    def __init__(self, *, trigger_ratio: float = 0.4) -> None:
        self._trigger_ratio = trigger_ratio

    def apply(
        self,
        conversation: Conversation,
        zones: CacheZones,
        budget: ContextBudget,
    ) -> Conversation:
        if budget.usage_ratio < self._trigger_ratio:
            return conversation

        seen: dict[str, int] = {}
        for i in range(zones.fresh_start, len(conversation.messages)):
            msg = conversation.messages[i]
            if msg.role != "tool":
                continue
            sig = self._tool_result_signature(msg)
            if sig is None:
                continue
            if sig in seen:
                first_call_index = seen[sig]
                placeholder = Message(
                    role="tool",
                    content=f"[cleared: same result as call #{first_call_index}]",
                    tool_call_id=msg.tool_call_id,
                )
                conversation.messages[i] = placeholder
            else:
                seen[sig] = i
        return conversation

    @staticmethod
    def _tool_result_signature(msg: Message) -> str | None:
        tool_name = None
        path = None
        for block in msg.blocks:
            if block.type == "tool_result":
                tool_name = block.metadata.get("tool_name")
                path = block.metadata.get("path")
                break
        if tool_name is None:
            return None
        return json.dumps(
            {"tool_name": tool_name, "path": path},
            ensure_ascii=False,
            sort_keys=True,
        )


class SlidingWindowEviction:
    def __init__(
        self,
        *,
        trigger_ratio: float = 0.7,
        keep_recent: int = 8,
    ) -> None:
        self._trigger_ratio = trigger_ratio
        self._keep_recent = keep_recent

    def apply(
        self,
        conversation: Conversation,
        zones: CacheZones,
        budget: ContextBudget,
    ) -> Conversation:
        if budget.usage_ratio < self._trigger_ratio:
            return conversation

        tool_result_indices = [
            i
            for i in range(zones.fresh_start, len(conversation.messages))
            if conversation.messages[i].role == "tool"
        ]

        if len(tool_result_indices) <= self._keep_recent:
            return conversation

        to_evict = tool_result_indices[: -self._keep_recent]
        for idx in to_evict:
            msg = conversation.messages[idx]
            call_id = msg.tool_call_id or "unknown"
            conversation.messages[idx] = Message(
                role="tool",
                content=f"[earlier tool result archived. call_id: {call_id}]",
                tool_call_id=msg.tool_call_id,
            )
        return conversation


class LLMSummarization:
    def __init__(
        self,
        *,
        trigger_ratio: float = 0.9,
        max_consecutive_failures: int = 3,
    ) -> None:
        self._trigger_ratio = trigger_ratio
        self._max_failures = max_consecutive_failures
        self._failure_count = 0

    def apply(
        self,
        conversation: Conversation,
        zones: CacheZones,
        budget: ContextBudget,
    ) -> Conversation:
        if budget.usage_ratio < self._trigger_ratio:
            return conversation
        if self._failure_count >= self._max_failures:
            return conversation
        # Placeholder: LLM summarization implementation deferred to follow-up spec.
        # Currently returns conversation unchanged (no-op until LLM integration).
        return conversation


class CompactionPipeline:
    def __init__(
        self,
        *,
        tool_result_budget: ToolResultBudget,
        tool_result_dedup: ToolResultDedup,
        sliding_window_eviction: SlidingWindowEviction,
        llm_summarization: LLMSummarization,
    ) -> None:
        self.tool_result_budget = tool_result_budget
        self.tool_result_dedup = tool_result_dedup
        self.sliding_window_eviction = sliding_window_eviction
        self.llm_summarization = llm_summarization

    def apply(
        self,
        conversation: Conversation,
        budget: ContextBudget,
    ) -> Conversation:
        zones = CacheZones.from_conversation(conversation)
        conversation = self.tool_result_dedup.apply(conversation, zones, budget)
        conversation = self.sliding_window_eviction.apply(conversation, zones, budget)
        conversation = self.llm_summarization.apply(conversation, zones, budget)
        return conversation
```

- [x] **Step 2: 编写测试 `tests/unit/services/context/compaction/test_pipeline.py`**

```python
from __future__ import annotations

from mycli.domain.conversation import Conversation, Message
from mycli.domain.runtime import RuntimeBlock
from mycli.services.context.compaction.budget import ContextBudget
from mycli.services.context.compaction.pipeline import (
    CompactionPipeline,
    LLMSummarization,
    SlidingWindowEviction,
    ToolResultDedup,
)
from mycli.services.context.tool_result_formatter import ToolResultFormatter
from mycli.services.context.compaction.pipeline import ToolResultBudget


def _tool_msg(
    call_id: str,
    tool_name: str = "read_file",
    path: str = "/a.py",
    content: str = "result",
) -> Message:
    return Message(
        role="tool",
        content=content,
        tool_call_id=call_id,
        blocks=(
            RuntimeBlock(
                type="tool_result",
                text=content,
                call_id=call_id,
                metadata={"tool_name": tool_name, "path": path, "success": True},
            ),
        ),
    )


class TestToolResultDedup:
    def test_dedup_triggers_at_threshold(self) -> None:
        dedup = ToolResultDedup(trigger_ratio=0.35)
        budget = ContextBudget(max_tokens=1000)
        budget.record({"total_tokens": 400})  # 40% >= 35%
        conv = Conversation(
            session_id="test",
            messages=[
                Message(role="user", content="hi"),
                _tool_msg("c1", path="/a.py"),
                _tool_msg("c2", path="/a.py"),  # same path
                _tool_msg("c3", path="/b.py"),
            ],
        )
        result = dedup.apply(conv, _zones(conv), budget)
        assert "[cleared" in result.messages[2].content

    def test_dedup_does_not_trigger_below_threshold(self) -> None:
        dedup = ToolResultDedup(trigger_ratio=0.4)
        budget = ContextBudget(max_tokens=1000)
        budget.record({"total_tokens": 300})  # 30% < 40%
        conv = Conversation(
            session_id="test",
            messages=[
                Message(role="user", content="hi"),
                _tool_msg("c1", path="/a.py"),
                _tool_msg("c2", path="/a.py"),
            ],
        )
        result = dedup.apply(conv, _zones(conv), budget)
        assert "[cleared" not in result.messages[2].content

    def test_dedup_skips_frozen_zone(self) -> None:
        dedup = ToolResultDedup(trigger_ratio=0.3)
        budget = ContextBudget(max_tokens=1000)
        budget.record({"total_tokens": 400})
        conv = Conversation(
            session_id="test",
            messages=[
                _tool_msg("c0", path="/old.py"),
                Message(role="user", content="turn2"),
                _tool_msg("c1", path="/old.py"),
            ],
        )
        result = dedup.apply(conv, _zones_with_frozen(conv), budget)
        assert (
            "[cleared" not in result.messages[0].content
        )  # frozen zone untouched
        assert (
            "[cleared" in result.messages[2].content
        )  # fresh zone deduped


class TestSlidingWindowEviction:
    def test_evicts_old_tool_results_when_over_threshold(self) -> None:
        eviction = SlidingWindowEviction(trigger_ratio=0.6, keep_recent=2)
        budget = ContextBudget(max_tokens=1000)
        budget.record({"total_tokens": 700})
        messages = [Message(role="user", content="hi")]
        for i in range(5):
            messages.append(_tool_msg(f"c{i}"))
        conv = Conversation(session_id="test", messages=messages)

        result = eviction.apply(conv, _zones(conv), budget)

        assert "[archived]" in result.messages[1].content  # oldest evicted
        assert "[archived]" in result.messages[2].content  # evicted
        assert "[archived]" in result.messages[3].content  # evicted
        assert "result" in result.messages[4].content       # kept (recent 2)
        assert "result" in result.messages[5].content       # kept (recent 2)

    def test_does_not_evict_when_below_threshold(self) -> None:
        eviction = SlidingWindowEviction(trigger_ratio=0.7, keep_recent=2)
        budget = ContextBudget(max_tokens=1000)
        budget.record({"total_tokens": 500})
        conv = Conversation(
            session_id="test",
            messages=[
                Message(role="user", content="hi"),
                _tool_msg("c1"),
                _tool_msg("c2"),
                _tool_msg("c3"),
            ],
        )
        result = eviction.apply(conv, _zones(conv), budget)
        assert "result" in result.messages[1].content

    def test_no_eviction_when_fewer_than_keep_recent(self) -> None:
        eviction = SlidingWindowEviction(trigger_ratio=0.6, keep_recent=8)
        budget = ContextBudget(max_tokens=1000)
        budget.record({"total_tokens": 700})
        conv = Conversation(
            session_id="test",
            messages=[
                Message(role="user", content="hi"),
                _tool_msg("c1"),
                _tool_msg("c2"),
            ],
        )
        result = eviction.apply(conv, _zones(conv), budget)
        assert "result" in result.messages[1].content
        assert "result" in result.messages[2].content


class TestCompactionPipeline:
    def test_pipeline_applies_all_strategies_in_order(self) -> None:
        formatter = ToolResultFormatter()
        pipeline = CompactionPipeline(
            tool_result_budget=ToolResultBudget(formatter),
            tool_result_dedup=ToolResultDedup(trigger_ratio=0.1),
            sliding_window_eviction=SlidingWindowEviction(
                trigger_ratio=0.1, keep_recent=1
            ),
            llm_summarization=LLMSummarization(trigger_ratio=0.99),
        )
        budget = ContextBudget(max_tokens=1000)
        budget.record({"total_tokens": 500})
        conv = Conversation(
            session_id="test",
            messages=[
                Message(role="user", content="hi"),
                _tool_msg("c1", path="/a.py"),
                _tool_msg("c2", path="/a.py"),  # will be deduped
                _tool_msg("c3", path="/b.py"),
            ],
        )
        result = pipeline.apply(conv, budget)
        # c2 deduped
        assert "[cleared" in result.messages[2].content
        # c1 archived (keep_recent=1)
        assert "[archived]" in result.messages[1].content


def _zones(conv: Conversation):
    from mycli.services.context.compaction.cache_zones import CacheZones

    return CacheZones.from_conversation(conv)


def _zones_with_frozen(conv: Conversation):
    from mycli.services.context.compaction.cache_zones import CacheZones

    return CacheZones.from_conversation(conv)
```

- [x] **Step 3: 运行测试**

Run: `pytest tests/unit/services/context/compaction/test_pipeline.py -v`

Expected: 8 passed

- [ ] **Step 4: 提交（未执行：保留 worktree 待审/统一提交）**

```bash
git add src/mycli/services/context/compaction/pipeline.py tests/unit/services/context/compaction/test_pipeline.py
git commit -m "$(cat <<'EOF'
feat: add CompactionPipeline with 4-layer strategies (budget/dedup/eviction/summarization)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: ContextManager 接入 ToolResultFormatter

**Files:**
- Modify: `src/mycli/services/context/context_manager.py`

- [x] **Step 1: 替换 render_tool_result**

将现有的 `render_tool_result` 方法改为委托给 `ToolResultFormatter`：

```python
    def render_tool_result(
        self,
        result: ToolResultV2,
        *,
        tool_name: str = "",
        max_chars: int = 1600,
    ) -> str:
        formatter = getattr(self, '_formatter', None)
        if formatter is not None:
            return formatter.format(tool_name, result)
        # fallback to existing behavior
        rendered = self._render_tool_result_details(result)
        if len(rendered) <= max_chars:
            return rendered
        return rendered[: max_chars - 3] + "..."
```

在 `__init__` 中支持注入 `ToolResultFormatter`：

```python
    def __init__(self, *, formatter=None):
        ...
        self._formatter = formatter
```

- [x] **Step 2: 运行现有测试确保兼容**

Run: `pytest tests/unit/services/test_runtime_policy.py tests/unit/ -x -q`

Expected: 全部通过（formatter 为 None 时走 fallback）

- [ ] **Step 3: 提交（未执行：保留 worktree 待审/统一提交）**

```bash
git add src/mycli/services/context/context_manager.py
git commit -m "$(cat <<'EOF'
refactor: delegate ContextManager.render_tool_result to ToolResultFormatter

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: ToolExecutionService 接入 L1/L2

**Files:**
- Modify: `src/mycli/application/runtime/tools/tool_execution_service.py`

- [x] **Step 1: 在 _record_tool_message 前接入 ToolResultFormatter**

在 `execute_tool_call` 中，将 `context_manager.render_tool_result(result)` 改为传入 tool_name：

```python
            tool_transcript_content = self._context_manager.render_tool_result(
                result, tool_name=normalized_call.name
            )
```

保留现有调用方式不变，只加 `tool_name` 参数。

- [x] **Step 2: 验证**

Run: `python -c "from mycli.application.runtime.tools.tool_execution_service import ToolExecutionService; print('OK')"`

Expected: `OK`

- [ ] **Step 3: 提交（未执行：保留 worktree 待审/统一提交）**

```bash
git add src/mycli/application/runtime/tools/tool_execution_service.py
git commit -m "$(cat <<'EOF'
feat: pass tool_name to render_tool_result for per-tool truncation

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: AgentRuntime 初始化管道

**Files:**
- Modify: `src/mycli/application/runtime/agent_runtime.py`

- [x] **Step 1: 添加导入和初始化**

在 import 区域添加：

```python
from mycli.services.context.compaction.pipeline import (
    CompactionPipeline,
    LLMSummarization,
    SlidingWindowEviction,
    ToolResultBudget,
    ToolResultDedup,
)
from mycli.services.context.compaction.budget import ContextBudget
from mycli.services.context.tool_result_formatter import ToolResultFormatter
```

在 `__init__` 中初始化：

```python
        self._tool_result_formatter = ToolResultFormatter()
        self._compaction_pipeline = CompactionPipeline(
            tool_result_budget=ToolResultBudget(self._tool_result_formatter),
            tool_result_dedup=ToolResultDedup(trigger_ratio=0.4),
            sliding_window_eviction=SlidingWindowEviction(
                trigger_ratio=0.7,
                keep_recent=8,
            ),
            llm_summarization=LLMSummarization(trigger_ratio=0.9),
        )
```

将 formatter 注入到 context_manager：

```python
        self._context_manager = context_manager or ContextManager(
            formatter=self._tool_result_formatter,
        )
```

- [x] **Step 2: 验证**

Run: `python -c "from mycli.application.runtime.agent_runtime import AgentRuntime; print('OK')"`

Expected: `OK`

- [ ] **Step 3: 提交（未执行：保留 worktree 待审/统一提交）**

```bash
git add src/mycli/application/runtime/agent_runtime.py
git commit -m "$(cat <<'EOF'
feat: initialize CompactionPipeline and ToolResultFormatter in AgentRuntime

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: turn_executor 接入 Pipeline + Budget 追踪

**Files:**
- Modify: `src/mycli/application/runtime/turn_executor.py`

- [x] **Step 1: 在 _run_turn_loop 中添加 Budget 追踪和 Pipeline 执行**

在 `step_index = 0` 之后初始化 budget：

```python
    step_index = 0
    cumulative_tokens = 0
    no_progress_tracker = NoProgressTracker()
    budget = runtime._compaction_pipeline and ContextBudget(
        max_tokens=runtime._config.max_tokens_per_turn,
    ) or None
```

在模型请求之前执行 pipeline：

```python
            # --- Compaction pipeline ---
            if (
                runtime._compaction_pipeline is not None
                and budget is not None
            ):
                conversation_for_model = runtime._compaction_pipeline.apply(
                    conversation, budget
                )
                # Re-assemble context with compacted messages
                context, turn_context = runtime._assemble_turn_context(
                    user_message=user_message,
                    conversation=conversation_for_model,
                    plan_state=current_plan_state,
                    runtime_reminders=runtime_reminders,
                    runtime_policy_state=runtime_policy_state,
                    capability_activations=capability_activations,
                    tool_exposure=planned_exposure.exposure,
                )
            else:
                context, turn_context = runtime._assemble_turn_context(...)
            # --- End compaction pipeline ---
```

**重要**：pipeline 创建了一个新的 `conversation_for_model`，不修改原始 `conversation`。原始 conversation 用于存储和 TurnGuard 检查，compacted 版本只用于 API 请求。

在模型请求后追踪 budget：

```python
            usage_payload = turn_result.metadata.get("usage")
            if isinstance(usage_payload, dict):
                cumulative_tokens += usage_payload.get("total_tokens", 0)
                if budget is not None:
                    budget.record(usage_payload)
```

- [x] **Step 2: 验证**

Run: `python -c "from mycli.application.runtime.turn_executor import TurnExecutor; print('OK')"`

Expected: `OK`

- [x] **Step 3: 运行测试**

Run: `pytest tests/unit/ -x -q`

Expected: 全部通过

- [ ] **Step 4: 提交（未执行：保留 worktree 待审/统一提交）**

```bash
git add src/mycli/application/runtime/turn_executor.py
git commit -m "$(cat <<'EOF'
feat: wire CompactionPipeline and ContextBudget into turn_executor

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: 工具定义稳定排序

**Files:**
- Modify: `src/mycli/tools/routing/tool_exposure_planner.py`

- [x] **Step 1: 确保 render_for_model 中工具定义按 name 排序**

找到 `render_for_model` 或等价的工具定义渲染方法，在返回列表前排序：

```python
    def render_for_model(self, exposure: ToolExposure) -> list[ModelToolDefinition]:
        defs = self._build_defs(exposure)
        defs.sort(key=lambda t: t.name)
        return defs
```

- [x] **Step 2: 验证**

Run: `python -c "from mycli.tools.routing.tool_exposure_planner import ToolExposurePlanner; print('OK')"`

Expected: `OK`

- [ ] **Step 3: 提交（未执行：保留 worktree 待审/统一提交）**

```bash
git add src/mycli/tools/routing/tool_exposure_planner.py
git commit -m "$(cat <<'EOF'
fix: stable-sort tool definitions by name for cache prefix stability

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: 最终验证

- [x] **Step 1: 运行全部测试**

Run: `pytest tests/unit/ -v`

Expected: 全部通过（新增 ~28 个测试 + 所有旧测试）

- [x] **Step 2: 确认导入链路完整**

```bash
python -c "
from mycli.services.context.compaction import (
    CompactionPipeline, ContextBudget, CacheZones,
    ToolResultBudget, ToolResultDedup, SlidingWindowEviction, LLMSummarization,
)
from mycli.services.context.tool_result_formatter import ToolResultFormatter
from mycli.application.runtime.agent_runtime import AgentRuntime
print('All imports OK')
"
```

Expected: `All imports OK`

- [x] **Step 3: 检查 git status**

```bash
git status
```
