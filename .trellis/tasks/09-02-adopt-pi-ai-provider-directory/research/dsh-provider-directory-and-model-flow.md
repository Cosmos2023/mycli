# DSH Provider Directory And Mycli Model Flow

## DeepSeek Harness Pattern

- `packages/llm/llm-pi-ai/src/catalog.ts` imports `builtinProviders`, `getBuiltinModels`, and `getBuiltinProviders` from `@earendil-works/pi-ai/providers/all` and caches providers by id.
- `packages/llm/llm-pi-ai/src/index.ts` publishes the installed catalog as a configurable-provider directory, but registers request routes only for entries declared in settings.
- Route registration and directory replacement are atomic; a collision leaves the previously registered set serving.
- `packages/llm/llm-pi-ai/src/adapter.ts` builds a new immutable `Models` snapshot for a changed profile map. An operation captures the snapshot before its first asynchronous boundary.
- Pi-ai stream options explicitly set `maxRetries: 0`; DSH's outer `llm-retry` plugin owns durable retry attempts.
- Known catalog routes delegate to the installed pi-ai provider. Unknown routes require a supported API, base URL, and non-empty model declaration.
- DSH also enables provider-native ambient credentials and OAuth. Mycli deliberately does not adopt those behaviors.
- DSH models `web_search` as an ordinary agent-executed function backed by its own search service;
  it does not use OpenAI Responses hosted search as a separate provider transport.

## Current Mycli Behavior

- `backend/packages/providers/src/pi-ai-model.ts` uses pi-ai built-in provider loaders only for the six recently curated providers. Other known providers are rebuilt with `createProvider` and generic API factories.
- `backend/packages/config/src/model-catalog.ts` merges a compiled static catalog with `~/.mycli/models.json` and returns one global list.
- `backend/apps/mycli/src/node-runtime/node-backend.ts` filters that global list by current selection or stored credential; `model.list` has no provider input.
- `tui/mycli-shell/src/components/model-selector.ts` sorts the global list by provider and model and uses provider text only as part of fuzzy search.
- Startup onboarding passes the provider id as initial search text instead of loading a provider-specific model list.
- The inline `/model <name>` path prefers the current provider but silently falls back to the first same-named model from another provider.
- Provider identity is currently a closed union reused by configuration, requests, worker RPC, transcript validation, and replay state. Opening routes requires a separately validated route type rather than changing every check to arbitrary strings.

## Recommended Mapping

```text
pi-ai pinned provider directory
  -> mycli support/auth/protocol classification
  -> explicit provider-route activation
  -> immutable route snapshot
  -> provider-scoped model catalog
  -> canonical ModelProvider request/events
```

- Stable providers remain product-supported entries.
- Experimental catalog routes are visible but dormant until explicitly activated with a mycli API-key reference.
- Custom-compatible routes remain fully declared and are the only routes built with generic protocol factories.
- Gateway model listing accepts an exact provider route and never returns another provider's models.
- User model overrides merge only with the selected provider catalog.
- Replay binds to route, underlying catalog provider, API, model, and a sanitized endpoint fingerprint.

## Hosted Responses Search

- The pinned pi-ai version exposes function/custom tools publicly, and its `onPayload` hook can append the
  Responses-native `{ type: "web_search", external_web_access: true }` tool after pi-ai builds the
  request.
- A redacted live probe confirmed the request produced `web_search_call` plus in-progress,
  searching, completed, and final response events. Pi-ai consumed those unmodelled lifecycle events
  and still returned final text, reasoning, usage, response identity, and completion.
- A final redacted request through mycli's configured OpenAI Responses relay and
  `ProviderRegistry` confirmed exactly one upstream attempt, native `web_search` payload injection,
  and canonical text, provider-state, usage, and completion events.
- The same behavior tolerates non-semantic `{ type: "keepalive" }` frames. Mycli therefore does not
  need a second OpenAI transport to complete hosted search.
- Pi-ai's public event/replay contract does not expose the native search lifecycle in this version.
  The unified transport deliberately gives up new canonical search progress rows and native
  search-call replay until pi-ai exposes them, while legacy persisted rows remain readable.

## Version And Candidate Notes

- Mycli pins `@earendil-works/pi-ai@0.84.4` exactly and uses a daily Dependabot check to propose
  reviewed exact-pin updates.
- Provider-grouped v2 declarations now treat `models` as catalog overrides/additions by default, so
  a dependency update can surface newly catalogued models. `model_policy: "subset"` is required to
  retain an allowlist; legacy flat catalogs normalize to subset semantics.
- At that version, a mechanical filter for API-key providers with models using `openai-completions`, `openai-responses`, or `anthropic-messages` finds roughly 33 candidates.
- Mixed-protocol providers and providers without a fixed base URL require an explicit model subset or endpoint; they must not be presented as automatically ready.
