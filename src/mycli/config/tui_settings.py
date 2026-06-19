from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Mapping
import tomllib

from mycli.config.settings import default_user_config_path
from mycli.domain.runtime import ViewMode

STATUSBAR_MODES = ("off", "compact", "full")
THEMES = ("dark", "light")
TOOL_DETAILS_DEFAULTS = ("collapsed", "expanded")
SUBAGENT_DENSITIES = ("compact", "normal", "detailed")


@dataclass(frozen=True, slots=True)
class TuiSettings:
    statusbar_mode: str = "full"
    view_mode: str = ViewMode.DEFAULT.value
    theme: str = "dark"
    hide_thinking: bool = True
    tool_details_default: str = "collapsed"
    hardware_cursor: bool = False
    clear_on_shrink: bool = True
    terminal_progress: bool = True
    subagent_density: str = "normal"

    def to_payload(self) -> dict[str, object]:
        return {
            "statusbar_mode": self.statusbar_mode,
            "view_mode": self.view_mode,
            "theme": self.theme,
            "hide_thinking": self.hide_thinking,
            "tool_details_default": self.tool_details_default,
            "hardware_cursor": self.hardware_cursor,
            "clear_on_shrink": self.clear_on_shrink,
            "terminal_progress": self.terminal_progress,
            "subagent_density": self.subagent_density,
        }


def load_tui_settings(home_dir: Path, *, runtime_config: object | None = None) -> TuiSettings:
    payload = _read_toml(default_user_config_path(home_dir))
    return _settings_from_payload(payload, runtime_config=runtime_config)


