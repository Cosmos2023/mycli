# Native Web Search Visibility

## Root Cause

The Responses request included the native `web_search` tool, but pi-ai 0.84.4 did
not expose its lifecycle in `AssistantMessageEvent`. Mycli's gateway, reducer,
history persistence, and search component already supported those activities.
The provider adapter never emitted them, so the TUI had no search item to render.
The registry test even asserted the absence of the start event.

## Change

- Observe native search records through the existing `eventsource-parser` SSE
  boundary. The SDK's next read acknowledges consumption of the preceding frame.
  Do not collect or separately parse the response.
- Merge bounded search activity with normalized SDK events in order, including
  when a network chunk contains multiple events or the runtime consumes slowly.
- Emit an immediate start and one completion per native call id and attempt.
  Recover completed items from final response output when individual lifecycle
  events are absent. A completion heartbeat without metadata waits for the output
  item or a successful response terminal; an unfinished start is never a completion.
- Reuse the existing runtime, Worker RPC, gateway, and transcript contracts.
  Successful provider steps persist their searches; retries discard transient
  activities from the previous attempt. No local tool execution or tool-result
  record is manufactured for a provider-executed search.
- Stop upstream work on interruption and early consumer return. Provider completion
  still does not wait for remote EOF or cancellation acknowledgement.

The existing compact TUI wording is retained. Multiple queries display as the
first query plus an ellipsis, with bounded query metadata preserved in history.
Historical searches that were never recorded cannot be reconstructed by this fix.

## Verification

Real pi-ai parser tests cover immediate activity without assistant output,
same-chunk event ordering (including adjacent unfinished-message deltas), slow
consumption, split UTF-8, duplicate notifications,
search/open/find actions, terminal-only records, missing metadata, interruption,
early consumer return, no-EOF completion, and ignored post-terminal events.

The backend integration test exercises both in-process and Worker root execution,
with and without a failed first attempt. It checks live TUI text before the server
finishes, one successful search after retries, and matching query metadata and
rendering after closing and restarting the backend.

The final `npm test --ignore-scripts` run passed all 361 test files in 173.5
seconds: 304 unit, 22 contract, 29 integration, 5 platform, and 1 release.
`npm run build`, `npm run lint`, `npm run typecheck`, `npm run contracts:check`,
`npm run config:check`, and `git diff --check` also passed. Provider tests use the
real pinned SDK with synthetic streams or loopback HTTP; no live provider request
was needed.
