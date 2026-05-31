# Current State

## Existing Behavior

- Runtime approval decisions already append local trace/log diagnostics:
  - `approval_resolution`
  - `approval_allowance`
  - `approval_auto_allowed`
- Integration tests prove these trace/log rows are written for rejection,
  invalid choices, session-scoped allowance creation, duplicate allowance, and
  session-allowance auto approvals.
- `DoctorService` already scans trace JSONL for malformed trace rows and
  summarizes `model_stream_diagnostics`.
- Doctor does not currently summarize approval diagnostics, so local operators
  cannot quickly answer whether a workspace has many rejected/invalid/missing
  approval resolutions or session allowance hits without manually reading trace
  JSONL.

## Gap

Hermes-like local agent foundations should be diagnosable after the fact.
Approval state-machine issues are safety-sensitive, so doctor should summarize
approval trace rows in a bounded, non-secret-leaking way.

## Chosen Slice

Add a read-only `approval_diagnostics` doctor check that scans existing trace
files and reports bounded counts for approval resolution, allowance, and
auto-allowed rows. Invalid or suspicious approval-resolution outcomes should
produce a warning summary, not raw payload output.

This slice does not change approval behavior, policy, gateway events, or trace
row shape.
