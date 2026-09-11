## Why

`@mycli/providers` currently owns separate OpenAI Responses, OpenAI-compatible Chat Completions, DeepSeek, and Anthropic wire adapters, including request dialects, streaming parsers, replay metadata, and SDK lifecycle. Replacing those general-purpose transport implementations with `@earendil-works/pi-ai` reduces duplicated provider maintenance while preserving the runtime contracts that make mycli retries, recovery, tools, diagnostics, and persisted sessions reliable.

## What Changes

- Introduce a pi-ai-backed `ModelProvider` implementation for the existing `responses`, `chat_completions`, and `anthropic_messages` protocols and the current OpenAI, Codex, compatible, Qwen, DeepSeek, and Anthropic routes.
- Keep `ProviderRequest`, `ProviderEvent`, `ProviderFailure`, runtime retry policy, auth storage, model configuration, tool execution, and session persistence as mycli-owned boundaries.
- Translate canonical mycli instructions, conversation items, images, tools, tool results, reasoning settings, cache settings, and output limits into pi-ai models, contexts, and stream options without exposing pi-ai types outside `@mycli/providers`.
- Preserve current instruction authority rules, including DeepSeek's existing mapping of stable developer instructions to the system prompt and dynamic developer context to user-role suffix messages.
- Translate pi-ai text, thinking, tool-call, usage, completion, cancellation, and error events back into the existing provider event and failure contracts.
- Force pi-ai request retries to zero so mycli remains the sole owner of visible request and stream retry budgets, delays, cancellation, diagnostics, and recovery events.
- Add a versioned pi-ai replay projection and backward-compatible readers for existing Responses, Anthropic, and DeepSeek replay state so persisted sessions remain resumable across the migration.
- Preserve OpenAI hosted web-search lifecycle and replay behavior through a narrowly scoped compatibility transport until pi-ai exposes equivalent hosted-tool events and replay metadata; all non-hosted-search model traffic moves to pi-ai.
- Remove the superseded general provider implementations and the direct Anthropic SDK dependency after parity verification; retain the direct OpenAI SDK dependency only for the hosted-search compatibility transport until pi-ai supplies equivalent hosted-tool support.
- Do not expand the configured provider ID set, replace mycli credential storage with pi-ai auth, or adopt the full pi-ai model catalog in this change.

## Capabilities

### New Capabilities

- `pi-ai-provider-transport`: Defines the pi-ai-backed provider boundary, canonical request and stream mapping, instruction authority, retry ownership, error normalization, replay compatibility, and hosted-search exception required for a behavior-preserving cutover.

### Modified Capabilities

None.

## Impact

- Primary code: `backend/packages/providers/`, provider construction in the Node app and agent worker, and provider-focused tests and fixtures.
- Dependencies: add an exact `@earendil-works/pi-ai` version; remove `@anthropic-ai/sdk`; keep `openai` temporarily and exclusively for the hosted-search compatibility transport, with an explicit removal condition.
- Compatibility surfaces: canonical provider requests/events, runtime retry behavior, instruction roles, tool-call identifiers, usage accounting, provider diagnostics, replay state, old-session recovery, and OpenAI hosted web-search activity.
- Distribution: the release and packed-CLI checks must cover pi-ai's larger transitive provider SDK set on Node 22.19 and Node 24 across supported platforms.
