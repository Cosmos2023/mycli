# Codex-Style Steering Queue Design

## Goal

Make mycli's steering and follow-up queue behave and render like Codex without replacing the existing turn executor or changing model-visible conversation semantics.

The finished experience must:

- show the actual queued message text instead of count-only status;
- distinguish same-turn steering from next-turn follow-up input;
- avoid rendering the same queue state in both the pending area and footer;
- edit only the most recent queued follow-up;
- preserve pending steering when the user interrupts the current turn;
- keep internal task notifications model-visible but absent from user-facing queue previews.

## Existing Behavior

The Python runtime already has two typed queues:

- `steering`: drained before the next model request inside the active turn;
- `follow_up`: started as a later turn after the active turn reaches a terminal state.

The gateway already exposes typed queue items, including text, local images, source, kind, and client turn ID. The TypeScript reducer retains visible queue text internally.

The mismatch is at the interaction and presentation boundaries:

- the projected TUI state exposes only queue counts;
- the pending area renders `Pending input: steer N · follow-up N`;
- the footer repeats the same counts;
- the dequeue action clears and restores every queued item;
- interrupt clears the queues before sending the interrupt request.

## Codex Mapping

mycli will map its existing queue types onto Codex concepts:

| mycli | Codex equivalent | Delivery |
|---|---|---|
| `steering` | pending steer | next tool/result or model-request boundary in the active turn |
| `follow_up` | queued user message | next turn after the active turn finishes |

Codex also has rejected steers for turn kinds that cannot accept steering. mycli does not currently model non-steerable active turn kinds, so this design does not introduce a third queue prematurely. The queue model can add that state later without changing the TUI component contract.

## Backend Design

### Queue Ownership

`AgentRuntime` remains the source of truth for queued input. Existing FIFO consumption remains unchanged:

- steering is consumed from the front at safe in-turn boundaries;
- follow-up input is consumed from the front when the TUI starts a subsequent turn.

### Edit Last Follow-Up

Add a typed operation that removes only the newest `follow_up` item and returns it intact, including images and client turn ID. It must not modify:

- pending steering;
- earlier follow-up items;
- internal task notifications in the steering queue.

Expose the operation through `TurnService` and a new gateway request, `turn.queue.pop`. The response contains the popped typed item plus the remaining queue snapshot. When no follow-up exists, it returns `item: null` and leaves the queue unchanged.

Keep `turn.queue.clear` for backward compatibility and diagnostics, but the TUI edit binding no longer calls it.

### Interrupt Behavior

`turn.interrupt` must not clear either queue. The TUI sends the interrupt request directly. Once the active turn reaches a terminal state, its existing queue drain scheduler prioritizes steering before follow-up input.

This gives pending steering the Codex behavior: interrupt the current work, then submit the pending steer at the earliest valid boundary. Ordinary follow-up messages stay queued.

### Queue Payloads

Continue sending typed `steering_items` and `follow_up_items`. Queue activity counts remain available for protocol consumers, but TUI visibility is derived from filtered user-visible items so hidden task notifications cannot create a phantom pending indicator.

## TUI State

Add a projected pending-input model containing two ordered arrays:

```text
pendingSteering
queuedFollowUps
```

Each item includes the display text and whether local images are attached. The reducer populates these arrays from typed gateway items when present and falls back to legacy string arrays.

Internal `<task-notification>` items remain in backend state but are removed from the projected display arrays and visible queue counts.

The footer no longer renders queue counts. Queue state has one visual owner: the pending-input preview above the composer.

## Pending Input Component

Create a dedicated component modeled after Codex's `PendingInputPreview`.

Pending steering renders first:

```text
• Messages to be submitted after next tool call
  (press esc to interrupt and send immediately)
  ↳ Please inspect the latest output.
```

Queued follow-up input renders second:

```text
• Queued follow-up inputs
  ↳ Summarize the remaining risks.
    alt+up edit last queued message
```

Rendering rules:

- omit empty sections;
- keep steering before follow-up input;
- show one `↳` prefix for the first visual line of each message;
- indent wrapped continuation lines;
- show at most three visual lines per message;
- append an indented `…` when a message exceeds the preview limit;
- sanitize control characters;
- remain width-safe for CJK and ANSI-styled text;
- show the edit hint only when a visible follow-up exists;
- use the existing terminal-specific `Alt+Up` or `Shift+Left` binding label.

The current count-only pending row and its generic `edit all queued messages` hint are removed.

## Interaction Flow

### Submit Steering

1. The user presses Enter during an active turn.
2. The TUI calls `turn.steer`.
3. The backend appends a typed steering item.
4. `turn.queue.updated` refreshes the pending steering preview.
5. The turn executor consumes steering at the next safe boundary.
6. A later queue update removes the committed item from the preview.

### Queue Follow-Up

1. The user presses Tab during an active turn.
2. The TUI calls `turn.follow_up`.
3. The follow-up appears under `Queued follow-up inputs`.
4. After the active turn ends, the existing scheduler starts the oldest follow-up.

### Edit Last Follow-Up

1. The user presses `Alt+Up` or the terminal-specific fallback.
2. The TUI calls `turn.queue.pop`.
3. The backend removes only the newest follow-up.
4. The returned text and image placeholders are restored into the composer before the current draft.
5. Remaining queue items stay visible.

### Interrupt

1. The user presses Escape during an active turn.
2. The TUI sends `turn.interrupt` without clearing queues.
3. Pending steering and follow-up previews remain visible while interruption completes.
4. Steering is submitted first when the runtime becomes eligible to drain queued input.

## Error Handling

- `turn.queue.pop` is idempotent when no follow-up exists.
- A stale local queue is repaired from the queue snapshot returned by every queue mutation.
- Gateway failure leaves local queue state unchanged and displays the existing request error path.
- Hidden internal task notifications never appear in previews or edit results.
- Image attachments survive pop and composer restoration.
- Narrow terminals truncate or wrap previews without moving the composer or footer unpredictably.

## Testing

### Python

- popping the newest follow-up preserves FIFO order for remaining items;
- popping follow-up does not remove steering or task notifications;
- image paths and client turn ID survive the pop response;
- empty pop is idempotent;
- gateway `turn.queue.pop` returns the item and remaining typed snapshot;
- interrupt does not clear either queue;
- steering still drains before the next model request.

### TypeScript

- reducer projects steering and follow-up text separately;
- internal task notifications do not create visible sections;
- pending steering renders before follow-up input;
- multiline and long messages obey the three-line preview limit;
- footer does not repeat queue counts;
- edit binding restores only the newest follow-up and preserves remaining queue state;
- local images survive edit restoration;
- interrupt leaves queue previews intact;
- all rendered lines remain width-safe.

## Acceptance Criteria

- Queue previews match the Codex information hierarchy and wording.
- Actual message content is visible while queued.
- Steering and follow-up semantics remain distinct.
- Queue state is rendered once above the composer and not repeated in the footer.
- `Alt+Up` or `Shift+Left` edits only the newest follow-up.
- Escape does not clear queued input.
- Pending steering is prioritized after interruption.
- Internal task notifications remain hidden from the TUI.
- Existing model requests, tool execution, shell lifecycle, session persistence, and queue compatibility APIs continue to work.
