from mycli.domain.runtime.planning import PlanItem, PlanState, PlanStatus


def test_plan_state_rejects_multiple_in_progress_items() -> None:
    first = PlanItem(
        id="inspect",
        content="Inspect runtime entrypoints",
        status=PlanStatus.IN_PROGRESS,
    )
    second = PlanItem(
        id="wire-cli",
        content="Wire CLI to runtime",
        status=PlanStatus.IN_PROGRESS,
    )

    try:
        PlanState(items=(first, second))
    except ValueError as exc:
        assert "single in_progress" in str(exc)
    else:
        raise AssertionError("PlanState should reject multiple in-progress items")
