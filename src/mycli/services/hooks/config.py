from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum
import json
from pathlib import Path
import re
from typing import Callable

from mycli.services.hooks.types import HookPoint
from mycli.tools.shell_resolver import (
    ShellCommandConfig,
    ShellResolutionError,
    resolve_shell,
)

DEFAULT_HOOK_TIMEOUT_SECONDS = 2.0
MAX_HOOK_TIMEOUT_SECONDS = 30.0


class HookConfigScope(StrEnum):
    REPO = "repo"
    USER = "user"


class HookWorkingDirectory(StrEnum):
    WORKSPACE = "workspace"
    CONFIG = "config"


class HookEnvPolicy(StrEnum):
    MINIMAL = "minimal"
    INHERIT_SAFE = "inherit_safe"


@dataclass(slots=True, frozen=True)
class HookMatcher:
    tool_name: str | None = None
    pattern: str | None = None

    def matches(self, *, hook_point: HookPoint, tool_name: str | None, source: str | None = None) -> bool:
        if hook_point in {HookPoint.USER_PROMPT_SUBMIT, HookPoint.STOP}:
            return True
        if self.tool_name is None:
            target = source if hook_point is HookPoint.SESSION_START else tool_name
            if self.pattern is None:
                return True
            return _pattern_matches(self.pattern, target)
        return tool_name == self.tool_name


@dataclass(slots=True, frozen=True)
class ConfiguredHookSpec:
    hook_id: str
    hook_point: HookPoint
    command: tuple[str, ...]
    enabled: bool = True
    timeout_seconds: float = DEFAULT_HOOK_TIMEOUT_SECONDS
    working_directory: HookWorkingDirectory = HookWorkingDirectory.WORKSPACE
    env_policy: HookEnvPolicy = HookEnvPolicy.MINIMAL
    matcher: HookMatcher = field(default_factory=HookMatcher)
    source: HookConfigScope = HookConfigScope.REPO
    source_path: Path | None = None

    @property
    def name(self) -> str:
        return f"configured:{self.source.value}:{self.hook_id}"

    def matches_tool(self, tool_name: str | None) -> bool:
        return self.matches(tool_name=tool_name)

    def matches(self, *, tool_name: str | None = None, source: str | None = None) -> bool:
        return self.matcher.matches(
            hook_point=self.hook_point,
            tool_name=tool_name,
            source=source,
        )


@dataclass(slots=True, frozen=True)
class HookConfigIssue:
    source: HookConfigScope
    path: Path
    message: str

    def safe_line(self) -> str:
        return f"{self.source.value}:{self.path.name}: {self.message}"


@dataclass(slots=True, frozen=True)
class HookConfigDiscovery:
    hooks: tuple[ConfiguredHookSpec, ...]
    issues: tuple[HookConfigIssue, ...]


class HookConfigRegistry:
    def __init__(
        self,
        *,
        workspace_root: Path,
        home_dir: Path,
        shell_path: str | None = None,
        shell_resolver: Callable[[str | None], ShellCommandConfig] = resolve_shell,
    ) -> None:
        self._workspace_root = workspace_root
        self._home_dir = home_dir
        self._shell_path = shell_path
        self._shell_resolver = shell_resolver

    @property
    def repo_config_path(self) -> Path:
        return self._workspace_root / ".mycli" / "hooks.json"

    @property
    def user_config_path(self) -> Path:
        return self._home_dir / ".mycli" / "hooks.json"

    def discover(self) -> HookConfigDiscovery:
        hooks: list[ConfiguredHookSpec] = []
        issues: list[HookConfigIssue] = []
        for scope, path in (
            (HookConfigScope.USER, self.user_config_path),
            (HookConfigScope.REPO, self.repo_config_path),
        ):
            loaded = self._load_config(scope=scope, path=path)
            hooks.extend(loaded.hooks)
            issues.extend(loaded.issues)
        return HookConfigDiscovery(hooks=tuple(hooks), issues=tuple(issues))

    def _load_config(self, *, scope: HookConfigScope, path: Path) -> HookConfigDiscovery:
        if not path.exists():
            return HookConfigDiscovery(hooks=(), issues=())
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            return HookConfigDiscovery(
                hooks=(),
                issues=(HookConfigIssue(scope, path, f"not parseable: {exc}"),),
            )
        if not isinstance(payload, dict):
            return HookConfigDiscovery(
                hooks=(),
                issues=(HookConfigIssue(scope, path, "root must be a JSON object"),),
            )
        raw_hooks = _raw_hook_entries(payload)
        if raw_hooks is None:
            return HookConfigDiscovery(
                hooks=(),
                issues=(
                    HookConfigIssue(
                        scope,
                        path,
                        "hooks must be a list or Codex event groups",
                    ),
                ),
            )

        hooks: list[ConfiguredHookSpec] = []
        issues: list[HookConfigIssue] = []
        seen_ids: set[str] = set()
        for index, raw_hook in enumerate(raw_hooks):
            parsed, issue = _parse_hook(
                scope=scope,
                path=path,
                index=index,
                raw_hook=raw_hook,
                shell_path=self._shell_path,
                shell_resolver=self._shell_resolver,
            )
            if issue is not None:
                issues.append(issue)
                continue
            assert parsed is not None
            if parsed.hook_id in seen_ids:
                issues.append(HookConfigIssue(scope, path, f"duplicate hook id: {parsed.hook_id}"))
                continue
            seen_ids.add(parsed.hook_id)
            hooks.append(parsed)
        return HookConfigDiscovery(hooks=tuple(hooks), issues=tuple(issues))


