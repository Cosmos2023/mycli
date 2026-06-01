from __future__ import annotations

from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from mycli.domain.tooling.calls import ToolCall
from mycli.llms.adapters.base import ModelToolDefinition, ModelToolParameter
from mycli.tools.base import (
    SchemaTool,
    ToolEffectProfile,
    ToolParameter,
    ToolSpec,
    ToolResult,
    mutation_targets_for_tool,
    tool_effects_for_tool,
    tool_has_mutation_contract,
)

_BUILTIN_TOOL_METADATA: dict[str, dict[str, object]] = {
    "Read": {
        "toolset": "file",
        "approval_policy": "auto_allow",
        "capability_tags": ("file", "read", "structured_data", "snapshot"),
    },
    "Edit": {
        "toolset": "file",
        "approval_policy": "auto_allow_or_request",
        "capability_tags": ("file", "edit", "mutation", "snapshot_guard", "diff"),
    },
    "Patch": {
        "toolset": "file",
        "approval_policy": "auto_allow_or_request",
        "capability_tags": ("file", "patch", "mutation", "snapshot_guard", "diff"),
    },
    "Write": {
        "toolset": "file",
        "approval_policy": "auto_allow_or_request",
        "capability_tags": ("file", "write", "mutation", "backup"),
    },
    "Grep": {
        "toolset": "search",
        "approval_policy": "auto_allow",
        "capability_tags": ("search", "file", "ripgrep"),
    },
    "Glob": {
        "toolset": "search",
        "approval_policy": "auto_allow",
        "capability_tags": ("search", "file", "glob"),
    },
    "LS": {
        "toolset": "file",
        "approval_policy": "auto_allow",
        "capability_tags": ("file", "list", "directory"),
    },
    "Bash": {
        "toolset": "terminal",
        "approval_policy": "shell_safety_analysis",
        "capability_tags": ("shell", "process", "terminal", "approval"),
    },
    "BashOutput": {
        "toolset": "terminal",
        "approval_policy": "auto_allow",
        "capability_tags": ("shell", "process", "background"),
    },
    "KillShell": {
        "toolset": "terminal",
        "approval_policy": "auto_allow_or_request",
        "capability_tags": ("shell", "process", "control", "mutation"),
    },
    "WebSearch": {
        "toolset": "web",
        "approval_policy": "auto_allow",
        "capability_tags": ("web", "search", "network"),
    },
    "WebFetch": {
        "toolset": "web",
        "approval_policy": "auto_allow",
        "capability_tags": ("web", "fetch", "network"),
    },
    "Lint": {
        "toolset": "dev",
        "approval_policy": "auto_allow",
        "capability_tags": ("dev", "diagnostics", "lint"),
    },
    "GitStatus": {
        "toolset": "dev",
        "approval_policy": "auto_allow",
        "capability_tags": ("dev", "git", "status", "read_only"),
    },
    "GitDiff": {
        "toolset": "dev",
        "approval_policy": "auto_allow",
        "capability_tags": ("dev", "git", "diff", "read_only"),
    },
    "GitLog": {
        "toolset": "dev",
        "approval_policy": "auto_allow",
        "capability_tags": ("dev", "git", "history", "read_only"),
    },
    "GitShow": {
        "toolset": "dev",
        "approval_policy": "auto_allow",
        "capability_tags": ("dev", "git", "revision", "read_only"),
    },
    "AskUserQuestion": {
        "toolset": "interaction",
        "approval_policy": "auto_allow",
        "capability_tags": ("clarification", "user_input"),
    },
    "Plan": {
        "toolset": "workflow",
        "approval_policy": "auto_allow",
        "capability_tags": ("planning", "status"),
    },
    "enter_plan_mode": {
        "toolset": "workflow",
        "approval_policy": "auto_allow",
        "capability_tags": ("planning", "mode"),
    },
    "exit_plan_mode": {
        "toolset": "workflow",
        "approval_policy": "auto_allow",
        "capability_tags": ("planning", "mode"),
    },
    "Task": {
        "toolset": "workflow",
        "approval_policy": "auto_allow_or_request",
        "capability_tags": ("task", "workflow", "subagent_foundation"),
    },
}


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

    def manifest(self) -> dict[str, object]:
        """Return the stable read-only manifest for registered local tools."""
        assert self.specs is not None
        assert self.executors is not None
        entries = [
            self._manifest_entry(name=name, spec=spec, executor=self.executors.get(name))
            for name, spec in sorted(self.specs.items())
        ]
        toolset_counts = Counter(
            entry["toolset"] for entry in entries if isinstance(entry["toolset"], str)
        )
        return {
            "schema_version": 1,
            "source": "builtin",
            "toolsets": [
                {"id": toolset, "tool_count": count}
                for toolset, count in sorted(toolset_counts.items())
            ],
            "tools": entries,
        }

    @staticmethod
    def manifest_issues(manifest: dict[str, object]) -> tuple[str, ...]:
        issues: list[str] = []
        if manifest.get("schema_version") != 1:
            issues.append("schema_version")
        tools = manifest.get("tools")
        if not isinstance(tools, list) or not tools:
            issues.append("tools")
            return tuple(issues)
        ids: list[str] = []
        names: list[str] = []
        required = {
            "id",
            "name",
            "toolset",
            "description",
            "parameters",
            "risk_level",
            "approval_policy",
            "capability_tags",
            "effects",
            "availability",
        }
        for index, item in enumerate(tools):
            if not isinstance(item, dict):
                issues.append(f"tools[{index}]")
                continue
            missing = sorted(required - set(item))
            if missing:
                issues.append(f"{item.get('name', index)} missing {','.join(missing)}")
            tool_id = item.get("id")
            name = item.get("name")
            if isinstance(tool_id, str) and tool_id:
                ids.append(tool_id)
            else:
                issues.append(f"{name or index} id")
            if isinstance(name, str) and name:
                names.append(name)
            else:
                issues.append(f"{tool_id or index} name")
            if item.get("risk_level") not in {"low", "medium", "high"}:
                issues.append(f"{name or index} risk_level")
            if not isinstance(item.get("parameters"), list):
                issues.append(f"{name or index} parameters")
            availability = item.get("availability")
            if not isinstance(availability, dict) or availability.get("status") != "available":
                issues.append(f"{name or index} availability")
        if len(ids) != len(set(ids)):
            issues.append("duplicate tool ids")
        if len(names) != len(set(names)):
            issues.append("duplicate tool names")
        return tuple(issues)

    def _manifest_entry(
        self,
        *,
        name: str,
        spec: ToolSpec,
        executor: SchemaTool | None,
    ) -> dict[str, object]:
        metadata = _BUILTIN_TOOL_METADATA.get(name, {})
        effect_profile = (
            tool_effects_for_tool(executor) if executor is not None else ToolEffectProfile()
        )
        return {
            "id": f"builtin:{name}",
            "name": name,
            "toolset": _metadata_text(metadata, "toolset", "general"),
            "description": spec.description,
            "parameters": [_parameter_manifest(parameter) for parameter in spec.parameters],
            "risk_level": spec.risk_level,
            "approval_policy": _approval_policy_for(spec=spec, metadata=metadata),
            "capability_tags": _capability_tags_for(spec=spec, metadata=metadata),
            "effects": {
                "filesystem": effect_profile.filesystem,
                "network": effect_profile.network,
                "process": effect_profile.process,
            },
            "availability": {"status": "available"},
            "usage_hint": None,
        }

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

    def mutation_targets(self, call: ToolCall) -> tuple[str, ...] | None:
        assert self.executors is not None
        executor = self.executors.get(call.name)
        if executor is None:
            raise ValueError(f"Unsupported tool: {call.name}")
        if not tool_has_mutation_contract(executor):
            return None
        self.validate(call.name, call.arguments)
        return mutation_targets_for_tool(executor, call.arguments)

    def effect_profile(self, call: ToolCall) -> ToolEffectProfile:
        assert self.executors is not None
        executor = self.executors.get(call.name)
        if executor is None:
            raise ValueError(f"Unsupported tool: {call.name}")
        return tool_effects_for_tool(executor)


