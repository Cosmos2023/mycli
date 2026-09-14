# Provider Transport Contract

## Versioned Failure Context

`ProviderFailure` owns a stable occurrence ID and optional typed reason, scope,
source, outcome and bounded causes. Structured auth/status/code/transport evidence
is classified before conversion; public summaries come from the contracts error
catalog. Preserve existing precedence and request/stream retry budgets.

Worker protocol 2 transfers optional version-1 context. Enriched attempt records
use the shared `providerAttemptId()` identity. Cleanup failures retain the most
recent committed concrete attempt cause. An unclassified local error is not
automatically retryable. Capability corrections and possible tool effects never
authorize whole-turn replay. See `error-handling.md` for the shared contract.

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
ModelProvider.stream(request: ProviderRequest, options: ProviderStreamOptions): AsyncIterable<ProviderEvent>;

interface ProviderStreamOptions {
  readonly signal: AbortSignal;
  readonly onPhase?: (phase: "response_terminal" | "sdk_terminal") => void;
}
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
- Bootstrap, session preference activation, and trust reload do not capture the complete model
  directory. Login rows use profiles, declarations, and shared product activation. Native readiness
  loads only the selected SDK auth adapter; typed lazy module wiring is checked against the pinned
  SDK directory. Environment/OAuth/reference semantics remain SDK-owned. Full route/model capture
  runs on execution or explicit discovery/connectivity demand. Fresh-process compiled tests check
  both deferred imports and existing credentials, in addition to packed startup smoke.
- Model input and reasoning metadata comes from the pinned pi-ai catalog. A complete explicit model
  declaration supplies metadata for an uncatalogued private relay. Hosted search stays a separate
  mycli product capability because the current integration has no first-class hosted-search option.
- A catalog-backed v2 provider follows all matching-protocol pi-ai models by default. Its `models`
  entries are provider-local overrides or complete uncatalogued additions; only the explicit
  `model_policy: "subset"` setting turns them into an allowlist. Legacy flat catalogs retain subset
  semantics so their compatibility behavior does not silently expand.
- Product activation includes the serviceable pi-ai `qwen-token-plan`, `qwen-token-plan-cn`, and
  `qwen-token-plan-individual` routes without requiring user declarations. They retain experimental
  support and pi-ai-owned models, semantic metadata, protocol, and endpoint. Explicit declarations
  take precedence over those defaults, including auth references and subset policies. Other new
  SDK routes remain dormant; ordinary DashScope `qwen` retains its independent route and fallback.
  Activation never writes `models.json`, shares credentials implicitly, or maintains a model-ID list.
- An SDK output ceiling that covers the whole context window is a per-request maximum, not a
  fixed output reservation. Model selection must retain a positive context-bounded input budget;
  pi-ai fits the output to the remaining context for each request. Do not reject such catalog
  models by subtracting their entire context as reserved output.
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
- `onPayload` is absent for ordinary requests. Its allowed uses are inserting
  `{type: "web_search", external_web_access: true}` into a live OpenAI Responses request and
  preserving canonical image detail, which pi-ai 0.84.4 does not yet expose. Image transforms
  touch only image detail fields, preserve untagged images and occurrence order, and are rebuilt
  for each request. Original detail is admitted only for explicitly marked Responses models in
  the existing model catalog; unknown models and other protocols use high. These product image
  capability markers do not filter pi-ai model discovery or change transport ownership.
  Hooks must not change roles, reasoning, temperature, output-token fields, storage, cache, or
  tool strictness. Remove the image shim when pi-ai supports the same semantic field natively.
- Live Responses hosted-search activity is observed at the existing parsed SSE boundary because
  pi-ai's normalized assistant stream does not expose native search items. Observe each frame when
  the SDK requests its next frame, acknowledging consumption, not when a network chunk is parsed.
  Merge the activity with SDK events promptly so chunk coalescing and slow consumers cannot move
  a search ahead of preceding assistant text, including deltas in an unfinished message.
- Await SSE consumption acknowledgements and SDK delivery on downstream drain. The merge queue
  retains at most 64 events and 8 MiB of serialized UTF-8 payloads; count or byte overflow raises
  `response_stream_error` with a bounded public detail, without silent drops or automatic replay.
  Keep only text/thinking deltas, native search events, and terminal SDK messages in this queue;
  mutable intermediate `partial` snapshots and ignored SDK bookkeeping are not retained.
  Cancellation and early return release both readers and blocked drain waiters. A pending SDK
  read/return that ignores cancellation must not hang the caller. Transport abort remains owned
  by the provider. Slow-reader tests cover upstream pull counts, interleaving, overflow, and cleanup.
