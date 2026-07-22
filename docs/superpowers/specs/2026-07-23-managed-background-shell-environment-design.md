# Managed Background Shell Environment Design

## Problem

mycli's `Shell` tool can manage a long-running foreground process after its initial yield,
but it cannot adopt a child that a wrapper script has detached with `nohup`, `disown`, or
an equivalent daemonization mechanism. The Visual Companion server currently follows that
detached path, so the wrapper exits successfully and `/ps` has no live Shell session to list.

## Decision

Follow Codex's cooperative process-management model instead of scanning the operating-system
process table. Every mycli-managed Shell environment exposes `MYCLI_CI=1`. Scripts that need
to survive across turns use this marker to remain in the foreground and let the Shell runtime
yield them into its background process store.

The Visual Companion startup script will treat `MYCLI_CI` like Codex's `CODEX_CI`: unless the
caller explicitly forces background mode, it switches to foreground mode. Explicit
`--background` continues to override automatic foreground selection.

## Behavior

1. `create_shell_environment()` adds `MYCLI_CI=1` after filtering user-provided environment
   variables, so restrictive inheritance policies cannot remove the runtime marker.
2. The Visual Companion startup script sees `MYCLI_CI=1` and keeps its Node server attached
   to the invoking Shell process.
3. If the process remains alive at `yield_time_ms`, the existing Shell session manager marks
   it as `background=true` and `process_state=running_background`.
4. `/ps` lists the managed session and `/stop` terminates its process group.
5. Arbitrary third-party daemons that ignore `MYCLI_CI` remain outside mycli's registry. mycli
   does not scan ports or adopt detached processes.

## Compatibility

`MYCLI_CI` is an additive mycli-owned variable. mycli does not impersonate Codex by injecting
`CODEX_CI`. Existing `MYCLI_THREAD_ID` behavior and user shell environment overrides remain
unchanged.

## Verification

- Unit-test that all shell inheritance policies receive `MYCLI_CI=1`, including restrictive
  `include_only` policies and attempts to override the marker.
- Test the Visual Companion startup-mode selection with `MYCLI_CI=1` and the explicit
  `--background` override.
- Run focused Shell environment and Shell session tests.
- Start a foreground test server through `Shell`, wait for yield, assert that `/ps` reports it,
  then stop it and assert the listener exits.
