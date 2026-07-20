# Native Scrollback Streaming Stability Design

## Problem

The shell TUI marks native scrollback history as a one-time full render, but the
flag is never consumed. Every assistant token therefore keeps the full transcript
inside the mutable render buffer. Once a changed line is above the visible
viewport, differential rendering replays the full transcript and the terminal
appears to jump to the top before returning to the input area.

## Design

Native scrollback keeps two distinct phases:

1. On startup or resume, write the complete transcript once so existing history
   remains available in the host terminal's scrollback.
2. After that write, retain the terminal's physical visible tail as the initial
   differential baseline and schedule one normal render to stabilize the bounded
   live frame. Streaming updates then operate on that frame and never rewrite
   committed scrollback history.

When fixed chrome leaves only one transcript row, visible transcript text takes
priority over decorative blank padding and the turn activity spinner.

The regular non-native viewport behavior remains unchanged. Native mode must not
emit clear-screen or clear-scrollback sequences.

## Testing

Add a regression test with a transcript taller than a 16-row terminal and
`nativeScrollback = true`. After the initial render, stream updates into one
assistant message and verify that:

- the initial output contains the complete history;
- subsequent output does not replay an early history marker;
- streaming does not add full redraws or terminal clear sequences.

Keep the existing eight-row terminal test to verify that a newly submitted user
message remains visible when the transcript viewport has only one row.
