## Context

The completed pi-ai transport change keeps `ModelProvider` as mycli's runtime-facing anti-corruption boundary, and the completed curated-catalog change loads six pi-ai built-in providers lazily. Two seams still duplicate upstream ownership:

1. `genericPiAiSnapshot()` reconstructs providers for original routes even when pi-ai has a matching built-in provider and model catalog.
2. `loadModelCatalog()` materializes one global compiled/user list, while `model.list` filters it by credentials and the TUI only sorts or searches by provider.

DeepSeek Harness demonstrates a better separation: a complete pi-ai directory is discoverable,
configured routes alone are registered, and every operation captures an immutable provider/model
snapshot. Mycli adapts that pattern while retaining API-key storage, canonical request/event
contracts, runtime retry and recovery, and bounded replay.

The pinned pi-ai catalog is not uniform. Some stable mycli routes have a matching built-in provider (`openai` Responses, `deepseek`, `anthropic`, and the six curated additions); other stable routes or protocols are not represented as that route (`qwen`, API-key `codex`, `compatible`, and OpenAI Chat Completions). Mixed-protocol providers also require one explicitly selected protocol per activated route. Therefore the rule is not “a built-in provider exists for every stable name”; it is “delegate to a built-in provider whenever the installed catalog describes the selected route/protocol, otherwise build the declaration with pi-ai's own `createProvider` and API factory.”

## Goals / Non-Goals

**Goals:**

- Make the exact pinned pi-ai provider and model catalog authoritative for catalog-backed routes.
- Stop duplicating built-in provider endpoints, factories, model lists, and compatibility metadata.
- Keep stable product support separate from extensible runtime route identity.
- Expose additional pi-ai providers as dormant directory entries and activate them only through explicit configuration.
- Make `/model` load exactly one activated provider route at a time and never select across routes implicitly.
- Preserve mycli credentials, retries, canonical events, replay, and session selection scopes while
  routing hosted Responses search through the same pi-ai transport.
- Keep catalog loading lazy and make upstream drift fail during verification rather than startup.

**Non-Goals:**

- Enabling ambient credentials, provider OAuth, Codex subscription auth, or cloud credential chains.
- Supporting pi-ai APIs outside OpenAI Completions, OpenAI Responses, and Anthropic Messages.
- Automatically activating a provider added by a later pi-ai version.
- Synthesizing canonical hosted-search progress or native search-call replay before pi-ai exposes
  those values through its public stream contract.
- Turning pi-ai model cost metadata into billing or spend reporting.

## Decisions

### 1. Separate stable product identity from runtime route identity

`ProviderId` remains the closed union used by stable product profiles. Add a bounded branded `ProviderRouteId` accepted at runtime/configuration boundaries:

```ts
type ProviderRouteId = ProviderId | Brand<string, "ProviderRouteId">
```

Route parsing accepts lowercase ASCII identifiers with internal hyphens and a fixed length bound. Existing provider literals remain assignable, while untrusted strings must pass one shared parser. `ProviderRequestConfig`, `NodeRuntimeConfig`, worker RPC, session preferences, replay state, and transcript validation carry `ProviderRouteId`; stable profile maps continue to require `ProviderId`.

The persisted JSON/SQLite field remains `provider`, so old sessions and configuration retain their shape. Adding a parallel `providerRoute` field was rejected because two identities would drift and every consumer already treats `provider` as the dispatch route. Changing `ProviderId` to unvalidated `string` was rejected because it would remove corruption checks from worker and storage boundaries.

### 2. Represent every selectable route with one normalized descriptor

The app assembly layer owns a `ProviderRouteDescriptor` assembled from stable profiles, user model/provider declarations, and the lazy pi-ai directory. It contains:

- exact route id and display name;
- support tier: `stable`, `experimental`, or `compatible`;
- source: `pi_ai_builtin` or `pi_ai_declared`;
- optional underlying pi-ai catalog provider id;
- exactly one mycli protocol/pi-ai API;
- endpoint, credential reference, activation state, and catalog/subset model policy;
- a monotonically replaced immutable capability/model snapshot.

Stable profiles create activated descriptors with backward-compatible defaults. An experimental catalog provider is discoverable but becomes activated only after configuration records its route, protocol, endpoint when required, model policy, and auth reference. A custom route unknown to pi-ai must declare protocol, endpoint, and at least one model. An alias may set `catalog_provider` so two routes can point at different protocol/model subsets of the same mixed-protocol upstream provider.

`~/.mycli/models.json` remains the user-owned declaration file. Its provider entries gain optional `source`, `catalog_provider`, and `model_policy`. A resolvable catalog-backed route follows every matching-protocol catalog model by default, while `models` supplies provider-local overrides or complete additions. Only `model_policy: "subset"` treats the declared models as an allowlist. Legacy flat catalogs are normalized to explicit subset semantics. Structural parsing stays in `@mycli/config`; catalog serviceability is validated where the app combines declarations with `@mycli/providers`, avoiding a config/providers dependency cycle.

