from __future__ import annotations

from mycli.services.context.compaction.trigger import (
    CompactPhase,
    CompactReason,
    CompactTokenStatus,
    CompactTriggerPolicy,
)


def test_pre_turn_uses_provider_tokens_before_request_estimate() -> None:
    policy = CompactTriggerPolicy(limit_tokens=87_000)

    decision = policy.pre_turn(
        CompactTokenStatus(
            provider_input_tokens=86_000,
            estimated_request_tokens=90_000,
        )
    )

    assert decision.should_compact is False
    assert decision.reason is None
    assert decision.trigger_tokens == 86_000
    assert decision.phase is CompactPhase.PRE_TURN


def test_pre_turn_uses_estimate_when_provider_usage_is_unavailable() -> None:
    decision = CompactTriggerPolicy(limit_tokens=87_000).pre_turn(
        CompactTokenStatus(
            provider_input_tokens=None,
            estimated_request_tokens=87_100,
        )
    )

    assert decision.should_compact is True
    assert decision.reason is CompactReason.CONTEXT_LIMIT
    assert decision.trigger_tokens == 87_100


def test_model_downshift_precedes_context_limit() -> None:
    decision = CompactTriggerPolicy(limit_tokens=87_000).pre_turn(
        CompactTokenStatus(
            provider_input_tokens=90_000,
            estimated_request_tokens=90_000,
        ),
        model_downshift=True,
    )

    assert decision.reason is CompactReason.MODEL_DOWNSHIFT
    assert decision.phase is CompactPhase.PRE_TURN


def test_compatibility_change_triggers_pre_turn_compact() -> None:
    decision = CompactTriggerPolicy(limit_tokens=87_000).pre_turn(
        CompactTokenStatus(provider_input_tokens=10_000),
        compatibility_changed=True,
    )

    assert decision.should_compact is True
    assert decision.reason is CompactReason.COMPATIBILITY_CHANGED
    assert decision.phase is CompactPhase.PRE_TURN


def test_mid_turn_uses_new_request_estimate_after_tool_results() -> None:
    decision = CompactTriggerPolicy(limit_tokens=87_000).mid_turn(
        CompactTokenStatus(
            provider_input_tokens=80_000,
            estimated_request_tokens=88_000,
        )
    )

    assert decision.should_compact is True
    assert decision.reason is CompactReason.MID_TURN_LIMIT
    assert decision.trigger_tokens == 88_000
    assert decision.phase is CompactPhase.MID_TURN


def test_manual_compact_is_always_a_standalone_decision() -> None:
    decision = CompactTriggerPolicy(limit_tokens=87_000).manual(active_tokens=12_000)

    assert decision.should_compact is True
    assert decision.reason is CompactReason.USER_REQUESTED
    assert decision.trigger_tokens == 12_000
    assert decision.phase is CompactPhase.STANDALONE
