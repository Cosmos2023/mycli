from __future__ import annotations

from typing import Mapping

ConfigSection = tuple[str, tuple[tuple[str, str], ...]]

CONFIG_SECTIONS: tuple[ConfigSection, ...] = (
    (
        "model",
        (
            ("provider", "provider"),
            ("protocol", "protocol"),
            ("name", "model"),
            ("api_base_url", "api_base_url"),
            ("supports_images", "supports_images"),
        ),
    ),
    (
        "request",
        (
            ("max_prompt_tokens", "max_prompt_tokens"),
            ("fallback_model", "fallback_model"),
            ("transport_retry_limit", "transport_retry_limit"),
            ("cache_control_enabled", "cache_control_enabled"),
            ("prompt_cache_key_enabled", "prompt_cache_key_enabled"),
        ),
    ),
    (
        "reasoning",
        (
            ("enabled", "thinking_enabled"),
            ("effort", "thinking_effort"),
            ("reasoning_effort", "reasoning_effort"),
        ),
    ),
    (
        "runtime",
        (
            ("collaboration_mode", "collaboration_mode"),
            ("sandbox_mode", "sandbox_mode"),
            ("heartbeat_enabled", "heartbeat_enabled"),
            ("heartbeat_interval_seconds", "heartbeat_interval_seconds"),
            ("shell_environment_policy", "shell_environment_policy"),
            ("sandbox_writable_roots", "sandbox_writable_roots"),
            ("sandbox_denied_read_roots", "sandbox_denied_read_roots"),
            ("sandbox_denied_read_globs", "sandbox_denied_read_globs"),
        ),
    ),
    (
        "memory",
        (
            ("enabled", "memory_enabled"),
            ("extraction_enabled", "memory_extraction_enabled"),
            ("extraction_interval_turns", "memory_extraction_interval_turns"),
            ("dream_enabled", "memory_dream_enabled"),
            ("dream_min_hours", "memory_dream_min_hours"),
            ("dream_min_sessions", "memory_dream_min_sessions"),
        ),
    ),
    (
        "context",
        (
            ("recent_message_count", "recent_message_count"),
            ("compression_threshold_tokens", "compression_threshold_tokens"),
            ("compaction_token_limit", "compaction_token_limit"),
            (
                "compaction_reserved_output_tokens",
                "compaction_reserved_output_tokens",
            ),
            ("compaction_tail_turns", "compaction_tail_turns"),
            ("compaction_tail_max_tokens", "compaction_tail_max_tokens"),
            ("compaction_l4_trigger_ratio", "compaction_l4_trigger_ratio"),
            ("compaction_l4_buffer_tokens", "compaction_l4_buffer_tokens"),
            ("compaction_l4_min_savings_ratio", "compaction_l4_min_savings_ratio"),
            ("compaction_l4_carry_turns", "compaction_l4_carry_turns"),
            (
                "compaction_l4_expected_summary_tokens",
                "compaction_l4_expected_summary_tokens",
            ),
            ("compaction_l4_summarizer_model", "compaction_l4_summarizer_model"),
            ("compaction_l4_carry_cost_per_1k", "compaction_l4_carry_cost_per_1k"),
            ("compaction_l4_input_cost_per_1k", "compaction_l4_input_cost_per_1k"),
            ("compaction_l4_output_cost_per_1k", "compaction_l4_output_cost_per_1k"),
        ),
    ),
    (
        "usage",
        (
            ("input_cost_per_1k", "usage_input_cost_per_1k"),
            ("output_cost_per_1k", "usage_output_cost_per_1k"),
            ("cache_read_cost_per_1k", "usage_cache_read_cost_per_1k"),
            ("cache_write_cost_per_1k", "usage_cache_write_cost_per_1k"),
        ),
    ),
    (
        "tui",
        (
            ("view_mode", "view_mode"),
            ("statusline_enabled", "statusline_enabled"),
            ("statusbar_mode", "tui_statusbar_mode"),
            ("theme", "tui_theme"),
            ("hide_thinking", "tui_hide_thinking"),
            ("clear_on_shrink", "tui_clear_on_shrink"),
            ("hardware_cursor", "tui_hardware_cursor"),
            ("startup_mark", "tui_startup_mark"),
            ("subagent_density", "tui_subagent_density"),
            ("terminal_progress", "tui_terminal_progress"),
            ("tool_details_default", "tui_tool_details_default"),
        ),
    ),
)

_SECTION_NAMES = frozenset(section for section, _keys in CONFIG_SECTIONS)


def format_user_config_toml(payload: Mapping[str, object]) -> str:
    payload = flatten_user_config_payload(payload)
    lines: list[str] = []
    emitted: set[str] = set()

    extra_lines: list[str] = []
    for key in sorted(payload):
        value = payload[key]
        if not isinstance(value, dict) and not _is_sectioned_key(key):
            extra_lines.append(_format_toml_item(key, value))
            emitted.add(key)
    if extra_lines:
        lines.extend(extra_lines)

    for section, keys in CONFIG_SECTIONS:
        group_lines: list[str] = []
        for section_key, flat_key in keys:
            if flat_key in payload and not isinstance(payload[flat_key], dict):
                group_lines.append(_format_toml_item(section_key, payload[flat_key]))
                emitted.add(flat_key)
        if group_lines:
            if lines:
                lines.append("")
            lines.append(f"[{section}]")
            lines.extend(group_lines)

    for key in sorted(payload):
        if key in emitted:
            continue
        value = payload[key]
        if isinstance(value, dict) and key not in _SECTION_NAMES:
            lines.extend(_format_toml_table((key,), value))
    return "\n".join(lines) + "\n"


def flatten_user_config_payload(payload: Mapping[str, object]) -> dict[str, object]:
    flat: dict[str, object] = {}
    for section, keys in CONFIG_SECTIONS:
        table = payload.get(section)
        if not isinstance(table, Mapping):
            continue
        for section_key, flat_key in keys:
            if section_key in table:
                flat[flat_key] = table[section_key]
            elif flat_key in table:
                flat[flat_key] = table[flat_key]

    for key, value in payload.items():
        if isinstance(value, Mapping):
            if key not in _SECTION_NAMES:
                flat[key] = dict(value)
            continue
        flat[key] = value
    return flat


def _is_sectioned_key(key: str) -> bool:
    return any(flat_key == key for _section, keys in CONFIG_SECTIONS for _section_key, flat_key in keys)


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
