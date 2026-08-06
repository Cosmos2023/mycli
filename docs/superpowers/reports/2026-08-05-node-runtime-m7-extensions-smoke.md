# Node Runtime M7 Extensions And Management Smoke Report

Date: 2026-08-06

Candidate base commit: `c80ee163` plus the Task 14 changes recorded by this report.

## Result

The local M7 contract, build, lint, typecheck, full test, parity, package, management, and
no-Python extension gates pass. The deterministic provider fixture completes the full
Skill -> MCP -> Plugin API v2 -> foreground subagent chain in the Node runtime, persists the
result, closes its MCP/plugin processes, and leaves the Python marker absent.

The Responses live-provider smoke completed on an authorized compatible endpoint with `gpt-5.5`.
The first full-chain attempt returned a structural failure before any tool completed. Bounded
follow-up probes confirmed successful Responses requests and function calls in both automatic and
required modes; an unchanged full-chain rerun then completed. This is recorded as a successful live
gate with an observed provider/model non-determinism risk, not as a first-attempt stable pass. Remote
Node 22.19/24 macOS/Linux/Windows lanes are configured in GitHub Actions but were not executed
locally.

## Environment

- Platform: Darwin 25.4.0 arm64
- Node: `v24.14.1`
- npm: `11.11.0`
- Python: `3.13.12`
- CI matrix configured: Node `22.19.0` and `24.x` on Ubuntu, macOS, and Windows

## Quality Gate

| Command | Outcome |
| --- | --- |
| `npm run contracts:generate` | Passed |
| `npm run contracts:check` | Passed |
| `npm run build` | Passed for all 10 workspaces |
| `npm run lint` | Passed |
| `npm run typecheck` | Passed for all workspaces |
| `npm test` | Passed for every workspace |
| `npm run test:m7` | Passed: 4 Node integration/smoke tests and 3 Python parity tests |
| `npm run smoke:package` | Passed: 10 packed workspaces installed and validated |
| Compiled management commands | Passed: hooks, plugins, MCP, subagents, and doctor JSON routes |
| Credential-gated Responses smoke | Passed on unchanged rerun; first full-chain attempt failed structurally |
| `git diff --check` | Passed before report generation; repeated in the final review |

The package smoke resolves `@mycli/integrations`, the Anthropic and MCP SDKs, and the compiled
Plugin API v2 worker bootstrap from the temporary installation. It also runs the five compiled
management command families and the native PTY probe. No Python process is part of those paths.

## Parity And Extension Coverage

- Shared fixtures compare Python and Node config precedence, skill/profile discovery, hook/MCP
  manifests, plugin migration state, doctor human/JSON output, and additive SQLite child-task rows.
- The approved parity difference is explicit: Python retains its historical implicit subagent
  limits, while Node profiles with no configured budget remain unlimited.
- Real MCP SDK descriptors with a Draft-07 root `$schema` are copied into the host schema without
  that root marker. The original descriptor is not mutated, and required-property validation still
  runs through the shared tool router.
- The no-Python integration asserts four ordered tool completions, two approval resolutions,
  durable skill/tool/subagent records, configured-hook execution, and process-tree cleanup.
- A regression test proves local structural setup failures return `failed`/exit `1`; only unavailable
  credentials or a provider that cannot begin the turn use `unavailable`/exit `77`.

Deterministic completed output:

```json
{"protocol":"responses","status":"completed","tool_counts":{"skill":1,"mcp":1,"plugin":1,"subagent":1},"hook_completed":true,"approval_count":2,"persisted":true,"cleanup_completed":true,"python_started":false}
```

Local no-credential output:

```json
{"protocol":"responses","status":"unavailable","tool_counts":{"skill":0,"mcp":0,"plugin":0,"subagent":0},"hook_completed":false,"approval_count":0,"persisted":false,"cleanup_completed":false,"python_started":false}
```

The separate no-credential command returned `77` and remains a verified skip path. The successful
credential-gated rerun returned `0` with the completed output shown above. Smoke output contains only
protocol, status, counts, booleans, and approval count. It excludes credentials, endpoints, prompts,
commands, environment values, provider text, raw tool output, and private paths.

## Rollout Decision

- M7 extension and management parity is locally complete.
- Keep `python-sidecar` available as the explicit rollback backend through M7.
- Never retry an accepted Node turn through Python.
- Python production-code deletion, Node-only ownership, and rollback removal remain M8 work.
- Require the configured remote platform matrix before release policy claims beyond this local
  result, and retain visibility into the observed first-attempt live-smoke non-determinism.
