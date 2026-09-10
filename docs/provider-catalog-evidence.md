# Builtin Provider Catalog Evidence

Pinned SDK: `@earendil-works/pi-ai@0.84.4`. This report describes offline source and
mocked transport evidence, not verified live accounts.

The actual `builtinProviders()` catalog contains 40 providers: 27 serviceable, 7 requiring
configuration, and 6 unsupported. The 34 serviceable/configurable providers expose 43 supported
provider/protocol routes. Every route is exercised through `PiAiProvider` with its actual builtin
provider identity, catalog model and native dispatch, an explicit offline endpoint, and a dummy
request API key. No generic `pi_ai_declared` route substitutes for builtin evidence.

The matrix covers healthy completion, nested stream errors, overload, type-only authentication,
quota, permission, context and invalid-request failures, empty/malformed JSON and error envelopes,
HTTP 502 and quota 429, premature EOF, body reset/timeout, caller cancellation during a pending body
read, and completion followed by an error in the same chunk.
Healthy Chat fixtures put usage after `finish_reason`; completion must retain it. Failure fixtures
produce partial output and must never publish successful completion or tool execution. Every case
asserts a single fetch so the SDK cannot hide retries. Each route uses one deterministic catalog
model; this does not claim coverage of every model's compatibility settings. Detailed tool, reasoning-only, split-frame,
cancellation and open-body regressions remain in the protocol-specific test suites.

Mycli preserves native auth callbacks, credential-based model filtering, and stream dispatch.
Supported adapters receive a request key, an isolated provider environment, or a stored SDK OAuth
grant through the native resolver. Credential refresh remains owned by the pinned SDK and is
serialized by the config credential store. These are offline contract tests; the catalog's auth
descriptors do not establish that a live account or unsupported AWS/Google transport works.
Cloudflare adapters retain their `cloudflareStreams` endpoint-substitution wrapper and receive
their account/gateway environment alongside the configured endpoint.
Radius uses its own dynamic catalog-refresh wrapper. Other factories use `createProvider` API dispatch.

The table is produced by `test/support/builtin-provider-inventory.ts` from actual SDK model APIs,
auth descriptors, provider source imports parsed with TypeScript, and reviewed adapter hooks.
`test/registry/builtin-provider-inventory.test.ts` checks this table for catalog drift. A new adapter
requires a reviewed hook disposition; a changed provider, API, auth descriptor or directory status
requires reviewing and regenerating the table. Hook behavior for enabled routes is additionally
tested by the real SDK matrix in `test/pi-ai/pi-ai-builtin-routes.test.ts`.

## Catalog

