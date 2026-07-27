from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

from mycli.domain.runtime import ExecutionPolicy, SandboxProfile
from mycli.domain.tooling.output import ToolModelOutput
from mycli.services.hooks import HookAction, HookContext, HookManager, HookPoint, HookResult
from mycli.services.plugins.commands import PluginCommandRegistry
from mycli.services.plugins.config import PluginEnablement
from mycli.services.plugins.discovery import PluginDiscovery, discover_plugins
from mycli.services.plugins.host import (
    PluginHostError,
    PluginProcessHost,
    hook_context_payload,
)
from mycli.services.plugins.manifest import PluginCandidate, PluginIssue, PluginLoadStatus
from mycli.services.plugins.tool import PluginTool, tool_spec_from_schema
from mycli.tools.base import ToolResult
from mycli.tools.registry import ToolRegistry


@dataclass(slots=True, frozen=True)
class LoadedPlugin:
    candidate: PluginCandidate
    status: PluginLoadStatus
    registered_hooks: tuple[str, ...] = ()
    registered_tools: tuple[str, ...] = ()
    registered_commands: tuple[str, ...] = ()
    issues: tuple[PluginIssue, ...] = ()

    @property
    def plugin_id(self) -> str:
        return self.candidate.plugin_id


@dataclass(slots=True, frozen=True)
class PluginRuntimeState:
    discovery: PluginDiscovery
    loaded: tuple[LoadedPlugin, ...]

    @property
    def issues(self) -> tuple[PluginIssue, ...]:
        collected: list[PluginIssue] = list(self.discovery.issues)
        for item in self.loaded:
            collected.extend(item.issues)
        return tuple(collected)


@dataclass(slots=True)
class PluginContext:
    plugin_id: str
    hook_manager: HookManager
    tool_registry: ToolRegistry
    command_registry: PluginCommandRegistry | None = None
    registered_hooks: list[str] = field(default_factory=list)
    registered_tools: list[str] = field(default_factory=list)
    registered_commands: list[str] = field(default_factory=list)

    def register_hook(self, hook_point: str | HookPoint, callback: Callable[..., Any], name: str | None = None) -> None:
        point = hook_point if isinstance(hook_point, HookPoint) else HookPoint(str(hook_point))
        hook_name = name or f"plugin:{self.plugin_id}:{getattr(callback, '__name__', 'hook')}"
        self.hook_manager.register(point, _plugin_hook_callback(callback), name=hook_name)
        self.registered_hooks.append(f"{point.value}:{hook_name}")

    def register_tool(
        self,
        name: str,
        schema: dict[str, Any],
        handler: Callable[[dict[str, Any]], Any],
        metadata: dict[str, Any] | None = None,
    ) -> None:
        spec = tool_spec_from_schema(name, schema)
        toolset = "plugin"
        tags: tuple[str, ...] = ()
        if metadata:
            toolset_value = metadata.get("toolset")
            if isinstance(toolset_value, str) and toolset_value:
                toolset = toolset_value
            raw_tags = metadata.get("capability_tags")
            if isinstance(raw_tags, (list, tuple)):
                tags = tuple(item for item in raw_tags if isinstance(item, str))
        self.tool_registry.register(
            PluginTool(
                spec=spec,
                handler=handler,
                plugin_id=self.plugin_id,
                toolset=toolset,
                capability_tags=tags,
            )
        )
        self.registered_tools.append(name)

    def register_command(
        self,
        name: str,
        schema: dict[str, Any],
        handler: Callable[[dict[str, Any]], Any],
        metadata: dict[str, Any] | None = None,
    ) -> None:
        if self.command_registry is None:
            return
        command_id = self.command_registry.register(
            plugin_id=self.plugin_id,
            name=name,
            schema=schema if isinstance(schema, dict) else {},
            handler=handler,
            metadata=metadata,
        )
        if command_id is not None:
            self.registered_commands.append(command_id)


def load_enabled_plugins(
    *,
    workspace_root: Path,
    home_dir: Path,
    hook_manager: HookManager,
    tool_registry: ToolRegistry,
    command_registry: PluginCommandRegistry | None = None,
    env: dict[str, str],
    sandbox: SandboxProfile | None = None,
) -> PluginRuntimeState:
    discovery = discover_plugins(workspace_root=workspace_root, home_dir=home_dir)
    effective_sandbox = sandbox or ExecutionPolicy.for_workspace(workspace_root).sandbox
    loaded: list[LoadedPlugin] = []
    for candidate in discovery.selected:
        loaded.append(_load_candidate(
            candidate,
            enablement=discovery.enablement,
            hook_manager=hook_manager,
            tool_registry=tool_registry,
            command_registry=command_registry,
            env=env,
            workspace_root=workspace_root,
            sandbox=effective_sandbox,
        ))
    return PluginRuntimeState(discovery=discovery, loaded=tuple(loaded))


