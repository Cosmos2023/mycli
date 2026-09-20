# Network Proxy Contract

## Scope

Applies to `tools/network/`, Shell process resources, sandbox proxy endpoints, and
changes to domain-constrained execution. The runtime supplies policy; the proxy
does not approve domains or modify the run snapshot.

## Interfaces

- `startNetworkProxy({ domains, lookup?, connect? }) -> Promise<NetworkProxyLease>`.
- `NetworkProxyLease` exposes its loopback `port`, frozen proxy `env`, and
  idempotent asynchronous `close()`.
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

CONNECT is an opaque TCP tunnel. It checks the authority and destination address,
not tunneled TLS SNI, encrypted HTTP Host, or application content. Allowed remote
services may themselves relay traffic. This is destination filtering, not TLS
inspection or a defense against a hostile unsandboxed host process. Seatbelt's
loopback filter is per TCP port, not per listening process identity.

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
