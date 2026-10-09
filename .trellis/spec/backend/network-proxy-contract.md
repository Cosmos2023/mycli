# Network Proxy Contract

## Scope

Applies to `tools/network/`, Shell process resources, sandbox proxy endpoints, and
changes to domain-constrained execution. The runtime supplies policy; the proxy
can request a live one-operation decision inside that policy but never modifies the run snapshot.

## Interfaces

- `startNetworkProxy({ domains, policy?, sourceEnv?, lookup?, connect?, originCa?, upstreamCa? }) -> Promise<NetworkProxyLease>`.
- `NetworkProxyLease` exposes its loopback `port`, frozen proxy `env`, and
  frozen proxy policy, optional public-bundle `readableRoots`, and idempotent asynchronous `close()`.
- `prepareSandboxedProcess(argv, profile, probes?, networkProxy?)` accepts a
  host-owned numeric endpoint. It never derives authority from shell environment.
- `ShellStartRequest.processResource?: ShellProcessResource` transfers process
  infrastructure ownership to `ShellSessionManager.start` on entry, including
  failure paths. `close()` must be idempotent and resolve after revocation.

## Policy And Transport

- Copy the domain list before async Shell preparation; normalize/freeze it when
  the proxy is created. Preserve the established exact and `*.` matching rules.
- macOS permits only `(remote tcp "localhost:<owned-port>")` in its restricted
  network policy. Never add unrestricted egress, DNS, inbound, UDP, or Unix socket
  rules to make a proxy client work. Windows uses a separate proxy identity with
  a persistent per-account WFP block and one dynamic per-logon exception for the
  owned IPv4 loopback TCP port. Linux rejects enabled non-empty domain lists.
- Windows installs each proxy exception before resuming its suspended runner. It
  matches the actual logon SID, protocol, address and port, never a mutable global
  account-wide port list. Dynamic WFP sessions revoke exceptions on host exit.
  Ordinary firewall denies still apply; do not use a hard permit. The host owner
  alone receives filter-add rights to its account's sublayer; sandbox identities
  receive no WFP management permissions. Account-derived keys prevent another
  user's setup from replacing live filters.
- Legacy Windows rejects custom process read roots and unrestricted filesystem
  policies combined with constrained networking; PSEC supports them. It must not
  narrow or broaden these policies silently.
- Empty lists and disabled network policy stay offline. Raw process launches
  without a proxy stay offline when the policy contains domains.
- Proxy listeners bind only IPv4 loopback on ephemeral ports. Each Shell process
  has a separate immutable lease; there is no mutable global domain policy.
- Support HTTP absolute-form requests on port 80 and CONNECT authority-form
  requests on port 443. Require a single matching Host header; reject credentials,
  ambiguous targets, other schemes/ports, Expect, and protocol upgrades.
- HTTP forwarding strips hop-by-hop headers, Connection-nominated headers, and
  proxy credentials; it reconstructs Host from the checked target. Ordinary
  resource authentication is forwarded only to that target.
- Reuse `network/public-target.ts` for local/private/reserved address rejection.
  Reject a DNS set containing any non-public address. Dial only the numeric
  checked result, never repeat hostname resolution in the transport.
- Apply policy on each new request/CONNECT, including client-followed redirects.
  The proxy does not follow redirects itself. No requests are silently retried.
- Bound headers (16 KiB), accepted connections (64), requests per connection (32),
  resolution/connect wait (10 seconds), and socket idle time (30 seconds).
- The shared TCP listener injects sockets into non-listening HTTP parsers. Node starts its own
  header/request deadline checker on `listening`, so do not rely on those options alone: enforce
  absolute initial/inner-header (10 seconds) and request-body (30 seconds) deadlines explicitly.
  A slow continuous stream must not extend a setup deadline.
- Diagnostics contain fixed structural messages, never raw URLs, credentials,
  request bodies, or exception stacks. Source environment proxy settings cannot
  select the sandbox endpoint or override the runtime proxy environment.

## Ownership And Shutdown

- Shell invocation completion/yield is distinct from process completion. Proxy
  ownership survives yield and background operation.
- Exit closes the lease before manager completion waiters resolve. Stop revokes
  the lease before process cleanup, even if termination proves inconclusive.
- Startup failure, capacity/validation rejection, cancellation during setup, and
  shutdown during an in-flight spawn release the lease. Manager shutdown awaits
  in-flight process/resource cleanup.
- Closing a proxy stops its listener, destroys client and upstream sockets,
  aborts pending lookups, and prevents late resolution from opening connections.
- Full filesystem access or a model escalation argument cannot erase a network
  bound. Only a host-approved explicit override can select a different policy;
  the runtime remains responsible for enforcing managed upper bounds.

## Limits