- Emit one `web_search_started` and at most one `web_search_completed` per native call id and
  provider attempt. Completion comes from a completed output item, including terminal output
  fallback. A completion heartbeat without action metadata waits for the output item or a successful
  response terminal; unfinished searches and failed responses cannot fabricate completed calls.
- Normalize only the existing `search`, `open_page`, `find_in_page`, and `other` action DTOs. Retain
  at most 4,096 search identities, 32 queries per action, and 2,048 characters per detail; reject
  missing or overlong call identities. Do not retain raw SSE records in diagnostics or replay state.
- Native search is provider-executed activity, not a local function call requiring a tool result.
  Existing runtime events, Worker RPC, successful-step display persistence, gateway item lifecycle,
  and TUI projection own its downstream handling. Retries discard the previous attempt's transient
  searches; successful searches remain visible after session reload. Early consumer return and
  cancellation stop both the SDK event pump and the underlying request.
- Every pi-ai call sets `maxRetries: 0`. `ProviderAgentLoop` alone owns request/stream retry budgets,
  backoff, partial-output reset, cancellation, diagnostics, recovery events, and exhaustion.
- Optional phase observers report parsed transport terminals and SDK terminal events for local
  timing only. Observer failures are contained, missing observations remain absent, and no phase
  callback grants completion authority. See the completion-tail contract in `logging-guidelines.md`.
- Compaction is also executed through the shared provider step executor. Its checkpoint-owned
  journal stores common attempt updates and reported usage without polluting the ordinary
  turn request ledger or emitting summary deltas as assistant output. Progress publication is
  outside the persistence callback, so a notification failure is not mislabeled as an attempt
  commit failure. Auth/config failures do not retry; cancellation stops the next dispatch.
- `request.request_max_retries_by_provider` and `request.stream_max_retries_by_provider` are
  independent maps from mycli route id to integer budgets in `[0, 100]`, with at most 128 entries
  each. Missing routes use the resolved global budgets (defaults 4 and 5). The winning config layer
  replaces the complete table, including explicit empty tables; project trust applies before reads.
  Config snapshots and policy resolution copy and freeze these values. Both step executors consume
  one effective scalar policy for the committed request's route; Worker execution carries those
  resolved numbers rather than re-reading configuration. A supplied committed `retryPolicy` wins
  over current configuration. Each step spends request and stream budgets independently without
  resetting either counter during recovery, bounding dispatches by `1 + request + stream`.
  Retry-After changes the cancellable delay only. Context compaction commits a new request and
  starts new budgets; an ordinary retry retains the same logical request, route, and model.
- The adapter normalizes pi-ai text, thinking, tool calls, usage, replay state, and terminal events.
  Attempt evidence is limited to bounded status, safe request id, Retry-After, transport kind, and a
  sanitized canonical remote stream failure (provider code/type and public reason);
  it excludes credentials, relay URLs, headers, prompt/response bodies, response ids, and stacks.
- Pi-ai `done` and `error` events end the adapter's read loop. Do not request another iterator
  item to confirm exhaustion after a terminal event. Validate the final message before publishing
  canonical tools, usage, replay, and completion; abort and close the iterator during cleanup.
- Successful supported SSE bodies pass through `sse-stream-boundary.ts` before pi-ai. It uses
  `eventsource-parser` to forward complete SSE events through the first `response.completed`,
  `response.incomplete`, `response.failed`, or `error` event, then closes the SDK-facing body and
  cancels the source without waiting for remote EOF or cancellation acknowledgement. It preserves
  event data and ordering, including split UTF-8 and multiline data, but normalizes SSE framing and
  removes the original Content-Length. Non-SSE/HTTP error bodies stay byte-exact.
  Pi-ai continues to own content, tool, usage, and terminal-status interpretation. Malformed JSON
  or completed/incomplete envelopes without a response id fail with a bounded stream error.
- Chat Completions keeps reading after `finish_reason` to retain late usage. It ends on `[DONE]`
  or clean EOF after a finish reason; an explicit pi-ai `supportsFinishReason=false` override also
  accepts a clean EOF after a choice chunk. An EOF-flushed `[DONE]` is harmless after that completion
  evidence, but incomplete JSON/tool event data is a retryable stream failure. Anthropic ends on
  `message_stop`; other EOF is a retryable stream failure. These rules do not depend on SDK error
  message spelling. Each parser buffers at most 32 Mi characters, and cancellation releases its
  source without recording a synthetic read failure.
