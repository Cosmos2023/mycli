# Shell Network Policy

The default Workspace (Ask for approval) profile enables networking for Shell and `web_fetch`
without a separate network grant. Filesystem writes remain confined to the workspace and risky
commands still require approval. Read Only starts offline; Full Access enables networking as well.
Restart mycli after updating to apply these defaults to new turns.

On macOS and Windows, mycli can route domain-constrained Shell HTTP/HTTPS traffic through a
local proxy. The operating-system sandbox blocks direct network connections.
Networking must still be authorized by the active permission profile or an
approved permission request.

## Configure Allowed Domains

The existing managed policy file is `~/.mycli/managed_config.toml`:

```toml
[execution_policy]
network = "enabled"
allowed_network_domains = ["api.github.com", "github.com", "*.githubusercontent.com"]
```

Merge these fields with any existing managed policy. Restart mycli to load changes.
Managed settings restrict permissions. Workspace networking is already enabled; the list above
limits its destinations without requiring an extra grant. `network = "enabled"` does not elevate
an offline Read Only profile. Grants and Shell escalation remain capped by the managed list,
including in Full Access mode.

Exact entries permit only that hostname. `*.example.com` permits subdomains, not
`example.com` itself. List every required redirect destination. An empty list or
`network = "disabled"` keeps commands offline. Omitting the list means there is
no domain constraint; the ordinary profile's network policy still applies.

From a source checkout, run `npm run build` after updates and `npm run mycli` to
start the compiled CLI. No separate proxy service or proxy configuration is needed.

## SOCKS5, Upstream Proxies And Limited Mode

Add this table to the same managed file, alongside `allowed_network_domains`:

```toml
[execution_policy.network_proxy]
mode = "full"
enable_socks5 = true
allow_upstream_proxy = false
```

Omitting the table preserves the existing HTTP/CONNECT behavior. With the table present, the
defaults are shown above. SOCKS5 CONNECT shares the owned loopback TCP port; `ALL_PROXY` and
`all_proxy` use `socks5h://` so clients can send hostnames to the proxy. Full mode supports public
TCP destinations on custom ports, including SSH when the client is configured to use SOCKS5.
IPv4/IPv6 literals need their own allowlist entries; local DNS resolution cannot substitute an
allowed hostname for an unlisted IP. BIND, UDP ASSOCIATE and private destinations remain rejected.

Set `allow_upstream_proxy = true` to read the **host's** HTTP/HTTPS upstream proxy settings at lease
creation. HTTP uses `http_proxy`, `HTTP_PROXY`, `all_proxy`, then `ALL_PROXY`; HTTPS first tries
`https_proxy` / `HTTPS_PROXY`, then the ALL variants, then the HTTP variants. Only `http://` and
`https://` upstream URLs are accepted, with optional Basic authentication. Without a matching
variable that route stays direct. Credentials stay in host memory, outside child environment and
policy snapshots. The runtime overwrites proxy variables and clears `NO_PROXY` for children.
Each upstream connection uses CONNECT to the already validated **numeric destination**, including
port 80 for ordinary HTTP. The upstream must support this; refusal never triggers direct fallback.
HTTPS upstreams require a trusted certificate. Destination validation still uses host DNS, so
proxy-only DNS names are unsupported. MCP stdio reads upstream settings from the hosting process.

Set `mode = "limited"` to permit only GET, HEAD and OPTIONS. This applies to both plain HTTP and
HTTPS: the proxy terminates TLS locally, checks the actual method, Host and SNI, and establishes a
separately verified TLS connection to the origin. HTTPS is restricted to HTTP/1.1 on port 443;
limited SOCKS5 also requires HTTPS on 443. POST/PUT/PATCH/DELETE, nested tunnels and upgrades fail.
This will block operations such as Git push and many API calls; GET itself is not a guarantee that
a remote service has no side effects.

