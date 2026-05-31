# Current State

## Existing Behavior

- `DoctorService._check_traces()` validates trace JSONL readability and reports
  valid/invalid row counts.
- `logs_redaction` scans traces for obvious unredacted secrets.
- Runtime now records `model_stream_diagnostics` trace rows with stream timing,
  event counts, text bytes, success, and failure metadata.

## Gap

Doctor does not summarize model stream diagnostics. A user can inspect raw
trace rows manually, but `mycli doctor` cannot yet answer practical questions:

- Have model streams been recorded?
- Were any recent streams failing?
- What are the observed TTFB/elapsed maxima in the inspected window?

## Chosen Slice

Add a read-only `stream_diagnostics` doctor check that scans bounded trace
files and summarizes `model_stream_diagnostics` rows:

- Missing trace dir or no stream diagnostics -> OK, no stream diagnostics found.
- Successful stream diagnostics only -> OK with stream count, max TTFB, max
  elapsed, and total text bytes.
- Any failed stream diagnostics -> WARNING with failure count and bounded
  failure-kind details.
- Invalid trace rows stay owned by the existing `traces` check.
