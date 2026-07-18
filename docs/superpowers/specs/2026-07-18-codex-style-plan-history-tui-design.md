# Codex-Style Plan History TUI Design

**Date:** 2026-07-18

**Status:** Approved

## Summary

mycli currently renders `activePlan` in a dedicated panel directly above the user composer. The panel is updated from live `plan.updated` events and removed when a completed turn reports that every step is complete. This differs from Codex.

Codex treats `update_plan` as an append-only transcript event. Each update becomes an `Updated Plan` history cell, while the latest completed/total count may be exposed as compact task progress in a status surface. The full checklist is not maintained as a separate composer-adjacent panel.

mycli will adopt that behavior. Plan updates will become durable, ordered transcript items; the composer panel will be removed; and the footer will expose only the latest compact task count.

## Goals

- Render every successful Plan state change as an ordered `Updated Plan` transcript block.
- Preserve all rendered Plan updates across session resume.
- Make live rendering and resumed rendering use the same canonical payload and component.
- Remove the full Plan panel from above the composer.
- Show the latest task count as compact footer state, for example `Tasks 2/5`.
- Keep proposed plans distinct from execution checklist updates.
- Keep Plan history width-safe for narrow terminals, long tokens, and CJK text.

## Non-Goals

- Do not change Plan tool semantics, validation, or model-facing schemas.
- Do not change Plan mode or proposed-plan generation.
- Do not collapse all Plan updates into a single mutable transcript row.
- Do not make historical Plan updates model-visible; the existing Plan tool call/result remains the model-facing record.
- Do not add Plan editing, selection, or keyboard controls.

## Codex Reference Behavior

The Codex TUI handles `TurnPlanUpdated` by converting it to `UpdatePlanArgs` and calling `on_plan_update`. That method:

1. Computes completed and total task counts.
2. Refreshes status surfaces with the latest count.
3. Appends `new_plan_update(update)` to history.

`PlanUpdateCell` renders `Updated Plan`, an optional explanation, and the complete checklist. Completed steps use a checked marker and dim styling, the in-progress step is emphasized, and pending steps are dimmed. This history cell remains in scrollback after the turn completes.

## Canonical Data Contract

Introduce a durable TUI-facing Plan update item with this logical shape:

```json
{
  "type": "plan_update",
  "text": "Updated Plan",
  "metadata": {
    "source": "Plan",
    "completed": 1,
    "total": 3,
    "items": [
      {"id": "inspect", "text": "Inspect runtime", "status": "completed"},
      {"id": "render", "text": "Render history cell", "status": "in_progress"},
      {"id": "verify", "text": "Run tests", "status": "pending"}
    ]
  }
}
```

The item is persistent and TUI-visible but model-hidden. Provider request projection must continue using the existing Plan tool call/result and must not inject a second Plan representation into model context.

The payload is generated from `PlanState`, not reparsed from display strings. IDs, statuses, text, and bounded evidence remain structured until the TUI rendering boundary.

## Runtime And Persistence Flow

When a successful Plan tool call produces a `PlanState` different from the
currently persisted state:

1. Runtime applies the Plan effect and persists the new `PlanState` as it does today.
2. Runtime appends a `PLAN_UPDATE` turn item at the exact position of the state change.
3. The live lifecycle sink emits `plan.updated` using the same structured payload.
4. Runtime history persistence stores the Plan update as a model-hidden history item.
5. Session snapshot projection includes it as a `plan_update` TUI transcript item.

This produces one ordered source for resume without replaying `events.jsonl` or reconstructing Plan updates from the latest state. Every update is retained, including multiple updates in one turn.

A successful no-op Plan call does not append a history item or emit a visible
update. A later update may repeat the same step text, but it is still retained
when any structured Plan field changed.

Older sessions without durable Plan update items remain valid. They simply have no historical `Updated Plan` cells. The current saved `PlanState` is not synthesized into old transcript history because that would invent ordering and duplicate uncertain state.

## Gateway Behavior

The live `plan.updated` event remains supported, but its schema is strengthened to carry the structured Plan object and optional source in addition to the compatibility `plan_steps` strings.

`transcript.load` and `session.bootstrap` return persisted `plan_update` items in their original order. The Gateway does not create composer state from the latest Plan and does not deduplicate separate updates.

Mirrored `runtime.event` envelopes continue to use the existing event deduper, so one backend update produces one visible history block.

## TUI State And Rendering

Remove `activePlan` from `RuntimeShellState` and `MycliShellState`, remove `PlanPanelComponent` mounting from both static and live shell paths, and delete completed-plan clearing logic.

On live `plan.updated`, the reducer seals any active assistant stream and appends a `plan_update` transcript item. It must not overwrite an earlier Plan update. Persisted `plan_update` items map to the same `MycliShellPlanUpdate` model during bootstrap.

`PlanUpdateComponent` renders:

```text
• Updated Plan
  └ ✔ Inspect runtime state
    □ Render Plan history
    □ Verify resume behavior
```

Rendering rules:

- Completed: `✔`, dim, and crossed out when terminal support allows it.
- In progress: `□`, accent color, bold text.
- Pending: `□`, dim text.
- Continuation lines align under step text.
- All steps render; there is no composer-height cap because the block lives in scrollback.
- Width calculations use terminal cell width and adaptive wrapping, not string length.
- Empty plans render `(no steps provided)` rather than an empty box.

Proposed plans continue to use `ProposedPlanComponent` and remain separate transcript items.

## Footer Progress

The runtime state tracks only the latest Plan update count for the footer:

```text
Tasks 2/5
```

The count is updated by live Plan events and reconstructed from the last persisted `plan_update` item on bootstrap. It remains available after turn completion and is replaced by the next Plan update. Empty plans clear it.

The footer treats task progress as optional and drops it before higher-priority status text when width is constrained.

## Error And Compatibility Behavior

- Failed Plan tool calls do not append Plan update history.
- A malformed live Plan payload is ignored without corrupting existing transcript state.
- Compatibility `plan_steps` strings are accepted when the structured `plan` object is absent.
- Unknown statuses normalize to `pending`.
- Duplicate direct and mirrored events are filtered by the existing Gateway event deduper.
- Historical `activePlan` is not required during bootstrap; its absence is backward compatible.

## Testing

### Python

- Plan state changes append a model-hidden `PLAN_UPDATE` history item in turn order.
- Multiple Plan calls persist multiple update items.
- Provider context excludes Plan update history items.
- Session snapshots include structured `plan_update` TUI items.
- Gateway live and resumed payloads share the same item shape.
- Failed and unchanged Plan calls do not append update history.

### TypeScript

- A live Plan update appends instead of replacing a previous update.
- Direct plus mirrored events render once.
- Bootstrap maps persisted Plan updates in order.
- The composer has no active Plan panel.
- Footer task counts update, persist after completion, and clear on an empty Plan.
- Completed, active, pending, empty, wrapped, narrow-width, and CJK rendering snapshots pass.
- Proposed plan rendering remains unchanged.

### Full Gates

- `uv run pytest -q`
- `uv run ruff check .`
- `uv run mypy src/mycli`
- `npm --prefix tui/mycli-shell test`
- `npm --prefix tui/mycli-shell run typecheck`

## Acceptance Criteria

- No full Plan checklist is mounted above the input composer.
- Every successful Plan update appears as a separate `Updated Plan` history block.
- Live and resumed sessions show the same Plan update order and content.
- Completed Plan history remains visible in scrollback.
- The footer exposes only compact latest progress.
- Plan update history never duplicates model context.
- Existing proposed plans and old sessions continue to render correctly.
