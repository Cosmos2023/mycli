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
