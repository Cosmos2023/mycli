from __future__ import annotations

from dataclasses import dataclass

from mycli.domain.conversation import Conversation, Message
from mycli.domain.runtime import RuntimeBlock
from mycli.domain.tooling.calls import ToolCall
from mycli.services.context.token_counter import TokenCounter
from mycli.services.turn_guard import TurnCheckpoint


@dataclass(slots=True, frozen=True)
class SoakResult:
    turns: int
    tool_calls: int
    total_tokens: int
    budget: int
    within_budget: bool
    hard_stop_turn: int | None = None


def run_deterministic_soak(
    *,
    turns: int = 50,
    tool_calls: int = 40,
    max_tokens_per_turn: int = 200_000,
) -> SoakResult:
    conversation = Conversation(session_id="soak")
    checkpoint = TurnCheckpoint(
        max_tokens_per_turn=max_tokens_per_turn,
    )
    counter = TokenCounter()
    emitted_tools = 0
    total_tokens = 0
    hard_stop_turn: int | None = None

    for turn_index in range(1, turns + 1):
        conversation.append(Message(role="user", content=f"turn {turn_index}: continue soak"))
        if emitted_tools < tool_calls:
            call_id = f"call_{emitted_tools + 1}"
            conversation.append(
                Message(
                    role="assistant",
                    content="",
                    tool_calls=(
                        ToolCall(
                            name="read_file",
                            arguments={"path": f"fixture-{emitted_tools + 1}.txt"},
                            reason="deterministic soak",
                            call_id=call_id,
                        ),
                    ),
                )
            )
            conversation.append(
                Message(
                    role="tool",
                    content=f"Tool read_file result {emitted_tools + 1}",
                    tool_call_id=call_id,
                    blocks=(
                        RuntimeBlock(
                            type="tool_result",
                            text=f"fixture content {emitted_tools + 1}",
                            tool_name="read_file",
                            call_id=call_id,
                        ),
                    ),
                )
            )
            emitted_tools += 1
        else:
            conversation.append(Message(role="assistant", content=f"soak response {turn_index}"))

        total_tokens = sum(counter.count_message(message) for message in conversation.messages)
        checkpoint_result = checkpoint.evaluate(
            step_index=emitted_tools,
            conversation=conversation,
            current_window_tokens=total_tokens,
        )
        if checkpoint_result.exit_reason is not None:
            hard_stop_turn = turn_index
            break

    return SoakResult(
        turns=turns if hard_stop_turn is None else hard_stop_turn,
        tool_calls=emitted_tools,
        total_tokens=total_tokens,
        budget=max_tokens_per_turn,
        within_budget=hard_stop_turn is None and total_tokens <= max_tokens_per_turn,
        hard_stop_turn=hard_stop_turn,
    )
