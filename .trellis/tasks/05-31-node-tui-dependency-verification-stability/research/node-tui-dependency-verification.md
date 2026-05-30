# Node TUI Dependency Verification Research

## Existing Findings

- The Node TUI package lives under `tui/node`.
- Normal launch and test execution require `tui/node/node_modules/.bin/tsx`.
- `mycli doctor` now warns when the `tsx` marker is missing, but the Node-side
  commands still fail with a low-level loader error if dependencies are absent.
- In fresh worktrees, repeated `npm --prefix tui/node ci` attempts entered npm's
  reify/tarball phase and left a partial `node_modules` containing only
  `es-toolkit`.
- `npm --prefix tui/node ls --depth=0 --json` then reports:
  - missing `tsx`
  - missing `typescript`
  - missing `ink`, `react`, `ink-testing-library`, and type packages
  - extraneous `es-toolkit`
- The package and lockfile are readable:
  - npm `pkg get` works
  - Node can read `package-lock.json`
  - Node/npm versions are present (`node v24.14.1`, `npm 11.11.0`)

## Root Cause Framing

The repo lacks a first-class Node TUI dependency preflight. When dependencies
are absent or partially installed, the first failing command is usually
`node --import tsx --test ...`, which reports `ERR_MODULE_NOT_FOUND` for `tsx`.
That is accurate but not actionable enough for future runtime/TUI slices.

## Recommended Shape

- Add a small Node script under `tui/node/scripts/verify-deps.js`.
- Keep it dependency-free so it runs before `tsx` exists.
- It should check:
  - `node_modules/.bin/tsx`
  - `node_modules/.bin/tsc`
  - root package directories for `ink`, `react`, `tsx`, `typescript`
- On failure:
  - exit non-zero
  - print missing markers
  - print remediation: `npm --prefix tui/node ci`
  - mention removing partial `tui/node/node_modules` if the install was
    interrupted
- Add npm script `verify:deps`.
- Make `test` and `typecheck` run `verify:deps` first.

## Non-Goals

- Do not vendor Node dependencies.
- Do not change the package manager.
- Do not install dependencies from Python or doctor.
- Do not change runtime gateway/TUI behavior.

## Verification Notes

This can be tested without a complete dependency install by running
`npm --prefix tui/node run verify:deps` in a worktree where `node_modules` is
missing or partial. The script should fail quickly with an actionable message.
