# Directory Structure

> How backend code is organized in this project.

---

## Overview

The production CLI is a Node.js npm monorepo. The Python package remains in the same repository as
an independently launched reference runtime. Keep those two runtime trees explicit: shared behavior
is verified through contracts and parity tests, not by importing implementation code across them.

---

## Directory Layout

```text
backend/
  apps/mycli/                Node CLI composition root, management commands, and gateway
  packages/
    config/                  Provider, auth, policy, and user configuration
    contracts/               Versioned schemas shared by Node runtime and TUI
    core/                    Provider-neutral domain state and decisions
    integrations/            MCP, plugins, skills, hooks, and subagents
    providers/               Model-provider transports and protocol adapters
    runtime/                 Turn orchestration and recovery workflows
    storage/                 SQLite stores and readable projections
    tools/                   File, shell, approval, sandbox, and ripgrep adapters
tui/mycli-shell/             Terminal UI and gateway client adapter
npm/ripgrep/<target>/        Release-only optional native packages; not npm workspaces
native/                      Native helper source built by the platform matrix
scripts/                     Repository build, smoke, and release helpers
src/mycli/                   Retained Python reference implementation
tests/                       Python unit and integration tests
docs/                        User, architecture, migration, and parity documentation
```

---

## Module Organization

- Put executable Node CLI wiring in `backend/apps/mycli`; keep business decisions in a package.
- Put provider-neutral decisions in `backend/packages/core` and orchestration in
  `backend/packages/runtime`.
- Keep filesystem, shell, process, and sandbox side effects behind `backend/packages/tools`
  interfaces.
- Keep persistence in `backend/packages/storage` and external extension protocols in
  `backend/packages/integrations`.
- Keep the TUI dependent on contracts and gateway APIs, not backend implementation modules.
- Put release-only native npm manifests under `npm/<component>/<target>`. Do not add mutually
  incompatible OS/CPU packages to the root workspace glob.
- Do not move the retained Python implementation into Node packages or use it as an npm fallback.
- Tests must use framework temporary directories. They must not create `.tmp-*`, session homes,
  databases, or generated artifacts at repository root.

## Scenario: Node Backend Workspace Layout

### 1. Scope / Trigger

- Trigger: adding, moving, packaging, or resolving a Node backend app/package or a root-level
  script, test, CI job, or document that references one.

### 2. Signatures

- Root workspaces: `backend/apps/*`, `backend/packages/*`, and `tui/*`.
- CLI source entry: `backend/apps/mycli/src/cli.ts`.
- Backend package names remain `@mycli/*`; the physical `backend/` prefix is not part of an npm
  package name or an internal package import.

### 3. Contracts

- All Node backend implementation workspaces live under `backend/apps` or `backend/packages`.
- `tui/`, `npm/`, `native/`, `scripts/`, and the retained Python `src/mycli/` tree remain at the
  repository root and are not backend workspaces.
- A backend file that resolves a root-level resource must account for the extra `backend/` path
  segment. Search both literal paths such as `packages/tools` and segmented construction such as
  `join(ROOT, "packages", "tools")` when changing the layout.
- The root `package-lock.json` must contain only the current workspace paths. Old workspace rows
  marked `extraneous` are stale migration artifacts, not an acceptable compatibility layer.

### 4. Validation & Error Matrix

- Missing `backend/` workspace glob -> npm cannot resolve local `@mycli/*` packages.
- Stale package `tsconfig.json` root extension -> TypeScript cannot load `tsconfig.base.json`.
- Stale root script or fixture path -> smoke fails with `ERR_MODULE_NOT_FOUND`, missing fixtures,
  or a bounded timeout.
- Stale lockfile workspace row -> regenerate the lockfile from the current root manifest and verify
  no root `apps/` or `packages/` entries remain.

### 5. Good/Base/Bad Cases

- Good: backend packages move physically while npm names, imports, exports, and dependency
  directions stay unchanged.
- Base: package-to-package relative paths under the common `backend/` parent remain valid.
- Bad: move the TUI or platform packages into backend merely to reduce the number of root folders.
- Bad: preserve old workspace directories or lockfile rows as aliases.

