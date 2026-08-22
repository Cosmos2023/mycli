## Context

M8 made the npm CLI unconditionally Node-owned but retained the Python package as a separately
launched reference by an explicit product decision. The final capability audit now has no
unresolved retained rows, subsequent schema-v12 work deliberately removed Python storage
compatibility, and the user no longer requires the Python launch or wheel surface.

Most Python files can be deleted without affecting the npm graph, but two active Node paths still
cross the old source boundary: the app copies its canonical system prompt from
`src/mycli/prompts/templates/system.md`, and the contracts generator writes JSON copies into
`src/mycli/schemas/generated`. Node tests also checksum language-neutral JSON corpora under
`tests/fixtures`; those fixtures are product regression assets rather than Python ownership.

The worktree contains ongoing Node runtime and storage changes. Retirement must preserve all Node,
native, fixture, OpenSpec, and historical documentation changes while deleting only the approved
Python product surface.

## Goals / Non-Goals

**Goals:**

- Make a source checkout, development command, production build, tests, CI, and packed npm CLI
  independent of the removed Python package and Python dependency manager.
- Give Node canonical ownership of the system prompt and generated contracts before deleting
  `src/mycli`.
- Remove the independent Python console script, wheel, runtime, tests, evaluations, parity runners,
  build hooks, and reference CI gate.
- Preserve Node-owned sanitized JSON fixtures, native helpers, and negative no-Python package
  probes.
- Keep existing schema-v12 session data untouched.

**Non-Goals:**

- Preventing users from running Python through the Shell tool or configured external hooks.
- Removing legacy Python-plugin detection or its migration guide while installed legacy plugins
  can still be diagnosed safely.
- Rewriting archived OpenSpec, Trellis task records, or historical reports merely because they
  describe the former Python implementation.
- Migrating or converting databases produced by the removed Python runtime.
- Removing Trellis-owned development scripts that happen to be implemented in Python.

## Decisions

### Move the canonical prompt into the Node app

The canonical Markdown prompt moves to `backend/apps/mycli/src/assets/system.md`. Source loading,
the build copy script, and prompt tests use that path; `dist/assets/system.md` remains the packaged
location. Keeping a copied prompt in both languages was rejected because it would retain ambiguous
ownership and drift checks for a removed product.

### Stop generating Python contract mirrors

`backend/packages/contracts` remains the only hand-edited schema source and generates only its
TypeScript declarations. The generator and fixture tests drop `src/mycli/schemas/generated`
targets. Retaining orphan JSON mirrors elsewhere was rejected because no runtime consumes them.

### Preserve language-neutral corpora without preserving their Python harness

The checksum-protected M2-M7 JSON files under `tests/fixtures` remain at their existing paths to
avoid unrelated fixture churn across core, provider, storage, and M8 audit tests. Python pytest
runners and TypeScript helpers used only as subprocesses by those runners are removed after a
reference scan proves no Node consumer remains.

### Delete the Python product as one explicit breaking boundary

Remove `src/mycli`, Python-only `tests/**/*.py`, `evaluation/**/*.py`, mycli-owned Python scripts,
`pyproject.toml`, `uv.lock`, `.python-version`, Hatch hooks, and Python wheel assets. Root M2-M7
commands keep their Node test portions and lose only pytest parity tails. The cross-platform
workflow keeps the Node and native matrices and removes the `python-reference-gate` job.

A long deprecation period was rejected because Python is already absent from the npm product,
cannot own fresh schema v12, and would continue imposing full maintenance cost during the period.

### Keep historical records and external-command semantics

Current README, architecture, rollout, Windows, troubleshooting, developer rules, and active
Trellis contracts become Node-only. Archived changes, reports, and task journals remain immutable
history. Shell execution policy continues recognizing Python executables because a user command is
not a mycli runtime dependency. Packed-smoke Python probes remain useful negative assertions.

## Risks / Trade-offs

- **Node build loses the system prompt** -> Move the asset first, assert source and packaged hashes,
  then delete the old tree and run both source-resolution and production builds.
- **Deleting `tests/` removes Node parity evidence** -> Preserve every referenced JSON corpus and
  run the checksum-enforced M8 audit plus package suites after deletion.
- **Stale Python references make clean builds fail** -> Run a scoped reference scan over active
  source, scripts, CI, package metadata, and current docs; allow only external-command handling,
  legacy-plugin diagnostics, negative probes, Trellis tooling, and historical records.
- **Existing Python users lose their entrypoint** -> Treat removal as breaking and document npm
  installation as the only migration. Do not provide a hidden fallback.
- **Large deletion obscures unrelated dirty worktree edits** -> Move and edit Node-owned files
  before bulk deletion, inspect status by path, and never reset or rewrite unrelated Node changes.

## Migration Plan

1. Move prompt ownership and remove generated Python contract targets while both trees still exist.
2. Update Node tests and checksum paths, then prove the Node build and focused tests pass.
3. Remove Python package/runtime/tests/tooling and Python CI/parity command surfaces.
4. Update current docs, AGENTS/Trellis guidance, and run the stale-reference scan.
5. Run the full Node build, contracts check, lint, typecheck, package tests, M8 smoke, packed smoke,
   native-sensitive tests available on macOS, and strict OpenSpec validation.

Rollback is source-level: restore the pre-retirement revision and its Python lock/package files.
No session database is modified, so there is no data rollback step.

## Open Questions

None. The user explicitly approved removing the retained Python reference runtime and does not
require its launch, packaging, compatibility, or migration surface.