def default_tools(workspace_root: Path) -> list[SchemaTool]:
    from mycli.tools.ask_user_question import AskUserQuestionTool
    from mycli.tools.bash import BashTool
    from mycli.tools.bash_output import BashOutputTool
    from mycli.tools.edit import EditTool
    from mycli.tools.file_snapshot import FileSnapshotStore
    from mycli.tools.git_tools import GitDiffTool, GitLogTool, GitShowTool, GitStatusTool
    from mycli.tools.glob import GlobTool
    from mycli.tools.grep import GrepTool
    from mycli.tools.kill_shell import KillShellTool
    from mycli.tools.lint import LintTool
    from mycli.tools.ls import LSTool
    from mycli.tools.patch import PatchTool
    from mycli.tools.plan import PlanTool
    from mycli.tools.plan_mode import EnterPlanModeTool, ExitPlanModeTool
    from mycli.tools.read import ReadTool
    from mycli.tools.task import TaskTool
    from mycli.tools.web_fetch import WebFetchTool
    from mycli.tools.web_search import WebSearchTool
    from mycli.tools.write import WriteTool

    snapshot_store = FileSnapshotStore()
    return [
        ReadTool(workspace_root, snapshot_store=snapshot_store),
        EditTool(workspace_root, snapshot_store=snapshot_store),
        PatchTool(workspace_root, snapshot_store=snapshot_store),
        WriteTool(workspace_root),
        GrepTool(workspace_root),
        GlobTool(workspace_root),
        LSTool(workspace_root),
        BashTool(workspace_root),
        BashOutputTool(),
        KillShellTool(),
        WebSearchTool(),
        WebFetchTool(),
        LintTool(),
        GitStatusTool(workspace_root),
        GitDiffTool(workspace_root),
        GitLogTool(workspace_root),
        GitShowTool(workspace_root),
        AskUserQuestionTool(),
        PlanTool(),
        EnterPlanModeTool(workspace_root),
        ExitPlanModeTool(workspace_root),
        TaskTool(),
    ]


def _parameter_manifest(parameter: ToolParameter) -> dict[str, object]:
    payload: dict[str, object] = {
        "name": parameter.name,
        "type": parameter.type,
        "required": parameter.required,
    }
    if parameter.description:
        payload["description"] = parameter.description
    if parameter.items_schema is not None:
        payload["items_schema"] = dict(parameter.items_schema)
    return payload


def _metadata_text(metadata: dict[str, object], key: str, fallback: str) -> str:
    value = metadata.get(key)
    if isinstance(value, str) and value:
        return value
    return fallback


def _approval_policy_for(*, spec: ToolSpec, metadata: dict[str, object]) -> str:
    value = metadata.get("approval_policy")
    if isinstance(value, str) and value:
        return value
    if spec.risk_level == "medium":
        return "auto_allow_or_request"
    if spec.risk_level == "high":
        return "requires_approval"
    return "auto_allow"


def _capability_tags_for(*, spec: ToolSpec, metadata: dict[str, object]) -> list[str]:
    value = metadata.get("capability_tags")
    if isinstance(value, tuple) and all(isinstance(item, str) for item in value):
        return sorted(set(value))
    return []
