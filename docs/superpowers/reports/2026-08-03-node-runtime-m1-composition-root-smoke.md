# Node Runtime M1 Composition Root Smoke Report

Date: 2026-08-03

Code commit tested: `c4a9581446e35064ef97d1018f6b522f29c2ceb9`

## Result

M1 makes Node the interactive composition root while retaining the existing Python runtime as
an explicit JSON-RPC sidecar. Node owns backend selection, TTY validation, signal handling, child
lifecycle, and process exit codes. Provider, tool, session, and persistence behavior remains in
Python for this milestone.

The local M1 gate passed except for one pre-existing Node 24 readline assertion described below.
The repository CI matrix now runs the lifecycle gate on Node 22.19 for macOS, Linux, and Windows;
that remote matrix must pass before promotion.

Live API: not applicable. M1 does not change provider traffic, and no smoke command issued a
provider request.

## Environment

- Node: `v24.14.1`
- npm: `11.11.0`
- Python: `3.13.12`
- Platform: macOS development worktree
- Clean npm install: 154 packages installed, 0 reported vulnerabilities

## Offline Gate

| Command | Outcome |
| --- | --- |
| `npm ci --cache .npm-cache` | Passed |
| `npm run contracts:check` | Passed |
| `npm run build` | Passed; contracts, TUI, then app |
| `npm run lint` | Passed |
| `npm run typecheck` | Passed for all three workspaces |
| `npm test --workspace @cosmos2023/mycli` | 41 passed |
| Handshake and gateway-client focused tests | 16 passed |
| Real-process lifecycle integration | 6 passed |
| `npm test` contracts workspace | 11 passed |
| `npm test` TUI workspace | 369 passed, 1 known Node 24 baseline failure |
| `uv run pytest -q` | 2459 passed, 30 skipped |
| `uv run ruff check src/mycli tests` | Passed |
| `uv run mypy src/mycli` | Passed; 321 source files |

The lifecycle integration covers readiness timeout, crash before handshake, crash after
handshake, normal shutdown, bounded SIGTERM escalation, and abnormal-parent orphan cleanup. PID
probes confirmed that each fixture child exited. Sidecar stderr remained outside protocol stdout
and secret-shaped fixture values were redacted within the 8 KiB diagnostic bound.

## Executable And Pack

Both compiled local commands exited zero without starting Python:

```text
node apps/mycli/dist/cli.js --help
node apps/mycli/dist/cli.js --version
```

The version output was `0.1.0`. `npm pack --workspace @cosmos2023/mycli --dry-run --json --cache
.npm-cache` reported 7 files, 4629 packed bytes, and 15777 unpacked bytes:

```text
dist/backend-router.d.ts
dist/backend-router.js
dist/cli.d.ts
dist/cli.js
dist/sidecar/python-sidecar.d.ts
dist/sidecar/python-sidecar.js
package.json
```

The executable has a Node shebang and executable mode. The pack contains no TypeScript source,
Python source, test fixture, credential, local environment file, or production `tsx` loader.

## Interactive Smoke

The Node-parent preview was started with the project Python environment:

```bash
MYCLI_PYTHON=.venv/bin/python npm run mycli
```

Outside the filesystem sandbox, the process remained active after readiness, manifest,
protocol, and session bootstrap, confirming that the TUI reached its interactive state. It was
then terminated without submitting a turn. A final process probe found no remaining Node CLI or
Python sidecar after the Node SIGTERM shutdown path completed.

## Rollout And Rollback

Preview rollout:

```bash
npm ci
npm run build
npm run mycli -- --runtime-backend python-sidecar
```

M1 implements only `python-sidecar`. Selecting `--runtime-backend node` returns
`runtime_backend_unavailable` with exit code 2 and never starts or falls back to Python.

Explicit rollback:

```bash
uv run mycli
```

M1 still requires Python 3.13 and the Python package. Management commands remain on the Python
CLI until their capability slices migrate.

## Known Local Baseline

On local Node `v24.14.1`, the existing test `native chat runtime appends transcript without
fullscreen control sequences` fails because Node readline emits `ESC[1A`. The same test failure
predates M1. CI is pinned to Node `22.19.0`, where this compatibility gate is expected to pass.

No M2 provider work should begin until the Node 22.19 macOS, Linux, and Windows CI matrix passes.
