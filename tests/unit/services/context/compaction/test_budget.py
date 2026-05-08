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


def test_budget_records_provider_specific_usage_shapes() -> None:
    budget = ContextBudget(max_tokens=100_000)
    budget.record({"input_tokens": 1200, "output_tokens": 300})
    budget.record({"prompt_tokens": 1000, "completion_tokens": 500})
    assert budget.total_tokens == 3000


def test_budget_records_input_only_usage_for_context_calibration() -> None:
    budget = ContextBudget(max_tokens=200_000)
    budget.record({"input_tokens": 45_000})
    assert budget.conversation_tokens == 45_000
    assert budget.usage_ratio == 45_000 / budget.usable_limit


def test_budget_conversation_tokens_setter_clamps_negative_values() -> None:
    budget = ContextBudget(max_tokens=100_000)
    budget.conversation_tokens = -1
    assert budget.total_tokens == 0


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