| Provider | Model APIs | Concrete SDK Adapter | SDK Auth | Current Disposition | Hooks |
| --- | --- | --- | --- | --- | --- |
| amazon-bedrock | bedrock-converse-stream | api/bedrock-converse-stream.js; createProvider API dispatch | apiKey (AWS credentials or bearer token) | unsupported: unsupported_protocol | bedrock-converse-stream: fetch=ignored, onResponse=supported |
| ant-ling | openai-completions | api/openai-completions.js; createProvider API dispatch | apiKey (Ant Ling API key) | serviceable: request_api_key | openai-completions: fetch=supported, onResponse=supported |
| anthropic | anthropic-messages | api/anthropic-messages.js; createProvider API dispatch | apiKey (Anthropic API key), oauth | serviceable: request_api_key | anthropic-messages: fetch=supported, onResponse=supported |
| azure-openai-responses | azure-openai-responses | api/azure-openai-responses.js; createProvider API dispatch | apiKey (Azure OpenAI API key) | configuration_required: endpoint_required | azure-openai-responses: fetch=supported, onResponse=supported |
| baseten | openai-completions | api/openai-completions.js; createProvider API dispatch | apiKey (Baseten API key) | serviceable: request_api_key | openai-completions: fetch=supported, onResponse=supported |
| cerebras | openai-completions | api/openai-completions.js; createProvider API dispatch | apiKey (Cerebras API key) | serviceable: request_api_key | openai-completions: fetch=supported, onResponse=supported |
| cloudflare-ai-gateway | anthropic-messages, openai-completions, openai-responses | api/anthropic-messages.js, api/openai-completions.js, api/openai-responses.js; cloudflareStreams endpoint env substitution | apiKey (Cloudflare API key) | configuration_required: endpoint_required, protocol_selection_required | anthropic-messages: fetch=supported, onResponse=supported; openai-completions: fetch=supported, onResponse=supported; openai-responses: fetch=supported, onResponse=supported |
| cloudflare-workers-ai | openai-completions | api/openai-completions.js; cloudflareStreams endpoint env substitution | apiKey (Cloudflare API key) | configuration_required: endpoint_required | openai-completions: fetch=supported, onResponse=supported |
| deepseek | openai-completions | api/openai-completions.js; createProvider API dispatch | apiKey (DeepSeek API key) | serviceable: request_api_key | openai-completions: fetch=supported, onResponse=supported |
| fireworks | anthropic-messages, openai-completions | api/anthropic-messages.js, api/openai-completions.js; createProvider API dispatch | apiKey (Fireworks API key) | configuration_required: protocol_selection_required | anthropic-messages: fetch=supported, onResponse=supported; openai-completions: fetch=supported, onResponse=supported |
| github-copilot | anthropic-messages, openai-completions, openai-responses | api/anthropic-messages.js, api/openai-completions.js, api/openai-responses.js; createProvider API dispatch | apiKey (GitHub Copilot token), oauth | configuration_required: protocol_selection_required | anthropic-messages: fetch=supported, onResponse=supported; openai-completions: fetch=supported, onResponse=supported; openai-responses: fetch=supported, onResponse=supported |
| google | google-generative-ai | api/google-generative-ai.js; createProvider API dispatch | apiKey (Gemini API key) | unsupported: unsupported_protocol | google-generative-ai: fetch=rejected, onResponse=absent |
| google-vertex | google-vertex | api/google-vertex.js; createProvider API dispatch | apiKey (Google Cloud credentials) | unsupported: unsupported_protocol | google-vertex: fetch=rejected, onResponse=absent |
| groq | openai-completions | api/openai-completions.js; createProvider API dispatch | apiKey (Groq API key) | serviceable: request_api_key | openai-completions: fetch=supported, onResponse=supported |
| huggingface | openai-completions | api/openai-completions.js; createProvider API dispatch | apiKey (Hugging Face token) | serviceable: request_api_key | openai-completions: fetch=supported, onResponse=supported |
| kimi-coding | anthropic-messages | api/anthropic-messages.js; createProvider API dispatch | apiKey (Kimi API key), oauth | serviceable: request_api_key | anthropic-messages: fetch=supported, onResponse=supported |
| minimax | anthropic-messages | api/anthropic-messages.js; createProvider API dispatch | apiKey (MiniMax API key) | serviceable: request_api_key | anthropic-messages: fetch=supported, onResponse=supported |
| minimax-cn | anthropic-messages | api/anthropic-messages.js; createProvider API dispatch | apiKey (MiniMax CN API key) | serviceable: request_api_key | anthropic-messages: fetch=supported, onResponse=supported |
| mistral | mistral-conversations | api/mistral-conversations.js; createProvider API dispatch | apiKey (Mistral API key) | unsupported: unsupported_protocol | mistral-conversations: fetch=supported, onResponse=supported |
| moonshotai | openai-completions | api/openai-completions.js; createProvider API dispatch | apiKey (Moonshot AI API key) | serviceable: request_api_key | openai-completions: fetch=supported, onResponse=supported |
| moonshotai-cn | openai-completions | api/openai-completions.js; createProvider API dispatch | apiKey (Moonshot AI API key) | serviceable: request_api_key | openai-completions: fetch=supported, onResponse=supported |
| nvidia | openai-completions | api/openai-completions.js; createProvider API dispatch | apiKey (NVIDIA API key) | serviceable: request_api_key | openai-completions: fetch=supported, onResponse=supported |
| openai | openai-responses | api/openai-responses.js; createProvider API dispatch | apiKey (OpenAI API key) | serviceable: request_api_key | openai-responses: fetch=supported, onResponse=supported |
| openai-codex | openai-codex-responses | api/openai-codex-responses.js; createProvider API dispatch | oauth | unsupported: unsupported_auth | openai-codex-responses: fetch=sse_only, onResponse=sse_only |
| opencode | anthropic-messages, google-generative-ai, openai-completions, openai-responses | api/anthropic-messages.js, api/google-generative-ai.js, api/openai-completions.js, api/openai-responses.js; createProvider API dispatch | apiKey (OpenCode API key) | configuration_required: endpoint_required, protocol_selection_required | anthropic-messages: fetch=supported, onResponse=supported; google-generative-ai: fetch=rejected, onResponse=absent; openai-completions: fetch=supported, onResponse=supported; openai-responses: fetch=supported, onResponse=supported |
| opencode-go | anthropic-messages, openai-completions, openai-responses | api/anthropic-messages.js, api/openai-completions.js, api/openai-responses.js; createProvider API dispatch | apiKey (OpenCode API key) | configuration_required: endpoint_required, protocol_selection_required | anthropic-messages: fetch=supported, onResponse=supported; openai-completions: fetch=supported, onResponse=supported; openai-responses: fetch=supported, onResponse=supported |
| openrouter | openai-completions | api/openai-completions.js; createProvider API dispatch | apiKey (OpenRouter API key), oauth | serviceable: request_api_key | openai-completions: fetch=supported, onResponse=supported |
| qwen-token-plan | openai-completions | api/openai-completions.js; createProvider API dispatch | apiKey (Qwen Token Plan API key) | serviceable: request_api_key | openai-completions: fetch=supported, onResponse=supported |
| qwen-token-plan-cn | openai-completions | api/openai-completions.js; createProvider API dispatch | apiKey (Qwen Token Plan CN API key) | serviceable: request_api_key | openai-completions: fetch=supported, onResponse=supported |
| qwen-token-plan-individual | openai-completions | api/openai-completions.js; createProvider API dispatch | apiKey (Qwen Token Plan Individual API key) | serviceable: request_api_key | openai-completions: fetch=supported, onResponse=supported |
| radius | none (dynamic) | api/pi-messages.js; dynamic catalog refresh | apiKey (Radius API key), oauth | unsupported: no_supported_models | pi-messages: fetch=supported, onResponse=supported |
| together | openai-completions | api/openai-completions.js; createProvider API dispatch | apiKey (Together API key) | serviceable: request_api_key | openai-completions: fetch=supported, onResponse=supported |
| vercel-ai-gateway | anthropic-messages | api/anthropic-messages.js; createProvider API dispatch | apiKey (Vercel AI Gateway API key) | serviceable: request_api_key | anthropic-messages: fetch=supported, onResponse=supported |
| xai | openai-responses | api/openai-responses.js; createProvider API dispatch | apiKey (xAI API key), oauth | serviceable: request_api_key | openai-responses: fetch=supported, onResponse=supported |
| xiaomi | openai-completions | api/openai-completions.js; createProvider API dispatch | apiKey (Xiaomi API key) | serviceable: request_api_key | openai-completions: fetch=supported, onResponse=supported |
| xiaomi-token-plan-ams | openai-completions | api/openai-completions.js; createProvider API dispatch | apiKey (Xiaomi Token Plan AMS API key) | serviceable: request_api_key | openai-completions: fetch=supported, onResponse=supported |
| xiaomi-token-plan-cn | openai-completions | api/openai-completions.js; createProvider API dispatch | apiKey (Xiaomi Token Plan CN API key) | serviceable: request_api_key | openai-completions: fetch=supported, onResponse=supported |
| xiaomi-token-plan-sgp | openai-completions | api/openai-completions.js; createProvider API dispatch | apiKey (Xiaomi Token Plan SGP API key) | serviceable: request_api_key | openai-completions: fetch=supported, onResponse=supported |
| zai | openai-completions | api/openai-completions.js; createProvider API dispatch | apiKey (Z.AI API key) | serviceable: request_api_key | openai-completions: fetch=supported, onResponse=supported |
| zai-coding-cn | openai-completions | api/openai-completions.js; createProvider API dispatch | apiKey (Z.AI Coding CN API key) | serviceable: request_api_key | openai-completions: fetch=supported, onResponse=supported |

