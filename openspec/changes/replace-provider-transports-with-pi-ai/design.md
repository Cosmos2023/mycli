## Context

`@mycli/providers` currently implements three wire protocols directly: OpenAI Responses, OpenAI-compatible Chat Completions (including DeepSeek-specific behavior), and Anthropic Messages. Those adapters own both request serialization and raw stream parsing, while `@mycli/runtime` already owns the higher-value product behavior: retry budgets, post-output recovery, cancellation, diagnostics, tool execution, session persistence, and canonical runtime events.

`@earendil-works/pi-ai@0.84.2` supports the same protocols behind a common model/context/event API, explicit per-request API-key and cancellation options, request/response hooks, provider compatibility metadata, and replay signatures. The DeepSeek Harness integration demonstrates the intended separation through immutable model snapshots plus dedicated context, stream, replay, and config adapters. Mycli cannot copy it verbatim because mycli persists role-bearing timeline context, does not durably store reasoning as a normal assistant content block, and exposes OpenAI hosted-search lifecycle events that pi-ai does not currently model.

The existing `ModelProvider` interface is already the correct anti-corruption boundary. The migration should replace the transport implementation beneath it instead of letting pi-ai types spread into core or runtime.

## Goals / Non-Goals

**Goals:**

- Route all existing non-hosted-search provider traffic through pi-ai in one production cutover.
- Preserve canonical request, event, error, retry, replay, cancellation, tool, image, and session behavior.
- Preserve current instruction authority and provider-specific role choices, including the existing DeepSeek mapping.
- Keep old persisted sessions resumable and make new replay metadata versioned and bounded.
- Delete the superseded general raw-stream parsers and direct Anthropic SDK dependency after parity gates pass.
- Make a later expansion to pi-ai's wider provider catalog possible without coupling that expansion to this migration.

**Non-Goals:**

- Expanding `ProviderId`, adding Google/OpenRouter/Bedrock routes, or redesigning provider configuration.
- Replacing mycli auth storage with pi-ai credential stores or adding provider OAuth/login flows.
- Moving retry, tool execution, approvals, hosted tools, or session orchestration into pi-ai.
- Changing gateway, TUI, storage, or canonical event schemas.
- Dropping hosted web-search events or replay merely to remove the last legacy path.
- Completing the separate dynamic-tool/provider-tool bridge change.

## Decisions

### 1. Keep `ModelProvider` as the only runtime-facing seam

The provider registry will continue returning `ModelProvider`. A new pi-ai-backed implementation will be split into small modules for model construction, canonical context conversion, role-sensitive payload adjustment, stream mapping, replay projection, and error normalization. Pi-ai types will not cross the `@mycli/providers` package boundary.

This follows the DeepSeek Harness adapter shape while preserving mycli's established dependency direction. Replacing runtime types with pi-ai messages was rejected because it would couple persistence, worker RPC, tests, and UI protocols to a third-party event model.

### 2. Build an immutable pi-ai snapshot from each resolved mycli config

`ProviderRegistry.create(config)` will construct an immutable pi-ai model/provider/models collection for the resolved route. The model will use the existing provider ID, protocol-to-API mapping, configured base URL, selected model ID, image capability, context limit, and output limit. A request captures that snapshot before stream consumption; configuration changes produce a new adapter instead of mutating an in-flight collection.

The protocol mapping is:

| Mycli protocol | Pi-ai API |
|---|---|
| `responses` | `openai-responses` |
| `chat_completions` | `openai-completions` |
| `anthropic_messages` | `anthropic-messages` |

Mycli's resolved configuration remains authoritative. Pi-ai catalog metadata may contribute known dialect compatibility fields, but it cannot override configured endpoint, model identity, capability limits, or explicit settings, and an uncatalogued compatible model remains valid. Adopting pi-ai's catalog as the product source of truth was rejected because it would turn the transport change into a user configuration and surface migration.

### 3. Continue using mycli auth and pass credentials per request

The registry will keep failing loudly when the selected route has no resolved API key. The adapter will pass that key through pi-ai's request-level `apiKey` option, which has priority over ambient pi-ai auth. Pi-ai credential stores and OAuth flows are not activated by this change.

This avoids two sources of credential truth and preserves existing `authRef`, private-file, management command, readiness, and redaction behavior.

