from mycli.evaluation.soak import run_deterministic_soak


def test_deterministic_soak_covers_50_turns_and_40_tool_calls_within_budget() -> None:
    result = run_deterministic_soak()

    assert result.turns == 50
    assert result.tool_calls == 40
    assert result.within_budget is True
    assert result.hard_stop_turn is None
    assert result.total_tokens < result.budget


def test_deterministic_soak_reports_budget_failure() -> None:
    result = run_deterministic_soak(max_tokens_per_turn=10)

    assert result.within_budget is False
    assert result.hard_stop_turn == 1
