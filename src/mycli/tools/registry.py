from __future__ import annotations

from collections import Counter, defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from mycli.domain.tooling.calls import ToolCall
from mycli.domain.tooling.contributed_tools import (
    ToolContributionRegistration,
    ToolContributionSource,
)
from mycli.llms.adapters.base import ModelToolDefinition, ModelToolParameter
from mycli.tools.base import (
    SchemaTool,
    ToolEffectProfile,
    ToolParameter,
    ToolResult,
    ToolSpec,
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
    "SubagentOutput": {
        "toolset": "workflow",
        "approval_policy": "auto_allow",
        "capability_tags": ("task", "workflow", "subagent", "background"),
    },
}


_DEFAULT_TOOLSET_ALIASES: dict[str, tuple[str, ...]] = {
    "dev": ("git", "lint"),
    "file": ("files", "fs"),
    "interaction": ("clarify", "user-input"),
    "search": ("find",),
    "terminal": ("shell",),
    "workflow": ("planning", "delegation"),
}


@dataclass(slots=True, frozen=True)
class ToolsetPolicy:
    enabled: bool = True
    aliases: tuple[str, ...] = ()
    availability: dict[str, object] = field(default_factory=lambda: {"status": "available"})


@dataclass(slots=True, frozen=True)
class ToolsetRegistry:
    tool_entries: tuple[dict[str, object], ...]
    policies: dict[str, ToolsetPolicy] = field(default_factory=dict)

    @classmethod
    def from_tool_manifest(
        cls,
        manifest: dict[str, object],
        *,
        policies: dict[str, ToolsetPolicy] | None = None,
    ) -> ToolsetRegistry:
        tools = manifest.get("tools")
        entries = tuple(item for item in tools if isinstance(item, dict)) if isinstance(tools, list) else ()
        return cls(tool_entries=entries, policies={} if policies is None else dict(policies))

    def manifest(self) -> dict[str, object]:
        grouped: dict[str, list[dict[str, object]]] = defaultdict(list)
        for entry in self.tool_entries:
            toolset = entry.get("toolset")
            if isinstance(toolset, str) and toolset:
                grouped[toolset].append(entry)
        toolsets = [
            self._toolset_entry(toolset_id, tuple(sorted(entries, key=lambda item: str(item.get("name", "")))))
            for toolset_id, entries in sorted(grouped.items())
        ]
        conflicts = self.conflicts()
        return {
            "schema_version": 1,
            "source": "extension_foundation",
            "toolsets": toolsets,
            "conflicts": conflicts,
            "summary": {
                "toolset_count": len(toolsets),
                "tool_count": len(self.tool_entries),
                "enabled_toolsets": sum(1 for item in toolsets if item["enabled"] is True),
                "disabled_toolsets": sum(1 for item in toolsets if item["enabled"] is False),
                "conflict_count": len(conflicts),
            },
        }

    def conflicts(self) -> list[dict[str, object]]:
        issues: list[dict[str, object]] = []
        alias_owners: dict[str, str] = {}
        for toolset_id in sorted(self._toolset_ids()):
            aliases = self._aliases_for(toolset_id)
            for alias in aliases:
                owner = alias_owners.get(alias)
                if owner is not None and owner != toolset_id:
                    issues.append(
                        {
                            "type": "alias_conflict",
                            "alias": alias,
                            "toolsets": sorted((owner, toolset_id)),
                        }
                    )
                else:
                    alias_owners[alias] = toolset_id
        route_counts = Counter(
            entry.get("name") for entry in self.tool_entries if isinstance(entry.get("name"), str)
        )
        for route_name, count in sorted(route_counts.items()):
            if count > 1:
                issues.append(
                    {
                        "type": "route_conflict",
                        "route_name": route_name,
                        "count": count,
                    }
                )
        return issues

    def manifest_issues(self) -> tuple[str, ...]:
        manifest = self.manifest()
        issues: list[str] = []
        toolsets = manifest.get("toolsets")
        if not isinstance(toolsets, list) or not toolsets:
            issues.append("toolsets")
            return tuple(issues)
        required = {
            "id",
            "enabled",
            "aliases",
            "sources",
            "tool_count",
            "tools",
            "availability",
        }
        for index, item in enumerate(toolsets):
            if not isinstance(item, dict):
                issues.append(f"toolsets[{index}]")
                continue
            missing = sorted(required - set(item))
            if missing:
                issues.append(f"{item.get('id', index)} missing {','.join(missing)}")
            if not isinstance(item.get("enabled"), bool):
                issues.append(f"{item.get('id', index)} enabled")
            if not isinstance(item.get("aliases"), list):
                issues.append(f"{item.get('id', index)} aliases")
            if not isinstance(item.get("tools"), list):
                issues.append(f"{item.get('id', index)} tools")
            availability = item.get("availability")
            if not isinstance(availability, dict) or not isinstance(availability.get("status"), str):
                issues.append(f"{item.get('id', index)} availability")
        if manifest.get("conflicts"):
            issues.append("conflicts")
        return tuple(issues)

    def _toolset_entry(
        self,
        toolset_id: str,
        entries: tuple[dict[str, object], ...],
    ) -> dict[str, object]:
        policy = self.policies.get(toolset_id, ToolsetPolicy(aliases=_DEFAULT_TOOLSET_ALIASES.get(toolset_id, ())))
        sources = sorted(
            {
                str(entry.get("source", "builtin"))
                for entry in entries
                if isinstance(entry.get("source", "builtin"), str)
            }
        )
        return {
            "id": toolset_id,
            "enabled": policy.enabled,
            "aliases": sorted(set(policy.aliases)),
            "sources": sources,
            "tool_count": len(entries),
            "tools": [str(entry["name"]) for entry in entries if isinstance(entry.get("name"), str)],
            "availability": dict(policy.availability),
        }

    def _toolset_ids(self) -> set[str]:
        return {
            str(entry["toolset"])
            for entry in self.tool_entries
            if isinstance(entry.get("toolset"), str) and entry.get("toolset")
        }

    def _aliases_for(self, toolset_id: str) -> tuple[str, ...]:
        policy = self.policies.get(toolset_id)
        if policy is not None:
            return policy.aliases
        return _DEFAULT_TOOLSET_ALIASES.get(toolset_id, ())