def save_tui_settings(
    home_dir: Path,
    raw_settings: Mapping[str, object],
    *,
    runtime_config: object | None = None,
) -> TuiSettings:
    path = default_user_config_path(home_dir)
    payload = _read_toml(path)
    current = _settings_from_payload(payload, runtime_config=runtime_config)
    settings = _settings_from_payload({**current.to_payload(), **dict(raw_settings)})
    payload.update(
        {
            "view_mode": settings.view_mode,
            "statusline_enabled": settings.statusbar_mode != "off",
            "tui_statusbar_mode": settings.statusbar_mode,
            "tui_theme": settings.theme,
            "tui_hide_thinking": settings.hide_thinking,
            "tui_tool_details_default": settings.tool_details_default,
            "tui_hardware_cursor": settings.hardware_cursor,
            "tui_clear_on_shrink": settings.clear_on_shrink,
            "tui_terminal_progress": settings.terminal_progress,
            "tui_subagent_density": settings.subagent_density,
        }
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(_format_toml(payload), encoding="utf-8")
    path.chmod(0o600)
    return settings


def _settings_from_payload(
    payload: Mapping[str, object],
    *,
    runtime_config: object | None = None,
) -> TuiSettings:
    runtime_view_mode = getattr(runtime_config, "view_mode", None)
    runtime_statusline_enabled = getattr(runtime_config, "statusline_enabled", None)
    view_mode_value = payload.get("viewMode", payload.get("view_mode"))
    if view_mode_value is None and runtime_view_mode is not None:
        view_mode_value = getattr(runtime_view_mode, "value", runtime_view_mode)
    statusbar_mode = payload.get(
        "statusbarMode",
        payload.get("statusbar_mode", payload.get("tui_statusbar_mode")),
    )
    if statusbar_mode is None:
        statusline_enabled = payload.get("statusline_enabled")
        if statusline_enabled is None and isinstance(runtime_statusline_enabled, bool):
            statusline_enabled = runtime_statusline_enabled
        statusbar_mode = "full" if statusline_enabled is not False else "off"
    return TuiSettings(
        statusbar_mode=_enum_value("statusbar_mode", statusbar_mode, STATUSBAR_MODES),
        view_mode=_view_mode_value(view_mode_value),
        theme=_enum_value("theme", payload.get("theme", payload.get("tui_theme", "dark")), THEMES),
        hide_thinking=_bool_value(
            "hide_thinking",
            payload.get("hideThinking", payload.get("hide_thinking", payload.get("tui_hide_thinking", True))),
        ),
        tool_details_default=_enum_value(
            "tool_details_default",
            payload.get(
                "toolDetailsDefault",
                payload.get("tool_details_default", payload.get("tui_tool_details_default", "collapsed")),
            ),
            TOOL_DETAILS_DEFAULTS,
        ),
        hardware_cursor=_bool_value(
            "hardware_cursor",
            payload.get("hardwareCursor", payload.get("hardware_cursor", payload.get("tui_hardware_cursor", False))),
        ),
        clear_on_shrink=_bool_value(
            "clear_on_shrink",
            payload.get("clearOnShrink", payload.get("clear_on_shrink", payload.get("tui_clear_on_shrink", True))),
        ),
        terminal_progress=_bool_value(
            "terminal_progress",
            payload.get("terminalProgress", payload.get("terminal_progress", payload.get("tui_terminal_progress", True))),
        ),
        subagent_density=_enum_value(
            "subagent_density",
            payload.get("subagentDensity", payload.get("subagent_density", payload.get("tui_subagent_density", "normal"))),
            SUBAGENT_DENSITIES,
        ),
    )


def _view_mode_value(value: object) -> str:
    raw = str(value or ViewMode.DEFAULT.value).strip().lower()
    try:
        return ViewMode(raw).value
    except ValueError as exc:
        allowed = ", ".join(item.value for item in ViewMode)
        raise ValueError(f"Unsupported view_mode '{raw}'. Supported values: {allowed}.") from exc


def _enum_value(name: str, value: object, allowed_values: tuple[str, ...]) -> str:
    raw = str(value or "").strip().lower()
    if raw in allowed_values:
        return raw
    allowed = ", ".join(allowed_values)
    raise ValueError(f"Unsupported {name} '{raw}'. Supported values: {allowed}.")


def _bool_value(name: str, value: object) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {"true", "1", "yes", "on"}:
            return True
        if normalized in {"false", "0", "no", "off"}:
            return False
    raise ValueError(f"{name} must be a boolean.")


def _read_toml(path: Path) -> dict[str, object]:
    if not path.exists():
        return {}
    with path.open("rb") as handle:
        return tomllib.load(handle)


def _format_toml(payload: Mapping[str, object]) -> str:
    preferred_order = (
        "provider",
        "protocol",
        "model",
        "api_base_url",
        "view_mode",
        "statusline_enabled",
        "tui_statusbar_mode",
        "tui_theme",
        "tui_hide_thinking",
    )
    lines: list[str] = []
    emitted: set[str] = set()
    for key in preferred_order:
        if key in payload and not isinstance(payload[key], dict):
            lines.append(_format_toml_item(key, payload[key]))
            emitted.add(key)
    for key in sorted(payload):
        if key in emitted:
            continue
        value = payload[key]
        if not isinstance(value, dict):
            lines.append(_format_toml_item(key, value))
            emitted.add(key)
    for key in sorted(payload):
        if key in emitted:
            continue
        value = payload[key]
        if isinstance(value, dict):
            lines.extend(_format_toml_table((key,), value))
    return "\n".join(lines) + "\n"


def _format_toml_item(key: str, value: object) -> str:
    return f"{key} = {_format_toml_value(value)}"


def _format_toml_value(value: object) -> str:
    if isinstance(value, bool):
        return str(value).lower()
    if isinstance(value, int | float):
        return str(value)
    if isinstance(value, list):
        return "[" + ", ".join(_format_toml_value(item) for item in value) + "]"
    return f'"{_escape_toml_string(str(value))}"'


def _format_toml_table(path: tuple[str, ...], payload: Mapping[str, object]) -> list[str]:
    scalar_lines: list[str] = []
    nested_tables: list[tuple[str, Mapping[str, object]]] = []
    for key in sorted(payload):
        value = payload[key]
        if isinstance(value, dict):
            nested_tables.append((key, value))
        else:
            scalar_lines.append(_format_toml_item(key, value))

    lines: list[str] = []
    if scalar_lines:
        lines.append("")
        lines.append(f"[{'.'.join(path)}]")
        lines.extend(scalar_lines)
    for key, value in nested_tables:
        lines.extend(_format_toml_table((*path, key), value))
    return lines


def _escape_toml_string(value: str) -> str:
    return value.replace("\\", "\\\\").replace('"', '\\"')
