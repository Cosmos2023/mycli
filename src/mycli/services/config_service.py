from __future__ import annotations

import tomllib
from pathlib import Path
from typing import Mapping

from mycli.domain.providers import parse_protocol, parse_provider
from mycli.domain.runtime import AgentConfig, ReasoningEffort
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
    max_steps_value = project_config.get("max_steps") or user_config.get("max_steps") or 4
    max_steps = int(str(max_steps_value))
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
    recent_message_count_value = (
        env.get("MYCLI_RECENT_MESSAGE_COUNT")
        or project_config.get("recent_message_count")
        or user_config.get("recent_message_count")
        or 6
    )

    return AgentConfig(
        workspace_root=cwd,
        provider=provider,
        model=model,
        protocol=protocol,
        api_base_url=api_base_url,
        api_key=api_key,
        session_id=session_id,
        max_steps=max_steps,
        max_prompt_tokens=int(str(max_prompt_tokens_value)),
        max_output_tokens=int(str(max_output_tokens_value)),
        reasoning_effort=reasoning_effort,
        thinking_enabled=thinking_enabled,
        thinking_effort=thinking_effort,
        compression_threshold_tokens=int(str(compression_threshold_tokens_value)),
        recent_message_count=int(str(recent_message_count_value)),
        auto_approve_medium=True,
    )