def contributed_tool_manifest_entry(
    registration: ToolContributionRegistration,
) -> dict[str, object]:
    descriptor = registration.descriptor
    effect_profile = tool_effects_for_tool(registration.tool)
    source = _contributed_manifest_source(descriptor)
    return {
        "id": descriptor.tool_id,
        "name": descriptor.route_name,
        "source": source,
        "toolset": _contributed_toolset_for(source),
        "description": descriptor.spec.description,
        "parameters": [_parameter_manifest(parameter) for parameter in descriptor.spec.parameters],
        "risk_level": descriptor.spec.risk_level,
        "approval_policy": _approval_policy_for(spec=descriptor.spec, metadata={}),
        "capability_tags": sorted(
            {
                "contributed",
                source,
                descriptor.scope.value,
                descriptor.lifecycle_state.value,
            }
        ),
        "effects": {
            "filesystem": effect_profile.filesystem,
            "network": effect_profile.network,
            "process": effect_profile.process,
        },
        "availability": {"status": "available", "state": descriptor.lifecycle_state.value},
        "usage_hint": None,
        "contribution": {
            "display_name": descriptor.display_name,
            "scope": descriptor.scope.value,
            "state": descriptor.lifecycle_state.value,
            "origin": dict(descriptor.origin_metadata),
        },
    }