_CODEX_HOOK_POINTS = {
    "PreToolUse": HookPoint.PRE_TOOL_USE,
    "PostToolUse": HookPoint.POST_TOOL_USE,
    "SessionStart": HookPoint.SESSION_START,
    "UserPromptSubmit": HookPoint.USER_PROMPT_SUBMIT,
    "Stop": HookPoint.STOP,
}


def _raw_hook_entries(payload: dict[str, object]) -> list[object] | None:
    raw_hooks = payload.get("hooks")
    if isinstance(raw_hooks, list):
        return raw_hooks
    codex_entries: list[object] = []
    for event_name, hook_point in _CODEX_HOOK_POINTS.items():
        raw_group = payload.get(event_name)
        if raw_group is None:
            continue
        if not isinstance(raw_group, list):
            return None
        for group_index, raw_entry in enumerate(raw_group):
            if not isinstance(raw_entry, dict):
                codex_entries.append(raw_entry)
                continue
            group_matcher = raw_entry.get("matcher")
            raw_group_hooks = raw_entry.get("hooks")
            if not isinstance(raw_group_hooks, list):
                codex_entries.append(raw_entry)
                continue
            for hook_index, raw_hook in enumerate(raw_group_hooks):
                if not isinstance(raw_hook, dict):
                    codex_entries.append(raw_hook)
                    continue
                raw_hook_type = raw_hook.get("type", "command")
                if raw_hook_type != "command":
                    continue
                codex_entries.append(
                    _codex_hook_to_flat_hook(
                        raw_hook,
                        hook_point=hook_point,
                        matcher=group_matcher,
                        event_name=event_name,
                        group_index=group_index,
                        hook_index=hook_index,
                    )
                )
    if codex_entries:
        return codex_entries
    if raw_hooks is None:
        return []
    return None


def _codex_hook_to_flat_hook(
    raw_hook: dict[str, object],
    *,
    hook_point: HookPoint,
    matcher: object,
    event_name: str,
    group_index: int,
    hook_index: int,
) -> dict[str, object]:
    timeout = raw_hook.get("timeout")
    if timeout is None:
        timeout = raw_hook.get("timeoutSec")
    hook_id = raw_hook.get("id")
    if not isinstance(hook_id, str) or not hook_id.strip():
        hook_id = f"{event_name}-{group_index}-{hook_index}"
    return {
        "id": hook_id,
        "hook_point": hook_point.value,
        "command": raw_hook.get("command"),
        "enabled": raw_hook.get("enabled", True),
        "timeout_seconds": timeout,
        "matcher": matcher,
        "working_directory": raw_hook.get("working_directory", "workspace"),
        "env_policy": raw_hook.get("env_policy", "minimal"),
    }


