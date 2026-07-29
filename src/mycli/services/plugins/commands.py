from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable

PluginCommandHandler = Callable[[dict[str, Any]], "PluginCommandResult | dict[str, Any] | str"]


@dataclass(slots=True, frozen=True)
class PluginCommandResult:
    ok: bool
    summary: str
    content: str = ""
    metadata: dict[str, object] = field(default_factory=dict)
    error: str = ""

    def to_dict(self) -> dict[str, object]:
        return {
            "ok": self.ok,
            "summary": self.summary,
            "content": self.content,
            "metadata": self.metadata,
            "error": self.error,
        }


@dataclass(slots=True, frozen=True)
class PluginCommandSpec:
    plugin_id: str
    name: str
    schema: dict[str, Any]
    handler: PluginCommandHandler
    metadata: dict[str, Any] = field(default_factory=dict)

    @property
    def command_id(self) -> str:
        return f"plugin:{self.plugin_id}:{self.name}"

    def manifest_entry(self) -> dict[str, object]:
        description = self.schema.get("description") or self.metadata.get("description") or ""
        kind = self.schema.get("kind") or self.metadata.get("kind") or "command"
        args_schema = self.schema.get("args_schema") or self.schema.get("input_schema") or self.schema.get("parameters") or {}
        return {
            "id": self.command_id,
            "name": self.name,
            "plugin_id": self.plugin_id,
            "source": "plugin",
            "kind": str(kind),
            "description": str(description) if description else "",
            "args_schema": dict(args_schema) if isinstance(args_schema, dict) else {},
            "metadata": _bounded_mapping(self.metadata),
        }


@dataclass(slots=True)
class PluginCommandRegistry:
    _commands: dict[str, PluginCommandSpec] = field(default_factory=dict)
    _issues: list[str] = field(default_factory=list)

    def register(
        self,
        *,
        plugin_id: str,
        name: str,
        schema: dict[str, Any],
        handler: PluginCommandHandler,
        metadata: dict[str, Any] | None = None,
    ) -> str | None:
        command_name = name.strip()
        if not command_name:
            self._issues.append(f"{plugin_id}: invalid command name")
            return None
        if not isinstance(schema, dict):
            self._issues.append(f"{plugin_id}:{command_name}: invalid command schema")
            return None
        command = PluginCommandSpec(
            plugin_id=plugin_id,
            name=command_name,
            schema=dict(schema),
            handler=handler,
            metadata=dict(metadata or {}),
        )
        if command.command_id in self._commands:
            self._issues.append(f"{command.command_id}: duplicate command id")
            return None
        self._commands[command.command_id] = command
        return command.command_id

    def list_entries(self, *, plugin_id: str | None = None) -> tuple[dict[str, object], ...]:
        entries = [
            spec.manifest_entry()
            for spec in self._commands.values()
            if plugin_id is None or spec.plugin_id == plugin_id
        ]
        return tuple(sorted(entries, key=lambda item: str(item["id"])))

    def issues(self) -> tuple[str, ...]:
        return tuple(self._issues)

    def execute(self, plugin_id: str, name: str, arguments: dict[str, Any]) -> PluginCommandResult:
        command_id = f"plugin:{plugin_id}:{name}"
        command = self._commands.get(command_id)
        if command is None:
            return PluginCommandResult(
                ok=False,
                summary="plugin command not found",
                error="command_not_found",
                metadata={"plugin_id": plugin_id, "command": name},
            )
        try:
            result = command.handler(dict(arguments))
        except Exception as exc:
            return PluginCommandResult(
                ok=False,
                summary="plugin command failed",
                error=exc.__class__.__name__,
                metadata={"plugin_id": plugin_id, "command": name},
            )
        return _coerce_result(result, plugin_id=plugin_id, command=name)


def _coerce_result(result: PluginCommandResult | dict[str, Any] | str, *, plugin_id: str, command: str) -> PluginCommandResult:
    if isinstance(result, PluginCommandResult):
        return result
    if isinstance(result, dict):
        ok = result.get("ok")
        summary = result.get("summary") or result.get("content") or result.get("message") or "plugin command completed"
        content = result.get("content") or result.get("message") or ""
        metadata = result.get("metadata")
        error = result.get("error") or ""
        return PluginCommandResult(
            ok=bool(ok) if isinstance(ok, bool) else not bool(error),
            summary=str(summary),
            content=str(content) if content else "",
            metadata=dict(metadata) if isinstance(metadata, dict) else {"plugin_id": plugin_id, "command": command},
            error=str(error) if error else "",
        )
    return PluginCommandResult(
        ok=True,
        summary=str(result),
        content=str(result),
        metadata={"plugin_id": plugin_id, "command": command},
    )


def _bounded_mapping(value: dict[str, Any]) -> dict[str, object]:
    bounded: dict[str, object] = {}
    for key, item in value.items():
        if not isinstance(key, str):
            continue
        if isinstance(item, str):
            bounded[key] = item[:180]
        elif isinstance(item, (int, float, bool)) or item is None:
            bounded[key] = item
    return bounded
