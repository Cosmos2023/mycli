# P21 Research: Provider Quirk Registry

## Current state

- Provider profiles already carry cache policy capability for OpenAI, Anthropic, DeepSeek, compatible, and Qwen.
- `resolve_provider_cache_policy_capability(...)` infers DeepSeek when Anthropic protocol is pointed at `api.deepseek.com/anthropic`, disabling Anthropic cache_control hints.
- DeepSeek adapter handles reasoning_content replay quirks.
- Cache usage normalization and provider request dry-run already exist.
- Quirks are spread across provider profiles, registry inference, adapters, eval probe scripts, and tests.

## Gap

P21 should make provider edge quirks explicit and queryable without changing canonical timeline or doing real API calls. The first registry can be metadata-only and used by tests/doctor/eval matrix.

## Direction

- Add `ProviderQuirkProfile` domain model with bounded metadata.
- Resolve quirks by provider/protocol/base_url.
- Include known local profiles for OpenAI Responses, OpenAI-compatible Chat, Anthropic Messages, DeepSeek OpenAI-compatible, and DeepSeek Anthropic-style endpoint.
- Add doctor `provider_quirk_diagnostics` from current config.
- Add a provider-free eval helper/matrix function and unit tests using local fixtures.

## Redaction

Quirk diagnostics may include provider family, protocol, cache strategy, boolean support flags, usage shape labels, streaming labels, and reasoning labels. They must not include API keys, headers, prompt text, provider payload body, full prompt_cache_key, raw reasoning content, or live response data.
