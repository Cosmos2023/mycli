# Plain Mode Retirement Design

Date: 2026-07-29

## Objective

Retire the line-oriented conversational REPL and make the Node TUI the only
interactive conversation surface. Keep non-conversation utility commands and
the setup wizard's independent text fallback available.

## Scope

Remove:

- the `--plain` command-line option;
- `src/mycli/cli/repl.py` and its line-oriented input loop;
- `src/mycli/cli/rendering.py` and rendering used only by that loop;
- readline path autocomplete installation used only by the REPL;
- `MYCLI_TUI_FALLBACK=plain` behavior;
- tests and evaluation coupling that exist only for the retired interface;
- current README and audit references that describe plain mode as supported.

Preserve:

- the default Node TUI and explicit `--node-tui` compatibility option;
- `doctor`, `hooks`, `plugins`, `mcp`, `subagents`, and `setup` utility commands,
  including non-TTY and JSON use;
- the setup wizard's own text fallback when its Node setup surface is
  unavailable;
- backend slash dispatch and text presentation used by management tests and
  focused smoke scripts;
- historical specifications and reports as records of prior behavior.

## Startup Behavior

Utility commands are dispatched before conversational startup and retain their
current behavior.

Conversational startup always launches the Node TUI. If stdin or stdout is not a
TTY, mycli returns exit code 2 with a concise message that interactive mycli
requires a terminal. It does not consume piped input or enter a hidden fallback
loop.

If Node, the compiled TUI entrypoint, or the TUI process is unavailable, mycli
prints the existing bounded startup error updated to remove `--plain` guidance,
then returns exit code 2. `MYCLI_TUI_FALLBACK` no longer changes this behavior.

## Shared Slash Dispatch

The reusable backend command handler currently located in `cli/repl.py` is not
REPL-specific. Move that small adapter to the existing slash dispatch boundary
or a narrowly named CLI command helper. Evaluation smoke scripts import the new
owner directly. The retired input loop and slash parsing compatibility behavior
are not retained around it.

## Deletion Boundaries

Delete only rendering proven exclusive to plain conversational output. Utility
command renderers in `cli/main.py`, slash command result rendering, setup
rendering, Doctor rendering, and Node gateway payload projection remain active.

Path completion candidates remain because the Node gateway uses them. Only the
readline installation function and readline-specific globals may be removed if
reference scanning confirms no other caller.

## Error Handling

- Unsupported `--plain` input is handled by argparse as an unknown option.
- Non-TTY conversational startup returns 2 without constructing an interactive
  REPL.
- Node TUI startup failures remain user-facing bounded messages without Python
  tracebacks.
- Runtime services are closed through the existing `finally` path after TUI
  termination or startup failure.

## Verification

- Add or update CLI tests for Node-only startup, non-TTY rejection, utility
  commands under non-TTY IO, and bounded Node startup failures.
- Remove the dedicated REPL integration module and plain-only rendering tests.
- Run the full Python suite, Ruff, mypy, Node TUI tests, and TypeScript
  typechecking.
- Scan for remaining live references to `--plain`, `run_repl`,
  `MYCLI_TUI_FALLBACK`, `cli.repl`, and `cli.rendering`.
- Recount production Python and update the redundancy audit with the actual
  reduction.
