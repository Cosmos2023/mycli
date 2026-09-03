# Provider Transport Contract

## Scenario: Pi-ai owns provider wire compatibility

### 1. Scope / Trigger

- Trigger: changes to provider/model discovery, route snapshots, request projection, pi-ai options,
  payload hooks, stream normalization, replay, or retry classification.
- The runtime-facing boundary is mycli's canonical `ModelProvider`. The exact
  `@earendil-works/pi-ai` version shared by the application and provider workspace manifests is the
  only provider transport, and its types stay private to `@mycli/providers`. Dependabot checks that
  pin daily; its pull request must update the root lockfile and pass the provider and package gates.
- Ownership is explicit: mycli owns credentials, route/session state, semantic request intent, and
  observable retries; pi-ai owns roles and all provider-specific reasoning, token, storage, cache,
  strict-tool, and affinity wire fields; the remote provider owns actual cache storage and hits.

### 2. Signatures

```typescript
type CacheRetention = "none" | "short" | "long";

interface ProviderRequestConfig {
  readonly provider: ProviderRouteId;
  readonly protocol: "responses" | "chat_completions" | "anthropic_messages";
  readonly model: string;
  readonly reasoningEffort?: ReasoningEffort;
  readonly maxOutputTokens?: number;
  readonly sessionId?: string;
  readonly cacheRetention?: CacheRetention;
  readonly webSearchMode?: "live" | "disabled";
}

type ModelProviderDeclarationModelPolicy = "catalog" | "subset";

interface ModelProviderDeclaration {
  readonly provider: ProviderRouteId;
  readonly protocol: ProtocolId;
  readonly authRef: string;
  readonly source?: "pi_ai_builtin" | "pi_ai_declared";
  readonly catalogProvider?: ProviderRouteId;
  readonly modelPolicy?: ModelProviderDeclarationModelPolicy;
  readonly models?: readonly ModelCatalogModelDeclaration[];
}

interface ProviderRouteDescriptor {
  readonly routeId: ProviderRouteId;
  readonly protocol: ProtocolId;
  readonly compat?: PiAiCompatOverride;
  readonly modelCompat?: Readonly<Record<string, PiAiCompatOverride>>;
  // Identity, endpoint, activation, model policy, and snapshot fields omitted here.
}

validatePiAiCompatOverride(
  protocol: ProtocolId,
  value: Readonly<Record<string, unknown>> | undefined,
): PiAiCompatOverride | undefined;

new ProviderRegistry(options?: { fetch?: typeof globalThis.fetch });
ProviderRegistry.create(config: ProviderTransportConfig, route?: ProviderRouteDescriptor): ModelProvider;
ModelProvider.stream(request: ProviderRequest, options: { signal: AbortSignal }): AsyncIterable<ProviderEvent>;
```

`~/.mycli/models.json` version 2 accepts bounded `compat` objects on a provider declaration and on
individual model declarations. `@mycli/config` stores immutable JSON DTOs; only
`@mycli/providers` validates the exact pi-ai API-specific keys and values.

### 3. Contracts

- Stable provider profiles contain only provider id, display name, default protocol, default
  endpoint, and optional default model. They do not contain protocol, cache, storage, role, strict
  tool, search, image, or reasoning compatibility tables.
- Provider and model discovery lazy-loads pi-ai metadata only on explicit directory/catalog demand.
  Directory DTOs expose identity, supported API, input modality, reasoning levels, limits, and cost,
  but never pi-ai `compat`, auth objects, functions, headers, keys, or duplicated wire facts.
- Model input and reasoning metadata comes from the pinned pi-ai catalog. A complete explicit model
  declaration supplies metadata for an uncatalogued private relay. Hosted search stays a separate
  mycli product capability because the current integration has no first-class hosted-search option.
- A catalog-backed v2 provider follows all matching-protocol pi-ai models by default. Its `models`
  entries are provider-local overrides or complete uncatalogued additions; only the explicit
  `model_policy: "subset"` setting turns them into an allowlist. Legacy flat catalogs retain subset
  semantics so their compatibility behavior does not silently expand.
