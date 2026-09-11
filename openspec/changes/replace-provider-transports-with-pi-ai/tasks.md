## 1. Dependency And Parity Baseline

- [x] 1.1 Pin the evaluated `@earendil-works/pi-ai` version in `@mycli/providers` and the root lockfile, using lazy API subpath imports where available.
- [x] 1.2 Add a provider mock HTTP server that can record structured request payloads and emit successful, failed, delayed, truncated, and aborted streams for all three existing protocols.
- [x] 1.3 Convert the current Responses, Chat, DeepSeek, Qwen/compatible, and Anthropic request expectations into shared parity fixtures before changing registry selection.
- [x] 1.4 Add package tests proving pi-ai retries are disabled and one `ModelProvider.stream()` invocation performs at most one upstream request.

## 2. Pi-ai Model And Provider Construction

- [x] 2.1 Expand the provider registry's private construction input to receive the resolved model capabilities and limits required to build a pi-ai model without changing public configuration schemas.
- [x] 2.2 Implement protocol-to-pi-api mapping and immutable per-config model/provider/models construction for Responses, Chat Completions, and Anthropic Messages.
- [x] 2.3 Implement known OpenAI, DeepSeek, Qwen, Anthropic, and generic compatible dialect metadata while keeping mycli endpoint, model, capability, and limit values authoritative.
- [x] 2.4 Add tests for catalogued and uncatalogued models, custom compatible base URLs, image capability, output limits, and missing API-key failures.

## 3. Canonical Context And Payload Mapping

- [x] 3.1 Implement canonical user, assistant, image, tool-call, tool-result, and tool-schema conversion into pi-ai `Context` with structural JSON Schema validation.
- [x] 3.2 Implement version-aware assistant reconstruction hooks so validated replay metadata can enrich canonical history without replacing canonical text or tool calls.
- [x] 3.3 Implement structured `onPayload` adjustments that preserve explicit `store`, prompt-cache key, cache-control, maximum-output, and reasoning values and fail closed on unexpected pi-ai payload shapes.
- [x] 3.4 Preserve OpenAI Responses and default/Qwen/compatible Chat developer authority in payload fixtures, including dynamic timeline context.
- [x] 3.5 Preserve DeepSeek's stable-developer-to-system and dynamic-developer-to-user mapping and Anthropic's developer-to-system mapping in payload fixtures.
- [x] 3.6 Implement per-request reasoning mapping, including distinct `max` and `ultra` wire values, and cover every configured reasoning effort with protocol-specific tests.

## 4. Stream, Usage, And Tool Mapping

- [x] 4.1 Implement the pi-ai assistant event translator for text and thinking deltas, terminal usage, completion, and strict rejection of unsupported or duplicate terminal states.
- [x] 4.2 Implement tool-call buffering and validation, stable canonical provider call IDs, native Responses item-ID replay metadata, and semantic JSON argument serialization.
- [x] 4.3 Define and test protocol-specific canonical usage projections, including cached input, cache write, reasoning, output, and total token accounting where providers report them.
- [x] 4.4 Implement early-consumer-return cleanup with an internal abort controller and upstream iterator closure, and test that late events never cross the canonical boundary.
- [x] 4.5 Test empty responses, length termination, pending/deferred outcomes, malformed tool calls, multiple content blocks, and events after terminal completion.

## 5. Error, Cancellation, And Retry Ownership

- [x] 5.1 Implement an attempt-local instrumented fetch wrapper that captures bounded response status/headers and original transport error identity without recording request headers, credentials, or bodies.
- [x] 5.2 Map pi-ai in-band errors and thrown failures into `ProviderFailure`, preferring captured structured evidence and using bounded textual fallback only when necessary.
- [x] 5.3 Add classification tests for auth, permission, quota, context overflow, invalid request, rate limit, overload, 408/5xx, DNS/socket/fetch failure, timeout, premature close, and truncated stream.
- [x] 5.4 Verify bounded Retry-After propagation, request-ID sanitization, caller-abort precedence, and interruption during provider setup, streaming, and iterator teardown.
- [x] 5.5 Run existing `ProviderAgentLoop` retry and recovery tests unchanged against a pi-ai-backed failure source, including request retry, post-output stream reset, exhaustion, and abortable backoff.

## 6. Replay State And Old-Session Compatibility

- [x] 6.1 Define a bounded, versioned pi-ai replay envelope containing only validated response identity, block layout, native signatures, and non-canonical reasoning content needed for replay.
- [x] 6.2 Implement new replay serialization and reconstruction with provider/model/content consistency checks and the existing one-megabyte JSON limit.
- [x] 6.3 Implement legacy Responses replay readers for `responsesNativeItems` and `responsesReasoningItems`, including safe degradation of unsupported hosted-search native items.
- [x] 6.4 Implement legacy Anthropic `thinkingBlocks` and DeepSeek `reasoningContent` readers and translate them into pi-ai history.
- [x] 6.5 Add cross-version session fixtures covering successful resume, tool-result continuation, provider/model handoff, malformed/foreign/oversized state, and canonical fallback diagnostics.

## 7. Hosted Search Compatibility Boundary

- [x] 7.1 Extract the current OpenAI Responses hosted-search request, event, and replay behavior into a narrowly named compatibility transport selected only for `webSearchMode: live`.
- [x] 7.2 Add registry and integration tests proving live hosted search uses the compatibility transport while every disabled-search Responses request uses pi-ai.
- [x] 7.3 Document and test the direct `openai` dependency as exclusive to hosted search, with removal criteria tied to pi-ai payload, lifecycle-event, and replay parity.

## 8. Atomic Registry Cutover And Cleanup

- [x] 8.1 Switch the provider registry, Node connectivity check, and agent worker construction to the pi-ai-backed provider for every non-hosted-search route without adding a long-lived backend feature flag.
- [x] 8.2 Run shared parity fixtures through legacy and pi-ai implementations, record intentional differences, and resolve every unapproved request, event, error, usage, or replay mismatch before cleanup.
- [x] 8.3 Remove the superseded general Responses, Chat, DeepSeek, and Anthropic transport code and obsolete client factory exports while retaining only the isolated hosted-search module.
- [x] 8.4 Remove the direct `@anthropic-ai/sdk` dependency, verify no general provider path imports the direct `openai` SDK, and update focused provider documentation and architecture notes.

## 9. Quality And Release Gates

- [x] 9.1 Run provider and runtime unit/integration tests, including worker RPC, provider continuation, model input timeline, compaction replay accounting, and connectivity checks.
- [x] 9.2 Run `npm run lint`, `npm run typecheck`, `npm run contracts:check`, and the full test suite.
- [x] 9.3 Run packed-CLI and release compatibility smoke checks on Node 22.19 and Node 24, including clean-install startup and lazy loading of each retained protocol.
- [x] 9.4 Measure and record packed/install size and startup impact from pi-ai's transitive SDK set, and resolve unsupported platform imports or material unexplained regressions before release.
- [x] 9.5 Review the final dependency graph, public exports, error redaction, replay bounds, and hosted-search exception against the capability spec before marking the change complete.
