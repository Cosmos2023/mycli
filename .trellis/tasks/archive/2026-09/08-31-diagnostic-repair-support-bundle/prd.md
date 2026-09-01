# Diagnostic Repair And Support Bundle

## Goal

Close the remaining OMX Phase 7 recovery gaps with deterministic doctor repairs and a bounded,
redacted support bundle built on the existing diagnostic taxonomy.

## Depends On

- `08-31-config-migration-reference`.
- `08-31-sandbox-setup-platform-recovery`.

## Requirements

- Add `doctor --fix` as preview-first typed repair plans for deterministic local actions only.
- Require explicit confirmation for interactive apply and an unambiguous opt-in flag for non-TTY
  apply; default behavior performs no repair.
- Add a support-bundle export containing versions, platform, bounded diagnostic rows, config layer
  metadata, sandbox/session/extension readiness, and safe log references.
- Exclude prompts, commands, tool content, provider bodies, credentials, headers, unnecessary raw
  paths, and internal stacks through structural allowlisting plus redaction tests.
- Make repairs idempotent, individually reported, and resilient to concurrent state changes through
  expected versions or fresh preconditions.
- Never make provider calls, install packages, elevate privileges, or upload a bundle implicitly.

## Acceptance Criteria

- [x] Preview/apply/cancel/version-conflict/partial-failure behavior has provider-free tests.
- [x] A repair cannot mutate state not shown in its preview.
- [x] Support bundle content is schema-bounded, deterministic, private on disk, and fuzz-tested for
  nested secrets, credential URLs, control characters, and local-path leakage.
- [x] Text and JSON doctor output stay compatible and reference the same repair/support metadata.
- [x] One root failure remains one primary TUI diagnostic after repair actions are added.

## Technical Approach

Represent repairs as typed plans issued by authoritative collectors, then execute through their
owning services. Build support output from allowlisted diagnostic DTOs rather than scraping rendered
text or logs.

## Definition Of Done

- Focused doctor/config/sandbox/storage/TUI tests plus lint, typecheck, contracts, and packed app
  smoke pass.
- Troubleshooting and support documentation explain preview, apply, bundle contents, and privacy.
- The task is committed, archived, and journaled independently.

## Out Of Scope

- Remote support upload, telemetry, automatic self-update, package installation, or elevation.
- Arbitrary shell-based repair scripts.
- Replacing specialized config/provider/sandbox error owners.

## Technical Notes

- Parent: `08-31-codex-ux-roadmap-completion`.
- Extend the archived Phase 7 diagnostic contracts rather than starting a second error module.
