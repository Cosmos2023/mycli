# Terminal Accessibility Completions And Non-TTY UX

## Goal

Deliver OMX Phase 8 so mycli remains usable across terminal capabilities, keyboard needs, CJK/IME
input, narrow layouts, automation shells, and environments without color or special glyph support.

## Depends On

- `08-31-ux-baseline-drift-gates`.

## Requirements

- Add configurable keymaps with validation, conflict diagnostics, reset behavior, and a searchable
  effective keymap viewer.
- Add semantic `auto|truecolor|256|16|none` color capability modes, reduced motion, ASCII glyph
  fallback, progress animation control, and a small high-contrast token set.
- Detect terminal capabilities once, project bounded degradation guidance, and never require emoji,
  Nerd Fonts, mouse input, or truecolor.
- Preserve ordinary editing, CJK IME, bracketed paste, undo, resize, selector focus, and Esc behavior.
- Generate bash, zsh, fish, and PowerShell completions from the canonical CLI registry and enforce
  drift against parser/help behavior.
- Define non-TTY chat behavior explicitly: management commands remain ordinary stdout; interactive
  chat either uses a separately specified execution contract or exits with one concise next action.
- Split implementation into reviewable batches for terminal capability/config contracts, TUI
  projection, keymaps, completions/non-TTY, and final regression coverage.

## Acceptance Criteria

- [ ] All primary TUI journeys are keyboard-complete and cancelable under default and custom keymaps.
- [ ] Key conflicts fail safely and leave the prior effective keymap unchanged.
- [ ] Semantic tokens remain legible in every supported color mode; no-color output contains no ANSI.
- [ ] ASCII/reduced-motion modes remove unsupported glyph/animation assumptions without changing
  transcript meaning or layout dimensions.
- [ ] CJK IME, paste bursts, resize/shrink, long paths, and widths 60/80/100/140 pass regressions.
- [ ] Generated completions match root help and management parser behavior through drift tests.
- [ ] Non-TTY invocation never mixes TUI control sequences with ordinary stdout/stderr.

## Technical Approach

Keep terminal capability and preference decisions in typed backend/config descriptors, then map them
to semantic TUI theme/glyph/motion tokens. Generate completions from the existing canonical command
metadata instead of maintaining shell-specific command lists.

## Decision (ADR-lite)

Ship capability adaptation and standard editing first. Vim mode is deferred until default editing,
IME, paste, selection, undo, and keymap conflicts remain stable under the new contract.

## Definition Of Done

- Config/gateway/TUI/CLI tests plus lint, typecheck, contracts, build, and packed artifact smoke pass.
- Accessibility, keymap, completion, terminal, and automation documentation is current.
- The task is committed, archived, and journaled independently.

## Out Of Scope

- A theme marketplace, mandatory mouse support, or mandatory special fonts.
- Vim mode in the first delivery unless separately approved after base editing gates pass.
- Redesigning the agent protocol merely to add a broad non-interactive execution API.

## Technical Notes

- Parent: `08-31-codex-ux-roadmap-completion`.
- This is the largest remaining implementation and may be decomposed into child batches during its
  own brainstorm without changing the parent roadmap.
