# Permission And Sandbox Status Research

## Existing mycli behavior

- `ExecutionPolicyCoordinator.snapshot()` already exposes the effective sandbox profile, trust,
  configuration source, managed/runtime constraint source, and active grants. This is the correct
  runtime truth source.
- `NodeGateway.permissionPayload()` currently rebuilds three display rows from the selected profile
  and omits the runtime snapshot. Consequently bootstrap, `permissions.list`, `/permissions`, and
  `/status` cannot explain constrained filesystem/network behavior.
- The TUI duplicates the same profile descriptions in `defaultPermissionState()`, so gateway and
  fallback copy can drift.
- `/status` currently reports session/model/context state but no permission, sandbox, approval, or
  policy-source information.
- doctor uses `prepareSandboxedProcess()` as a provider-free probe. It safely detects unsupported or
  missing platform wrappers, but its result is not available to the gateway or permission selector.
- The Windows helper already has a side-effect-free `--handshake`; the concurrent Windows workstream
  is changing first-use setup behavior and must remain untouched here.

## Codex comparison

Local Codex sources:

- `codex-rs/utils/approval-presets/src/lib.rs`
- `codex-rs/tui/src/chatwidget/permissions_menu.rs`
- `codex-rs/tui/src/status/card.rs`
- `codex-rs/tui/src/chatwidget/windows_sandbox_prompts.rs`

Codex keeps a UI-agnostic built-in preset catalog that pairs approval behavior with a permission
profile. The selector tests whether managed requirements permit each choice and shows a disabled
reason when they do not. `/status` renders the effective permission profile and approval policy,
including custom or constrained states, instead of merely repeating the selected preset. Windows
sandbox setup and repair are separate prompts driven by readiness state.

## Feasible approaches

### A. Enrich the existing gateway projection (recommended)

- Build one bounded permission-status payload from the selected profile, the runtime execution
  policy snapshot, and a cached platform readiness result.
- Reuse that payload in bootstrap, `status.inspect`, `permissions.list`, `permissions.update`,
  `/permissions`, and `/status`.
- Extend the TUI model/selector to render the effective filesystem, network, approval behavior,
  source, and constraint note.
- Add provider-free `mycli sandbox status` and make doctor consume the same readiness classifier.

Pros: reuses the established runtime security boundary, minimal migration risk, no second policy
engine, and leaves native setup mutation isolated. Cons: setup/reset remain a later Phase 4 slice.

### B. Introduce a full sandbox management service now

- Add status/setup/reset, native helper orchestration, gateway recovery, and policy projection in one
  batch.

Pros: completes all Phase 4 commands at once. Cons: overlaps the active Windows helper/CI work,
mixes read-only projection with elevated mutation, and increases cross-platform release risk.

## Decision

Use approach A. Treat the runtime snapshot as authoritative, keep readiness inspection
side-effect-free and bounded, and make setup/reset a follow-up that consumes the same readiness
contract. Do not edit native Windows files or interpret raw helper errors in the TUI.

## Expansion sweep

- Future evolution: the readiness payload can add setup/retry/reset actions without changing the
  effective-policy fields; Phase 5 settings can reuse the same profile descriptors.
- Related surfaces: bootstrap, status events, permission selection, slash status, doctor, and the
  management CLI must agree on stable readiness terms.
- Failure cases: missing executable, unsupported platform, handshake timeout/malformed data,
  untrusted workspace, managed constraints, and a profile update that produces less access than its
  nominal preset must remain bounded and fail closed.
