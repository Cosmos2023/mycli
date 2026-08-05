# Node Runtime M5 Rollout

## Current Status

The Node runtime is an explicit preview backend for text turns, the built-in `Read`, `Edit`,
`Patch`, and `Write` tools, and M5 session state and recovery. The default remains
`python-sidecar`. Do not promote Node to the default until the M5 live smoke and the Node 22.19
and Node 24 macOS, Linux, and Windows matrices pass for the release candidate.

Select the preview backend before starting a new turn:

```bash
mycli --runtime-backend=node
```

Use `--model <name>` and `--session <id>` with the same precedence and session semantics as the
existing CLI. A backend owns the complete turn before provider IO or a tool effect begins.

## Supported M5 Scope

- OpenAI Responses and OpenAI-compatible Chat Completions
- streamed text, reasoning, compaction, tool, approval, and terminal events
- bounded runtime-owned retries and interruption
- append-compatible SQLite conversation, history, rollout, state, summary, and idempotency records
- session catalog, bounded transcript replay, lineage, atomic resume, and schema-v2 snapshots
- duplicate `client_turn_id` protection and startup interruption of orphaned running turns
- durable rejected steers, follow-ups, queue revisions, and commit-before-provider ordering
- Node-native `Read`, `Edit`, `Patch`, and `Write` tools with the M4 workspace safety contract
- one-time `approve_once` or `reject` continuation for Node-owned tools
- claimed-effect recovery that reports `effect_outcome_unknown` instead of replaying a mutation
- context-only compaction with raw history retention, durable summaries, and bounded rehydration
- workspace-scoped Markdown memory, bounded deterministic fallback selection, and explicit
  remember/forget actions
- validated Responses continuation metadata with canonical HTTP replay
- Chat canonical replay from persisted conversation items
- Python/Node shared-state compatibility and four-way persistence parity
- user-owned workspace trust decisions that survive Node process restarts
- no fixed per-turn provider-step or total tool-call ceiling, matching Python behavior

`LS`, `Glob`, and `Grep` remain retired. M5 does not support remembered approval rules, external
writable roots, local images, shell execution, PTY/background processes, MCP, plugins, hooks,
skills, or subagents. Automatic background memory extraction and dream consolidation remain
deferred. Unsupported capabilities fail explicitly and are never delegated to Python after a
Node turn starts.

Node stores trust decisions under `~/.mycli/trust/`, keyed by the canonical workspace path. The
TUI waits for the runtime to save the decision before entering the main interface, and corrupt or
mismatched records fall back to `unknown`. Trust payloads still report `enforced=false`: full
runtime policy enforcement for a read-only untrusted mode remains outside the M5 scope, so only a
persisted `trusted` decision dismisses the Node startup gate.

## Recovery And Ownership

Session resume prepares and validates the transcript, queue, approval, compaction, continuation,
workspace, and runtime binding before publishing a new session generation. Corrupt, cross-session,
or unsupported state fails closed without replacing the active session.

Queue input is durable before publication. Pending steers are committed with their history rows,
and rejected steers or follow-ups remain queued until a later turn is reserved. Compaction replaces
only provider context; canonical history and rollouts remain available for replay.

A pending approval belongs to the backend and generation that suspended the turn. Restart the same
Node backend and approve or reject that decision before changing backends. Do not start the pending
continuation through Python, and do not delete its state manually. If recovery finds an effect that
was claimed but lacks a durable result, the turn is interrupted as `effect_outcome_unknown`; the
tool is not executed again.

## Failure And Rollback

A failed Node turn reports its actual terminal error. mycli does not replay it through Python,
because that could duplicate a provider request, queued input, approval, or file mutation.

Rollback is operator-controlled and applies before a later turn, after any pending Node approval
has been resolved or rejected:

```bash
mycli --runtime-backend=python-sidecar --session <id>
```

Both backends read the shared SQLite schema. Sessions written by the M5 Node slice remain readable
by Python, and Node preserves compatible optional Python fields when it rewrites state. Installing
the prior release is also a valid rollback when no newer turn is running or awaiting approval.

## Verification

Run the deterministic M5 gate and the previous milestone regression after a clean install:

```bash
npm run test:m5
npm run test:m4
npm run smoke:package
```

`test:m5` builds the workspace, runs the Node M5 integration suite, and runs the four-way
Python/Node persistence fixture. CI runs that gate plus the packed CLI smoke on Node 22.19 and
Node 24 across macOS, Linux, and Windows.

The opt-in live smoke uses `gpt-5.5`, a disposable home, workspace, database, and session, one
bounded memory topic, forced compaction, zero retries, 64 output tokens per provider request, and
a 30-second deadline:

```bash
npm run smoke:m5
```

The M5 smoke requires a configured non-official compatible endpoint and exits `77` when
credentials or the service are unavailable. It performs no retry after an unavailable request.
Success prints exactly one structural JSON line containing protocol, status, compacted,
memory-visible, resumed, persisted, and `python_started=false` fields. Unavailable runs print the
same shape with false assertions.

The smoke never prints credentials, endpoint data, prompts, memory bodies, summaries, provider
text, raw responses, tool arguments, hashes, database paths, workspace paths, or session paths.
Run it only after the offline gates pass, and do not retry an unavailable paid-service request in
the same verification run.
