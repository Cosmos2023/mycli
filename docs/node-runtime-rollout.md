# Node Runtime M4 Rollout

## Current Status

The Node runtime is an explicit preview backend for text turns and the built-in `Read`, `Edit`,
`Patch`, and `Write` tools. The default remains `python-sidecar`. Do not promote Node to the
default until the M4 live smoke and the Node 22.19 macOS, Linux, and Windows matrix pass for the
release candidate.

Select the preview backend for a new turn:

```bash
mycli --runtime-backend=node
```

Use `--model <name>` and `--session <id>` with the same precedence and session semantics as the
existing CLI. The selected backend owns the complete turn before provider IO begins.

## Supported M4 Scope

- OpenAI Responses and OpenAI-compatible Chat Completions
- streamed text and reasoning events
- bounded runtime-owned retries and interruption
- append-compatible SQLite conversation, history, rollout, and idempotency records
- duplicate `client_turn_id` protection
- startup recovery for orphaned running turns
- Node-native `Read`, `Edit`, `Patch`, and `Write` tools
- bounded UTF-8 text and CSV/TSV reads
- exact-replacement Edit/Patch after a current process-local Read snapshot
- complete-file Write with optional `expected_sha256` conflict detection
- workspace-local mutation auto-allow, matching the Python default permission behavior
- workspace confinement with traversal and symlink escape protection
- fail-closed binary, invalid UTF-8, directory, file/content size, and secret-like-content checks
- atomic sibling-file replacement with existing mode preservation
- bounded unified diffs and Python-compatible durable `file_changes` metadata
- Responses and Chat Completions tool continuation
- ordered, durable assistant tool calls and tool results
- bounded `tool.start`, `tool.complete`, `tool.failed`, and `turn.event` projection
- no fixed per-turn provider-step or total tool-call ceiling, matching Python behavior

`LS`, `Glob`, and `Grep` are retired and are neither advertised nor implemented by the Node
backend. M4 does not support interactive approval pause/resume, remembered approval rules,
external writable roots, local images, shell execution, MCP, plugins, hooks, subagents,
compaction, memory, queues, or steering. Workspace escapes are denied rather than sent for
approval. An unsupported capability fails explicitly and is never delegated to Python.

## Failure And Rollback

A failed Node turn reports its real terminal error. mycli does not replay it through Python,
because a retry could duplicate provider requests or later tool side effects.

Rollback is operator-controlled and applies before a later turn:

```bash
mycli --runtime-backend=python-sidecar --session <id>
```

Both backends read the shared SQLite schema. Sessions written by the M4 Node slice remain readable
by Python, and Node reopening a database preserves Python-compatible records.

## Verification

Run the deterministic M4 gate after a clean build:

```bash
npm run test:m4
npm run smoke:package
```

Live M4 smoke is opt-in and uses a disposable workspace. It prints only protocol, terminal status,
mutation lifecycle counts, persistence state, file-update state, and `python_started=false`:

```bash
node scripts/smoke_node_m4_mutation.mjs --protocol responses --dry-run
node scripts/smoke_node_m4_mutation.mjs --protocol responses
```

The runner uses `gpt-5.5`, a temporary session database, one small public file, zero retries, a
64-token output cap, and a 45-second deadline. Missing credentials exit with code `77`. CI runs
deterministic M4 and packed CLI smokes on Node 22.19 across macOS, Linux, and Windows. Live requests
run only after the matrix passes on a `main` branch push, through a protected live-test environment
when its secret is configured.

The M4 smoke must run only after every offline gate passes. A passing sanitized result records at
least one completed mutation lifecycle, a durable tool transcript, the expected disposable file
update, and `python_started=false`. Credentials, endpoint data, prompts, tool arguments, original
or final file content, diffs, hashes, and model text are never printed or stored in the summary.
