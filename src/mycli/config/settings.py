from __future__ import annotations

import tomllib
from pathlib import Path
from typing import Mapping

from mycli.domain.providers import ProviderId, parse_protocol, parse_provider
from mycli.domain.runtime import (
    AgentConfig,
    ProviderCachePolicyCapability,
    ReasoningEffort,
    ViewMode,
)
from mycli.infrastructure.providers import (
    infer_provider_from_base_url,
    profile_for_provider,
    validate_provider_protocol,
)

_SUPPORTED_REASONING_EFFORTS: tuple[str, ...] = tuple(item.value for item in ReasoningEffort)


def _read_toml(path: Path) -> dict[str, object]:
    if not path.exists():
        return {}
    with path.open("rb") as handle:
        return tomllib.load(handle)


def _validate_reasoning_effort(reasoning_effort: str) -> ReasoningEffort:
    if reasoning_effort in _SUPPORTED_REASONING_EFFORTS:
        return ReasoningEffort(reasoning_effort)
    allowed = ", ".join(_SUPPORTED_REASONING_EFFORTS)
    raise ValueError(
        f"Unsupported reasoning effort '{reasoning_effort}'. Supported values: {allowed}."
    )


def _parse_optional_bool(value: object) -> bool | None:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {"true", "1", "yes", "on"}:
            return True
        if normalized in {"false", "0", "no", "off"}:
            return False
    return None


def _config_value(
    *,
    env: Mapping[str, str],
    project_config: Mapping[str, object],
    user_config: Mapping[str, object],
    env_key: str,
    config_key: str,
) -> object | None:
    if env_key in env:
        return env[env_key]
    if config_key in project_config:
        return project_config[config_key]
    return user_config.get(config_key)


def _provider_cache_policy_override(
    *,
    provider: ProviderId,
    env: Mapping[str, str],
    project_config: Mapping[str, object],
    user_config: Mapping[str, object],
) -> ProviderCachePolicyCapability | None:
    prompt_cache_key_enabled = _parse_optional_bool(
        _config_value(
            env=env,
            project_config=project_config,
            user_config=user_config,
            env_key="MYCLI_PROMPT_CACHE_KEY_ENABLED",
            config_key="prompt_cache_key_enabled",
        )
    )
    cache_control_enabled = _parse_optional_bool(
        _config_value(
            env=env,
            project_config=project_config,
            user_config=user_config,
            env_key="MYCLI_CACHE_CONTROL_ENABLED",
            config_key="cache_control_enabled",
        )
    )
    if prompt_cache_key_enabled is None and cache_control_enabled is None:
        return None
    profile_default = profile_for_provider(provider).cache_policy_capability
    default_capability = (
        profile_default
        if isinstance(profile_default, ProviderCachePolicyCapability)
        else ProviderCachePolicyCapability(
            prompt_cache_key_enabled=False,
            cache_control_enabled=False,
        )
    )
    return ProviderCachePolicyCapability(
        prompt_cache_key_enabled=(
            default_capability.prompt_cache_key_enabled
            if prompt_cache_key_enabled is None
            else prompt_cache_key_enabled
        ),
        cache_control_enabled=(
            default_capability.cache_control_enabled
            if cache_control_enabled is None
            else cache_control_enabled
        ),
    )


def _parse_view_mode(value: object) -> ViewMode:
    raw = str(value or ViewMode.DEFAULT.value).strip().lower()
    try:
        return ViewMode(raw)
    except ValueError as exc:
        allowed = ", ".join(item.value for item in ViewMode)
        raise ValueError(
            f"Unsupported view_mode '{raw}'. Supported values: {allowed}."
        ) from exc


def _parse_optional_float(value: object) -> float | None:
    if value is None:
        return None
    if isinstance(value, bool):
        return None
    if isinstance(value, (float, int)):
        return float(value)
    if isinstance(value, str) and value.strip():
        return float(value)
    return None


def _parse_float_setting(value: object, *, default: float) -> float:
    parsed = _parse_optional_float(value)
    return default if parsed is None else parsed


def _parse_float_map(value: object) -> dict[str, float]:
    if not isinstance(value, dict):
        return {}
    parsed: dict[str, float] = {}
    for key, item in value.items():
        if not isinstance(key, str):
            continue
        numeric = _parse_optional_float(item)
        if numeric is None:
            continue
        parsed[key] = numeric
    return parsed


