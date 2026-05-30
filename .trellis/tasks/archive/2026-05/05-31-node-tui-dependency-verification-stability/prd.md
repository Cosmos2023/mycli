# Node TUI Dependency Verification Stability

## Goal

Make Node TUI verification failures actionable in fresh or partially installed
worktrees, so future runtime/TUI slices can quickly distinguish missing
dependencies from actual TypeScript or reducer regressions.

## Context

- Recent runtime/TUI slices repeatedly hit missing `tsx` in fresh worktrees.
- Python `mycli doctor` now reports missing Node TUI dependencies, but direct
  Node commands still fail with low-level module-loader errors.
- The target Hermes-like workflow needs reliable runtime/TUI verification
  before deeper UI work.

## Research References

- [`research/node-tui-dependency-verification.md`](research/node-tui-dependency-verification.md)
  — documents the partial-install state and recommends a dependency-free
  Node-side preflight.

## Requirements

- Add a dependency-free Node TUI preflight script.
- The preflight must run before `tsx` is required.
- It must check for the local dependency markers needed by Node TUI verification:
  - `node_modules/.bin/tsx`
  - `node_modules/.bin/tsc`
  - package directories for `ink`, `react`, `tsx`, and `typescript`
- On missing dependencies, it must:
  - exit non-zero
  - print a concise error explaining Node TUI dependencies are missing or
    incomplete
  - list missing markers
  - print remediation: `npm --prefix tui/node ci`
  - mention removing `tui/node/node_modules` if an interrupted install left a
    partial directory
- Add an npm script named `verify:deps`.
- Make `npm --prefix tui/node test` and
  `npm --prefix tui/node run typecheck` run `verify:deps` first.
- Keep package dependencies unchanged.

## Non-Goals

- Do not vendor or commit `node_modules`.
- Do not replace npm with another package manager.
- Do not make `mycli doctor` install dependencies.
- Do not change Node TUI runtime behavior.
- Do not merge into `main`.

## Acceptance Criteria

- Unit or script-level test proves missing dependencies produce the actionable
  preflight output.
- Running `npm --prefix tui/node run verify:deps` in the current partial/missing
  dependency state fails with the new message rather than `ERR_MODULE_NOT_FOUND`.
- Python gateway baseline tests still pass.
- If dependencies can be installed, Node `test` and `typecheck` pass; otherwise
  the verification gap is reported with the preflight output as evidence.
- Trellis task is archived and committed only on
  `feature/mycli-node-tui-deps-verification`.