- Effective compatibility precedence is `pi-ai catalog/detection < route compat < model compat`.
  Route snapshots and Worker RPC carry only validated, deeply frozen override DTOs. Catalog models
  are cloned before merging; declared models otherwise retain pi-ai automatic detection.
- `ProviderRequest` carries the stable mycli `sessionId` and provider-neutral `cacheRetention`.
  `request.cache_retention` defaults to `short`; `MYCLI_CACHE_RETENTION` is its environment override.
  The removed prompt-cache and cache-control booleans may produce deprecation diagnostics but must
  never produce request fields or block provider switching.
- New runtime, Worker, continuation, and storage projections emit only `sessionId` and
  `cacheRetention`. Storage readers may decode the legacy `store`, `promptCacheKey`, and
  `cacheControlEnabled` fields from already durable requests and normalize them without rewriting
  append-only history.
- New requests expose no mycli `store` control. Pi-ai decides whether the selected API/model emits a
  storage field.
- Stable instructions, configured developer instructions, and developer-role canonical context
  items are joined in deterministic order into pi-ai `Context.systemPrompt`. Developer context items
  are not also emitted as timeline messages. Pi-ai selects the supported system/developer wire role
  from model metadata and compat.
- Every call passes request-scoped `apiKey`, cancellation signal, fixed mycli temperature, optional
  reasoning, `maxTokens`, `sessionId`, `cacheRetention`, instrumented `fetch`, and `onResponse`
  through pi-ai `SimpleStreamOptions`. Pi-ai chooses the provider field names and formats.
- Explicit reasoning is admitted from pi-ai's `getSupportedThinkingLevels()` for catalog models.
  Mycli's `ultra` intent maps to pi-ai level `max` with an explicit `thinkingLevelMap.max = "ultra"`.
  Uncatalogued declared models use their configured reasoning metadata.
- `onPayload` is absent for ordinary requests. Its only allowed use is inserting
  `{type: "web_search", external_web_access: true}` into a live OpenAI Responses request. It must not
  change roles, reasoning, temperature, output-token fields, storage, cache, or tool strictness.
- Every pi-ai call sets `maxRetries: 0`. `ProviderAgentLoop` alone owns request/stream retry budgets,
  backoff, partial-output reset, cancellation, diagnostics, recovery events, and exhaustion.
- The adapter normalizes pi-ai text, thinking, tool calls, usage, replay state, and terminal events.
  Attempt evidence is limited to bounded status, safe request id, Retry-After, and transport kind;
  it excludes credentials, relay URLs, headers, prompt/response bodies, response ids, and stacks.
- Replay remains canonical and transport-bound. Early consumers abort the upstream pi-ai iterator
  and call `return()` so a stopped consumer cannot leave a hidden request running.

### 4. Validation & Error Matrix

| Condition | Required result |
| --- | --- |
| Missing resolved API key | `ProviderFailure(code="auth_error")` before transport setup |
| Unknown compat key, invalid value, or cross-API field | Bounded `config_error` before traffic |
| Catalog-backed v2 declaration has `models` and no policy | Merge overrides/additions into the complete matching pi-ai catalog |
| `model_policy="subset"` has no non-empty `models` | Bounded model-catalog configuration error |
| Explicit `pi_ai_declared` route has a catalog model policy | Bounded model-catalog configuration error |
| Legacy flat catalog is decoded | Normalize its grouped declarations to explicit subset semantics |
| Worker route/request/config identities disagree | Reject the Worker command before dispatch |
| Cache retention is unsupported by the selected provider | Pi-ai downgrades or omits wire fields; mycli does not reject |
| Catalog model excludes requested reasoning | `unsupported_capability` before traffic |
| Declared model omits reasoning support | Reasoning remains disabled unless explicitly declared |
| Live hosted search on Responses | Add exactly one native search tool through `onPayload` |
| Live hosted search on another protocol | `unsupported_capability` before traffic |
| Image input on a text-only model | `unsupported_capability` before traffic |
| 408/429/overload/5xx/known transport failure | One retryable canonical failure; no hidden pi-ai retry |
| Auth, quota, context, or invalid caller request | Canonical non-retryable/account failure |
| Caller abort during setup, stream, or cleanup | `interrupted` takes precedence |
| Stream ends without a valid terminal event | Retryable `response_stream_error` |
| Foreign, malformed, inconsistent, or oversized replay | Canonical replay with bounded degradation evidence |

