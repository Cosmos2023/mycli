from __future__ import annotations

from dataclasses import dataclass, field
import importlib.util
from pathlib import Path
from types import ModuleType
from typing import Any, Callable

from mycli.services.hooks import HookAction, HookContext, HookManager, HookPoint, HookResult
from mycli.services.plugins.config import PluginEnablement
from mycli.services.plugins.discovery import PluginDiscovery, discover_plugins
from mycli.services.plugins.manifest import PluginCandidate, PluginIssue, PluginLoadStatus
from mycli.services.plugins.tool import PluginTool, tool_spec_from_schema
from mycli.tools.registry import ToolRegistry


@dataclass(slots=True, frozen=True)
class LoadedPlugin:
    candidate: PluginCandidate
    status: PluginLoadStatus
    registered_hooks: tuple[str, ...] = ()
    registered_tools: tuple[str, ...] = ()
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
    registered_hooks: list[str] = field(default_factory=list)
    registered_tools: list[str] = field(default_factory=list)

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


def load_enabled_plugins(
    *,
    workspace_root: Path,
    home_dir: Path,
    hook_manager: HookManager,
    tool_registry: ToolRegistry,
    env: dict[str, str],
) -> PluginRuntimeState:
    discovery = discover_plugins(workspace_root=workspace_root, home_dir=home_dir)
    loaded: list[LoadedPlugin] = []
    for candidate in discovery.selected:
        loaded.append(_load_candidate(
            candidate,
            enablement=discovery.enablement,
            hook_manager=hook_manager,
            tool_registry=tool_registry,
            env=env,
        ))
    return PluginRuntimeState(discovery=discovery, loaded=tuple(loaded))


def _load_candidate(
    candidate: PluginCandidate,
    *,
    enablement: PluginEnablement,
    hook_manager: HookManager,
    tool_registry: ToolRegistry,
    env: dict[str, str],
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
    module, issue = _load_module(candidate)
    if issue is not None:
        issues.append(issue)
        return LoadedPlugin(candidate=candidate, status=PluginLoadStatus.ERROR, issues=tuple(issues))
    register = getattr(module, "register", None)
    if not callable(register):
        issues.append(PluginIssue(candidate.plugin_id, candidate.source, candidate.module_path, "register(ctx) missing"))
        return LoadedPlugin(candidate=candidate, status=PluginLoadStatus.ERROR, issues=tuple(issues))
    ctx = PluginContext(
        plugin_id=candidate.plugin_id,
        hook_manager=hook_manager,
        tool_registry=tool_registry,
    )
    try:
        register(ctx)
    except Exception as exc:
        issues.append(PluginIssue(candidate.plugin_id, candidate.source, candidate.module_path, f"register failed: {exc.__class__.__name__}"))
        return LoadedPlugin(candidate=candidate, status=PluginLoadStatus.ERROR, issues=tuple(issues))
    return LoadedPlugin(
        candidate=candidate,
        status=PluginLoadStatus.LOADED,
        registered_hooks=tuple(ctx.registered_hooks),
        registered_tools=tuple(ctx.registered_tools),
        issues=tuple(issues),
    )


def _load_module(candidate: PluginCandidate) -> tuple[ModuleType | None, PluginIssue | None]:
    module_name = f"mycli_user_plugin_{candidate.source.value}_{candidate.plugin_id.replace('-', '_')}"
    try:
        spec = importlib.util.spec_from_file_location(module_name, candidate.module_path)
        if spec is None or spec.loader is None:
            return None, PluginIssue(candidate.plugin_id, candidate.source, candidate.module_path, "module spec unavailable")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
    except Exception as exc:
        return None, PluginIssue(candidate.plugin_id, candidate.source, candidate.module_path, f"load failed: {exc.__class__.__name__}")
    return module, None


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
            return HookResult(
                action=hook_action,
                message=str(message) if message else "",
                modified_args=dict(modified_args) if isinstance(modified_args, dict) else None,
            )
        return HookResult(action=HookAction.ALLOW)
    return invoke
