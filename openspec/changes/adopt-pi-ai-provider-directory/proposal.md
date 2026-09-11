## Why

Mycli now sends ordinary model traffic through pi-ai, but it still rebuilds known provider definitions and serves `/model` from a global, credential-filtered static catalog. Making pi-ai's installed providers and per-provider model catalogs the authoritative integration source removes the remaining duplicated provider work and makes model selection follow the provider route the request will actually use.

## What Changes

- Reuse pi-ai's built-in `Provider` object, provider factory, endpoint, protocol implementation, model catalog, and compatibility metadata for every installed provider route mycli supports; stop rebuilding known providers from generic API factories.
- Retain mycli ownership of explicit API-key resolution, configuration, canonical requests/events,
  capability admission, `maxRetries: 0`, error classification, replay validation, and session
  persistence while routing hosted Responses search through pi-ai as a provider-native tool.
- Add a validated provider-route directory that distinguishes stable first-class providers, explicitly enabled experimental pi-ai catalog routes, and fully declared custom-compatible routes without weakening stable `ProviderId` checks to arbitrary strings.
- Lazily load pi-ai's complete provider catalog only for provider-directory/model-resolution work, and keep ordinary startup free of eager `providers/all` imports.
- **BREAKING**: make the internal `model.list` gateway request provider-scoped and return models only for the requested route instead of a global credential-filtered list.
- Make `/model` resolve the current provider route first and immediately load its models. Keep the provider list one back action away, and let Enter apply the selected model to the session with its default reasoning while Tab opens reasoning and scope options.
- Merge user model declarations only into their owning provider catalog, preserve an active uncatalogued custom model as `current/custom`, and remove silent cross-provider fallback for `/model <name>`.
- Use pi-ai `createProvider` only when the selected route/protocol is not described by the installed catalog; keep `compatible` as the public fully declared path and require explicit protocol, endpoint, model, credential reference, and capabilities there.
- Remove the dedicated hosted-search transport and direct OpenAI SDK dependency. The pinned pi-ai version
  consumes hosted-search lifecycle frames but does not expose them through its public event/replay
  contract, so new turns retain final assistant output without canonical search progress rows.

## Capabilities

### New Capabilities

- `pi-ai-provider-directory`: Defines stable, experimental catalog-backed, and custom-compatible provider routes; pi-ai built-in provider reuse; lazy catalog loading; authentication and retry boundaries; snapshot and replay identity; and provider activation rules.
- `provider-scoped-model-selection`: Defines provider-first `/model` behavior, provider-scoped gateway queries, pi-ai catalog and user-override merging, selection identity, missing-credential behavior, and removal of cross-provider fallback.

### Modified Capabilities

None.

## Impact

- Core/config: separate stable provider identities from validated route identities and resolve provider-scoped model catalogs.
- Provider integration: replace generic construction for known providers with pi-ai catalog-provider delegation while retaining the existing `ModelProvider` anti-corruption boundary.
- Gateway/TUI: change `model.list`, runtime-state model loading, `/model` selection stages, and startup/login handoff.
- Storage/replay: preserve the existing persisted `provider` field while validate it as an exact route identity and bind pi-ai replay to a sanitized transport fingerprint.
- Tests/docs: add provider-directory, module-loading, gateway, selector, replay, configuration, mock transport, packed CLI, and upgrade/rollback coverage.
- Dependency policy: keep `@earendil-works/pi-ai` exactly pinned, remove mycli's direct `openai`
  dependency, and leave newly shipped catalog providers discoverable but inactive by default.