Treating every catalog entry as a new stable `ProviderId` was rejected because an upstream dependency update would silently expand product support. Using credentials as route activation was rejected because possession of a key does not define protocol, endpoint, model subset, or capabilities.

### 3. Lazily load one complete pi-ai directory, then publish sanitized DTOs

`@mycli/providers` exposes an async directory service that dynamically imports `@earendil-works/pi-ai/providers/all` on first provider-directory or catalog-resolution use and memoizes that promise. Ordinary startup and a request for an already constructed stable snapshot do not eagerly import the directory. Returned DTOs contain provider/model ids, names, base URLs, supported mapped APIs, modalities, limits, reasoning levels, and compatibility facts; they never expose pi-ai auth objects, functions, credentials, headers, or mutable provider instances across the package boundary.

The directory classifies every installed provider as serviceable, configuration-required, or unsupported by the current mycli protocol/auth policy. Unsupported entries may be reported to diagnostics/configuration surfaces with a bounded reason but cannot be activated. Provider modules and catalogs are exact-version drift surfaces covered by tests and packed startup checks.

Generating a copied manifest in source was rejected because it would recreate the catalog and drift on every dependency update. Eagerly importing `providers/all` from the normal provider registry was rejected because it would load unrelated cloud/OAuth transports on startup.

### 4. Delegate catalog-backed routes to their built-in provider

For a catalog-backed route, resolution obtains the installed provider, filters or clones models for the route's one API, applies explicit endpoint/limit/modality overrides, and registers a wrapper provider whose `stream` and `streamSimple` delegate to the installed provider with that provider as receiver. The wrapper overrides only route identity, explicit auth seam, endpoint, and served models. This follows DSH's catalog-route wrapper and preserves provider-specific state or factory behavior.

For a route/API absent from the catalog, mycli uses pi-ai `createProvider` with one of the three supported lazy API factories. This covers declared compatible gateways and backward-compatible stable routes such as Qwen or OpenAI Chat Completions without restoring bespoke HTTP transports. A model absent from a known catalog may be synthesized only from an explicit declaration with bounded limits and capabilities; catalog metadata is never guessed.

Mycli request-scoped API keys always override provider auth. Registry readiness rejects a missing key before traffic, so pi-ai ambient discovery is never consulted. Every stream call continues to set `maxRetries: 0`.

### 5. Resolve and merge models inside one provider route

The config package parses user declarations without manufacturing a global product catalog. The app's model-directory service resolves one activated route and returns:

1. matching-protocol models from the pinned pi-ai provider catalog, when present;
2. provider-local user model entries and field overrides, which win explicitly;
3. the active configured model as `current/custom` when no other source describes its exact route/protocol/model/endpoint identity.

Entries from another route are never loaded as part of this operation. Duplicate identity is route + protocol + model + normalized endpoint. Catalog costs are ignored. Model descriptors are immutable for an operation and cache by route descriptor identity plus the exact pi-ai version; a configuration replacement creates a new cache key and leaves in-flight callers on the old snapshot.

Keeping `BUILTIN_MODEL_CATALOG` as a parallel list for catalog-backed providers was rejected because `/model` would continue to lag pi-ai. Stable routes without a catalog retain only the minimum explicit product default needed to construct their declared route.

### 6. Make the gateway and TUI provider-first

The internal JSON-RPC contract becomes:

```text
provider.list {}                    -> activated/configurable route summaries
model.list { provider }             -> models for exactly one activated route
model.select { provider, protocol, model, base_url, ... }
```

`model.list` validates the route, returns the route id with its model array, and rejects missing, unknown, inactive, or unserviceable routes with bounded request errors. It does not filter a global list by credential presence.

Opening `/model` uses a provider-scoped selector with a one-confirmation common path:

```text
resolve current provider -> asynchronously load its models -> model
  Enter -> apply the model to this session with its default reasoning
  Tab   -> reasoning when applicable -> scope
  [/]   -> load the previous/next provider directly
  Esc   -> provider list when multiple usable routes exist
```

The TUI keeps the route associated with the currently loaded model array, shows a stable loading/empty/error state, and discards a late response if the user has selected another provider meanwhile. The current or explicitly preferred route is selected implicitly even when multiple usable routes exist; the provider list remains reachable by backing out of the model list. Login/setup success opens `/model` for that exact route. A configured route missing credentials remains visible but selection routes to login before model traffic.

Enter on a model is the fast path: it submits the catalog default reasoning choice, or the first supported choice when the catalog has no valid default, with session scope. Tab opens the existing reasoning and scope stages for users who want a different effort or a persistent user default. Bracket keys cycle provider-scoped catalogs without returning to the provider list, while stale-response fencing remains active. Selection remains pending until the gateway accepts it, and a bounded failure leaves the model list open for retry.