def combined_tool_manifest(
    *,
    builtin_manifest: dict[str, object],
    contributed_tools: tuple[ToolContributionRegistration, ...] = (),
) -> dict[str, object]:
    tools = builtin_manifest.get("tools")
    entries = list(tools) if isinstance(tools, list) else []
    entries.extend(contributed_tool_manifest_entry(registration) for registration in contributed_tools)
    toolset_counts = Counter(
        entry["toolset"]
        for entry in entries
        if isinstance(entry, dict) and isinstance(entry.get("toolset"), str)
    )
    return {
        **builtin_manifest,
        "source": "combined",
        "toolsets": [
            {"id": toolset, "tool_count": count}
            for toolset, count in sorted(toolset_counts.items())
        ],
        "tools": entries,
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

    def toolset_registry(
        self,
        *,
        policies: dict[str, ToolsetPolicy] | None = None,
    ) -> ToolsetRegistry:
        return ToolsetRegistry.from_tool_manifest(self.manifest(), policies=policies)

    @staticmethod
    def toolset_registry_from_manifest(
        manifest: dict[str, object],
        *,
        policies: dict[str, ToolsetPolicy] | None = None,
    ) -> ToolsetRegistry:
        return ToolsetRegistry.from_tool_manifest(manifest, policies=policies)

    def toolset_manifest(
        self,
        *,
        policies: dict[str, ToolsetPolicy] | None = None,
    ) -> dict[str, object]:
        return self.toolset_registry(policies=policies).manifest()

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
            if item.get("source") not in {
                "builtin",
                "contributed",
                "provider",
                "mcp",
                "plugin",
                "skill",
                "subagent",
            }:
                issues.append(f"{item.get('name', index)} source")
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
        metadata = _tool_metadata(name=name, executor=executor)
        effect_profile = (
            tool_effects_for_tool(executor) if executor is not None else ToolEffectProfile()
        )
        source = _metadata_text(metadata, "source", "builtin")
        tool_id = _metadata_text(metadata, "id", f"{source}:{name}" if source != "builtin" else f"builtin:{name}")
        return {
            "id": tool_id,
            "name": name,
            "source": source,
            "toolset": _metadata_text(metadata, "toolset", "general"),
            "description": spec.description,
            "parameters": [_parameter_manifest(parameter) for parameter in spec.parameters],
            "risk_level": spec.risk_level,
            "supports_parallel_tool_calls": spec.supports_parallel_tool_calls,
            "approval_policy": _approval_policy_for(spec=spec, metadata=metadata),
            "capability_tags": _capability_tags_for(metadata=metadata),
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

    def supports_parallel_tool_calls(self, name: str) -> bool:
        assert self.specs is not None
        spec = self.specs.get(name)
        if spec is None:
            raise ValueError(f"Unsupported tool: {name}")
        return spec.supports_parallel_tool_calls


def default_tools(workspace_root: Path) -> list[SchemaTool]:
    from mycli.services.filesystem import FileSystemRuntime
    from mycli.tools.ask_user_question import AskUserQuestionTool
    from mycli.tools.bash import BashTool
    from mycli.tools.bash_output import BashOutputTool
    from mycli.tools.edit import EditTool
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
    from mycli.tools.subagent_output import SubagentOutputTool
    from mycli.tools.task import TaskTool
    from mycli.tools.web_fetch import WebFetchTool
    from mycli.tools.web_search import WebSearchTool
    from mycli.tools.write import WriteTool

    filesystem_runtime = FileSystemRuntime(workspace_root=workspace_root)
    return [
        ReadTool(workspace_root, filesystem_runtime=filesystem_runtime),
        EditTool(workspace_root, filesystem_runtime=filesystem_runtime),
        PatchTool(workspace_root, filesystem_runtime=filesystem_runtime),
        WriteTool(workspace_root, filesystem_runtime=filesystem_runtime),
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
        SubagentOutputTool(),
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


def _tool_metadata(*, name: str, executor: SchemaTool | None) -> dict[str, object]:
    metadata = dict(_BUILTIN_TOOL_METADATA.get(name, {}))
    if executor is None:
        return metadata
    extra = getattr(executor, "manifest_metadata", None)
    if isinstance(extra, dict):
        metadata.update(extra)
    return metadata


def _approval_policy_for(*, spec: ToolSpec, metadata: dict[str, object]) -> str:
    value = metadata.get("approval_policy")
    if isinstance(value, str) and value:
        return value
    if spec.risk_level == "medium":
        return "auto_allow_or_request"
    if spec.risk_level == "high":
        return "requires_approval"
    return "auto_allow"


def _capability_tags_for(*, metadata: dict[str, object]) -> list[str]:
    value = metadata.get("capability_tags")
    if isinstance(value, tuple) and all(isinstance(item, str) for item in value):
        return sorted(set(value))
    return []


def _contributed_manifest_source(descriptor: object) -> str:
    source = getattr(descriptor, "source", None)
    tool_id = getattr(descriptor, "tool_id", "")
    origin_metadata = getattr(descriptor, "origin_metadata", {})
    if (
        isinstance(tool_id, str)
        and tool_id.startswith("mcp:")
        and isinstance(origin_metadata, dict)
        and isinstance(origin_metadata.get("server"), str)
        and isinstance(origin_metadata.get("tool"), str)
    ):
        return "mcp"
    if (
        isinstance(tool_id, str)
        and tool_id.startswith("skill:")
        and isinstance(origin_metadata, dict)
        and isinstance(origin_metadata.get("skill"), str)
    ):
        return "skill"
    if (
        isinstance(tool_id, str)
        and tool_id.startswith("subagent:")
        and isinstance(origin_metadata, dict)
        and isinstance(origin_metadata.get("profile"), str)
    ):
        return "subagent"
    if source is ToolContributionSource.PROVIDER:
        return "provider"
    return "contributed"


def _contributed_toolset_for(source: str) -> str:
    if source in {"mcp", "provider", "skill", "subagent"}:
        return "external"
    return "runtime"
