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

## Design

### Transcript Split

`TranscriptViewportComponent` computes the same bottom-aligned visible range for
both normal rendering and replay. It exposes the transcript prefix before that
range as committed history rows. The live frame continues to render only the
visible transcript tail.

The prefix plus the visible tail represents the complete transcript exactly once.
No tool, message, or plan row is duplicated.

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

Non-native terminals retain their existing full-screen behavior. Ordinary live
streaming and incremental transcript growth continue through the differential
renderer and do not replay committed history.

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
- Keep existing streaming, resize, and non-native renderer tests passing.
