# Global Tool Detail Toggle Design

**Date:** 2026-07-21

**Status:** Approved for implementation planning

## Goal

Make `Ctrl+O` reliably toggle all tool and shell details in the full mycli TUI. The action must work regardless of editor focus and must survive subsequent gateway and streaming state updates.

## Current Problem

The keybinding is registered as an editor action. This makes delivery depend on the editor being the focused component. The toggle then mutates projected `MycliShellState` only. A later gateway projection can replace that state with `expanded` values derived from transcript defaults, discarding the user's choice.

The visible symptom is that pressing `Ctrl+O` appears to do nothing.

## User Experience

- `Ctrl+O` is a global TUI action when no modal selector or overlay owns input.
- Pressing it once expands all visible tool and shell details.
- Pressing it again collapses all visible tool and shell details.
- Newly received tool and shell blocks inherit the current local mode.
- Streaming updates do not reset the mode.
- Modal selectors retain exclusive keyboard ownership; `Ctrl+O` does not alter the transcript while a modal is open.
- The existing header and inline hints continue to show `ctrl+o`.

The action remains global rather than adding per-tool focus, selection, mouse handling, or individual expansion state.

## State Ownership

`MycliShellRuntime` owns one local override:

```text
toolDetailMode: default | expanded | collapsed
```

`default` means projected `expanded` values and the persisted visual setting decide initial rendering. The first explicit `Ctrl+O` chooses a concrete mode:

- if any visible expandable block is collapsed, choose `expanded`;
- otherwise choose `collapsed`.

Once explicit, the runtime applies that mode to every tool and shell block whenever `setState()` receives a new gateway projection. Command-result list folding is not part of this override because it is a separate command surface, not tool execution detail.

## Input Routing

The existing TUI input listener handles `Ctrl+O` before input reaches the focused component. It consumes the event after toggling. It ignores the event while an overlay or selector is active so those surfaces preserve keyboard ownership.

The editor action remains as a compatibility path for direct client actions and tests, but both routes call the same toggle method.

## Update Flow

```text
Ctrl+O
  -> global input listener
  -> choose expanded or collapsed mode
  -> apply mode to tools, shells, and transcript tool/shell blocks
  -> rebuild changed components

gateway event
  -> projected MycliShellState
  -> MycliShellRuntime.setState()
  -> apply current local detail mode
  -> incremental component update
```

Session changes keep the explicit mode for the lifetime of the TUI process, matching a global transcript view preference. Restarting mycli returns to the configured default.

## Rejected Alternatives

1. **Editor-only keybinding fix:** smaller, but still fails when focus moves and does not prevent gateway refreshes from resetting the choice.
2. **Persist every tool's expanded field through Python:** adds backend and session schema complexity for presentation-only state.
3. **Per-tool focus and expansion:** useful later, but substantially changes transcript navigation and is outside this bug fix.

## Testing

Add focused tests proving:

- raw `Ctrl+O` input reaches the runtime and changes rendered tool details;
- a second press collapses them;
- a gateway-style `setState()` update preserves the explicit mode;
- a newly added tool or shell inherits the mode;
- modal/selector input does not trigger the global toggle;
- existing Node tests and TypeScript type checking remain green.
