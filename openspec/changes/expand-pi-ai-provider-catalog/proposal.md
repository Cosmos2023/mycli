## Why

Mycli's pi-ai transport now handles the existing providers, but the product catalog still exposes only six hard-coded routes even though several additional pi-ai providers use the already-supported OpenAI Completions protocol. Promoting a small, verified set of those routes to first-class providers removes manual `compatible` setup without prematurely committing mycli to pi-ai's full OAuth, cloud-credential, and protocol surface.

## What Changes

- Add first-class provider IDs and profiles for OpenRouter, Groq, Together, Moonshot AI, NVIDIA, and Cerebras.
- Give each new provider a deterministic display name, `chat_completions` protocol, default API base URL, API-key auth reference, setup support, and provider/model catalog visibility.
- Reuse pi-ai's built-in OpenAI Completions transport and known model compatibility metadata for catalogued models while keeping configured endpoints, credentials, model selection, retry policy, canonical events, and session persistence under mycli ownership.
- Continue accepting uncatalogued model IDs for the six providers through a conservative OpenAI-compatible fallback so a pinned pi-ai catalog does not become an artificial model allowlist.
- Treat `compatible` as the supported escape hatch for other OpenAI-compatible endpoints and document the difference between first-class and custom-compatible support.
- Add payload, stream, error, tool-call, usage, setup, configuration, model-catalog, and packed-CLI coverage for the six new routes, plus optional real-key smoke instructions that never expose credentials.
- Do not expose pi-ai's complete provider catalog, add OAuth login, adopt pi-ai credential storage, or add Google, Vertex, Bedrock, Mistral, Azure, or other new wire protocols in this change.

## Capabilities

### New Capabilities

- `pi-ai-provider-catalog`: Defines the curated first-class provider set, configuration and setup behavior, pi-ai metadata use, compatible fallback, capability boundaries, and verification requirements for expanding mycli beyond its original provider routes.

### Modified Capabilities

None.

## Impact

- Core and configuration: provider identity types, provider profiles and inference, runtime setting choices, model catalog bootstrap, config parsing/writing, and credential references.
- Provider integration: pi-ai snapshot construction, provider-specific compatibility metadata selection, request validation, replay identity, and provider registry tests; runtime retry and canonical event contracts remain unchanged.
- CLI and TUI: setup provider list, provider display names, login/status surfaces, model selection, diagnostics, and configuration documentation.
- Testing and release: mock HTTP parity for all six routes, API-key redaction checks, packed CLI smoke coverage on supported Node versions, and documented opt-in live-provider smoke commands.
- Dependency policy: retain the exact pinned `@earendil-works/pi-ai` version; a dependency upgrade must revalidate the curated providers and must not automatically publish newly appearing pi-ai providers as mycli-supported routes.
