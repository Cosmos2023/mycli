# Doctor Approval Safety Metadata Current State

## Context

The prior slice added bounded `safety_metadata` to approval safety decisions,
approval outcomes, and approval allowance/auto-allow diagnostics. The field is
now present in local trace/log rows but doctor does not summarize it yet.

## Existing doctor behavior

- `approval_diagnostics` scans trace JSONL rows for:
  - `approval_resolution`
  - `approval_allowance`
  - `approval_auto_allowed`
- It reports total counts, resolution counts, allowance counts, auto-allowed
  counts, and resolution result counts.
- Warning output reports only allowlisted result counters.
- It intentionally avoids raw command patterns, reasons, headers, provider
  text, user text, and secret-like values.

## Gap

Hermes-like diagnostics should be able to explain safety posture without raw
payloads. With `safety_metadata` present, doctor can report bounded aggregate
counts such as how many approval diagnostics include safety metadata, and which
safe risk levels or policy identifiers are present.

## Slice direction

Extend the approval diagnostics summary with allowlisted aggregate metadata:

- `safety_metadata=<count>`
- `risk_levels: high=<n>, medium=<n>, low=<n>` in detail when present
- `policies: shell_command_analysis=<n>, ...` in detail when present

Do not print command patterns, reasons, tool arguments, file paths, or raw trace
payloads.
