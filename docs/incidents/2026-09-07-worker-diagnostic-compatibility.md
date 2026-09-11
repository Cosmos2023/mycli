# Successful Provider Attempts Followed By Generic Turn Failure

## Evidence

The reported session's two latest failures on September 7 have the following
durable timestamps (Asia/Shanghai):

| Turn | Started | Provider attempt completed | Turn failed |
| --- | --- | --- | --- |
| `turn_7ab3b22f0167486f9c0074f5502a1ebb` | 22:29:21.168 | 22:30:08.819 | 22:30:09.167 |
| `turn_67754be749b54dec8e4adfa5cd9cfc46` | 22:30:53.894 | 22:31:20.056 | 22:31:20.376 |

Both provider requests were dispatched. Each attempt ledger contains `started`
and `completed`, with no retry and no failed provider attempt. The policy
allowed four request retries and five stream retries. Neither request received
the later provider-step `acknowledged` record or a model-stream diagnostic.
The turns persisted only the generic `provider_error` and its canonical message.
No assistant/tool-call batch was persisted for either failed turn.

A mycli process started at 18:57:29 was still running from this worktree. The
runtime and Worker artifacts had been rebuilt at 20:52:33 with new completion
timing fields. The session's preceding long turn started at 20:38:24 and ended
at 22:01:32, with the older diagnostic shape throughout. A later Worker can
load the rebuilt modules while the coordinator retains modules already loaded
in memory. Restarting the coordinator is required to load a consistent build.

The original raw exception was not persisted, so these records alone cannot
recover its stack. They locate the failure after remote attempt completion and
before coordinator result acceptance. Offline tests reproduced the incompatible
diagnostic path below, including the exact exception discarded by that boundary.

## Root Cause

1. Completion timing added optional fields to `ProviderStreamDiagnostics`, and
   the new Worker emitted them without checking coordinator support.
2. The older coordinator's strict parser rejects these fields with
   `agent_worker_provider_rpc_error: provider stream diagnostic has invalid fields`.
3. `WorkerProviderStepExecutor` treated every response parse failure as fatal,
   including this auxiliary diagnostic sent immediately before the real result.
   It terminated the lease and discarded the queued successful provider result.
4. Turn runtime converted the local exception to a generic `provider_error`,
   losing the explanation. The remote attempt had succeeded, so retrying the
   upstream error path could not repair this local failure.

The offline reproduction used a real Worker and a loopback provider, then checked
its output against the pre-timing coordinator allowlist. The unpatched Worker
sent six unsupported timing fields. Separate executor tests reproduced the
fatal diagnostic parser exception after a committed successful attempt. No
real model requests or modifications to the affected session were needed.

## Fix

- A current coordinator explicitly requests `streamDiagnosticsVersion: 1`.
  Without that field, the Worker emits the fixed legacy diagnostic shape.
  Current peers continue to exchange full completion timing.
- The coordinator validates diagnostic envelopes, byte limits, identities and
  sequence before parsing advisory content. Invalid diagnostic content is
  dropped while retaining sequence continuity; canonical event, attempt and
  result validation remains strict.
- A Worker advances its outgoing sequence only after the frame is validated
  and sent. A contained diagnostic failure cannot leave a missing sequence.
- Typed Worker RPC failures retain `error_source=worker_rpc` and a fixed public
  explanation to restart mycli and reload matching modules. They remain local,
  non-retryable failures and never expose raw exception text as public detail.

This is compatibility for the diagnostic extension, not a general guarantee for
arbitrary in-place rebuilds or runtime protocol changes. Already loaded Workers
also retain their current code. Restart the affected mycli process and resume
the session after the rebuild. Do not promote historical failed turns to success
based only on an attempt-completed record: their actual response was not committed.

## Bug Analysis

### 1. Root Cause Category

- B, cross-layer contract: best-effort diagnostics became fatal at the RPC parser.
- D, coverage gap: tests covered matching builds and throwing diagnostic sinks,
  but not an older coordinator consuming newer diagnostic fields.
- E, implicit assumption: a rebuild was assumed to update an active coordinator
  and a newly created Worker together. Node module caches do not provide that.

### 2. Why Earlier Verification Missed It

The previous complete suite used freshly loaded matching modules. Its observer
failure tests contained callback exceptions within one version. The live
provider-only latency probe also had no long-running coordinator or Worker RPC.
Those checks could pass while an older user process still rejected new fields.

### 3. Prevention Mechanisms

| Priority | Mechanism | Status |
| --- | --- | --- |
| P0 | Explicit opt-in for extended diagnostic payloads; fixed legacy projection | Implemented |
| P0 | Isolate advisory payload errors after validating the fence | Implemented |
| P1 | Real Worker regression against the legacy field allowlist | Passing |
| P1 | Keep local protocol failure detail through the canonical error boundary | Passing |

### 4. Systematic Expansion

Other strict Worker command/result changes can also fail across in-place
rebuilds. Their authoritative payloads must not be relaxed under the diagnostic
exception. Use explicit version/capability decisions and restart matching runtime
modules; deployment-wide immutable builds are outside this incident's fix.

### 5. Knowledge Capture

- Logging guidelines now define negotiation and advisory RPC isolation.
- Error-handling guidelines now require safe local Worker failure detail.
