# Per-Request Provider Usage In The Runtime Trace

## Problem

Cache accounting was only durable per turn: `runtime_turns.result_json.usage` aggregates every
provider step of a turn, and `turn_lifecycle` keeps the last request's usage. Answering "which
request missed the cache" required rebuilding the model-input ledger and estimating the new content
per step.

## Change

Each provider attempt now carries its own usage:

- `ProviderStreamDiagnostics` gains an optional `usage: ProviderUsage` (input, output, total,
  reasoning, cached and cache-write/read variants), attached when the attempt settles — on success
  and on failure, so partial usage is preserved.
- Worker-run provider steps travel through the agent-worker RPC. The diagnostic parser accepts
  `usage` behind the existing `streamDiagnosticsVersion: 1` opt-in; the sanitizer used for older
  coordinators is unchanged, so an old coordinator never receives the new field.
- The node runtime trace writes the usage numbers flat into the `model_stream_diagnostics` row
  (the same layout the compaction rows already use) and the trace reader whitelists them, keeping
  only safe non-negative integers.

## Reading it

```
node --conditions=mycli-source --import tsx native/windows-sandbox-helper/build/session-audit/per-request-usage.mts <sessionIdPrefix>
```

The report prints each request's `input`, `cached`, `miss` and hit rate, subtotals per turn
(including the first request versus later requests), the session total, and the largest single
request misses. Sessions that ran before this change have no usage rows and say so.

## Verification

- `backend/packages/runtime/test/providers/provider-agent-loop.test.ts` asserts the attempt
  diagnostics carry the streamed usage.
- `backend/packages/runtime/test/workers/agent-worker-provider-rpc.test.ts` asserts the worker
  diagnostic envelope round-trips usage and rejects negative, non-numeric, or malformed keys.
- `backend/apps/mycli/test/node-runtime-trace.test.ts` asserts the trace writer/reader keeps the
  usage numbers and drops unsafe or unknown ones.

Unit suite: 375 files pass.

## Limits

- The trace rotates at 5 MiB, so per-request rows are a recent window rather than a full archive.
- Only requests that actually emitted provider usage are recorded; estimates are never invented.
