# Adaptive Footer Design

## Goal

Replace mycli's current three-line composer footer with a quieter two-line footer that preserves the information needed for the current interaction and removes persistent default-state noise.

## Layout

The footer always uses two base rows:

```text
~/.../termcn-tui-polish  * Session title                         (feature/tui)
enter send  *  tab follow-up                    trust? | 11% ctx | model * medium
```

The first row identifies the working context. The second row places currently available actions on the left and current runtime state on the right. Extension status lines may still appear below these rows because they are owned by extensions rather than the base footer.

## Information Rules

### Working-context row

- Show the shortened working directory and session title.
- Show the Git branch only when the available width can hold it without displacing the session title.
- On narrow terminals, shorten the path first, then hide the Git branch. Preserve the session title for as long as possible.
- Sanitize control characters and keep every rendered line within the terminal's visual width, including CJK text.

### Action and status row

- The left side contains only actions available in the current state.
- Show `enter send` while idle and `enter steer` while a turn is running.
- Show `tab follow-up` while input can be queued.
- Show `ctrl+c interrupt` only while a turn is running.
- Show `option+up edit follow-up` only when queued input exists.
- The right side may show exceptional trust state, non-default collaboration mode, context usage, active background terminals, task progress, live state, model, and reasoning level.
- Hide `trust trusted`, `mode default`, and `Idle` because they describe the normal state.
- Hide the provider. The model name is sufficient in the normal footer.
- Do not show cumulative token counts, cache counters, hit rate, or cost. `/usage` remains the detailed usage surface.

## Responsive Degradation

Footer content is dropped by meaning rather than by arbitrary string truncation.

1. Preserve path, session title, and the primary `enter` action.
2. Preserve exceptional state such as untrusted mode, running state, or background terminals.
3. Preserve context percentage and model when space permits.
4. Drop Git branch, secondary action hints, reasoning level, task progress, and model metadata before primary context.
5. Truncate the remaining path or title only after optional segments have been removed.

The renderer must never wrap a base footer row or exceed the supplied terminal width.

## Architecture

`FooterComponent` owns both adaptive rows. `MycliShellRuntime.rebuildFooter()` supplies interaction state to the component instead of rendering a separate permanent `Message mycli` hint line. The existing footer data remains the source of workspace and runtime state; a small action-state input carries whether a turn is running and whether queued input exists.

Keeping the layout in one component gives it a single width budget and allows semantic degradation across both sides of each row.

## Testing

Component tests cover idle, running, queued-input, Plan, untrusted, and background-terminal states at wide and narrow widths. They verify that defaults and detailed usage counters are absent, session title outranks Git branch, conditional actions appear only when available, CJK and long paths remain width-safe, and the base footer stays at two rows.

Runtime tests verify that the old `Message mycli` row is removed and footer action state updates when a turn starts, completes, or gains queued input.