### 5. Good / Base / Bad Cases

- Good: switching one session from an OpenAI relay to DeepSeek preserves `cacheRetention="short"`;
  pi-ai emits only fields supported by the selected model and no old OpenAI cache flag blocks it.
- Good: a private Chat relay sets route `supportsStore=false` and one model overrides it to `true`;
  only that model receives the model override.
- Good: a DeepSeek request supplies one authoritative `Context.systemPrompt`; pi-ai chooses the wire
  role and thinking format.
- Good: upgrading pi-ai adds a matching DeepSeek model to `/model` even when the v2 route contains
  metadata for older models.
- Base: `model_policy="subset"` deliberately exposes only its non-empty declared model set.
- Base: an uncatalogued compatible model uses the configured endpoint and explicit model metadata,
  with pi-ai automatic compat detection where no override exists.
- Bad: infer a catalog subset merely because a v2 provider contains a `models` object.
- Bad: checking provider profile booleans before transport, reconstructing DeepSeek roles in mycli,
  or mutating `store`, `max_tokens`, `reasoning_effort`, cache fields, or strict-tool flags in
  `onPayload`.
- Bad: enabling pi-ai retries, which creates invisible upstream attempts outside runtime budgets.

### 6. Tests Required

- Config tests cover `request.cache_retention`, environment and file precedence, default `short`,
  deprecated cache-key diagnostics, removal of request storage options, and bounded compat JSON.
- Directory tests prove pi-ai metadata supplies modality/reasoning and that wire compat remains
  private. They also prove v2 declarations inherit later catalog models by default, explicit subset
  policy narrows, and legacy flat catalogs remain subsets. Provider tests cover catalog clones,
  declared models, automatic detection, override precedence, immutability, and API-specific rejection.
- Payload tests capture mock Responses, Chat/DeepSeek, and Anthropic requests and prove pi-ai owns
  roles, caching, reasoning, token fields, storage, tools, and replay. Hosted search tests assert the
  hook changes only the Responses tool array.
- Worker tests round-trip dynamic route/model compat and the new request vocabulary, revalidate both
  boundaries, and reject legacy request fields.
- Runtime/storage tests cover stable session identity, provider switching, durable legacy decode,
  retry/recovery events, retry exhaustion, cancellation, and partial-output reset.
- Packed and provider smoke checks use mock endpoints or the configured mycli private relay. They
  must never contact an official OpenAI endpoint or print keys, relay URLs, prompts, responses, or
  response ids.

### 7. Wrong vs Correct

#### Wrong

```typescript
const modelPolicy = declaration.models === undefined
  ? { kind: "catalog" }
  : { kind: "subset", modelIds: declaration.models.map((model) => model.model) };

if (!profile.promptCacheKeyEnabled) throw unsupportedCapability();
payload.role = provider === "deepseek" ? "assistant" : "developer";
payload.store = false;
return streamSimple(model, context, { maxRetries: 2 });
```

#### Correct

```typescript
const modelPolicy = declaration.modelPolicy === "subset"
  ? { kind: "subset", modelIds: requireDeclaredModels(declaration) }
  : { kind: "catalog" };

const provider = new ProviderRegistry().create(resolvedConfig, frozenRouteSnapshot);
for await (const event of provider.stream({
  ...canonicalRequest,
  sessionId,
  cacheRetention,
}, { signal })) {
  publishCanonicalProviderEvent(event);
}
```

Keep provider-neutral intent in mycli, merge validated compat only at provider construction, and let
pi-ai serialize one upstream attempt.