### 6. Tests Required

- Build and type-check every workspace from the repository root.
- Run Node workspace tests and Python parity tests that launch TypeScript helpers.
- Run the packed CLI smoke and assert all local workspaces and platform packages install.
- Run a stale-path scan that includes literal paths and segmented `join`/`Path` construction.

### 7. Wrong vs Correct

#### Wrong

```json
{ "workspaces": ["apps/*", "packages/*", "tui/*"] }
```

#### Correct

```json
{ "workspaces": ["backend/apps/*", "backend/packages/*", "tui/*"] }
```

---

## Scenario: Source-Resolved Workspace Development

### 1. Scope / Trigger

- Trigger: changing a workspace package export, root development command, TypeScript source entry,
  or any workflow where `npm run mycli` must observe unbuilt local source changes.

### 2. Signatures

- Source condition: `mycli-source`.
- Development commands: `npm run mycli` and `npm run dev`.
- Production condition: Node's default `import` condition.

### 3. Contracts

- Every `backend/packages/*` package exposes `mycli-source` for its public root export.
- `mycli-shell-tui` exposes `mycli-source` for `.`, `./gateway`, and `./gateway-transport`.
- Root development commands enable `--conditions=mycli-source` together with `--import tsx`, so
  the app, its worker threads, backend workspace dependencies, and TUI all execute current `.ts`
  sources without a preliminary build.
- Default imports, the published app bin, package `types`, and packed smokes continue to resolve
  compiled files under `dist`; source resolution is never enabled implicitly for consumers.
- Adding a new runtime workspace package or public TUI subpath requires adding the same source
  condition and extending the resolution regression test.

### 4. Validation & Error Matrix

| Condition | Required behavior |
| --- | --- |
| Root `npm run mycli` after a source-only edit | Resolve the edited workspace module from `src` |
| Default package import | Resolve JavaScript from `dist` |
| Worker spawned by the source CLI | Inherit the source condition and TypeScript loader |
| Missing source condition on a dependency | Package resolution test fails with a `dist` path |
| Packed or installed CLI | Run compiled JavaScript without `tsx` |

### 5. Good/Base/Bad Cases

- Good: edit a TUI or runtime source file, restart `npm run mycli`, and observe the change directly.
- Base: run a package consumer without custom conditions and load its compiled export.
- Bad: rebuild only the TUI while a changed backend dependency still loads stale `dist` output.
- Bad: point the default `import` condition at TypeScript and make the published CLI require `tsx`.

### 6. Tests Required

- Assert both root development scripts enable `mycli-source` and `tsx`.
- Resolve every backend package plus all runtime TUI subpaths in a child Node process with the
  source condition and assert each URL points to a `.ts` file under `src`.
- Resolve a representative package without the source condition and assert it still points to
  `dist/*.js`.
- Keep workspace build, type-check, package tests, and packed CLI smoke green.

### 7. Wrong vs Correct

#### Wrong

```json
{ "mycli": "node --import tsx backend/apps/mycli/src/cli.ts" }
```

#### Correct

```json
{ "mycli": "node --conditions=mycli-source --import tsx backend/apps/mycli/src/cli.ts" }
```

---

## Naming Conventions

- TypeScript modules and package directories use lowercase kebab-case where a multiword filename is
  needed; exported types and classes use PascalCase.
- Python modules remain snake_case.
- Native package child directories use the canonical target key, for example
  `npm/ripgrep/macos-aarch64` or `npm/ripgrep/windows-x86_64`.
- Generated `dist/`, `vendor/`, cache, session, and test-home directories are ignored and must be
  reproducible from source.

---

## Examples

- `backend/packages/tools/src/ripgrep-targets.ts` owns cross-platform ripgrep metadata.
- `backend/packages/runtime/src/node-turn-runtime.ts` is the Node turn orchestration boundary.
- `backend/apps/mycli/src/management/` keeps provider-free CLI commands separate from runtime startup.
- `npm/ripgrep/README.md` documents why native release packages are outside workspaces.
