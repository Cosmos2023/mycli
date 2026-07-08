from __future__ import annotations

from pathlib import Path

from mycli.application.runtime.tools.tool_file_history_runtime import ToolFileHistoryRuntime
from mycli.domain.tooling.calls import ToolCall
from mycli.domain.tooling.exposure import ToolExposure
from mycli.services.file_history import FileHistoryService
from mycli.tools.base import ToolResult


class FakeRouter:
    def __init__(self, paths: tuple[str, ...] | None) -> None:
        self._paths = paths

    def mutation_targets(self, call: ToolCall, *, exposure: ToolExposure) -> tuple[str, ...] | None:
        del call, exposure
        return self._paths


def _runtime(tmp_path: Path, workspace: Path) -> ToolFileHistoryRuntime:
    return ToolFileHistoryRuntime(
        session_id="demo",
        file_history=FileHistoryService(
            home_dir=tmp_path / "home",
            workspace_root=workspace,
        ),
    )


def test_tool_file_history_runtime_snapshots_and_finalizes_mutation(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    (workspace / "notes.txt").write_text("before\n", encoding="utf-8")
    runtime = _runtime(tmp_path, workspace)
    metadata: dict[str, object] = {}

    snapshot_ids = runtime.snapshot_before_file_mutation(
        call=ToolCall(
            name="edit_file",
            arguments={"path": "notes.txt", "new_content": "after\n"},
            reason="edit",
            call_id="call_edit_1",
        ),
        tool_router=FakeRouter(paths=None),  # type: ignore[arg-type]
        tool_exposure=ToolExposure(entries=()),
        turn_id="turn_1",
        turn_metadata=metadata,
    )
    (workspace / "notes.txt").write_text("after\n", encoding="utf-8")
    runtime.finalize_file_history_snapshots(
        snapshot_ids=snapshot_ids,
        result=ToolResult(success=True, summary="Edited", raw_payload={}),
        turn_metadata=metadata,
    )

    assert isinstance(metadata["file_history_snapshot_ids"], list)
    rewind = runtime.file_history.rewind_latest(session_id="demo")
    assert rewind.restored_paths == ("notes.txt",)
    assert (workspace / "notes.txt").read_text(encoding="utf-8") == "before\n"


def test_tool_file_history_runtime_discards_snapshot_on_failed_result(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    (workspace / "notes.txt").write_text("before\n", encoding="utf-8")
    runtime = _runtime(tmp_path, workspace)
    metadata: dict[str, object] = {}

    snapshot_ids = runtime.snapshot_before_file_mutation(
        call=ToolCall(
            name="Write",
            arguments={"file_path": "notes.txt", "content": "after\n"},
            reason="write",
            call_id="call_write_1",
        ),
        tool_router=FakeRouter(paths=None),  # type: ignore[arg-type]
        tool_exposure=ToolExposure(entries=()),
        turn_id="turn_1",
        turn_metadata=metadata,
    )
    runtime.finalize_file_history_snapshots(
        snapshot_ids=snapshot_ids,
        result=ToolResult(success=False, summary="Failed", raw_payload={}),
        turn_metadata=metadata,
    )

    assert "file_history_snapshot_ids" not in metadata
    assert runtime.file_history.list_snapshots(session_id="demo") == ()


def test_tool_file_history_runtime_uses_mutation_contract_paths(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    (workspace / "contract.txt").write_text("before\n", encoding="utf-8")
    runtime = _runtime(tmp_path, workspace)
    metadata: dict[str, object] = {}

    snapshot_ids = runtime.snapshot_before_file_mutation(
        call=ToolCall(
            name="ReplaceFile",
            arguments={"target": "ignored.txt", "content": "after\n"},
            reason="replace",
            call_id="call_replace_1",
        ),
        tool_router=FakeRouter(paths=("contract.txt",)),  # type: ignore[arg-type]
        tool_exposure=ToolExposure(entries=()),
        turn_id="turn_1",
        turn_metadata=metadata,
    )
    (workspace / "contract.txt").write_text("after\n", encoding="utf-8")
    runtime.finalize_file_history_snapshots(
        snapshot_ids=snapshot_ids,
        result=ToolResult(success=True, summary="Replaced", raw_payload={}),
        turn_metadata=metadata,
    )

    rewind = runtime.file_history.rewind_latest(session_id="demo")
    assert rewind.restored_paths == ("contract.txt",)


def test_tool_file_history_runtime_legacy_mutation_paths_include_patch(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    (workspace / "app.py").write_text("before\n", encoding="utf-8")
    runtime = _runtime(tmp_path, workspace)
    metadata: dict[str, object] = {}

    snapshot_ids = runtime.snapshot_before_file_mutation(
        call=ToolCall(
            name="Patch",
            arguments={"file_path": "app.py"},
            reason="patch",
            call_id="call_patch_1",
        ),
        tool_router=FakeRouter(paths=None),  # type: ignore[arg-type]
        tool_exposure=ToolExposure(entries=()),
        turn_id="turn_1",
        turn_metadata=metadata,
    )

    assert snapshot_ids
    assert isinstance(metadata["file_history_snapshot_ids"], list)
