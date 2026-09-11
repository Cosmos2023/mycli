# Shell Network Policy

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
Managed settings restrict permissions; `network = "enabled"` allows a network
grant but does not itself enable networking in the default workspace profile.
Approve a network permission request when mycli needs one. Grants and Shell
escalation remain capped by the managed list, including in Full Access mode.

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