def _parse_hook(
    *,
    scope: HookConfigScope,
    path: Path,
    index: int,
    raw_hook: object,
    shell_path: str | None,
    shell_resolver: Callable[[str | None], ShellCommandConfig],
) -> tuple[ConfiguredHookSpec | None, HookConfigIssue | None]:
    if not isinstance(raw_hook, dict):
        return None, HookConfigIssue(scope, path, f"hooks[{index}] must be an object")
    hook_id = _required_string(raw_hook.get("id"))
    if hook_id is None:
        return None, HookConfigIssue(scope, path, f"hooks[{index}].id is required")
    raw_hook_point = _required_string(raw_hook.get("hook_point"))
    if raw_hook_point is None:
        return None, HookConfigIssue(scope, path, f"{hook_id}.hook_point is required")
    try:
        hook_point = HookPoint(raw_hook_point)
    except ValueError:
        allowed = ", ".join(item.value for item in HookPoint)
        return None, HookConfigIssue(scope, path, f"{hook_id}.hook_point unsupported: {allowed}")
    try:
        command = _parse_command(
            raw_hook.get("command"),
            shell_path=shell_path,
            shell_resolver=shell_resolver,
        )
    except ShellResolutionError as exc:
        return None, HookConfigIssue(scope, path, f"{hook_id}.command: {exc}")
    if command is None:
        return None, HookConfigIssue(scope, path, f"{hook_id}.command must be a non-empty string list")
    timeout = _parse_timeout(raw_hook.get("timeout_seconds"))
    if timeout is None:
        return None, HookConfigIssue(
            scope,
            path,
            f"{hook_id}.timeout_seconds must be > 0 and <= {MAX_HOOK_TIMEOUT_SECONDS:g}",
        )
    working_directory = _parse_enum(
        raw_hook.get("working_directory"),
        HookWorkingDirectory,
        default=HookWorkingDirectory.WORKSPACE,
    )
    if working_directory is None:
        return None, HookConfigIssue(scope, path, f"{hook_id}.working_directory unsupported")
    env_policy = _parse_enum(
        raw_hook.get("env_policy"),
        HookEnvPolicy,
        default=HookEnvPolicy.MINIMAL,
    )
    if env_policy is None:
        return None, HookConfigIssue(scope, path, f"{hook_id}.env_policy unsupported")
    matcher = _parse_matcher(raw_hook.get("matcher"))
    if matcher is None:
        return None, HookConfigIssue(scope, path, f"{hook_id}.matcher unsupported")
    enabled = raw_hook.get("enabled", True)
    if not isinstance(enabled, bool):
        return None, HookConfigIssue(scope, path, f"{hook_id}.enabled must be boolean")
    return (
        ConfiguredHookSpec(
            hook_id=hook_id,
            hook_point=hook_point,
            command=command,
            enabled=enabled,
            timeout_seconds=timeout,
            working_directory=working_directory,
            env_policy=env_policy,
            matcher=matcher,
            source=scope,
            source_path=path,
        ),
        None,
    )


def _required_string(value: object) -> str | None:
    if isinstance(value, str) and value.strip():
        return value.strip()
    return None


def _parse_command(
    value: object,
    *,
    shell_path: str | None,
    shell_resolver: Callable[[str | None], ShellCommandConfig],
) -> tuple[str, ...] | None:
    if isinstance(value, str) and value.strip():
        shell = shell_resolver(shell_path)
        return (str(shell.executable), *shell.args, value.strip())
    if not isinstance(value, list) or not value:
        return None
    command = tuple(item.strip() for item in value if isinstance(item, str) and item.strip())
    return command if len(command) == len(value) else None


def _parse_timeout(value: object) -> float | None:
    if value is None:
        return DEFAULT_HOOK_TIMEOUT_SECONDS
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    timeout = float(value)
    if timeout <= 0 or timeout > MAX_HOOK_TIMEOUT_SECONDS:
        return None
    return timeout


def _parse_enum[T: StrEnum](value: object, enum_type: type[T], *, default: T) -> T | None:
    if value is None:
        return default
    if not isinstance(value, str):
        return None
    try:
        return enum_type(value)
    except ValueError:
        return None


def _parse_matcher(value: object) -> HookMatcher | None:
    if value is None:
        return HookMatcher()
    if isinstance(value, str):
        pattern = value.strip()
        if not pattern or pattern == "*":
            return HookMatcher()
        try:
            re.compile(pattern)
        except re.error:
            return None
        return HookMatcher(pattern=pattern)
    if not isinstance(value, dict):
        return None
    tool_name = value.get("tool_name")
    if tool_name is None:
        return HookMatcher()
    if isinstance(tool_name, str) and tool_name.strip():
        return HookMatcher(tool_name=tool_name.strip())
    return None


def _pattern_matches(pattern: str, target: str | None) -> bool:
    if target is None:
        return False
    try:
        return re.search(pattern, target) is not None
    except re.error:
        return False
