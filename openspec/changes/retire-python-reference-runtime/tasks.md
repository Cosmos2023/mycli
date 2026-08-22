## 1. Node Asset Ownership

- [x] 1.1 Move the canonical system prompt into the Node app and update source loading, build-copy,
  hash/parity tests, and package coverage to use the Node-owned asset.
- [x] 1.2 Remove generated Python schema targets from the contracts generator and update drift tests
  so generation owns only canonical schemas and TypeScript declarations.
- [x] 1.3 Inventory root parity fixtures and TypeScript helpers, preserve every Node-consumed JSON
  corpus, and identify helpers that become unreferenced when pytest runners are removed.

## 2. Python Product Removal

- [x] 2.1 Simplify root M2-M7 commands to their Node test gates and add a repository regression test
  that rejects Python product metadata, runtime source, parity command tails, and reference CI.
- [x] 2.2 Remove the cross-platform Python reference job and Python wheel/sandbox copy path while
  preserving the Node and native helper matrices.
- [x] 2.3 Delete the Python runtime package, Python-only tests/evaluations/helpers, Python build hooks,
  dependency metadata, lock files, and Python-only TypeScript subprocess helpers without deleting
  Node fixtures or Trellis tooling.

## 3. Guidance And Hygiene

- [x] 3.1 Update `AGENTS.md`, README, architecture, rollout, Windows, troubleshooting, and active
  development documentation for the Node-only repository and npm migration boundary.
- [x] 3.2 Update active Trellis backend contracts to remove Python-reference requirements while
  retaining explicit exceptions for external commands, legacy-plugin diagnostics, negative probes,
  historical records, and Trellis-owned scripts.
- [x] 3.3 Run a scoped stale-reference scan and remove remaining active Python-runtime, `uv`, pytest,
  wheel, sidecar, and generated-Python ownership references outside the explicit exceptions.

## 4. Verification

- [x] 4.1 Run focused system-prompt, contract-generation, repository-retirement, M8 audit, storage,
  provider, core, and app tests against the preserved Node fixtures.
- [x] 4.2 Run the full Node build, contracts check, lint, typecheck, workspace tests, `git diff
  --check`, and strict OpenSpec validation.
- [x] 4.3 Run provider-free M8, packed npm CLI, TUI PTY, and available macOS native-sensitive smokes;
  verify the packed artifact contains and probes no Python runtime surface.
