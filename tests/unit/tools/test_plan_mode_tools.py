from __future__ import annotations

from mycli.tools.plan_mode import EnterPlanModeTool, ExitPlanModeTool


def test_enter_plan_mode_tool_is_legacy_noop_and_does_not_write_repo_files(tmp_path) -> None:
    tool = EnterPlanModeTool(tmp_path)

    result = tool.execute(
        {
            "items": [
                {"content": "Inspect repo", "status": "completed"},
                {"content": "Edit code", "status": "in_progress"},
            ]
        }
    )

    assert result.success is True
    assert result.raw_payload["status"] == "legacy_noop"
    assert result.raw_payload["items"] == [
        {"id": "step-1", "content": "Inspect repo", "status": "completed"},
        {"id": "step-2", "content": "Edit code", "status": "in_progress"},
    ]
    assert not (tmp_path / "docs" / "tasks" / "current.md").exists()


def test_exit_plan_mode_tool_reads_anchor_file(tmp_path) -> None:
    plan_path = tmp_path / "docs" / "tasks" / "current.md"
    plan_path.parent.mkdir(parents=True)
    plan_path.write_text("# Current Plan\n\n- [x] Inspect repo\n", encoding="utf-8")
    tool = ExitPlanModeTool(tmp_path)

    result = tool.execute({})

    assert result.success is True
    assert result.raw_payload["items"] == [
        {"id": "step-1", "content": "Inspect repo", "status": "completed"}
    ]