def _load_candidate(
    candidate: PluginCandidate,
    *,
    enablement: PluginEnablement,
    hook_manager: HookManager,
    tool_registry: ToolRegistry,
    command_registry: PluginCommandRegistry | None,
    env: dict[str, str],
    workspace_root: Path,
    sandbox: SandboxProfile | None,
) -> LoadedPlugin:
    issues = list(candidate.issues)
    if not enablement.is_enabled(candidate.plugin_id):
        return LoadedPlugin(candidate=candidate, status=PluginLoadStatus.DISABLED, issues=tuple(issues))
    if candidate.manifest is None:
        return LoadedPlugin(candidate=candidate, status=PluginLoadStatus.ERROR, issues=tuple(issues))
    missing_env = [name for name in candidate.manifest.requires_env if not env.get(name)]
    if missing_env:
        issues.append(PluginIssue(candidate.plugin_id, candidate.source, candidate.manifest_path, f"missing required env: {', '.join(sorted(missing_env))}"))
        return LoadedPlugin(candidate=candidate, status=PluginLoadStatus.ERROR, issues=tuple(issues))
    if candidate.issues:
        return LoadedPlugin(candidate=candidate, status=PluginLoadStatus.ERROR, issues=tuple(issues))
    host = PluginProcessHost(
        candidate=candidate,
        workspace_root=workspace_root,
        env={
            name: env[name]
            for name in candidate.manifest.requires_env
            if name in env
        },
        sandbox=sandbox,
    )
    try:
        registrations = host.describe()
    except PluginHostError as exc:
        issues.append(
            PluginIssue(
                candidate.plugin_id,
                candidate.source,
                candidate.module_path,
                f"load failed: {exc.error_type}",
            )
        )
        return LoadedPlugin(candidate=candidate, status=PluginLoadStatus.ERROR, issues=tuple(issues))
    ctx = PluginContext(
        plugin_id=candidate.plugin_id,
        hook_manager=hook_manager,
        tool_registry=tool_registry,
        command_registry=command_registry,
    )
    for registration in registrations:
        try:
            if registration.kind == "hook" and registration.hook_point is not None:
                ctx.register_hook(
                    registration.hook_point,
                    _remote_hook_handler(host, registration.token),
                    name=registration.name,
                )
            elif registration.kind == "tool":
                ctx.register_tool(
                    registration.name,
                    registration.schema,
                    _remote_tool_handler(host, registration.token),
                    registration.metadata,
                )
            elif registration.kind == "command":
                ctx.register_command(
                    registration.name,
                    registration.schema,
                    _remote_command_handler(host, registration.token),
                    registration.metadata,
                )
        except (TypeError, ValueError) as exc:
            issues.append(
                PluginIssue(
                    candidate.plugin_id,
                    candidate.source,
                    candidate.module_path,
                    f"registration failed: {exc.__class__.__name__}",
                )
            )
    return LoadedPlugin(
        candidate=candidate,
        status=PluginLoadStatus.LOADED,
        registered_hooks=tuple(ctx.registered_hooks),
        registered_tools=tuple(ctx.registered_tools),
        registered_commands=tuple(ctx.registered_commands),
        issues=tuple(issues),
    )


def _remote_hook_handler(
    host: PluginProcessHost,
    token: str,
) -> Callable[[HookContext], object]:
    def invoke(context: HookContext) -> object:
        try:
            result = host.invoke(
                token,
                hook_context_payload(
                    hook_point=context.hook_point.value,
                    tool_name=context.tool_name,
                    tool_args=context.tool_args,
                    session_id=context.session_id,
                    metadata=context.metadata,
                ),
            )
        except PluginHostError as exc:
            return HookResult(
                action=HookAction.ERROR,
                message=f"plugin hook failed: {exc.error_type}",
            )
        return result

    return invoke


def _remote_tool_handler(
    host: PluginProcessHost,
    token: str,
) -> Callable[[dict[str, Any]], object]:
    def invoke(arguments: dict[str, Any]) -> object:
        try:
            return host.invoke(token, arguments)
        except PluginHostError as exc:
            message = f"Plugin tool failed: {exc.error_type}"
            return ToolResult(
                success=False,
                summary="plugin tool failed",
                error=exc.error_type,
                model_output=ToolModelOutput.from_text(message, success=False),
            )

    return invoke


def _remote_command_handler(
    host: PluginProcessHost,
    token: str,
) -> Callable[[dict[str, Any]], object]:
    def invoke(arguments: dict[str, Any]) -> object:
        try:
            return host.invoke(token, arguments)
        except PluginHostError as exc:
            return {
                "ok": False,
                "summary": "plugin command failed",
                "error": exc.error_type,
            }

    return invoke


def _plugin_hook_callback(callback: Callable[..., Any]) -> Callable[[HookContext], HookResult]:
    def invoke(ctx: HookContext) -> HookResult:
        try:
            result = callback(ctx)
        except Exception as exc:
            return HookResult(action=HookAction.ERROR, message=f"plugin hook failed: {exc.__class__.__name__}")
        if isinstance(result, HookResult):
            return result
        if isinstance(result, dict):
            action = result.get("action", HookAction.ALLOW.value)
            try:
                hook_action = HookAction(str(action))
            except ValueError:
                hook_action = HookAction.ERROR
            message = result.get("message", "")
            modified_args = result.get("modified_args")
            additional_contexts = result.get("additional_contexts")
            return HookResult(
                action=hook_action,
                message=str(message) if message else "",
                modified_args=dict(modified_args) if isinstance(modified_args, dict) else None,
                additional_contexts=_plugin_additional_contexts(additional_contexts),
            )
        return HookResult(action=HookAction.ALLOW)
    return invoke


def _plugin_additional_contexts(value: object) -> tuple[str, ...]:
    if isinstance(value, str):
        return (value,) if value.strip() else ()
    if not isinstance(value, list):
        return ()
    return tuple(item for item in value if isinstance(item, str) and item.strip())
