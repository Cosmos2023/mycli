from __future__ import annotations

from mycli.domain.runtime import (
    ExecPolicyDecision,
    ExecPolicyRule,
    ExecPolicyRuleSet,
    ExecPolicySource,
)


def test_prefix_rule_matches_command_args_and_redacts_trace_metadata() -> None:
    rule = ExecPolicyRule(
        source=ExecPolicySource.PROJECT,
        index=0,
        pattern=("uv", "run", "pytest"),
        decision=ExecPolicyDecision.ALLOW,
    )

    assert rule.matches(("uv", "run", "pytest", "-q"))
    assert not rule.matches(("uv", "run", "ruff", "check"))

    payload = rule.to_trace_payload(argument_count=4)

    assert payload == {
        "execpolicy_decision": "allow",
        "execpolicy_rule_source": "project",
        "execpolicy_rule_index": 0,
        "execpolicy_rule_pattern_hash": rule.pattern_hash,
        "execpolicy_rule_pattern_length": 3,
        "execpolicy_rule_argument_count": 4,
    }
    assert "pytest" not in str(payload)


def test_project_rules_override_user_rules_when_both_match() -> None:
    ruleset = ExecPolicyRuleSet(
        rules=(
            ExecPolicyRule(
                source=ExecPolicySource.USER,
                index=0,
                pattern=("uv", "run", "pytest"),
                decision=ExecPolicyDecision.ALLOW,
            ),
            ExecPolicyRule(
                source=ExecPolicySource.PROJECT,
                index=0,
                pattern=("uv", "run", "pytest"),
                decision=ExecPolicyDecision.ASK,
            ),
        )
    )

    match = ruleset.match(("uv", "run", "pytest", "-q"))

    assert match is not None
    assert match.rule.source is ExecPolicySource.PROJECT
    assert match.rule.decision is ExecPolicyDecision.ASK