def resolve_config(
    cli_args: Mapping[str, object],
    env: Mapping[str, str],
    cwd: Path,
    home: Path,
) -> AgentConfig:
    user_config = _read_toml(home / ".config" / "mycli" / "config.toml")
    project_config = _read_toml(cwd / ".mycli" / "config.toml")

    configured_api_base_url = (
        env.get("MYCLI_BASE_URL")
        or project_config.get("api_base_url")
        or user_config.get("api_base_url")
    )
    api_base_url_for_inference = (
        str(configured_api_base_url).rstrip("/")
        if configured_api_base_url is not None
        else "https://api.openai.com/v1"
    )
    raw_provider = (
        env.get("MYCLI_PROVIDER")
        or project_config.get("provider")
        or user_config.get("provider")
    )
    provider = (
        parse_provider(raw_provider)
        if raw_provider is not None
        else infer_provider_from_base_url(api_base_url_for_inference)
    )
    profile = profile_for_provider(provider)
    api_base_url = (
        str(configured_api_base_url).rstrip("/")
        if configured_api_base_url is not None
        else profile.default_base_url
    )
    protocol = parse_protocol(
        env.get("MYCLI_PROTOCOL")
        or project_config.get("protocol")
        or user_config.get("protocol")
        or profile.default_protocol.value
    )
    validate_provider_protocol(provider=provider, protocol=protocol)
    model = str(
        cli_args.get("model")
        or env.get("MYCLI_MODEL")
        or project_config.get("model")
        or user_config.get("model")
        or profile.default_model
        or "gpt-5"
    )
    api_key_value = (
        env.get("MYCLI_API_KEY")
        or project_config.get("api_key")
        or user_config.get("api_key")
    )
    api_key = str(api_key_value) if api_key_value else None
    session_id = str(cli_args.get("session") or "default")
    max_prompt_tokens_value = (
        env.get("MYCLI_MAX_PROMPT_TOKENS")
        or project_config.get("max_prompt_tokens")
        or user_config.get("max_prompt_tokens")
        or 12000
    )
    max_output_tokens_value = (
        env.get("MYCLI_MAX_OUTPUT_TOKENS")
        or project_config.get("max_output_tokens")
        or user_config.get("max_output_tokens")
        or 2048
    )
    fallback_model_value = (
        env.get("MYCLI_FALLBACK_MODEL")
        or project_config.get("fallback_model")
        or user_config.get("fallback_model")
    )
    transport_retry_limit_value = (
        env.get("MYCLI_TRANSPORT_RETRY_LIMIT")
        or project_config.get("transport_retry_limit")
        or user_config.get("transport_retry_limit")
        or 2
    )
    output_limit_escalation_max_tokens_value = (
        env.get("MYCLI_OUTPUT_LIMIT_ESCALATION_MAX_TOKENS")
        or project_config.get("output_limit_escalation_max_tokens")
        or user_config.get("output_limit_escalation_max_tokens")
        or 65_536
    )
    output_recovery_retry_limit_value = (
        env.get("MYCLI_OUTPUT_RECOVERY_RETRY_LIMIT")
        or project_config.get("output_recovery_retry_limit")
        or user_config.get("output_recovery_retry_limit")
        or 3
    )
    heartbeat_enabled_raw: object | None = env.get("MYCLI_HEARTBEAT_ENABLED")
    if heartbeat_enabled_raw is None:
        heartbeat_enabled_raw = (
            project_config["heartbeat_enabled"]
            if "heartbeat_enabled" in project_config
            else user_config.get("heartbeat_enabled")
        )
    heartbeat_enabled_value = _parse_optional_bool(heartbeat_enabled_raw)
    heartbeat_interval_seconds_value = (
        env.get("MYCLI_HEARTBEAT_INTERVAL_SECONDS")
        or project_config.get("heartbeat_interval_seconds")
        or user_config.get("heartbeat_interval_seconds")
        or 30.0
    )
    view_mode_value = (
        env.get("MYCLI_VIEW_MODE")
        or project_config.get("view_mode")
        or user_config.get("view_mode")
        or ViewMode.DEFAULT.value
    )
    statusline_enabled_raw: object | None = env.get("MYCLI_STATUSLINE_ENABLED")
    if statusline_enabled_raw is None:
        statusline_enabled_raw = (
            project_config["statusline_enabled"]
            if "statusline_enabled" in project_config
            else user_config.get("statusline_enabled")
        )
    statusline_enabled_value = _parse_optional_bool(statusline_enabled_raw)
    tui_startup_mark_value = (
        env.get("MYCLI_TUI_STARTUP_MARK")
        or project_config.get("tui_startup_mark")
        or user_config.get("tui_startup_mark")
        or "default"
    )
    legacy_reasoning_effort = (
        env.get("MYCLI_REASONING_EFFORT")
        or project_config.get("reasoning_effort")
        or user_config.get("reasoning_effort")
    )
    thinking_enabled_value = _parse_optional_bool(
        env.get("MYCLI_THINKING_ENABLED")
        or project_config.get("thinking_enabled")
        or user_config.get("thinking_enabled")
    )
    thinking_effort_value = (
        env.get("MYCLI_THINKING_EFFORT")
        or project_config.get("thinking_effort")
        or user_config.get("thinking_effort")
    )
    reasoning_effort = _validate_reasoning_effort(
        str(thinking_effort_value or legacy_reasoning_effort or ReasoningEffort.MEDIUM.value)
    )
    thinking_enabled = True if thinking_enabled_value is None else thinking_enabled_value
    if thinking_enabled is False and thinking_effort_value is not None:
        raise ValueError("thinking_effort requires thinking_enabled=true")
    thinking_effort = reasoning_effort if thinking_enabled else None
    compression_threshold_tokens_value = (
        env.get("MYCLI_COMPRESSION_THRESHOLD_TOKENS")
        or project_config.get("compression_threshold_tokens")
        or user_config.get("compression_threshold_tokens")
        or 8000
    )
    compaction_l4_trigger_ratio_value = (
        env.get("MYCLI_COMPACTION_L4_TRIGGER_RATIO")
        or project_config.get("compaction_l4_trigger_ratio")
        or user_config.get("compaction_l4_trigger_ratio")
        or 0.9
    )
    compaction_l4_buffer_tokens_value = (
        env.get("MYCLI_COMPACTION_L4_BUFFER_TOKENS")
        or project_config.get("compaction_l4_buffer_tokens")
        or user_config.get("compaction_l4_buffer_tokens")
        or 13_000
    )
    compaction_l4_min_savings_ratio = _parse_optional_float(
        env.get("MYCLI_COMPACTION_L4_MIN_SAVINGS_RATIO")
        or project_config.get("compaction_l4_min_savings_ratio")
        or user_config.get("compaction_l4_min_savings_ratio")
    )
    compaction_l4_input_cost_per_1k = _parse_float_setting(
        env.get("MYCLI_COMPACTION_L4_INPUT_COST_PER_1K")
        or project_config.get("compaction_l4_input_cost_per_1k")
        or user_config.get("compaction_l4_input_cost_per_1k"),
        default=0.0,
    )
    compaction_l4_output_cost_per_1k = _parse_float_setting(
        env.get("MYCLI_COMPACTION_L4_OUTPUT_COST_PER_1K")
        or project_config.get("compaction_l4_output_cost_per_1k")
        or user_config.get("compaction_l4_output_cost_per_1k"),
        default=0.0,
    )
    compaction_l4_carry_cost_per_1k = _parse_float_setting(
        env.get("MYCLI_COMPACTION_L4_CARRY_COST_PER_1K")
        or project_config.get("compaction_l4_carry_cost_per_1k")
        or user_config.get("compaction_l4_carry_cost_per_1k"),
        default=0.0,
    )
    compaction_l4_expected_summary_tokens_value = (
        env.get("MYCLI_COMPACTION_L4_EXPECTED_SUMMARY_TOKENS")
        or project_config.get("compaction_l4_expected_summary_tokens")
        or user_config.get("compaction_l4_expected_summary_tokens")
        or 500
    )
    compaction_l4_carry_turns_value = (
        env.get("MYCLI_COMPACTION_L4_CARRY_TURNS")
        or project_config.get("compaction_l4_carry_turns")
        or user_config.get("compaction_l4_carry_turns")
        or 1
    )
    compaction_l4_summarizer_model_value = (
        env.get("MYCLI_COMPACTION_L4_SUMMARIZER_MODEL")
        or project_config.get("compaction_l4_summarizer_model")
        or user_config.get("compaction_l4_summarizer_model")
    )
    compaction_trigger_ratios_by_model = _parse_float_map(
        project_config.get("compaction_l4_trigger_ratios_by_model")
        or user_config.get("compaction_l4_trigger_ratios_by_model")
    )
    usage_input_cost_per_1k = _parse_float_setting(
        env.get("MYCLI_USAGE_INPUT_COST_PER_1K")
        or project_config.get("usage_input_cost_per_1k")
        or user_config.get("usage_input_cost_per_1k"),
        default=0.0,
    )
    usage_output_cost_per_1k = _parse_float_setting(
        env.get("MYCLI_USAGE_OUTPUT_COST_PER_1K")
        or project_config.get("usage_output_cost_per_1k")
        or user_config.get("usage_output_cost_per_1k"),
        default=0.0,
    )
    usage_cache_read_cost_per_1k = _parse_float_setting(
        env.get("MYCLI_USAGE_CACHE_READ_COST_PER_1K")
        or project_config.get("usage_cache_read_cost_per_1k")
        or user_config.get("usage_cache_read_cost_per_1k"),
        default=0.0,
    )
    usage_cache_write_cost_per_1k = _parse_float_setting(
        env.get("MYCLI_USAGE_CACHE_WRITE_COST_PER_1K")
        or project_config.get("usage_cache_write_cost_per_1k")
        or user_config.get("usage_cache_write_cost_per_1k"),
        default=0.0,
    )
    recent_message_count_value = (
        env.get("MYCLI_RECENT_MESSAGE_COUNT")
        or project_config.get("recent_message_count")
        or user_config.get("recent_message_count")
        or 6
    )
    cache_policy_capability = _provider_cache_policy_override(
        provider=provider,
        env=env,
        project_config=project_config,
        user_config=user_config,
    )

    return AgentConfig(
        workspace_root=cwd,
        provider=provider,
        model=model,
        protocol=protocol,
        api_base_url=api_base_url,
        api_key=api_key,
        session_id=session_id,
        cache_policy_capability=cache_policy_capability,
        max_prompt_tokens=int(str(max_prompt_tokens_value)),
        max_output_tokens=int(str(max_output_tokens_value)),
        fallback_model=str(fallback_model_value) if fallback_model_value else None,
        transport_retry_limit=int(str(transport_retry_limit_value)),
        output_limit_escalation_max_tokens=int(
            str(output_limit_escalation_max_tokens_value)
        ),
        output_recovery_retry_limit=int(str(output_recovery_retry_limit_value)),
        heartbeat_enabled=True if heartbeat_enabled_value is None else heartbeat_enabled_value,
        heartbeat_interval_seconds=float(str(heartbeat_interval_seconds_value)),
        view_mode=_parse_view_mode(view_mode_value),
        statusline_enabled=True
        if statusline_enabled_value is None
        else statusline_enabled_value,
        tui_startup_mark=str(tui_startup_mark_value).strip().lower() or "default",
        reasoning_effort=reasoning_effort,
        thinking_enabled=thinking_enabled,
        thinking_effort=thinking_effort,
        compression_threshold_tokens=int(str(compression_threshold_tokens_value)),
        compaction_l4_trigger_ratio=float(str(compaction_l4_trigger_ratio_value)),
        compaction_l4_buffer_tokens=int(str(compaction_l4_buffer_tokens_value)),
        compaction_l4_min_savings_ratio=compaction_l4_min_savings_ratio,
        compaction_l4_input_cost_per_1k=compaction_l4_input_cost_per_1k,
        compaction_l4_output_cost_per_1k=compaction_l4_output_cost_per_1k,
        compaction_l4_carry_cost_per_1k=compaction_l4_carry_cost_per_1k,
        compaction_l4_expected_summary_tokens=int(
            str(compaction_l4_expected_summary_tokens_value)
        ),
        compaction_l4_carry_turns=int(str(compaction_l4_carry_turns_value)),
        compaction_l4_summarizer_model=(
            str(compaction_l4_summarizer_model_value)
            if compaction_l4_summarizer_model_value
            else None
        ),
        compaction_l4_trigger_ratios_by_model=compaction_trigger_ratios_by_model,
        usage_input_cost_per_1k=usage_input_cost_per_1k,
        usage_output_cost_per_1k=usage_output_cost_per_1k,
        usage_cache_read_cost_per_1k=usage_cache_read_cost_per_1k,
        usage_cache_write_cost_per_1k=usage_cache_write_cost_per_1k,
        recent_message_count=int(str(recent_message_count_value)),
        auto_approve_medium=True,
    )