## Native Expansion Limits

- azure-openai-responses: Azure endpoint/deployment configuration
- google-generative-ai: custom fetch explicitly rejected
- google-vertex: custom fetch rejected; native Google auth context
- bedrock-converse-stream: AWS transport/auth; metadata middleware only
- mistral-conversations: native conversation protocol not enabled
- openai-codex-responses: OAuth; WebSocket path needs separate observation
- pi-messages: dynamic catalog requires native configuration refresh

Google's two pinned adapters explicitly reject a custom fetch and do not call `onResponse`.
Bedrock uses an AWS SDK client and response metadata middleware rather than the supplied fetch.
Enabling these APIs without a tested transport hook would lose the request-scoped error boundary.
Codex SSE has fetch/response hooks, but its WebSocket branch requires separate evidence.
OpenCode's Google models remain excluded even though its other three APIs are configurable.
The six unsupported providers and all live credential families remain unvalidated by this suite.

Native OAuth dispatch is covered for Anthropic, OpenRouter, xAI, Kimi Coding, and all three
GitHub Copilot APIs. These tests use real SDK auth adapters with offline grants and verify healthy
completion, structured stream failures, and fatal HTTP quota failures. Shared refresh tests cover
serialized updates across independent SDK instances, restart, refresh failure, cancellation, and
logout. OpenRouter's nonexpiring grant legitimately has an empty refresh token. Local status
does not refresh OAuth or send a model request. A stored grant takes precedence over native
environment discovery; an explicit `MYCLI_API_KEY` overrides it. Missing explicit credential
references do not silently fall back to ambient provider credentials.