### 4. Use pi-ai context conversion with a narrow role-sensitive payload layer

Canonical user, assistant, tool-call, tool-result, image, and tool-schema content will be converted into pi-ai `Context`. Provider replay metadata will reconstruct native pi-ai assistant blocks only when it validates against canonical content.

Pi-ai history cannot directly express developer messages, so the adapter will also own a structured payload adjustment for role-sensitive instruction items and explicit mycli request controls. The adjustment will operate on parsed request objects through `onPayload`; it will not perform string replacement. Provider payload shape checks will fail closed if a pinned pi-ai version changes unexpectedly.

The authority matrix remains:

| Route | Stable instructions | Dynamic developer context |
|---|---|---|
| OpenAI Responses | system/developer authority | developer authority |
| Default/Qwen/compatible Chat | system plus developer authority | developer or existing compatible fallback |
| DeepSeek Chat | merged system prompt | user-role suffix |
| Anthropic Messages | system prompt | system prompt |

Fields such as `store`, exact prompt-cache key, cache control, hosted-search selection, and `ultra` reasoning will also be restored in this structured layer when pi-ai's simple options do not express the existing mycli value exactly. For `ultra`, the adapter will use a per-request cloned model/thinking map so pi-ai's internal `max` level produces the `ultra` wire spelling without changing normal `max` requests.

Flattening every developer item into a user message, as the generic DeepSeek Harness history converter does, was rejected for OpenAI-style routes because mycli developer context contains permission and runtime policy. Rebuilding every provider request body wholesale was also rejected because it would retain most of the bespoke provider implementation; the compatibility layer is limited to authority and explicit-value corrections with fixture coverage.

### 5. Translate the closed pi-ai event union into canonical events

The stream mapper will ignore start/end framing events, forward text and thinking deltas, collect tool calls, map terminal usage into the existing numeric usage vocabulary, emit one bounded provider replay state, and emit one completion only for supported successful terminal reasons.

OpenAI Responses tool IDs produced by pi-ai may combine the provider call ID with an output item ID. Mycli will keep the externally visible provider call ID stable and store the output item identity in replay metadata so a later pi-ai history reconstruction can recover the combined native identity. Tool argument objects will be serialized as valid JSON after terminal validation.

Pi-ai `error` and `aborted` events will be raised as canonical failures rather than returned as successful stream results. Pending, deferred, empty successful responses, invalid tool calls, and unsupported truncation will also fail explicitly. Early consumer return will abort an internal controller and close the upstream iterator, matching the cancellation discipline used by the DeepSeek Harness adapter.

### 6. Keep retry ownership exclusively in runtime

Every pi-ai stream call will set `maxRetries: 0`. The adapter will never call `retryAssistantCall`. The existing `ProviderAgentLoop` remains the only component allowed to schedule another request attempt, including failures after partial output.

Each request will pass an attempt-local instrumented `fetch` wrapper to pi-ai. The wrapper records safe response status and headers before the SDK processes HTTP failures and retains the original transport error identity before pi-ai flattens it into `errorMessage`; it never records request headers, credentials, or unbounded bodies. A small, bounded textual classifier remains only for failures produced above or outside the injectable fetch path, including provider-specific premature-close and truncated-stream messages. Captured transport identity, HTTP metadata, and structured provider tokens take precedence over text matching. Caller abort always wins.

Enabling pi-ai retries was rejected because nested retry budgets hide attempts from persisted diagnostics, multiply request counts, and cannot implement mycli's post-output reset semantics.

### 7. Add a versioned replay envelope with legacy readers

New replay state will use a named kind and version and store only metadata required for provider-native replay: API/provider/model identity, response ID, block ordering, native text/thinking/tool signatures, and reasoning content that is not otherwise durable in mycli. Canonical assistant text and tool calls remain authoritative. The existing one-megabyte JSON bound continues to apply.

The reader will accept the new envelope and the three legacy families:

- Responses `responsesNativeItems` / `responsesReasoningItems`
- Anthropic `thinkingBlocks`
- DeepSeek `reasoningContent`

Legacy or new metadata is used only when provider identity and canonical content agree. Malformed, foreign, inconsistent, or unsupported metadata degrades to canonical history with a safe diagnostic. Failing an entire session because optional native metadata is unusable was rejected.

### 8. Retain one hosted-search compatibility path

