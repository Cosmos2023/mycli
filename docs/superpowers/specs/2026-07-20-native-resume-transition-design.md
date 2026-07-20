# Native Resume Transition Design

## Problem

Selecting a saved session replaces most of the inline TUI at once. When the
differential renderer falls back to a full redraw on a native-scrollback terminal,
it writes the new frame from the current cursor position instead of the tracked
viewport origin. The old footer and new header can therefore join as
`mediummycli`, and the selector may be pushed into scrollback as stale UI.

The selected session's complete transcript is loaded into memory, but the
transcript viewport's one-time full-history mode was consumed during startup, so
resume does not deliberately insert the newly loaded history into scrollback.

## Design

After a session selection callback finishes loading state, the shell runtime marks
the transcript for one full render and requests a frame. The complete selected
history is inserted once, then the existing native-scrollback stabilization path
returns rendering to the bounded live viewport.

For a non-initial full redraw on a native-scrollback terminal, the renderer moves
from the tracked hardware cursor to the top row of the current viewport, returns
to column zero, and clears each row before writing it. It does not clear the
screen or terminal scrollback. This replaces the selector in place and prevents
the old footer from joining the new header.

## Testing

- Resume through the session selector and verify the oldest loaded history item is
  written once, the selector is absent from the replacement output, and no
  clear-screen sequence is emitted.
- Force a native full redraw from a cursor below the viewport origin and verify the
  output moves upward and returns to column zero before writing the first new row.