Limited mode gives each managed child a temporary **public CA bundle** through `NODE_EXTRA_CA_CERTS`,
`SSL_CERT_FILE`, `REQUESTS_CA_BUNDLE`, `CURL_CA_BUNDLE` and `GIT_SSL_CAINFO`. Private signing keys remain
in memory, and the public bundle is removed when the process lease closes. System trust stores
are untouched. Clients that ignore these variables, pin certificates, or require HTTP/2 may fail;
do not disable certificate verification. Certificates last 24 hours; restart long-lived processes
to obtain a fresh lease. Limited mode rejects direct loopback exceptions and structured egress;
it needs a domain list and retains its limits through grants, child agents and resumed turns.
Windows limited mode requires PSEC custom read grants for the public bundle; the legacy backend
fails closed. Windows end-to-end verification remains pending; the packaged helper is unchanged.
These method restrictions apply to the managed process proxy, not host-side `web_fetch` or remote
HTTP MCP transports. Configurable MITM rewrite hooks are not implemented.

## One-Request Approvals And Block Reasons

To require interactive permission for selected destinations, add `approval_domains` to the
existing proxy table. For example:

```toml
[execution_policy]
allowed_network_domains = ["api.github.com", "*.example.com"]

[execution_policy.network_proxy]
mode = "limited"
approval_domains = ["*.example.com"]
```

Restart once after changing managed configuration. `api.github.com` remains automatic;
`api.example.com` asks on each request. `approval_domains` is an extra restriction **inside**
`allowed_network_domains`, never permission to bypass that list. Exact and `*.` patterns use the
same rules as the allowlist. Omitted/empty approval domains preserve automatic allowed access.
Domains outside the allowlist, private/reserved addresses, offline policy and forbidden methods
remain blocked even in Full Access. There is no per-request configuration rewrite or restart.

The TUI shows the destination, port, protocol and available HTTP method, with **Allow once** and
**Reject** in English and Chinese. Approval holds the existing request before connecting to the
target; it never reruns the Shell command. Plain HTTP and limited HTTPS authorize one HTTP request.
Full-mode HTTPS CONNECT and SOCKS authorize one TCP tunnel, which may carry multiple application
requests; encrypted methods are not visible in full mode. Redirects and new connections are checked
again. There is no session-wide or persistent grant.

Approval survives Shell yield/background execution. Its separate wait limit is two minutes; proxy
setup/idle budgets pause while asking. The command's own absolute timeout and client timeouts still
apply. Process exit/stop, request disconnect, interruption, gateway shutdown and the last interactive
consumer disconnect cancel pending decisions. In an embedded multi-client service, detaching the
controller cancels network decisions even if observers remain; without a controller, new gated
requests fail closed. Reattaching permits new decisions but cannot revive cancelled requests.
Ordinary command approvals and running processes retain their existing reconnect behavior.
Session transitions revoke old process responders.
Approval IDs are live only and cannot be resumed after restarting mycli.

Blocked Shell requests produce bounded bilingual notices distinguishing domain, method, private
address, port, DNS, rejected/unavailable/expired approval and connection failures. Notices exclude
URL paths, queries, credentials, bodies and resolved private IPs. At most 32 are shown per process.
These notices are live UI diagnostics, not durable conversation history.

The live approval bridge currently covers Shell/Bash, including child agents. Headless execution and
stdio MCP have no live network responder and reject approval-required destinations. This does not
add per-request approvals to host-side `web_fetch`, remote HTTP MCP, hooks or plugin networking.
Windows uses the same TypeScript bridge; real Windows acceptance is still pending.

## Supported Traffic

| Environment | Domain-constrained Shell behavior |
| --- | --- |
| macOS with Seatbelt | HTTP on port 80 and HTTPS through CONNECT on port 443 |
| Windows restricted-token sandbox | HTTP on port 80 and HTTPS through CONNECT on port 443, limited to each logon’s proxy port |
| Windows PSEC | Same proxy traffic; explicit local-service exceptions are described below |
| Linux | `network_proxy_unavailable` before process start when networking is enabled and the list is non-empty |
| Network disabled / empty domain list | Commands run with networking disabled |

