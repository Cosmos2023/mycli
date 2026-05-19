from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

from mycli.domain.tooling.calls import ToolCall
from mycli.llms.adapters.base import ModelToolDefinition, ModelToolParameter
from mycli.tools.base import SchemaTool, ToolSpec, ToolResult


@dataclass(slots=True)
class ToolRegistry:
    specs: dict[str, ToolSpec] | None = None
    executors: dict[str, SchemaTool] | None = None
    workspace_root: Path | None = None

    def __post_init__(self) -> None:
        if self.specs is not None and self.executors is not None:
            return
        root = self.workspace_root or Path.cwd()
        default = self.from_tools(default_tools(root))
        self.specs = default.specs
        self.executors = default.executors

    @classmethod
    def from_tools(cls, tools: list[SchemaTool]) -> ToolRegistry:
        return cls(
            specs={tool.spec.name: tool.spec for tool in tools},
            executors={tool.spec.name: tool for tool in tools},
        )

    def list_names(self) -> list[str]:
        assert self.specs is not None
        return sorted(self.specs)

    def list_all(self) -> list[SchemaTool]:
        assert self.executors is not None
        return [self.executors[name] for name in self.list_names()]

    def register(self, tool: SchemaTool) -> None:
        assert self.specs is not None
        assert self.executors is not None
        self.specs[tool.spec.name] = tool.spec
        self.executors[tool.spec.name] = tool

    def render_for_model(self, tool_names: tuple[str, ...] | None = None) -> list[ModelToolDefinition]:
        assert self.specs is not None
        selected_names = tuple(self.specs) if tool_names is None else tool_names
        return [
            ModelToolDefinition(
                name=spec.name,
                description=spec.description,
                parameters=tuple(
                    ModelToolParameter(
                        name=parameter.name,
                        type=parameter.type,
                        required=parameter.required,
                        description=parameter.description,
                        items_schema=parameter.items_schema,
                    )
                    for parameter in spec.parameters
                ),
            )
            for name in selected_names
            if (spec := self.specs.get(name)) is not None
        ]

    def validate(self, name: str, arguments: dict[str, Any]) -> None:
        assert self.specs is not None
        spec = self.specs.get(name)
        if spec is None:
            raise ValueError(f"Unsupported tool: {name}")
        missing = [
            parameter.name
            for parameter in spec.parameters
            if parameter.required and parameter.name not in arguments
        ]
        if missing:
            raise ValueError(f"Missing required arguments: {', '.join(missing)}")

    def execute(self, call: ToolCall) -> ToolResult:
        assert self.executors is not None
        self.validate(call.name, call.arguments)
        executor = self.executors.get(call.name)
        if executor is None:
            raise ValueError(f"Unsupported tool: {call.name}")
        return executor.execute(call.arguments)


def default_tools(workspace_root: Path) -> list[SchemaTool]:
    from mycli.tools.ask_user_question import AskUserQuestionTool
    from mycli.tools.bash import BashTool
    from mycli.tools.edit import EditTool
    from mycli.tools.file_snapshot import FileSnapshotStore
    from mycli.tools.glob import GlobTool
    from mycli.tools.grep import GrepTool
    from mycli.tools.kill_shell import KillShellTool
    from mycli.tools.lint import LintTool
    from mycli.tools.ls import LSTool
    from mycli.tools.plan import PlanTool
    from mycli.tools.plan_mode import EnterPlanModeTool, ExitPlanModeTool
    from mycli.tools.read import ReadTool
    from mycli.tools.web_fetch import WebFetchTool
    from mycli.tools.web_search import WebSearchTool
    from mycli.tools.write import WriteTool

    snapshot_store = FileSnapshotStore()
    return [
        ReadTool(workspace_root, snapshot_store=snapshot_store),
        EditTool(workspace_root, snapshot_store=snapshot_store),
        WriteTool(workspace_root),
        GrepTool(workspace_root),
        GlobTool(workspace_root),
        LSTool(workspace_root),
        BashTool(workspace_root),
        KillShellTool(),
        WebSearchTool(),
        WebFetchTool(),
        LintTool(),
        AskUserQuestionTool(),
        PlanTool(),
        EnterPlanModeTool(workspace_root),
        ExitPlanModeTool(workspace_root),
    ]
