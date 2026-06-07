from __future__ import annotations

from dataclasses import dataclass

from mycli.domain.providers import ProtocolId, ProviderId
from mycli.infrastructure.providers import resolve_provider_quirk_profile


@dataclass(frozen=True, slots=True)
class ProviderQuirkMatrixCase:
    case_id: str
    provider: ProviderId
    protocol: ProtocolId
    base_url: str | None


DEFAULT_PROVIDER_QUIRK_MATRIX_CASES: tuple[ProviderQuirkMatrixCase, ...] = (
    ProviderQuirkMatrixCase(
        case_id="openai_responses",
        provider=ProviderId.OPENAI,
        protocol=ProtocolId.RESPONSES,
        base_url="https://api.openai.com/v1",
    ),
    ProviderQuirkMatrixCase(
        case_id="compatible_chat",
        provider=ProviderId.COMPATIBLE,
        protocol=ProtocolId.CHAT_COMPLETIONS,
        base_url="https://example.invalid/v1",
    ),
    ProviderQuirkMatrixCase(
        case_id="anthropic_messages",
        provider=ProviderId.ANTHROPIC,
        protocol=ProtocolId.ANTHROPIC_MESSAGES,
        base_url="https://api.anthropic.com",
    ),
    ProviderQuirkMatrixCase(
        case_id="deepseek_chat",
        provider=ProviderId.DEEPSEEK,
        protocol=ProtocolId.CHAT_COMPLETIONS,
        base_url="https://api.deepseek.com",
    ),
    ProviderQuirkMatrixCase(
        case_id="deepseek_anthropic_style",
        provider=ProviderId.ANTHROPIC,
        protocol=ProtocolId.ANTHROPIC_MESSAGES,
        base_url="https://api.deepseek.com/anthropic",
    ),
)


def provider_quirk_matrix_rows(
    cases: tuple[ProviderQuirkMatrixCase, ...] = DEFAULT_PROVIDER_QUIRK_MATRIX_CASES,
) -> tuple[dict[str, object], ...]:
    rows: list[dict[str, object]] = []
    for case in cases:
        profile = resolve_provider_quirk_profile(
            provider=case.provider,
            protocol=case.protocol,
            base_url=case.base_url,
        )
        payload = profile.to_diagnostic_payload()
        rows.append(
            {
                "case_id": case.case_id,
                "configured_provider": case.provider.value,
                "configured_protocol": case.protocol.value,
                "provider_family": payload["provider_family"],
                "protocol": payload["protocol"],
                "cache_strategy": payload["cache_strategy"],
                "prompt_cache_key_supported": payload["prompt_cache_key_supported"],
                "cache_control_supported": payload["cache_control_supported"],
                "automatic_prefix_cache": payload["automatic_prefix_cache"],
                "wire_hints_supported": payload["wire_hints_supported"],
                "usage_cached_token_shape": payload["usage_cached_token_shape"],
                "streaming_event_shape": payload["streaming_event_shape"],
                "reasoning_content_replay": payload["reasoning_content_replay"],
            }
        )
    return tuple(rows)


__all__ = [
    "DEFAULT_PROVIDER_QUIRK_MATRIX_CASES",
    "ProviderQuirkMatrixCase",
    "provider_quirk_matrix_rows",
]
