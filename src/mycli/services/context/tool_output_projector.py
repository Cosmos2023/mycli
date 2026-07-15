from __future__ import annotations

from collections.abc import Callable
from dataclasses import replace

from mycli.domain.tooling.calls import ToolResult
from mycli.domain.tooling.output import ToolModelOutput, ToolOutputBudgetClass
from mycli.services.context.tool_output_budget import ToolOutputBudgeter
from mycli.services.context.tool_result_formatter import ToolResultFormatter


class ToolModelOutputProjector:
    def __init__(
        self,
        *,
        formatter: ToolResultFormatter | None = None,
        legacy_renderer: Callable[[str, ToolResult], str] | None = None,
        budgeter: ToolOutputBudgeter | None = None,
        read_max_chars: int = 8_000,
        read_range_max_chars: int = 6_000,
        shell_max_chars: int = 2_000,
        default_max_chars: int = 1_600,
        instruction_max_chars: int = 32_000,
    ) -> None:
        self._formatter = formatter or ToolResultFormatter(
            read_file_max_chars=read_max_chars,
            read_file_range_max_chars=read_range_max_chars,
            run_shell_max_chars=shell_max_chars,
            default_max_chars=default_max_chars,
        )
        self._legacy_renderer = legacy_renderer
        self._budgeter = budgeter or ToolOutputBudgeter()
        self._limits = {
            ToolOutputBudgetClass.READ: read_max_chars,
            ToolOutputBudgetClass.READ_RANGE: read_range_max_chars,
            ToolOutputBudgetClass.SHELL: shell_max_chars,
            ToolOutputBudgetClass.DEFAULT: default_max_chars,
            ToolOutputBudgetClass.INSTRUCTION: instruction_max_chars,
        }

    def project(self, tool_name: str, result: ToolResult) -> ToolModelOutput:
        output = result.model_output
        if output is None:
            rendered = (
                self._legacy_renderer(tool_name, result)
                if self._legacy_renderer is not None
                else self._formatter.format(tool_name, result)
            )
            output = ToolModelOutput.from_text(
                rendered,
                success=result.success,
                budget_class=_legacy_budget_class(tool_name),
            )
        elif output.success is None:
            output = replace(output, success=result.success)

        return self._budgeter.apply(
            output,
            max_chars=self._limits[output.budget_class],
        )


def _legacy_budget_class(tool_name: str) -> ToolOutputBudgetClass:
    if tool_name in {"read_file", "Read"}:
        return ToolOutputBudgetClass.READ
    if tool_name == "read_file_range":
        return ToolOutputBudgetClass.READ_RANGE
    if tool_name in {"run_shell", "Shell", "Bash", "ShellOutput", "BashOutput"}:
        return ToolOutputBudgetClass.SHELL
    if tool_name == "Skill":
        return ToolOutputBudgetClass.INSTRUCTION
    return ToolOutputBudgetClass.DEFAULT


__all__ = ["ToolModelOutputProjector"]