Windows PSEC selects a per-process endpoint policy with default-deny egress and one allow
for the owned `127.0.0.1/32` TCP port. `MXC-Loopback` alone is not authorization for all host
loopback ports. Keep foreign proxy ports, IPv6 and UDP denied in default proxy mode. Explicit
`allowLocalBinding=true` broadens only proxied loopback egress to 127.0.0.0/8 and ::1, all ports
and protocols. This permits host services outside the domain proxy and must survive child policy
narrowing. Offline policy still wins. Local bind and outbound loopback are verified; host ingress
is blocked by the Windows Firewall `AppContainerLoopback` filter and is not an accepted capability.
mycli matches Codex's no-elevation design: do not add a per-identity loopback exemption or LAN
capability to bypass it.
Offline PSEC has
no network capabilities. The legacy account/WFP backend retains its existing contract above.
UDP tests require an acknowledged datagram and check receiver counts: a successful unconnected
send can be silently dropped by Windows and is not proof of a policy failure or network access.

Full-mode CONNECT is an opaque TCP tunnel. It checks the authority and destination address,
not tunneled TLS SNI, encrypted HTTP Host, or application content. Allowed remote
services may themselves relay traffic. This is destination filtering, not TLS
inspection or a defense against a hostile unsandboxed host process. Seatbelt's
loopback filter is per TCP port, not per listening process identity.

## Optional Managed Proxy Policy

- `networkProxy: { mode: "full" | "limited", enableSocks5, allowUpstreamProxy }` is frozen
  authority in managed config, run snapshots, child snapshots and SQLite restore. A missing object
  retains legacy HTTP/CONNECT behavior. An explicit object defaults to full/SOCKS enabled/upstream disabled.
  Limited wins during intersection; transports cannot be enabled by a child or recovered policy.
  Approved filesystem escalation retains proxy mode, network state and domain bounds.
- SOCKS5 shares the owned TCP listener, requires no authentication, supports CONNECT IPv4/IPv6/domain
  targets and rejects BIND/UDP. Full mode supports arbitrary public TCP ports. Limited requires TLS
  HTTP/1.1 on 443. Apply domain authorization and public-address pinning to every destination.
- Upstream HTTP(S) is opt-in from host environment only. Never read credentials from child/agent
  snapshot environment or MCP server config. Shell composition supplies the live host proxy environment
  separately from inherited agent environment. Captured settings are immutable per lease; no direct
  retry after upstream failure. CONNECT uses the numeric validated destination even for port 80.
  HTTPS upstream verification is mandatory. NO_PROXY cannot bypass runtime proxy settings.
- Limited mode decrypts TLS, checks GET/HEAD/OPTIONS on every request, binds Host and SNI to the
  tunnel destination, and independently verifies upstream origin TLS. Reject nested CONNECT, upgrades,
  non-origin-form inner requests, broad local binding, nonempty loopback ports and structured egress.
  Scope is the managed process proxy; do not claim host-side web_fetch/remote HTTP MCP method enforcement.
- Use lazy X.509 loading, in-memory signing keys and a per-lease public-only CA bundle. Never install a
  global root or persist private keys. Context cache is capped at 64 hostnames; certificates last 24 hours.
  Child trust environment and host-owned read grants are ephemeral resources, not policy snapshot fields.
  Explicit read denies win; Windows limited mode requires PSEC custom reads and legacy fails closed.
  Close destroys TLS/tunnel/HTTP sockets, aborts pending work and removes the bundle after pending signing.
- Same restrictions apply to stdio MCP's per-generation proxy. SOCKS UDP and configurable MITM hooks
  remain outside scope. Native binaries are not changed by this TypeScript feature.

## Verification

- Protocol fixtures exercise requests/bodies/headers, redirects, exact/wildcard
  policy, malformed targets, private/mixed DNS, pinned dial arguments, CONNECT
  bytes, concurrent lease separation, and shutdown during resolution.
- Shell/manager tests cover frozen authority, supported/unsupported projections,
  escalation bounds, early failure, yield, natural exit, abort, timeout,
  inconclusive stop, capacity, and shutdown during startup.
- Real macOS tests run curl over HTTP and certificate-validated HTTPS and prove
  direct TCP, alternative proxy ports, ignored proxy settings, UDP, and Unix
  socket attempts fail at the OS boundary. Only these tests skip on other OSes;
  their unsupported launch behavior is tested on every host.
- Windows Server 2022/2025 tests use real Shell launches for online/offline TCP
  and UDP, proxy allow/deny, direct egress, foreign concurrent proxy ports,
  ConPTY, process-tree cleanup, and reset/reinitialization. Native protocol and
  restricted-token tests alone are not an end-to-end gate. Release helper
  artifacts must pass this same reusable Windows workflow before upload.
- Run the full repository gates and provider-free installed-package smoke.

## Scenario: Live Network Decisions And Block Diagnostics

### 1. Scope / Trigger

Changes to managed proxy authorization, Shell process callbacks, gateway approvals or network UI.

### 2. Signatures

- `NetworkProxyPolicy.approvalDomains?: readonly string[]`, managed `network_proxy.approval_domains`.
- `NetworkProxyInteraction.requestApproval(details, signal) -> Promise<"approve_once" | "reject" | "unavailable">`.
- `NetworkProxyInteraction.onBlocked(details) -> void`.
- `NetworkApprovalBroker.interaction({sessionId, turnId?, callId})` captures one process owner.
- Existing `approval.request` gains optional `network_request: NetworkAccessDetails`; responses use
  `approval.respond` with exact `network:<uuid>` decision and session IDs. Cancellation has
  `interactive.cancelled.network_request`; `network.blocked` carries `details` and process ownership.

