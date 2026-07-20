# Codex-Style Native History Replay Design

## Problem

The first native Resume fix replayed the complete component tree as
`header + full transcript + footer`, then stabilized back to a bounded live frame.
The stabilization pass painted the fixed header over a transcript row near the
top of the visible terminal. As a result, `mycli ctrl+p...` appeared inside an
assistant answer. The full-tree replay could also commit selector or footer chrome
to terminal scrollback.

Codex treats committed history and the mutable viewport as separate rendering
channels. mycli needs the same boundary: terminal scrollback receives transcript
rows only, while the header, editor, status, and footer remain in the live frame.

That boundary must remain active after startup. As a new turn grows, transcript
rows leave the bounded tail. If those rows are only removed from the live frame,
a newly submitted user message can be overwritten by a long assistant response
without ever reaching terminal scrollback.

## Design

### Transcript Split

`TranscriptViewportComponent` computes the same bottom-aligned visible range for
both normal rendering and replay. It exposes the transcript prefix before that
range as committed history rows. The live frame continues to render only the
visible transcript tail.

The prefix plus the visible tail represents the complete transcript exactly once.
No tool, message, or plan row is duplicated.

### Continuous Commit Watermark

The transcript viewport tracks how many leading rows have already been committed
at the current terminal width. Startup and Resume reset the watermark after
queuing the initial prefix. Later state updates compare the current visible start
with that watermark and return only the newly hidden rows.

The watermark follows these rules:

- Commit only while the viewport follows the bottom; manual transcript scrolling
  never changes terminal history.
- If the visible start advances, queue `lines[committedStart:visibleStart]` and
  advance the watermark.
- If content shrinks or the prefix changes incompatibly, reset to the current
  visible start without replaying old rows.
- If terminal width changes, reset at the reflowed visible start so wrapped rows
  are not duplicated in scrollback.

Multiple state updates can occur before the renderer consumes a frame. The TUI
history queue therefore appends pending deltas in order instead of replacing the
previous pending rows. This preserves every user, tool, and stable assistant row
that crosses the viewport boundary during fast streaming.

### Atomic History Replay

The TUI accepts transcript rows for insertion before the next native frame. On
that frame it performs one synchronized terminal write:

1. Move from the tracked hardware cursor to viewport row zero and column zero.
2. Replace the current selector or old frame with committed transcript prefix
   rows.
3. Advance and clear one viewport height so all committed rows enter terminal
   scrollback and the current viewport becomes blank.
4. Move back to viewport row zero and draw the bounded live frame, clearing every
   row before writing it.
5. Store the bounded frame as the differential-render baseline.

The operation does not emit clear-screen, clear-scrollback, alternate-screen, or
mouse-capture sequences. Because history insertion and the final frame share one
synchronized write, users do not see an intermediate blank screen.

### Runtime Coordination

Initial startup and session Resume both queue the transcript prefix instead of
calling `renderFullNext()`. A Resume selector remains mounted while the session
and transcript load; after loading, mycli queues replay and restores the editor.
This avoids briefly showing the previous session during the asynchronous load.

After the initial replay, normal state updates ask the transcript viewport for a
newly committed delta after rebuilding changed chat components. If a delta exists,
the runtime queues it through the same atomic history-and-frame renderer used by
Resume. Token updates that do not move the visible boundary stay on the ordinary
differential path.

Non-native terminals retain their existing full-screen behavior. Native token
updates continue through the differential renderer unless they advance the
visible transcript boundary; only that boundary delta enters the history
insertion path, and already committed rows are never replayed.

## Testing

- Verify initial startup writes the transcript prefix once and leaves the header
  only in the final bounded frame.
- Resume through the session selector and verify transcript prefix ordering,
  complete-history coverage without duplication, and no selector/header/footer
  chrome among committed history rows.
- Verify Resume loading keeps the selector mounted until the asynchronous callback
  completes.
- Verify native replay uses synchronized output and emits no clear-screen,
  clear-scrollback, alternate-screen, or mouse-capture sequence.
- After Resume, add a user message and grow a long assistant response until that
  message leaves the live tail; verify the user message is inserted once before
  the live header rather than overwritten.
- Verify several queued history deltas preserve order when they arrive before one
  render frame.
- Verify width changes reset the watermark without replaying old transcript rows.
- Keep existing streaming, resize, and non-native renderer tests passing.