`/model <name>` searches only the active route. An explicit provider argument or the interactive provider stage is required to switch routes. The former fallback to another provider's first same-named model is removed. Session and user selection scopes retain their existing persistence behavior and exact selection identity.

### 7. Bind replay to the effective transport without persisting secrets

The pi-ai replay envelope gains a versioned transport identity containing route id, catalog provider id when present, API, model, and a SHA-256 fingerprint of the normalized non-secret endpoint identity. It does not store credentials, request headers, query strings, raw payloads, or mutable catalog objects.

Replay is restored only when canonical content and the effective route/model/transport identity match. Old replay for stable routes remains readable under its legacy checks; replay without sufficient identity for an experimental or reconfigured route degrades to canonical history with a bounded diagnostic. Configuration changes during a request cannot change its captured replay identity.

### 8. Preserve one owner for failures, retries, and lifecycle

The existing provider error classifier remains the single boundary mapping pi-ai failures into
`ProviderFailure`. Directory/configuration failures use request-scoped config errors and do not
terminalize an unrelated active turn. Runtime remains the only retry owner, including post-output
recovery. There is no direct provider SDK transport beside pi-ai.

Live hosted search is a Responses-native tool. The pi-ai `onPayload` hook appends
`{ type: "web_search", external_web_access: true }` to its generated tool list; Chat Completions and
Anthropic Messages reject the capability before sending traffic. The pinned pi-ai version consumes heartbeat
and native search lifecycle frames but exposes only its supported assistant events. Mycli accepts
that bounded limitation: final text, usage, response identity, completion, and supported replay are
preserved, while new canonical search progress rows and native search-call replay are unavailable
until pi-ai adds them. Historical persisted search activity remains readable.

## Risks / Trade-offs

- [Risk] Pi-ai catalogs include mixed or unsupported APIs. -> Mitigation: activate exactly one supported protocol per route and require aliases for a second protocol.
- [Risk] Loading `providers/all` increases startup time or imports cloud SDKs. -> Mitigation: dynamic import only from directory/catalog operations, module-loading tests, and packed startup budgets.
- [Risk] A pi-ai upgrade changes provider/model metadata. -> Mitigation: exact pin, catalog drift fixtures, compile-time API gates, and explicit review before version changes.
- [Risk] Dynamic route identity weakens persisted validation. -> Mitigation: one branded parser and independent validation at config, worker, storage, and gateway boundaries.
- [Risk] Provider switching creates stale async model responses in the TUI. -> Mitigation: associate each response with route/request generation and ignore superseded results.
- [Risk] User overrides accidentally apply across providers. -> Mitigation: merge only after exact route identity resolution and test same-named models on multiple routes.
- [Risk] Reconfigured routes reuse incompatible replay. -> Mitigation: versioned sanitized transport fingerprint and canonical degradation.
- [Trade-off] Catalog-backed `/model` may expose many models. -> Mitigation: provider-first loading, fuzzy search, bounded rendering, and provider-local optional model narrowing.
- [Trade-off] Some stable routes still use pi-ai `createProvider`. -> This is required where pi-ai has no matching built-in route/API and still avoids a mycli-owned transport implementation.
- [Trade-off] The pinned pi-ai version does not publish hosted-search lifecycle events or native search-call
  replay. -> New turns omit search progress rows and replay from canonical assistant content, in
  exchange for one transport and no direct OpenAI SDK dependency.

## Migration Plan

1. Add route identity/descriptor contracts and backward-compatible parsers while stable route behavior remains unchanged.
2. Add the lazy pi-ai directory and catalog DTOs, then implement catalog-provider delegation beside the existing curated loader map.
3. Convert stable catalog-backed routes and delete the closed six-provider loader map after parity tests cover all routes.
4. Replace global catalog materialization with provider-scoped resolution while retaining readers for existing `models.json` v2 declarations.
5. Change gateway/TUI model loading atomically, including provider selection, stale-response handling, and removal of cross-provider fallback.
6. Add replay transport identity with legacy degradation tests.
7. Route hosted Responses search through pi-ai payload injection, remove the direct OpenAI
   transport/dependency, and add heartbeat/lifecycle-frame completion coverage.
8. Update setup/auth/docs and run provider, config, app, TUI, runtime, storage, contract, packed Node 22.19/24, and startup gates.

Rollback restores the prior registry/catalog/TUI path. Existing stable provider strings, credentials, `models.json` declarations, session preferences, and canonical transcript fields remain readable because their persisted names and shapes are retained. Experimental routes are ignored or reported unsupported by the prior release; users can convert them to `compatible` before downgrade without moving credentials.

## Open Questions

- Live credentials for newly discoverable experimental providers are not available locally; deterministic mock verification is required, and live support status must remain explicit.
- Pi-ai's provider directory currently contains entries with no models or provider-specific configuration requirements. Their exact disabled reason vocabulary should remain internal and bounded rather than becoming a long-lived public error taxonomy in this change.