- A provider response completion is not a turn completion. Runtime still owns subsequent model
  steps, tool execution, stop hooks, and terminal persistence. The TUI stops on the terminal turn
  event, never on the last text delta or an individual output-item completion.
- At each SSE boundary, capture the first `error` (flat or nested), named `event:error`, or Responses `response.failed`
  error object before the SDK formats it. Instrumented fetch immediately classifies it into a
  sanitized `ProviderFailure`; attempt evidence must not retain raw error envelopes or response bodies.
  Caller cancellation takes precedence, then this structured failure, regardless of the SDK's
  terminal/error text. Later terminal events must not overwrite it or delay completion.
- `pi-ai-failure.ts` retains SDK envelope decoding as a compatibility fallback when no structured
  stream failure was observed. Fatal code/type categories always win over generic remote retries,
  including missing/null/invalid codes and type-only errors. An identified remote failure with no
  usable error fields remains retryable without publishing SDK placeholders. Plain HTTP error
  reasons are allowed, but raw/malformed JSON, HTML, and SDK empty-body boilerplate are not.
- Instrumented fetch observes both fetch rejection and response-body read rejection. Its observer
  forwards bytes from the selected body with pull-driven backpressure and cancellation, without
  teeing or collecting whole responses. Cancellation of a pending read must not record a synthetic
  closed-controller error. Caller cancellation wins; an internal transport abort is not a user interrupt.
- A thrown local exception is not a remote SDK terminal error envelope. Do not decode arbitrary
  local `Error.message` as remote JSON or make all generic provider errors retryable.
- Replay remains canonical and transport-bound. Early consumers abort the upstream pi-ai iterator
  and call `return()` so a stopped consumer cannot leave a hidden request running.
- A projected tool result uses the same native ID as its projected assistant tool call (for
  example `call-id|fc-item-id`). Canonical stored IDs remain unchanged. Mixing canonical result
  IDs with native assistant IDs makes pi-ai synthesize duplicate missing-result messages.

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
| Native search runs before any assistant text | Publish `web_search_started` immediately |
| Duplicate native lifecycle notifications or terminal output fallback | One completed search record per call and attempt |
| Search attempt fails and is retried | Remove transient searches; persist only the successful attempt's calls |
| Session restarts after a successful search | Restore its completed TUI row and bounded query metadata |
| Live hosted search on another protocol | `unsupported_capability` before traffic |
| Image input on a text-only model | `unsupported_capability` before traffic |
| 408/429/overload/5xx/known transport failure | One retryable canonical failure; no hidden pi-ai retry |
| Auth, quota, context, or invalid caller request | Canonical non-retryable/account failure |
| Caller abort during setup, stream, or cleanup | `interrupted` takes precedence |
| Valid Responses completion while HTTP body remains open | Complete without EOF; cancel the source and retain final tools, usage, and replay |
| Events follow the first terminal event, including in one network chunk | Ignore the trailing events; preserve the first terminal outcome |
| Malformed JSON, invalid completion envelope, or EOF within a terminal frame | Retryable `response_stream_error`; no canonical completion or tool calls |
| Stream ends without a valid terminal event | Retryable `response_stream_error` |
| HTTP 200 followed by `response.failed` / SSE `error` | Decode remote code and safe reason; fatal category or bounded stream retry |
| Nested SSE `error` with `stream_read_error` followed by `response.failed` | Retain the first error's code/type/detail; retry even after reasoning-only output |
| `response.failed` supplies only a fatal `type` | Preserve the fatal classification; never retry based on missing code |
| HTTP 502 with plain `upstream request failed` | Retryable provider failure retaining the safe reason and Retry-After |
| Body read fails with `UND_ERR_SOCKET`, body timeout, or reset | Retain transport identity; post-output disconnect uses stream retry |
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
- Real pinned pi-ai fixture tests cover HTTP/SSE upstream failures, fatal code precedence without
  an HTTP error status, flat/nested errors, absent or malformed code fields, type-only fatal errors,
  consecutive terminal events, body-read causes, redaction, and private local exceptions even after
  HTTP success. Include reasoning-only partial output and SDK terminal translation changes. Worker
  integration must prove a prior tool executes once, each failed attempt retains safe trace fields,
  and terminal diagnostics/detail survive SQLite reopen/resume. TUI render tests must show the
  same safe detail for live and resumed errors at narrow and wide terminal widths.
