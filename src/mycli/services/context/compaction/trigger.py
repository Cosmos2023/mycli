from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum


class CompactReason(StrEnum):
    CONTEXT_LIMIT = "context_limit"
    MODEL_DOWNSHIFT = "model_downshift"
    COMPATIBILITY_CHANGED = "compatibility_changed"
    MID_TURN_LIMIT = "mid_turn_limit"
    USER_REQUESTED = "user_requested"


class CompactPhase(StrEnum):
    PRE_TURN = "pre_turn"
    MID_TURN = "mid_turn"
    STANDALONE = "standalone"


@dataclass(frozen=True, slots=True)
class CompactTokenStatus:
    provider_input_tokens: int | None = None
    estimated_request_tokens: int = 0

    @property
    def pre_turn_tokens(self) -> int:
        if self.provider_input_tokens is not None and self.provider_input_tokens >= 0:
            return self.provider_input_tokens
        return max(0, self.estimated_request_tokens)

    @property
    def mid_turn_tokens(self) -> int:
        return max(
            0,
            self.provider_input_tokens or 0,
            self.estimated_request_tokens,
        )


@dataclass(frozen=True, slots=True)
class CompactDecision:
    should_compact: bool
    reason: CompactReason | None
    phase: CompactPhase
    trigger_tokens: int
    limit_tokens: int


class CompactTriggerPolicy:
    def __init__(self, *, limit_tokens: int) -> None:
        if limit_tokens <= 0:
            raise ValueError("limit_tokens must be positive")
        self._limit_tokens = limit_tokens

    @property
    def limit_tokens(self) -> int:
        return self._limit_tokens

    def pre_turn(
        self,
        status: CompactTokenStatus,
        *,
        model_downshift: bool = False,
        compatibility_changed: bool = False,
    ) -> CompactDecision:
        trigger_tokens = status.pre_turn_tokens
        if model_downshift:
            return self._compact(
                reason=CompactReason.MODEL_DOWNSHIFT,
                phase=CompactPhase.PRE_TURN,
                trigger_tokens=trigger_tokens,
            )
        if compatibility_changed:
            return self._compact(
                reason=CompactReason.COMPATIBILITY_CHANGED,
                phase=CompactPhase.PRE_TURN,
                trigger_tokens=trigger_tokens,
            )
        return self._threshold_decision(
            reason=CompactReason.CONTEXT_LIMIT,
            phase=CompactPhase.PRE_TURN,
            trigger_tokens=trigger_tokens,
        )

    def mid_turn(self, status: CompactTokenStatus) -> CompactDecision:
        return self._threshold_decision(
            reason=CompactReason.MID_TURN_LIMIT,
            phase=CompactPhase.MID_TURN,
            trigger_tokens=status.mid_turn_tokens,
        )

    def model_transition(
        self,
        *,
        previous_context_limit: int | None,
        current_context_limit: int | None,
        active_tokens: int,
    ) -> CompactDecision:
        trigger_tokens = max(0, active_tokens)
        if (
            previous_context_limit is not None
            and current_context_limit is not None
            and previous_context_limit > 0
            and current_context_limit > 0
            and current_context_limit < previous_context_limit
        ):
            return self._compact(
                reason=CompactReason.MODEL_DOWNSHIFT,
                phase=CompactPhase.PRE_TURN,
                trigger_tokens=trigger_tokens,
            )
        return self._no_compact(
            phase=CompactPhase.PRE_TURN,
            trigger_tokens=trigger_tokens,
        )

    def compatibility_transition(
        self,
        *,
        previous_hash: str | None,
        current_hash: str | None,
        active_tokens: int,
    ) -> CompactDecision:
        trigger_tokens = max(0, active_tokens)
        if previous_hash and current_hash and previous_hash != current_hash:
            return self._compact(
                reason=CompactReason.COMPATIBILITY_CHANGED,
                phase=CompactPhase.PRE_TURN,
                trigger_tokens=trigger_tokens,
            )
        return self._no_compact(
            phase=CompactPhase.PRE_TURN,
            trigger_tokens=trigger_tokens,
        )

    def manual(self, *, active_tokens: int = 0) -> CompactDecision:
        return self._compact(
            reason=CompactReason.USER_REQUESTED,
            phase=CompactPhase.STANDALONE,
            trigger_tokens=max(0, active_tokens),
        )

    def forced(
        self,
        *,
        reason: CompactReason,
        phase: CompactPhase,
        trigger_tokens: int,
    ) -> CompactDecision:
        return self._compact(
            reason=reason,
            phase=phase,
            trigger_tokens=max(0, trigger_tokens),
        )

    def _threshold_decision(
        self,
        *,
        reason: CompactReason,
        phase: CompactPhase,
        trigger_tokens: int,
    ) -> CompactDecision:
        if trigger_tokens >= self._limit_tokens:
            return self._compact(
                reason=reason,
                phase=phase,
                trigger_tokens=trigger_tokens,
            )
        return self._no_compact(phase=phase, trigger_tokens=trigger_tokens)

    def _no_compact(
        self,
        *,
        phase: CompactPhase,
        trigger_tokens: int,
    ) -> CompactDecision:
        return CompactDecision(
            should_compact=False,
            reason=None,
            phase=phase,
            trigger_tokens=trigger_tokens,
            limit_tokens=self._limit_tokens,
        )

    def _compact(
        self,
        *,
        reason: CompactReason,
        phase: CompactPhase,
        trigger_tokens: int,
    ) -> CompactDecision:
        return CompactDecision(
            should_compact=True,
            reason=reason,
            phase=phase,
            trigger_tokens=trigger_tokens,
            limit_tokens=self._limit_tokens,
        )


__all__ = [
    "CompactDecision",
    "CompactPhase",
    "CompactReason",
    "CompactTokenStatus",
    "CompactTriggerPolicy",
]
