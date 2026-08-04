# Node Runtime M2 Rollout

## Current Status

The Node runtime is an explicit preview backend for text-only, no-tool turns. The default remains
`python-sidecar`. Do not promote Node to the default until both provider live smokes and the
Node 22.19 macOS, Linux, and Windows matrix pass for the release candidate.

Select the preview backend for a new turn:

```bash
mycli --runtime-backend=node
```

Use `--model <name>` and `--session <id>` with the same precedence and session semantics as the
existing CLI. The selected backend owns the complete turn before provider IO begins.

## Supported M2 Scope

- OpenAI Responses and OpenAI-compatible Chat Completions
- streamed text and reasoning events
- bounded runtime-owned retries and interruption
- append-compatible SQLite conversation, history, rollout, and idempotency records
- duplicate `client_turn_id` protection
- startup recovery for orphaned running turns

M2 does not support tools, approvals, local images, shell execution, MCP, plugins, hooks,
subagents, compaction, memory, queues, or steering in the Node backend. A provider tool call or
local image fails with `unsupported_capability`; it is never delegated to Python.

## Failure And Rollback

A failed Node turn reports its real terminal error. mycli does not replay it through Python,
because a retry could duplicate provider requests or later tool side effects.

Rollback is operator-controlled and applies before a later turn:

```bash
mycli --runtime-backend=python-sidecar --session <id>
```

Both backends read the shared SQLite schema. Sessions written by the M2 Node slice remain readable
by Python, and Node reopening a database preserves Python-compatible records.

## Verification

Run the deterministic M2 gate after a clean build:

```bash
npm run test:m2
npm run smoke:package
```

Live smoke is opt-in and uses existing config/auth without printing credentials, endpoint data,
prompt text, or response text:

```bash
node scripts/smoke_node_m2.mjs --protocol responses --dry-run
node scripts/smoke_node_m2.mjs --protocol chat_completions --dry-run
node scripts/smoke_node_m2.mjs --protocol responses
node scripts/smoke_node_m2.mjs --protocol chat_completions
```

The runner uses a temporary session database, no tools, zero retries, a 64-token output cap, and a
45-second deadline. Missing credentials exit with code `77`. CI runs deterministic M2 and packed
CLI smokes on Node 22.19 across macOS, Linux, and Windows. Live requests run only after the matrix
passes on a `main` branch push, through the protected `node-m2-live` GitHub Environment, when its
secret is configured.

See `docs/superpowers/reports/2026-08-03-node-runtime-m2-no-tool-turn-smoke.md` for the current
evidence and unresolved live-provider gate.
