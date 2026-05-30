# Node TUI Clarify Request Consumption Research

## Existing Behavior

- Runtime now emits `clarify.request` as a typed gateway notification and as a
  `runtime.event` mirror.
- Node protocol types already include `ClarifyRequestPayload` because the
  runtime contract slice extended the gateway event union.
- The reducer currently handles approval, status, tool lifecycle, message,
  reasoning, terminal turn status, and envelope unwraps.
- `approval.request` writes both `pendingApproval` and an `approval` transcript
  item. This is not a good fit for clarification because approval is a safety
  gate with numeric response shortcuts, while clarification is user-input UX.
- Transcript grouping has an `approvals` bucket rendered before tool rows, plus
  generic notice/error buckets. Adding a separate `clarification` bucket keeps
  display semantics explicit without changing approval behavior.

## Recommended Slice

- Add `pendingClarification` to `ShellState`.
- Add transcript item type `clarification`.
- On direct or envelope `clarify.request`, store the payload in
  `pendingClarification` and append one visible clarification transcript item
  to the current turn.
- Render clarification rows as compact system-style question blocks:
  title/header, question text, and option labels/descriptions.
- Add `clarification pending` to the status metadata while pending.
- Clear `pendingClarification` on terminal turn state or a future-compatible
  `clarify.respond` event if it arrives.

## Boundaries

- Do not add `clarify.respond` request sending.
- Do not capture numeric keys or reuse `ApprovalPrompt`.
- Do not block input differently from existing turn-running behavior.
- Do not alter runtime/Python gateway emission.

## Risks

- Showing options without a response loop could imply the user can answer in
  place.
  - Mitigation: label it as a clarification request and avoid keybinding hints.
- Duplicating direct and envelope events could duplicate transcript rows if both
  are fed to the reducer.
  - Existing production client ignores `runtime.event`; reducer tests should
    still prove envelope unwrapping works when used alone.
- Adding a new transcript type can break grouping/render tests if not classified
  explicitly.
  - Mitigation: add display model and rendering tests.
