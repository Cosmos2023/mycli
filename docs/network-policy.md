# Shell Network Policy

The default Workspace (Ask for approval) profile enables networking for Shell and `web_fetch`
without a separate network grant. Filesystem writes remain confined to the workspace and risky
commands still require approval. Read Only starts offline; Full Access enables networking as well.
Restart mycli after updating to apply these defaults to new turns.

On macOS, mycli can route domain-constrained Shell HTTP/HTTPS traffic through a
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

## Supported Traffic

| Environment | Domain-constrained Shell behavior |
| --- | --- |
| macOS with Seatbelt | HTTP on port 80 and HTTPS through CONNECT on port 443 |
| Linux / Windows | `network_proxy_unavailable` before process start when networking is enabled and the list is non-empty |
| Network disabled / empty domain list | Commands run with networking disabled |

Proxy-aware clients such as curl and Git over HTTPS use the runtime-provided
`HTTP_PROXY`, `HTTPS_PROXY`, and lowercase equivalents. Tools that ignore proxy
settings cannot connect directly. SSH, UDP, custom ports, HTTP upgrades, Expect,
and private/local destinations are not supported by this proxy. The proxy does
not require disabling certificate validation or installing a mycli certificate.

A Shell command that returns a running handle keeps its proxy until the process
ends. Stopping it, reaching its timeout, or closing mycli revokes its connections.
The proxy allows 64 client connections, bounds headers to 16 KiB, and closes
connections idle for 30 seconds; DNS and connection establishment have a
10-second limit.

## Enforcement Limits

Every HTTP target and CONNECT authority must match the frozen allowed list and
resolve exclusively to public addresses. The actual upstream connection uses a
checked numeric address, preventing a second DNS lookup from changing the target.

HTTPS remains end-to-end encrypted. The proxy does not inspect TLS SNI, encrypted
Host headers, or application content, and cannot prevent an allowed remote server
from relaying traffic elsewhere. Domain filtering therefore controls destination
selection; it is not content filtering. Seatbelt allows a loopback TCP port, not
a particular listening process identity; this boundary assumes the unsandboxed
host and runtime are trusted.

## MCP Networking

MCP processes have a separate startup policy: ordinary host subprocesses with filesystem access and
enabled networking by default, capped by managed network and writable-root bounds. Temporary Shell grants and the turn
permission selector do not reconfigure a running MCP process. In `mcp_servers.toml`, set
`[servers.<id>.sandbox] network = "disabled"` to keep an individual server offline, or set
`mode = "workspace-write"` / `mode = "read-only"` to restrict filesystem writes. Explicit restrictions
use the platform sandbox and fail closed if they cannot be enforced. Tool approvals remain independent
of process isolation.

Domain-constrained stdio MCP uses this same macOS proxy and traffic restrictions, with one proxy per
process generation. Cancellation/timeout retires that generation and closes its proxy; a later
explicit call starts a fresh generation. Linux/Windows fail before starting a process when they
cannot enforce the requested enabled domain restriction.

Remote HTTP MCP checks allowed hostnames and the enabled/disabled policy before every request.
It rejects redirects instead of forwarding endpoint credentials or tool arguments. Unlike the
stdio proxy, this HTTP client permits configured loopback endpoints and custom ports. It does
not inherit Shell's proxy environment. These HTTP hostname checks do not claim the stdio proxy's
public-address pinning guarantee. See [MCP configuration](node-extensions.md#mcp).
