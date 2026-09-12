# MCP Authentication, Interaction And Discovery

## 1. Scope and ownership

Applies to MCP OAuth, server-initiated questions, gateway/TUI interaction, canonical discovery
load points and pi-ai serialization. Integrations own MCP/SDK state; app brokers own live
responders; contracts own wire schemas; TUI depends on contracts only. No subagent is needed to
implement or verify these boundaries.

## 2. Interfaces

- `loginMcpOAuth({config, homeDir, signal, fetch, onAuthorization}) -> Promise<void>`
- `McpOAuthStore.load()/update(edit, signal)` uses a configuration-derived identity.
- `McpElicitationHandler(prompt, signal) -> Promise<ElicitResult>`; `prompt.validate()` validates
  against the original schema before a responder is consumed.
- `mcp.elicitation.request` carries a bounded normalized `McpElicitationRequest`.
- `mcp.elicitation.respond` RPC accepts session/request identity, action and optional typed content;
  its notification carries only identity/action. `pending_mcp_elicitation` is live status.
- `CanonicalToolResult.toolDiscoveries` holds bounded identities/fingerprints. `addedToolNames`
  remains private to the pi-ai provider adapter.

## 3. Invariants

OAuth:
- Only explicit login owns browser interaction, loopback state/PKCE and a five-minute deadline.
  Configured bearer auth and OAuth are separate identities. No automatic login during discovery.
- Credentials are private, bounded, atomic and isolated by config identity; never log tokens,
  metadata bodies, verifiers, codes, authorization headers or secret URL paths.
- Token refresh and logout serialize using the private-file lock. Refresh cannot revive credentials
  removed by logout, overwrite a newer rotated token with a stale response, or initiate a browser
  flow. Configuration changes do not inherit old credentials.
- Authentication fetches use the same effective network policy, HTTPS/loopback restriction,
  bounded responses, cancellation and redirect rejection. MCP-specific headers are not forwarded
  to metadata/registration/token endpoints.
- Expiry refresh is independent of MCP session recovery. Only explicit 401 rejection permits one
  refreshed-token retry. Ambiguous disconnect/timeouts never replay tools.

Elicitation:
- Form capabilities include primitive fields and flat enum arrays only. Strictly bound fields,
  text, options and response size. Unsupported forms decline; unsafe URLs never open.
- Admit a server request only when the connection has active calls with one unambiguous owner.
  No guessed ownership, startup/resource interaction or task-augmented elicitation.
- Unique local request identities prevent responses crossing servers/generations. The broker
  checks session identity, pending membership and schema before consuming the responder.
- One visible queue serves approval, ordinary clarification and MCP elicitation. Concurrent hidden
  requests retain their own responders; cancelling a queued request must not clear the visible one.
- Pause the execution deadline while asking; bound user wait separately. Call completion, abort,
  connection close and last UI disconnect cancel responders, including handlers that ignore abort.
- These requests are live, never durable continuations. They do not create a user conversation
  message, approval grant, model call or transcript answer. Full Access never auto-answers.
- TUI preserves underlying enum values, including commas and repeated display labels; field
  navigation uses keyboard and cell-width-aware shared decision layout. Escape cancels MCP input
  without needing to interrupt the entire turn. Decline and cancel remain distinct actions.

Discovery:
- Storage projects discovery metadata only from successful local `tool_search` results.
- Worker transfer, canonical copy, model-input request/timeline validation and compaction
  replacement retain validated fingerprints. Timeline hashes include discovery load points;
  dropping them is a persistence failure, even if ordinary small catalogs still work.
- Provider projection matches id/name/full-definition hash against the current authorized request.
  Removed, changed, failed or spoofed results cannot install historical tool schemas.
- pi-ai owns Responses `additional_tools` or `tool_search_*`, Anthropic references and generic
  fallback. Do not add payload hooks, API-specific runtime types or a second provider transport.
- No remote cache-hit claim follows from deterministic prefix/history tests.

## 4. Failure matrix

| Trigger | Result |
| --- | --- |
| Invalid OAuth config/transport or conflicting bearer identity | Reject before login |
| Invalid callback state/host/path/code | Reject callback without consuming the valid login |
| Login cancelled/failed | Close callback; retain previously committed credentials |
| Invalid/oversized auth store | Bounded `mcp_oauth_store_failed` diagnostic |
| Refresh unavailable | `mcp_oauth_required`; user explicitly logs in |
| Invalid MCP form answer | `invalid_params`; request remains pending |
| Stale/cross-session reply | `clarification_not_pending`; no responder consumed |
| UI absent, owner ambiguous or generation closed | MCP `cancel` |
| Elicitation deadline | Cancel prompt, then resume remaining execution budget |
| Provider lacks native discovery | SDK serializes ordinary function tools |

## 5. Required verification

Use only temporary homes and loopback fixtures. Test state/PKCE, private files, config isolation,
rotated/concurrent refresh, logout, abort during callback bind and redirected/denied networking.
Exercise actual SDK server-to-client form and URL RPCs through the application gateway, including
parallel queueing, correction, delayed user input beyond the tool deadline, interruption and stale
responses. Before submitting another turn, wait for `status.changed.turn_running === false`
after the final message; final text may precede execution-claim cleanup. Assert notifications/history
omit answers. Verify narrow/CJK TUI layout and typed
multi-select values, Worker/reopen discovery replay, and real pi-ai wire payloads for native/fallback.
Finish with full build, test, lint, typecheck, contract/config drift and error inventory checks.
