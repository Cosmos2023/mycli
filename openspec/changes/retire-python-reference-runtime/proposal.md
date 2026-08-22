## Why

The npm product, TUI, providers, tools, workers, and fresh schema-v12 session store are already
owned exclusively by Node.js, while the repository still maintains a second independently launched
Python product with roughly 79,000 source lines and 81,000 test lines. Keeping that reference
runtime now adds dependency, CI, documentation, and contract-generation cost without protecting a
supported production fallback or a compatible schema-v12 writer.

## What Changes

- Move the canonical system prompt and generated-contract ownership out of `src/mycli` so Node
  source builds and packaged builds own every required runtime asset.
- Preserve the sanitized M2-M7 JSON corpora and any language-neutral native helpers still consumed
  by Node tests or release packages.
- **BREAKING**: remove the independently launched `uv run mycli` Python product, Python wheel,
  Python runtime source, Python-only tests/evaluations, and Python plugin worker implementation.
- Remove Python dependency metadata, lock files, build hooks, Python parity command tails, and the
  Python 3.13 reference CI matrix.
- Update current installation, development, architecture, rollout, Windows, and troubleshooting
  documentation to describe a Node-only repository and release gate.
- Keep negative package-smoke assertions that the npm CLI does not import, invoke, or probe Python;
  external shell commands and hooks may still invoke a user-installed Python executable.

## Capabilities

### New Capabilities

- `node-only-repository-runtime`: Node owns all production assets, generated contracts, tests, and
  release gates, with no maintained Python implementation or Python toolchain requirement.

### Modified Capabilities

None.

## Impact

- Removes `src/mycli/**/*.py`, Python tests and evaluations, `pyproject.toml`, `uv.lock`, Python
  build hooks, and Python-only CI/release paths.
- Changes system-prompt and contract-generation source paths under `backend/`.
- Simplifies root npm scripts and active documentation while retaining Node-owned JSON fixtures,
  TypeScript tests, C/C++ native helpers, and npm native packages.
- Existing `~/.mycli` schema-v12 databases and readable session artifacts are not migrated or
  rewritten. Users of the removed Python console script must switch to the npm CLI.
