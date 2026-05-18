from __future__ import annotations

from pathlib import Path

from mycli.application.runtime.agent_runtime import AgentRuntime
from mycli.domain.conversation import Conversation, Message
from mycli.domain.runtime import AgentConfig, RuntimeBlock
from mycli.services.context.compaction.budget import ContextBudget
from mycli.services.context.compaction.cache_zones import CacheZones
from mycli.services.context.compaction.pipeline import LLMSummarization, _collect_recent_files


def _make_tool_msg(tool_name: str, path: str, tool_call_id: str = "c1") -> Message:
    return Message(
        role="tool",
        content="ok",
        tool_call_id=tool_call_id,
        metadata={"tool_name": tool_name, "path": path},
        blocks=(
            RuntimeBlock(
                type="tool_result",
                text="ok",
                call_id=tool_call_id,
                metadata={"tool_name": tool_name, "path": path},
            ),
        ),
    )


class TestRehydration:
    def test_collects_edited_first(self) -> None:
        msgs = [
            _make_tool_msg("Read", "a.py", "c1"),
            _make_tool_msg("Read", "b.py", "c2"),
            _make_tool_msg("Edit", "c.py", "c3"),
        ]

        result = _collect_recent_files(msgs, n=3)

        assert result[0] == "c.py"

    def test_no_files_returns_empty(self) -> None:
        msgs = [Message(role="user", content="hello")]

        assert _collect_recent_files(msgs) == []

    def test_deduplicates_paths(self) -> None:
        msgs = [
            _make_tool_msg("Read", "auth.py", "c1"),
            _make_tool_msg("Read", "auth.py", "c2"),
        ]

        result = _collect_recent_files(msgs, n=3)

        assert len(result) == 1

    def test_frozen_zone_unchanged_after_l4_apply(self) -> None:
        summarizer = LLMSummarization(trigger_ratio=0.1, summarizer_client=None)
        budget = ContextBudget(max_tokens=200_000)
        budget.record({"total_tokens": 190_000})

        conv = Conversation(session_id="test")
        conv.messages = [
            Message(role="system", content="FROZEN_sys", metadata={"cache_policy": "STATIC"}),
            Message(role="system", content="FROZEN_tool", metadata={"cache_policy": "STATIC"}),
            Message(role="user", content="test", metadata={"cache_policy": "DYNAMIC"}),
            Message(role="assistant", content="resp", metadata={"cache_policy": "DYNAMIC"}),
            _make_tool_msg("Read", "a.py", "c1"),
            Message(role="user", content="continue", metadata={"cache_policy": "DYNAMIC"}),
            Message(role="assistant", content="more", metadata={"cache_policy": "DYNAMIC"}),
            Message(role="assistant", content="done", metadata={"cache_policy": "DYNAMIC"}),
        ]

        zones = CacheZones.from_conversation(conv)
        frozen_before = [
            (message.content, dict(message.metadata))
            for message in conv.messages[: zones.fresh_start]
        ]

        result = summarizer.apply(conv, zones, budget)
        frozen_after = [
            (message.content, dict(message.metadata))
            for message in result.messages[: zones.fresh_start]
        ]

        assert frozen_before == frozen_after
        assert summarizer.last_cost_metrics is not None
        assert summarizer.last_cost_metrics["recent_files"] == ["a.py"]


def test_runtime_builds_recent_file_rehydration_block(tmp_path: Path) -> None:
    (tmp_path / "src").mkdir()
    target = tmp_path / "src" / "app.py"
    target.write_text("def answer():\n    return 42\n", encoding="utf-8")
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=object(),
    )
    runtime.rebind_session(AgentConfig(workspace_root=tmp_path))

    reminders = runtime._build_l4_rehydration_reminders(
        {"recent_files": ["src/app.py"]}
    )

    assert len(reminders) == 1
    assert "src/app.py" in reminders[0]
    assert "def answer()" in reminders[0]
    assert "Compaction rehydration" in reminders[0]


def test_runtime_rehydration_rejects_paths_outside_workspace(tmp_path: Path) -> None:
    outside = tmp_path.parent / "outside.py"
    outside.write_text("secret = True\n", encoding="utf-8")
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=object(),
    )
    runtime.rebind_session(AgentConfig(workspace_root=tmp_path))

    reminders = runtime._build_l4_rehydration_reminders(
        {"recent_files": [str(outside)]}
    )

    assert reminders == ()


def test_runtime_rehydration_truncates_large_files(tmp_path: Path) -> None:
    target = tmp_path / "large.py"
    target.write_text("x = 1\n" * 10_000, encoding="utf-8")
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=object(),
    )
    runtime.rebind_session(AgentConfig(workspace_root=tmp_path))

    reminders = runtime._build_l4_rehydration_reminders(
        {"recent_files": ["large.py"]}
    )

    assert reminders
    assert "truncated" in reminders[0].lower()
