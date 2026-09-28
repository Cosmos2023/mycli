# Windows Real-Host Acceptance For The Managed Proxy

## Problem

The managed proxy change added SOCKS5 CONNECT, host HTTP/HTTPS upstream proxies, limited
GET/HEAD/OPTIONS with local TLS interception, one-request network approvals, and per-port loopback
exceptions. Only the portable integration tests and the macOS sandbox suite exercised them:
`backend/packages/tools/test/network/shell-network-proxy.platform.test.ts` is gated on
`process.platform !== "darwin"`, so Windows ran none of it. The parity and network documents
recorded that gap as "Windows end-to-end acceptance remains pending".

## Change

`backend/packages/tools/test/network/windows-shell-network-proxy.platform.test.ts` drives the same
behaviours through a real sandboxed PowerShell Shell on a PSEC host. It follows the conventions of
`windows-sandbox.platform.test.ts`: `skip: process.platform !== "win32"`, a temporary workspace with
the probe fixture copied in, `ShellSessionManager` over the pipe transport, and a `ShellTool` whose
policy is the fixture workspace root. The fixture probes the real sandbox instead of asserting on
runtime state, so every case fails if the helper stops enforcing the policy.

The probe fixture gained four operations: `proxy-socks` performs a SOCKS5 handshake and then a
plain HTTP request over the tunnel, `proxy-https` CONNECTs and then runs the request over TLS with
the scoped bundle, `proxy-post` sends a POST through the same path, and `proxy-env` prints the
proxy variables the child actually received.

The five cases:

- A request inside `approval_domains` keeps the Shell running after yield while the decision is
  pending, the origin is never contacted before it, and stopping the Shell cancels the pending
  decision so a later approval cannot reach the origin.
- A SOCKS5 request reaches an allowed host and a denied host is refused without touching the
  origin.
- With `allow_upstream_proxy`, the request travels through the host's upstream proxy with its
  Basic credentials while the child environment carries neither the credentials nor the
  untrusted `HTTP_PROXY` value it was given.
- In limited mode the public bundle is granted as a readable root, HTTPS GET succeeds under that
  scoped trust, POST is refused with 403 before the origin is contacted, and closing the lease
  removes the bundle.
- `loopback_ports` lets a real sandboxed Shell reach a listed `127.0.0.1` port while an unlisted
  port stays blocked and never accepts a connection.

## Evidence

Run on a Windows 11 host (10.0.26200, Node v24.14.0, x64) whose sandbox reports `backend=psec`,
`setup_complete=true` and `sandbox_ready=true`. All five cases pass; the whole file takes about
10 s. `ctest` covers the matching native validation and PSEC rule generation, and the packaged
helper was promoted in the same change so the shipped binary carries `loopback_ports`.

`docs/network-policy.md`, `docs/parity/windows-sandbox-feature-parity.md`, `docs/zh/network-policy.md`
and `docs/zh/windows.md` no longer describe this as pending.

## Limits

- The file skips on every non-Windows host and asserts a ready sandbox on Windows, exactly like the
  existing Windows sandbox suite. A Windows host without `mycli sandbox setup --confirm` fails it
  rather than skipping, which is the established convention for platform acceptance.
- Only the PSEC backend is exercised. The legacy backend rejects the limited-mode read grants and
  the per-port loopback option by design, so it stays fail-closed rather than accepted.
- SOCKS BIND/UDP ASSOCIATE, configurable MITM rewrite hooks and proxy-only DNS remain unsupported,
  and the cases cover HTTP/1.1 only.