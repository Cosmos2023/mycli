# Node Runtime M2 No-Tool Turn Smoke Report

Date: 2026-08-04

Candidate base commit: `581fbc2` plus the Task 10 changes recorded by this report.

## Result

The deterministic M2 implementation, parity, packaging, and local cross-platform-oriented gates
pass. The installed npm CLI path now includes runtime JSON Schemas and starts correctly through
its generated `.bin/mycli` symlink.

Live Chat Completions completed and persisted successfully. The local Responses credential/path
did not produce a valid stream event and terminated as `retry_exhausted` with runtime retries set
to zero. Therefore the M2 live acceptance gate is incomplete, Python remains the default backend,
and this candidate must not be promoted as a fully accepted M2 release.

## Environment

- Platform: macOS development worktree
- Node: `v24.14.1`
- npm: `11.11.0`
- Python: `3.13.12`
- CI target: Node `22.19.0` on Ubuntu, macOS, and Windows
- Clean npm install: 164 packages installed, 0 reported vulnerabilities

## Offline Gate

| Command | Outcome |
| --- | --- |
| `npm ci` with an isolated temporary cache | Passed |
| `npm run contracts:check` | Passed |
| `npm run build` | Passed for all runtime workspaces and the app |
| `npm run lint` | Passed |
| `npm run typecheck` | Passed for all workspaces |
| `npm test` | 486 passed |
| `npm run test:m2` | Passed: Node backend/smoke integration plus Python parity |
| `npm run smoke:package` | Passed: 8 tarballs installed and `.bin/mycli --help` executed |
| `uv run ruff check .` | Passed |
| `uv run mypy src/mycli` | Passed for 321 source files |
| `uv run pytest -q` | 2463 passed, 30 skipped |

The Node total is app 53, config 9, contracts 14, core 7, providers 11, runtime 12, storage 10,
and TUI 370. Final review added coverage for request-level atomic duplicate rejection and for
protecting a live process's running turn from another store's startup recovery. The prior Node 24
false positive was an over-broad test regex that classified
readline's single-line `ESC[1A` redraw as a fullscreen control sequence; the test continues to
reject alternate-screen, mouse-capture, and clear-screen sequences.

## Live Smoke

Both commands used existing local auth, a temporary SQLite database, no tools, zero runtime/SDK
retries, a 64-token output cap, and a 45-second deadline. Output contained only sanitized JSON.

Chat Completions:

```json
{"protocol":"chat_completions","status":"completed","event_counts":{"reasoning_delta":11,"text_delta":1,"completed":1},"persisted":true,"credential":"configured"}
```

Responses:

```json
{"protocol":"responses","status":"failed","event_counts":{},"persisted":false,"credential":"configured","error_code":"retry_exhausted"}
```

The Responses failure occurred before the first valid provider event. No automatic retry or
Python fallback occurred. Raw provider errors, headers, endpoint data, prompts, responses, and
credentials were not printed or stored in this report.

## Rollout Decision

- Keep `python-sidecar` as the default.
- Allow explicit `--runtime-backend=node` preview use for supported text-only no-tool turns.
- Do not silently retry a failed Node turn through Python.
- Roll back by selecting `python-sidecar` before a later turn.
- Require a successful sanitized Responses live smoke and the Node 22.19 three-platform CI matrix
  before declaring M2 complete or changing the default backend.