Proxy-aware clients such as curl and Git over HTTPS use the runtime-provided
`HTTP_PROXY`, `HTTPS_PROXY`, and lowercase equivalents. Tools that ignore proxy
settings cannot connect directly. Without the additional table, only HTTP port 80 and CONNECT
port 443 are supported. Optional SOCKS5 extends full-mode TCP forwarding as described above.
UDP, HTTP upgrades, Expect and private/local destinations remain unsupported.

A Shell command that returns a running handle keeps its proxy until the process
ends. Stopping it, reaching its timeout, or closing mycli revokes its connections.
The proxy allows 64 client connections, bounds headers to 16 KiB, and closes
connections idle for 30 seconds; DNS and connection establishment have a
10-second limit.

## Enforcement Limits

Every HTTP target and CONNECT authority must match the frozen allowed list and
resolve exclusively to public addresses. The actual upstream connection uses a
checked numeric address, preventing a second DNS lookup from changing the target.

In full mode, HTTPS remains end-to-end encrypted: the proxy does not inspect TLS SNI, encrypted
Host headers or application content. Limited mode performs the HTTPS inspection described above.
Neither mode can prevent an allowed remote service from relaying traffic elsewhere. Seatbelt allows a loopback TCP port, not
a particular listening process identity; this boundary assumes the unsandboxed
host and runtime are trusted.

The legacy Windows backend uses a dedicated proxy account with a persistent WFP network deny. Each command receives
an exception scoped to its unique logon SID and one IPv4 loopback TCP port; another command's proxy
port is not authorized. The host installs the exception before resuming the suspended runner and
revokes it on exit. This does not override other Windows firewall restrictions. The legacy backend
requires a read-only or workspace-write filesystem policy when networking is constrained; combining
unrestricted filesystem access with network constraints fails closed.

PSEC enforces independent per-process policies and supports unrestricted files with constrained
networking. Its proxy default permits only the owned proxy endpoint. The source additionally accepts
managed `loopback_ports = [5432, 6379]` alongside `allowed_network_domains`, granting direct outbound
TCP to those ports on `127.0.0.1` and `::1`. The explicit list overrides the older all-port
`allow_local_binding` exception; `[]` grants no extra ports, and offline policy still wins.
This is a direct local-service exception, not proxy support for private targets. It requires an
updated PSEC helper; the packaged binary is unchanged and Windows compilation/enforcement validation
for this addition remains pending. See [port limits and compatibility](windows.md#psec-compatibility-and-boundaries).

## MCP Networking

MCP processes have a separate startup policy: ordinary host subprocesses with filesystem access and
enabled networking by default, capped by managed network and writable-root bounds. Temporary Shell grants and the turn
permission selector do not reconfigure a running MCP process. In `mcp_servers.toml`, set
`[servers.<id>.sandbox] network = "disabled"` to keep an individual server offline, or set
`mode = "workspace-write"` / `mode = "read-only"` to restrict filesystem writes. Explicit restrictions
use the platform sandbox and fail closed if they cannot be enforced. Tool approvals remain independent
of process isolation.

Domain-constrained stdio MCP uses this same macOS/Windows proxy and traffic restrictions, with one proxy per
process generation. Cancellation/timeout retires that generation and closes its proxy; a later
explicit call starts a fresh generation. Linux fails before starting a process when they
cannot enforce the requested enabled domain restriction. On the legacy Windows backend, explicitly select a
restricted filesystem mode for a stdio MCP server when applying domain or offline restrictions.

Remote HTTP MCP checks allowed hostnames and the enabled/disabled policy before every request.
It rejects redirects instead of forwarding endpoint credentials or tool arguments. Unlike the
stdio proxy, this HTTP client permits configured loopback endpoints and custom ports. It does
not inherit Shell's proxy environment. These HTTP hostname checks do not claim the stdio proxy's
public-address pinning guarantee. See [MCP configuration](node-extensions.md#mcp).
