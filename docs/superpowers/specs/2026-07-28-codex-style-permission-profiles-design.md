# Codex-Style Permission Profiles

## Goal

Replace mycli's separate sandbox, command-permission, and shortcut flows with one Codex-style permission selector while preserving existing session command allowances and legacy slash-command compatibility.

## User Experience

`/permissions` and `Ctrl+X` open the same `Update Model Permissions` selector. The selector contains:

1. **Ask for approval** (`workspace`): read and write the current workspace; require approval for network and access outside the workspace.
2. **Full Access** (`full-access`): unrestricted filesystem and network access without routine approval. Selecting it requires a confirmation step.
3. **Read Only** (`read-only`): read the current workspace; require approval for edits, network, and access outside the workspace.
4. **Command allowances...**: open a secondary view for inspecting and clearing session-scoped command allowances.

The current profile is marked with `(current)`. Arrow keys move selection, Enter confirms, and Escape returns or closes the selector. A successful change appends only one compact transcript notice, for example:

```text
• Permissions updated to Ask for approval
```

## Permission Model

`PermissionProfile` is the canonical session permission state. Built-in profiles map atomically to sandbox and approval behavior:

| Profile | Sandbox | Network | Approval |
| --- | --- | --- | --- |
| `read-only` | read-only | restricted | on request |
| `workspace` | workspace-write | restricted | on request |
| `full-access` | danger-full-access | enabled | never |

Session command allowances remain an independent overlay and survive profile switches. Project trust remains separate: `/trust` decides whether the workspace is trusted, while permission profiles decide what the model may do in the active session.

## Compatibility

- Bare `/permissions` is TUI-owned and opens the selector.
- `/permissions allow|revoke|clear` remains backend-owned and keeps its current behavior.
- `/sandbox` remains a hidden compatibility alias. Explicit legacy modes map to the corresponding profile; `/sandbox next` continues cycling for scripts and older clients.
- Existing `sandbox_mode` configuration remains accepted and is translated to a built-in profile when no explicit permission profile is present.

## Runtime Flow

The gateway bootstrap and status payloads expose the active profile, available built-in profiles, and session allowance count. Selection submits a dedicated permission update request and waits for its acknowledgement before closing.

Permission updates do not call the broad `rebind_session` path because it resets unrelated runtime state. A narrow runtime update changes the session config and policy gate in place. During an active turn, an already-started tool is allowed to finish; subsequent tool decisions use the new profile. New composer input remains deferred until the update acknowledgement is received.

For `full-access`, runtime approval evaluation is bypassed only after sandbox, collaboration-mode, and explicit deny checks. This preserves hard policy denials and protocol invariants while removing routine approval prompts.

## Failure Handling

- A failed or timed-out update leaves the previous profile active.
- The selector stays open and shows a concise error; Python tracebacks are logged, not rendered.
- Unsupported or policy-locked profiles appear disabled with a reason.
- Full Access confirmation can be cancelled without changing state.

## TUI Layout

The selector follows the existing Node TUI overlay architecture and Codex's compact selection layout. Descriptions wrap within the available width, the selected row uses the existing accent style, and semantic labels remain visible without relying on color. Narrow terminals retain a stable single-column list.

## Verification

Tests cover profile mapping, runtime policy behavior, active-turn updates, failed-update rollback, gateway payloads, slash-command ownership, legacy `/sandbox` compatibility, allowance persistence, Full Access confirmation, `Ctrl+X`, keyboard navigation, narrow-width rendering, and compact transcript notices.

## Out of Scope

- Custom user-defined permission profiles
- Reworking project trust semantics
- Enabling the incomplete Windows sandbox implementation
- Revoking or terminating tools that were already executing when permissions changed
