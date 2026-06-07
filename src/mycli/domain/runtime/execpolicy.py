from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum
import hashlib
import json


class ExecPolicyDecision(StrEnum):
    ALLOW = "allow"
    DENY = "deny"
    ASK = "ask"


class ExecPolicySource(StrEnum):
    USER = "user"
    PROJECT = "project"
    SESSION = "session"


_SOURCE_PRECEDENCE: dict[ExecPolicySource, int] = {
    ExecPolicySource.USER: 0,
    ExecPolicySource.PROJECT: 1,
    ExecPolicySource.SESSION: 2,
}


@dataclass(slots=True, frozen=True)
class ExecPolicyRule:
    source: ExecPolicySource
    index: int
    pattern: tuple[str, ...]
    decision: ExecPolicyDecision

    def __post_init__(self) -> None:
        if self.index < 0:
            raise ValueError("execpolicy rule index cannot be negative.")
        if not self.pattern:
            raise ValueError("execpolicy prefix_rule pattern cannot be empty.")
        if any(not token for token in self.pattern):
            raise ValueError("execpolicy prefix_rule pattern tokens cannot be blank.")

    @property
    def pattern_hash(self) -> str:
        payload = json.dumps(
            {"pattern": self.pattern},
            ensure_ascii=True,
            sort_keys=True,
            separators=(",", ":"),
        )
        return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:16]

    @property
    def precedence(self) -> int:
        return _SOURCE_PRECEDENCE[self.source]

    def matches(self, command_args: tuple[str, ...]) -> bool:
        return len(command_args) >= len(self.pattern) and command_args[
            : len(self.pattern)
        ] == self.pattern

    def to_trace_payload(self, *, argument_count: int) -> dict[str, object]:
        return {
            "execpolicy_decision": self.decision.value,
            "execpolicy_rule_source": self.source.value,
            "execpolicy_rule_index": self.index,
            "execpolicy_rule_pattern_hash": self.pattern_hash,
            "execpolicy_rule_pattern_length": len(self.pattern),
            "execpolicy_rule_argument_count": argument_count,
        }


@dataclass(slots=True, frozen=True)
class ExecPolicyMatch:
    rule: ExecPolicyRule
    argument_count: int

    def to_trace_payload(self) -> dict[str, object]:
        return self.rule.to_trace_payload(argument_count=self.argument_count)


@dataclass(slots=True, frozen=True)
class ExecPolicyRuleSet:
    rules: tuple[ExecPolicyRule, ...] = ()

    def match(self, command_args: tuple[str, ...]) -> ExecPolicyMatch | None:
        matches = [
            rule for rule in self.rules if rule.matches(command_args)
        ]
        if not matches:
            return None
        rule = max(
            matches,
            key=lambda candidate: (
                candidate.precedence,
                len(candidate.pattern),
                candidate.index,
            ),
        )
        return ExecPolicyMatch(rule=rule, argument_count=len(command_args))
