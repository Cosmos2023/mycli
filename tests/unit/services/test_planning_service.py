from mycli.domain.runtime import PlanItem, PlanState, PlanStatus
from mycli.services.planning.planning_service import PlanningService


def test_planning_service_replaces_plan_from_description_only_items() -> None:
    service = PlanningService()

    state = service.replace(
        [
            {
                "status": "in_progress",
                "description": "Stabilize runtime decisions",
            },
            {
                "status": "pending",
                "description": "Converge provider integration",
            },
        ]
    )

    assert state.items == (
        PlanItem(
            id="step-1",
            content="Stabilize runtime decisions",
            status=PlanStatus.IN_PROGRESS,
        ),
        PlanItem(
            id="step-2",
            content="Converge provider integration",
            status=PlanStatus.PENDING,
        ),
    )


def test_planning_service_accepts_codex_style_plan_steps() -> None:
    service = PlanningService()

    state = service.replace(
        [
            {"step": "Map runtime state", "status": "completed"},
            {"step": "Render active plan", "status": "in_progress"},
        ]
    )

    assert state.items == (
        PlanItem(
            id="step-1",
            content="Map runtime state",
            status=PlanStatus.COMPLETED,
        ),
        PlanItem(
            id="step-2",
            content="Render active plan",
            status=PlanStatus.IN_PROGRESS,
        ),
    )


def test_planning_service_applies_partial_update_without_dropping_items() -> None:
    service = PlanningService()
    state = PlanState(
        items=(
            PlanItem(id="inspect", content="Inspect repo", status=PlanStatus.IN_PROGRESS),
            PlanItem(id="verify", content="Run tests", status=PlanStatus.PENDING),
        )
    )

    updated = service.apply_operation(
        state,
        {
            "op": "update",
            "item_id": "verify",
            "content": "Run focused tests",
            "status": "in_progress",
            "evidence": ["pytest targeted tests"],
        },
    )

    assert updated.items == (
        PlanItem(id="inspect", content="Inspect repo", status=PlanStatus.PENDING),
        PlanItem(
            id="verify",
            content="Run focused tests",
            status=PlanStatus.IN_PROGRESS,
            evidence=("pytest targeted tests",),
        ),
    )


def test_planning_service_adds_and_removes_items() -> None:
    service = PlanningService()
    state = PlanState(
        items=(PlanItem(id="inspect", content="Inspect repo", status=PlanStatus.COMPLETED),)
    )

    added = service.apply_operation(
        state,
        {"op": "add", "item": {"id": "verify", "step": "Run tests", "status": "pending"}},
    )
    removed = service.apply_operation(added, {"op": "remove", "item_id": "inspect"})

    assert added.items == (
        PlanItem(id="inspect", content="Inspect repo", status=PlanStatus.COMPLETED),
        PlanItem(id="verify", content="Run tests", status=PlanStatus.PENDING),
    )
    assert removed.items == (
        PlanItem(id="verify", content="Run tests", status=PlanStatus.PENDING),
    )


def test_planning_service_marks_single_task_completed() -> None:
    service = PlanningService()
    state = PlanState(
        items=(
            PlanItem(id="inspect", content="Inspect repo", status=PlanStatus.IN_PROGRESS),
            PlanItem(id="edit", content="Edit README", status=PlanStatus.PENDING),
        )
    )

    updated = service.mark_completed(state, "inspect")

    assert updated.items[0].status is PlanStatus.COMPLETED
    assert updated.items[1].status is PlanStatus.PENDING


def test_planning_service_marks_single_task_in_progress() -> None:
    service = PlanningService()
    state = PlanState(
        items=(
            PlanItem(id="inspect", content="Inspect repo", status=PlanStatus.PENDING),
            PlanItem(id="edit", content="Edit README", status=PlanStatus.PENDING),
        )
    )

    updated = service.mark_in_progress(state, "inspect")

    assert updated.items[0].status is PlanStatus.IN_PROGRESS
    assert updated.items[1].status is PlanStatus.PENDING
