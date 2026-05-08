from __future__ import annotations

from mycli.domain.runtime import PlanItem, PlanState, PlanStatus
from mycli.services.planning.plan_mode import PlanModeService


def test_plan_mode_writes_current_plan_file(tmp_path) -> None:
    service = PlanModeService(workspace_root=tmp_path)
    state = PlanState(
        items=(
            PlanItem(id="inspect", content="Inspect repo", status=PlanStatus.COMPLETED),
            PlanItem(id="edit", content="Edit code", status=PlanStatus.IN_PROGRESS),
            PlanItem(id="verify", content="Run tests", status=PlanStatus.PENDING),
        )
    )

    path = service.write_current_plan(state)

    assert path == tmp_path / "docs" / "tasks" / "current.md"
    assert path.read_text(encoding="utf-8") == (
        "# Current Plan\n\n"
        "- [x] Inspect repo\n"
        "- [~] Edit code\n"
        "- [ ] Run tests\n"
    )


def test_plan_mode_recovers_plan_state_from_anchor_file(tmp_path) -> None:
    plan_path = tmp_path / "docs" / "tasks" / "current.md"
    plan_path.parent.mkdir(parents=True)
    plan_path.write_text(
        "# Current Plan\n\n- [x] Inspect repo\n- [~] Edit code\n- [ ] Run tests\n",
        encoding="utf-8",
    )
    service = PlanModeService(workspace_root=tmp_path)

    state = service.load_current_plan()

    assert state.items == (
        PlanItem(id="step-1", content="Inspect repo", status=PlanStatus.COMPLETED),
        PlanItem(id="step-2", content="Edit code", status=PlanStatus.IN_PROGRESS),
        PlanItem(id="step-3", content="Run tests", status=PlanStatus.PENDING),
    )


def test_plan_mode_recover_current_plan_preserves_existing_session_state(tmp_path) -> None:
    service = PlanModeService(workspace_root=tmp_path)
    existing = PlanState(
        items=(PlanItem(id="live", content="Live plan", status=PlanStatus.IN_PROGRESS),)
    )

    recovered = service.recover_current_plan(existing)

    assert recovered is existing


def test_plan_mode_recover_current_plan_loads_anchor_when_session_is_empty(tmp_path) -> None:
    plan_path = tmp_path / "docs" / "tasks" / "current.md"
    plan_path.parent.mkdir(parents=True)
    plan_path.write_text("# Current Plan\n\n- [ ] Recover this\n", encoding="utf-8")
    service = PlanModeService(workspace_root=tmp_path)

    recovered = service.recover_current_plan(PlanState())

    assert recovered.items == (
        PlanItem(id="step-1", content="Recover this", status=PlanStatus.PENDING),
    )