- Completion fixtures leave the source open after its terminal event and may leave cancellation
  acknowledgement pending. Cover late events in the same chunk, byte-split UTF-8/CRLF/multiline SSE,
  incomplete terminal frames, final tool arguments and usage, malformed envelopes, failed/incomplete
  statuses, cancellation during a pending read, and an SDK iterator that stalls after `done`/`error`.
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

### Durable Recovery and Native Auth

- Supported native APIs are the closed `ProviderNativeApi` union: Completions, Responses,
  Anthropic Messages, and Azure Responses. Canonical protocols stay at the existing three values.
  Native snapshots bind provider, API, model source/id, endpoint hash, and Azure version/deployment;
  Worker request validation, request hashing, SQLite reconstruction, and replay preserve them.
- `instrumented-fetch.ts` observes supported SSE protocols and bounded unsuccessful HTTP JSON
  bodies before SDK formatting. Keep fatal auth, permission, quota, invalid-request, and context
  precedence; cancellation and the first terminal response are authoritative. Retain late Chat
  usage, finish-reason compatibility, and backpressure. Never persist raw error bodies.
- SDK retries are disabled. Effective per-provider request and stream budgets are frozen per
  logical request and additive. Scheduling charges a retry budget before waiting. One timestamp
  establishes scheduling and its deadline; commit latency consumes the remaining wait.
- The v13 additive migration adds immutable retry chains and attempt events without replaying v12
  DDL. Coordinator commits precede Worker dispatch acknowledgements. Started attempts interrupted
  by a crash become unknown, scheduled attempts become cancelled, and loading history dispatches
  nothing. Only an explicitly restored scheduled operation may continue its existing budget.
  The current session lease owns writes after approval/clarification resume; a stale turn owner
  cannot override that lease. Direct store callers without a session lease retain the turn-owner
  check. Do not treat an unowned paused turn as authority for arbitrary writers.
- SQLite attempt timestamps use canonical UTC `Z` format, independently of the legacy store clock
  formatter. Ledger events stay out of model context. `provider.attempts.load` uses a scoped
  `beforeEventId` cursor; resumed TUI history must backfill records outside the latest 200 events.
- Attempt placement uses the readable item's optional `turn_id` as its primary boundary. Storage
  projection, snapshot sanitization, gateway conversion, and TUI normalization preserve this field.
  Order attempts by observation time within their turn, after its initial user row and before its
  terminal notice. Recovered interruption timestamps may postdate newer turns and must not pull
  their attempts into an earlier turn. Legacy pages without ownership use user-message boundaries
  before comparing timestamps. Test partial pages and local user rows without timestamps.
- A cancelled provider attempt is not necessarily a cancelled retry. If the first attempt is
  interrupted before any request/stream retry budget is charged, the TUI shows the canonical turn
  interruption warning without an extra retry block. Keep its ledger records available in state.
  Use attempt number and cumulative retry counters so live, resumed, and partial history agree.
  Only suppress a cancellation whose failure code is `interrupted`; preserved provider failures
  and unknown outcomes remain visible even on attempt 1. Label a visible cancelled
  record `Retry cancelled` only when its attempt number exceeds 1 or a retry counter is nonzero;
  otherwise use `Request cancelled`. Test both summary and expanded labels, ordinary interruption,
  and cancellation after either request or stream retry scheduling.
- The config credential store privately retains API-key/env and OAuth grants. OAuth refresh is
  serialized by the existing private-file writer; logout uses the same lock. Empty OAuth refresh
  strings are valid for nonexpiring providers. No secret enters Worker diagnostics, public auth
  status, native snapshots, gateway events, model history, or trace output.
- Native auth resolves against captured provider environment, selected credential reference, and
  the SDK provider's auth/model filter. Preserve explicit missing-reference failures, OAuth endpoint
  identity, and terminal cancellation. Do not replace all native auth with a request API key.
- `builtin-provider-inventory.test.ts` gates the pinned SDK version and generated provider/API/auth
  disposition report. `pi-ai-builtin-routes.test.ts` exercises each enabled builtin route through
  its actual adapter. Unsupported Google, Vertex, Bedrock, Mistral, Codex, and Radius native paths
  remain disabled until equivalent observation and auth evidence exists. Live status is separate
  from mocked SDK coverage; `smoke:providers:native` requires `--live` to send a request.
