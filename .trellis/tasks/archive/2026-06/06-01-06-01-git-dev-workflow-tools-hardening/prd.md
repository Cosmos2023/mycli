# Git Dev Workflow Tools Hardening

## Problem

`mycli` can run git commands through `Bash`, but that leaves core development
state hidden inside raw terminal output. Models need stable, read-only tools for
common repository inspection so they can reason about dirty worktrees, diffs,
recent commits, and specific revisions without using destructive git commands.

## Scope

This slice adds minimal built-in local git workflow tools:

- `GitStatus`
- `GitDiff`
- `GitLog`
- `GitShow`
- registry/manifest metadata
- model-visible formatter output
- unit tests and integration smoke coverage

## Non-goals

- No destructive git operations.
- No commit, merge, rebase, checkout, reset, clean, push, or pull automation.
- No MCP, ACP, skills, subagents, browser, or computer-use productization.

## Requirements

1. Tools execute git without shell interpolation.
2. Tools run inside the configured workspace root.
3. `GitStatus` returns branch/upstream/raw porcelain entries and dirty status.
4. `GitDiff` returns bounded diff/stat/shortstat with path and staged filters.
5. `GitLog` returns structured bounded commit metadata.
6. `GitShow` returns bounded revision metadata and optional diff.
7. Non-git workspaces and git failures return stable `error_kind`.
8. Manifest marks git tools as low-risk `dev` tools with read-only effects.
9. Formatter renders status/diff/log/show in a compact model-visible form.

## Acceptance

- Unit tests cover status, diff, log, show, bounded output, and non-git failure.
- Registry manifest includes the git tools with stable ids and dev tags.
- Integration toolset smoke includes the git tools.
- `ruff`, `mypy`, and Python unit/integration tests pass before commit.