### 3. Contracts

- Approval patterns add restrictions within `networkDomains`. Empty or missing lists add no asks.
  Intersection unions approval restrictions; child subset checks cannot remove them. Freeze and
  validate at config, child, run snapshot and SQLite restore boundaries. No new exception authority.
- Validate protocol, hard domain ceiling, limited method and public DNS before asking. Pin the public
  address across the decision. Do not connect to the target, forward bodies or replay commands before
  approval. No domain cache, session grants, persistent grant or auto-approval in Full Access.
- Full CONNECT/SOCKS asks for one tunnel. Limited TLS setup does not grant origin access: ask for
  each decrypted method-checked HTTP request. A full tunnel may carry many application requests.
- Setup has a ten-second active budget; only approval wait pauses it. Approval expires at two minutes.
  Pause both TLS and underlying TCP idle timers. Resume body deadline after authorization. The Shell
  absolute timeout and client timeouts still apply; they close the lease and cancel decisions.
- Process lease owns the request past tool yield. Proxy close and client disconnect cancel even a
  callback ignoring abort. Shell also forwards owning execution cancellation. Session transition
  invalidates old process responder epochs; gateway shutdown and last consumer removal cancel all.
- An embedded service's permanent upstream subscription is not an approval controller. Host-only
  `NodeBackend.setNetworkApprovalAvailability` follows controller attach/detach, cancels pending
  network decisions and rejects new asks while detached. Observers cannot enable approval. Forward
  availability through a generation-fenced worker control message and preserve it across restarts.
  Reattachment enables only fresh requests; ordinary durable approvals and running work survive.
- `approval_domains` describes destinations that need a live decision, so host-side callers without a
  responder must fail closed rather than bypass it. `web_fetch` checks the approval list for its
  initial URL and every redirect target and returns `network_approval_unavailable` with a corrective
  message. Remote HTTP MCP, hooks and plugin networking keep their existing allowlist behavior and
  are not implied to support per-request approval.
- Broker retains at most 32 requests; existing interactive controller queues them with ordinary
  approvals/clarifications. Hidden cancellation never clears the visible request. Live replay uses
  bootstrap of the same process; cold restart restores no responders.
- Network request/response/cancel events never invent turn running/terminal state. Background
  approval survives originating-turn completion. Actual status includes live pending decisions.
- The canonical closed schema permits only bounded host/port/protocol/method/reason fields. No raw
  URLs, paths, queries, headers, bodies, credentials or resolved private addresses. Callback exceptions
  cannot change authorization. Bilingual notices are live, at most 32 per process, and not persisted.
- Live callbacks cover Shell/Bash and child agents. Headless `approvalMode=suspend` omits responders;
  stdio MCP also has none. Both reject approval-required destinations. Host web_fetch/HTTP MCP and
  hooks/plugins are outside this interaction scope. No native helper change or Windows acceptance claim.

### 4. Validation & Error Matrix

| Condition | Outcome |
| --- | --- |
| Domain outside ceiling, forbidden method/port, private address | Hard block; no prompt or target dial |
| Valid approval-required request, no interactive responder | `approval_unavailable`; no dial |
| Exact owner approves once | Resume the original request/tunnel; next request asks again |
| Persistent choice or wrong session | Reject RPC without consuming the pending responder |
| Late/duplicate response | `approval_not_pending`; no replay |
| Approval expires / request cancelled | Cancel the live prompt and reject access |
| Process exits or stops after yield | Close lease before completion; late approval cannot dial |

### 5. Good/Base/Bad Cases

- Good: admin permits `*.example.com` but gates that pattern; a child asks before contacting a new
  subdomain, then uses only its pinned destination for the approved request.
- Base: no approval patterns preserves existing automatic allowlist behavior.
- Bad: union an approved hostname into the immutable domain ceiling or rerun the command after consent.

### 6. Tests Required

Real sockets assert no preapproval dial, original POST body preservation, separate decisions for
subsequent HTTP/CONNECT/SOCKS requests, hard denial before prompting, bounded diagnostics and shutdown
with uncooperative callbacks. Limited HTTPS tests inspect the decrypted method before approval.
Timer tests cover setup and both TLS/TCP idle budgets. Broker/gateway tests cover session identity,
queueing, cancellation, stale responses, bootstrap and background-turn state. UI tests cover bilingual
text, narrow CJK wrapping and Esc rejection. Real macOS tests exercise sandboxed Shell yield/stop;
portable policy tests cover immutable child/restore/grant restrictions. Run all repository gates.

### 7. Wrong vs Correct

Wrong: approve a domain by mutating the proxy allowlist, then launch the Shell command again.

Correct: validate and pin this request, await a process-owned decision, recheck cancellation and dial
that same target once; leave the immutable policy and original command unchanged.
