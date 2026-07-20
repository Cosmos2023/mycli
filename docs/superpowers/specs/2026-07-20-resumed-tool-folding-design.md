# Resumed Tool Folding Design

## Problem

Native session resume now writes the complete visible transcript into terminal
scrollback. Historical tool records commonly omit an explicit `folded` value.
The runtime currently applies the global `tool_details_default` setting to those
records, so a user configured for expanded live tools sees every historical tool
detail expanded during resume.

## Behavior

Resumed tool and shell records use collapsed as their fallback presentation:

- `folded: false` remains expanded.
- `folded: true` remains collapsed.
- A missing `folded` value becomes collapsed for resumed history.

Live tool events continue to use `tool_details_default`. This preserves the
existing preference for newly executed tools without allowing that preference to
inflate an entire restored transcript.

The complete visible transcript is still inserted once into native scrollback.
Only each historical tool's detail density changes; transcript ordering,
summaries, errors, commands, and retained output data remain unchanged.

## Implementation Boundary

Apply the fallback while constructing runtime state from persisted transcript
items, before shell projection. Do not change the shared tool component or the
global setting because both are also used by live events.

## Testing

- A resumed tool without `folded` is collapsed even when
  `tool_details_default` is `expanded`.
- A resumed tool with `folded: false` remains expanded.
- Live tools without an explicit fold state still honor
  `tool_details_default = expanded`.
- The native resume regression continues to write complete history once without
  clearing terminal scrollback.
