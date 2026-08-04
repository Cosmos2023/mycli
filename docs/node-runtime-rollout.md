# Node Runtime M3 Rollout

## Current Status

The Node runtime is an explicit preview backend for text turns and the built-in `Read` tool. The
default remains `python-sidecar`. Do not promote Node to the default until the M3 live smoke and
the Node 22.19 macOS, Linux, and Windows matrix pass for the release candidate.

Select the preview backend for a new turn:

```bash
mycli --runtime-backend=node
```

Use `--model <name>` and `--session <id>` with the same precedence and session semantics as the
existing CLI. The selected backend owns the complete turn before provider IO begins.

## Supported M3 Scope

- OpenAI Responses and OpenAI-compatible Chat Completions
- streamed text and reasoning events
- bounded runtime-owned retries and interruption
- append-compatible SQLite conversation, history, rollout, and idempotency records
- duplicate `client_turn_id` protection
- startup recovery for orphaned running turns
- one Node-native `Read` tool for bounded UTF-8 text and CSV/TSV files
- workspace confinement with traversal and symlink escape protection
- Responses and Chat Completions tool continuation
- ordered, durable assistant tool calls and tool results
- bounded `tool.start`, `tool.complete`, `tool.failed`, and `turn.event` projection
- no fixed per-turn provider-step or total tool-call ceiling, matching Python behavior

`LS`, `Glob`, and `Grep` are retired and are neither advertised nor implemented by the Node
backend. M3 does not support mutation tools, approvals, local images, shell execution, MCP,
plugins, hooks, subagents, compaction, memory, queues, or steering. An unsupported capability
fails explicitly and is never delegated to Python.

## Failure And Rollback

A failed Node turn reports its real terminal error. mycli does not replay it through Python,
because a retry could duplicate provider requests or later tool side effects.

Rollback is operator-controlled and applies before a later turn:

```bash
mycli --runtime-backend=python-sidecar --session <id>
```

Both backends read the shared SQLite schema. Sessions written by the M3 Node slice remain readable
by Python, and Node reopening a database preserves Python-compatible records.

## Verification

Run the deterministic M3 gate after a clean build:

```bash
npm run test:m3
npm run smoke:package
```

Live M3 smoke is opt-in and uses a disposable workspace. It prints only protocol, terminal status,
tool lifecycle counts, persistence state, and `python_started=false`:

```bash
node scripts/smoke_node_m3_read.mjs --protocol responses --dry-run
node scripts/smoke_node_m3_read.mjs --protocol responses
```

The runner uses a temporary session database, one small public file, zero retries, a 64-token
output cap, and a 45-second deadline. Missing credentials exit with code `77`. CI runs deterministic
M3 and packed CLI smokes on Node 22.19 across macOS, Linux, and Windows. Live requests run only
after the matrix passes on a `main` branch push, through a protected live-test environment when
its secret is configured.

The sanitized M3 Responses smoke completed against an authorized OpenAI-compatible endpoint with
`gpt-5.5`: one Read execution started and completed, the canonical tool transcript persisted, and
no Python process started. Credentials, endpoint data, prompts, tool arguments, file contents, and
model text were not printed or stored.