Azure uses its native `azure-openai-responses` API with canonical Responses projection. Its
committed transport snapshot binds catalog provider, native API, model source, model id, endpoint
hash, API version, and deployment name. Worker dispatch and replay validate the same snapshot.
The endpoint comes from `model.api_base_url`, `AZURE_OPENAI_BASE_URL`, or
`AZURE_OPENAI_RESOURCE_NAME`; `AZURE_OPENAI_API_VERSION` defaults to `v1`, and the optional
`AZURE_OPENAI_DEPLOYMENT_NAME_MAP` uses comma-separated `model=deployment` entries. Configuration
is captured from the injected runtime environment; secrets never enter the durable snapshot.
The backend integration also verifies a failed Azure attempt, durable retry scheduling, recovery,
and SQLite reopen in both main-process and Worker execution. Packed CLI smoke covers the same
native Azure recovery and stored OAuth status/logout using temporary homes and a loopback server.

## Live Validation

All enabled API-key, native environment, and OAuth families are **not live validated** in this
change. A successful local readiness check means credentials are available, not that the remote
account has permission, quota, or access to every model.

`npm run smoke:providers:native -- --provider <catalog-id>` reports local readiness only.
Add `--live` to send one fixed, tool-free request through the native adapter; optional `--model`
and `--protocol` select a configured family. Missing credentials or unsupported providers exit 77.
The JSON result reports auth source/type, native API, canonical failure code, and live-validation
status without credentials, endpoints, request payloads, or raw errors. The offline regression
for this command prevents default traffic and hidden retries. No live probe ran during this work.

## Verification

```sh
node --conditions=mycli-source --import tsx --test \
  backend/packages/providers/test/pi-ai/pi-ai-builtin-routes.test.ts \
  backend/packages/providers/test/registry/builtin-provider-inventory.test.ts
```

To inspect a regenerated table without modifying files:

```sh
node --conditions=mycli-source --import tsx --input-type=module -e 'import { builtinProviderInventory, renderBuiltinProviderInventory } from "./backend/packages/providers/test/support/builtin-provider-inventory.ts"; console.log(renderBuiltinProviderInventory(await builtinProviderInventory()));'
```
