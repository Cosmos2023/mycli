from __future__ import annotations

from dataclasses import dataclass


@dataclass(slots=True)
class ContextBudget:
    max_tokens: int
    total_tokens: int = 0

    @classmethod
    def from_estimate(cls, *, max_tokens: int, estimated_input_tokens: int) -> ContextBudget:
        return cls(max_tokens=max_tokens, total_tokens=max(0, estimated_input_tokens))

    def record(self, usage: dict[str, object]) -> None:
        tokens = self._tokens_from_usage(usage)
        if tokens > 0:
            self.total_tokens += tokens

    @property
    def conversation_tokens(self) -> int:
        return self.total_tokens

    @conversation_tokens.setter
    def conversation_tokens(self, value: int) -> None:
        self.total_tokens = max(0, value)

    @property
    def usable_limit(self) -> int:
        return self.max_tokens

    def reset_from_estimate(self, estimated_input_tokens: int) -> None:
        self.total_tokens = max(0, estimated_input_tokens)

    @property
    def usage_ratio(self) -> float:
        if self.max_tokens <= 0:
            return 0.0
        return self.total_tokens / self.max_tokens

    @property
    def remaining(self) -> int:
        return max(0, self.max_tokens - self.total_tokens)

    def _tokens_from_usage(self, usage: dict[str, object]) -> int:
        total_tokens = usage.get("total_tokens")
        if isinstance(total_tokens, (int, float)) and total_tokens > 0:
            return int(total_tokens)

        input_tokens = usage.get("input_tokens")
        output_tokens = usage.get("output_tokens")
        if isinstance(input_tokens, (int, float)) and input_tokens > 0 and output_tokens is None:
            return int(input_tokens)
        if (
            isinstance(input_tokens, (int, float))
            and input_tokens > 0
            and isinstance(output_tokens, (int, float))
            and output_tokens > 0
        ):
            return int(input_tokens + output_tokens)

        prompt_tokens = usage.get("prompt_tokens")
        completion_tokens = usage.get("completion_tokens")
        if (
            isinstance(prompt_tokens, (int, float))
            and prompt_tokens > 0
            and isinstance(completion_tokens, (int, float))
            and completion_tokens > 0
        ):
            return int(prompt_tokens + completion_tokens)
        return 0