Pi-ai 0.84.2 can inject an OpenAI `web_search` tool through `onPayload`, but its public assistant event union and Responses parser do not expose search-started/search-completed events or durable web-search call replay. Therefore `webSearchMode: live` will continue to use a renamed, narrowed Responses hosted-search transport. All other Responses traffic uses pi-ai.

The compatibility module owns only hosted-search request and event behavior and is selected explicitly by the registry. Its direct `openai` dependency remains documented as exclusive to that path. Removal requires a pinned pi-ai release to provide payload, lifecycle event, and replay parity, followed by the same fixtures. Silently losing search activity or replay was rejected.

### 9. Cut over atomically after side-by-side parity tests

Development will keep legacy and pi-ai implementations side by side only long enough to run common request/stream fixtures and mock HTTP integration tests. Production selection changes once, for every non-hosted-search route. After the gate passes, general legacy implementations and their tests are removed rather than retaining a long-lived runtime feature flag.

The dependency is pinned to the evaluated exact version. A future version bump must rerun provider parity and packed-release checks because pi-ai event, payload, catalog, and transitive SDK behavior are part of this adapter's compatibility surface.

## Risks / Trade-offs

- [Risk] Pi-ai request conversion changes provider payload roles or explicit fields. -> Mitigation: structured `onPayload` corrections, fail-closed shape validation, and payload fixtures for each existing route.
- [Risk] Pi-ai flattens transport error causes and weakens retry classification. -> Mitigation: capture response metadata, keep a bounded fallback classifier, and test every canonical error category and abort race.
- [Risk] Pi-ai usage accounting names and cached-token semantics differ from current provider usage. -> Mitigation: define protocol-specific canonical numeric projections and freeze them in fixtures consumed by runtime tests.
- [Risk] New replay metadata cannot resume sessions written by old adapters. -> Mitigation: legacy readers, canonical-source validation, degradation diagnostics, and version-crossing session fixtures.
- [Risk] Pi-ai changes tool-call IDs or JSON formatting. -> Mitigation: retain stable canonical call IDs, keep native item identity only in replay state, and compare semantic arguments rather than provider whitespace.
- [Risk] The pi-ai package and transitive provider SDKs increase install size or startup cost. -> Mitigation: use lazy API subpath imports, measure packed install/startup on Node 22.19 and 24, and fail the release gate on unsupported platform imports.
- [Risk] The hosted-search exception delays removal of the direct OpenAI SDK. -> Mitigation: isolate it in one module with an explicit selection condition and removal tests; do not let general Responses traffic fall back to it.
- [Risk] A simultaneous provider catalog or auth migration makes rollback unsafe. -> Mitigation: keep user configuration, credentials, model selection, and canonical schemas unchanged in this change.

## Migration Plan

1. Pin pi-ai and add mock-server/parity fixtures while legacy transports remain the production path.
2. Implement immutable model construction, context/payload conversion, stream/error mapping, and versioned replay behind the existing `ModelProvider` interface.
3. Add legacy replay readers and cross-version session tests before changing registry selection.
4. Extract and rename the current Responses hosted-search behavior into its explicit compatibility module.
5. Run payload and event parity for Responses, Chat, DeepSeek, Qwen/compatible, and Anthropic, followed by provider/runtime tests, lint, typecheck, contracts, packed CLI, and Node/platform release checks.
6. Switch all non-hosted-search registry routes to pi-ai in one change and remove superseded general adapters plus the direct Anthropic SDK.
7. Retain the hosted-search module and direct OpenAI SDK only until upstream parity exists; remove both in a follow-up change once its exit criteria pass.

Rollback uses the last release or reverts the registry cutover and dependency change. No persisted canonical schema is rewritten, and new replay metadata is optional, so rollback readers can ignore it while canonical history remains usable.

## Open Questions

- Should the first implementation pin exactly `0.84.2`, matching the inspected DeepSeek Harness integration, or re-evaluate the newest pi-ai release immediately before implementation and pin that version after parity?
- Should replay degradation be exposed only through existing provider diagnostics, or also receive a dedicated bounded runtime diagnostic counter?
- Is the temporary hosted-search compatibility exception acceptable for the initial cutover, or should implementation wait for upstream pi-ai hosted-tool support so the direct OpenAI SDK can be removed in the same release?
