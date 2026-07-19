# Provider-Managed Model Output Limits

## Goal

Remove the generic user-facing `max_output_tokens` setting from model requests so
providers can apply their native output limits, matching Codex's Responses API
request shape where the output limit is not explicitly configured.

This change applies only to model generation. Tool-output budgets such as Bash
`max_output_tokens` remain unchanged.

## Protocol Behavior

- OpenAI-compatible Chat Completions requests omit `max_tokens`.
- OpenAI Responses requests omit `max_output_tokens`.
- Anthropic Messages requests retain `max_tokens` because that protocol requires
  it. The client uses an internal `8192` token default, which remains above the
  existing maximum thinking budget of `6144`, rather than a generic user setting.
- Provider-reported truncation remains an error condition. Chat Completions
  `finish_reason="length"` and Responses `response.incomplete` must not produce an
  `assistant_completed` turn.

## Configuration

The generic `max_output_tokens` setting and `MYCLI_MAX_OUTPUT_TOKENS` environment
override are removed from configuration loading and generated configuration.
Legacy config files may still contain the key; it is ignored rather than treated
as an error.

The generic `output_limit_escalation_max_tokens` and
`output_recovery_retry_limit` settings are also removed. Legacy values are
ignored. A truncation signal is reported as a model error; mycli does not retry
the same generation with a client-selected larger budget.

## Runtime Flow

1. The selected model client builds a request using its protocol requirements.
2. Chat Completions and Responses leave the optional output-limit field absent.
3. Anthropic supplies its internal required `max_tokens` value.
4. A normal provider completion finalizes the turn.
5. A provider truncation signal becomes a typed `ModelResponseError` and follows
   normal model-error handling without output-budget escalation; partial text is
   never recorded as a successful final answer.

## Compatibility

- Existing Chat Completions and Responses users receive provider-managed output
  budgets without changing configuration.
- Existing `max_output_tokens` values in TOML stop affecting model generation.
- Anthropic remains functional because its required request field is preserved.
- Legacy output-limit and escalation settings remain parse-safe but have no
  runtime effect.
- Shell, `WriteStdin`, code-mode, and other tool-output limits are out of scope.

## Verification

- Request-shape tests assert Chat Completions omits `max_tokens`.
- Request-builder tests assert Responses omits `max_output_tokens` and excludes it
  from continuation signatures.
- Anthropic request tests assert `max_tokens` is still present.
- A streaming Chat Completions regression test asserts `finish_reason="length"`
  raises an output-limit error instead of emitting `TURN_COMPLETED`.
- Runtime recovery tests assert a truncated assistant response cannot produce
  `assistant_completed`.
- Configuration tests assert legacy output-limit keys are ignored and generated
  configuration no longer emits them.
