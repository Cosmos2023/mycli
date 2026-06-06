# Request Chain Research

## Current Flow

The request assembly path is:

`TurnContextAssembler -> InstructionContractAssembler -> RequestShapeBuilder -> RequestShapePayloadFormatter -> model adapter/client`

`RequestShapeBuilder` is the right boundary for P1 because it can see:

- base instructions and developer sections
- contextual user sections with cache metadata
- conversation replay
- current user request
- rendered tools and tool order
- target provider/protocol/model

## Provider Observations

- Responses uses runtime items. It can preserve richer canonical item shape and
  provider-private continuation state, but prompt cache optimization should be
  expressed as a wire/request option such as a future `prompt_cache_key`, not as
  canonical text.
- OpenAI-compatible Chat Completions uses transcript messages. Provider-private
  Responses and Anthropic fields must not leak into this lane.
- Anthropic Messages can use Hermes-style `cache_control`, but those markers are
  wire-only. They should be added to a send copy, not persisted to the canonical
  timeline or transcript.

## Cache Policy

- Static prefix: system prompt, deterministic tool schema/order, workspace
  instructions, stable skill/tool catalogs.
- Dynamic replay: conversation replay, memory, plan, environment facts,
  compaction rehydration, and provider-private replay state when supported.
- Ephemeral tail: current user intent, runtime reminders, approval hints, and
  current-turn hook/plugin additions.

Model-visible content that affects future decisions should be persisted in the
canonical timeline. Diagnostic-only values, provider request hints, and
provider-specific cache markers remain wire-only.

## Compact Policy

All providers share the canonical compact engine. Cheap pruning may summarize or
deduplicate dynamic replay/tool output, but must not mutate frozen/static prefix.
Compaction rehydration is dynamic and should be placed before current user
intent. Provider-specific compact APIs can be evaluated later only if they
preserve canonical compact invariants.

