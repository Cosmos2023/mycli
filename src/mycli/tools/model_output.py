from __future__ import annotations

from collections.abc import Callable
import json

from mycli.domain.tooling.calls import ToolResult
from mycli.domain.tooling.output import ToolModelOutput, ToolOutputBudgetClass


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
    payload = result.raw_payload
    shell_id = payload.get("shell_id") or payload.get("bash_id")
    status = payload.get("status")
    process_state = payload.get("process_state")
    if (
        isinstance(shell_id, str)
        and shell_id
        and (status == "running" or process_state == "running_background")
    ):
        poll_arguments = json.dumps(
            {"shell_id": shell_id},
            ensure_ascii=False,
            separators=(",", ":"),
        )
        return ToolModelOutput.from_text(
            "\n".join(
                (
                    "Background shell started",
                    f"shell_id: {shell_id}",
                    f"status: {status or 'running'}",
                    f"Poll with ShellOutput({poll_arguments})",
                )
            ),
            success=result.success,
            budget_class=ToolOutputBudgetClass.SHELL,
        )
    output = payload.get("output")
    if not isinstance(output, str):
        parts = [
            value
            for key in ("stdout", "stderr")
            if isinstance((value := payload.get(key)), str) and value
        ]
        output = "\n".join(parts)
    text = output if output else compact_model_output(result).text_content()
    return ToolModelOutput.from_text(
        text,
        success=result.success,
        budget_class=ToolOutputBudgetClass.SHELL,
    )


def mutation_model_output(result: ToolResult) -> ToolModelOutput:
    parts = [result.summary]
    path = result.raw_payload.get("path")
    if isinstance(path, str) and path:
        parts.append(f"Path: {path}")
    diff = result.raw_payload.get("diff")
    if isinstance(diff, str) and diff.strip():
        parts.extend(("Diff:", diff.rstrip()))
    if not result.success and result.error:
        parts.append(f"Error: {result.error}")
    return ToolModelOutput.from_text("\n".join(parts), success=result.success)


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
