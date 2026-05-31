# Turn Status Display Diagnostics Research

## Existing Behavior

- `StatusLine.statusMetadata(...)` builds a compact footer string from session,
  model, theme, context usage, live status text, and approval marker.
- Completed live status is intentionally hidden to avoid sticky success noise.
- `LiveStatus` currently includes `state`, `kind`, `text`, optional
  `client_turn_id`, and optional `severity`.
- `turn.status` payloads can include `message`, but the reducer has nowhere to
  store it yet.
- `RunningActivity` already prioritizes concise status text and should not be
  made noisy with full error details.

## Recommended Approach

- Add optional `message` to `LiveStatus`.
- Reuse `liveStatusFromParams(...)` so both `turn.status` and `status.update`
  can carry detail if provided.
- Add a small `statusLabel(...)` helper in `StatusLine.tsx` that formats
  `text: bounded message`.
- Keep the bound conservative, around 48 characters, because status metadata is
  rendered in a single terminal row with model/session/context data.

## Risks

- Long provider or runtime errors could make the footer unreadable.
  - Mitigation: truncate detail with the existing `truncateMiddle(...)` helper.
- Showing completed detail could create sticky noise after successful turns.
  - Mitigation: preserve the existing `state !== "completed"` guard.
- Duplicating error content in transcript and status line could feel noisy.
  - Mitigation: status line only shows a bounded single-line detail; transcript
    remains the authoritative error row.

## Out Of Scope

- No new panels or overlays.
- No RunningActivity changes.
- No event contract changes.
- No Python runtime changes.
