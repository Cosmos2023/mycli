from __future__ import annotations

from collections.abc import Callable
import json
from uuid import uuid4

from mycli.domain.tooling.calls import ToolResult
from mycli.domain.tooling.output import ToolModelOutput, ToolOutputBudgetClass
from mycli.services.file_change_display import mutation_receipt


ToolModelOutputAdapter = Callable[[ToolResult], ToolModelOutput]


def compact_model_output(result: ToolResult) -> ToolModelOutput:
    text = result.summary
    if result.error and result.error not in text:
        text = f"{text}\nError: {result.error}"
    return ToolModelOutput.from_text(text, success=result.success)


def read_model_output(result: ToolResult) -> ToolModelOutput:
    content = result.raw_payload.get("content")
    if not result.success or not isinstance(content, str):
        return compact_model_output(result)
    return ToolModelOutput.from_text(
        content,
        success=True,
        budget_class=ToolOutputBudgetClass.READ,
    )


def shell_model_output(result: ToolResult) -> ToolModelOutput:
    from mycli.services.context.tool_output_budget import ToolOutputBudgeter

    payload = result.raw_payload
    payload.setdefault("chunk_id", uuid4().hex[:8])
    text = _shell_response_text(result)
    payload["original_token_count"] = (len(text) + 3) // 4
    output = ToolModelOutput.from_text(
        text,
        success=result.success,
        budget_class=ToolOutputBudgetClass.SHELL,
    )
    max_output_tokens = payload.get("max_output_tokens", 10_000)
    if (
        not isinstance(max_output_tokens, int)
        or isinstance(max_output_tokens, bool)
        or max_output_tokens <= 0
    ):
        max_output_tokens = 10_000
    return ToolOutputBudgeter().apply(output, max_chars=max_output_tokens * 4)


def _shell_response_text(result: ToolResult) -> str:
    payload = result.raw_payload
    chunk_id = str(payload["chunk_id"])
    wall_time_value = payload.get("wall_time_seconds")
    if not isinstance(wall_time_value, (int, float)):
        duration_ms = payload.get("duration_ms")
        wall_time_value = (
            duration_ms / 1000 if isinstance(duration_ms, (int, float)) else 0.0
        )
    output = payload.get("output")
    if not isinstance(output, str):
        parts = [
            value
            for key in ("stdout", "stderr")
            if isinstance((value := payload.get(key)), str) and value
        ]
        output = "\n".join(parts)
    if not output and result.error:
        output = result.error

    session_id = payload.get("shell_id") or payload.get("bash_id")
    if payload.get("terminal_state") is None and isinstance(session_id, str):
        status = f"Process running with session ID {session_id}"
        heading = "Live output:"
    else:
        exit_code = payload.get("exit_code")
        status = f"Process exited with code {exit_code if isinstance(exit_code, int) else -1}"
        heading = "Final output:"
    lines = [
        f"Chunk ID: {chunk_id}",
        f"Wall time: {float(wall_time_value):.2f} seconds",
        status,
        heading,
    ]
    if output:
        lines.append(output)
    return "\n".join(lines)


def mutation_model_output(result: ToolResult) -> ToolModelOutput:
    return ToolModelOutput.from_text(
        mutation_receipt(result),
        success=result.success,
    )


def structured_model_output(result: ToolResult) -> ToolModelOutput:
    if not result.success:
        return compact_model_output(result)
    return ToolModelOutput.from_json(result.raw_payload, success=True)


def git_model_output(result: ToolResult) -> ToolModelOutput:
    if not result.success:
        return compact_model_output(result)
    payload = result.raw_payload
    for key in ("diff", "content", "stdout"):
        value = payload.get(key)
        if isinstance(value, str) and value:
            return ToolModelOutput.from_text(value, success=True)
    return ToolModelOutput.from_text(
        json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")),
        success=True,
    )


__all__ = [
    "ToolModelOutputAdapter",
    "compact_model_output",
    "git_model_output",
    "mutation_model_output",
    "read_model_output",
    "shell_model_output",
    "structured_model_output",
]
