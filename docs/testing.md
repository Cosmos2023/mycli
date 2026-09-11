# Testing mycli

mycli uses one repository test catalog to separate fast feedback, cross-layer behavior,
host-dependent behavior, and release validation. The catalog is defined in
`scripts/test-suite-catalog.mjs`; `scripts/run-test-suite.mjs` is the only root-level Node test
orchestrator.

## Test Suites

| Suite | Purpose | Normal dependencies |
| --- | --- | --- |
| `unit` | Deterministic in-process domain, service, storage, and headless TUI behavior | Node and temporary files |
| `contract` | JSON Schema, generated declarations, frozen fixtures, package metadata, and repository drift | Current source; some package checks inspect `dist/` |
| `integration` | Local HTTP, Worker, subprocess, extension, recovery, and concurrency boundaries | Loopback and local child processes |
| `platform` | Native PTY, host shell, process transport, and platform-specific execution | Supported host platform and native prerequisites |
| `release` | Versioning, packing, compatibility policy, and workflow publication gates | Repository release metadata |
| `smoke` | Executable provider-free journeys against built or packed artifacts | A current build and platform dependencies |

Real-provider checks are not part of `npm test`. They are explicit, credential-gated smoke tests
and must emit only redacted structural evidence.

## Commands

```bash
npm run test:list
npm run test:unit
npm run test:contract
npm run test:integration
npm run test:platform
npm run test:release
npm run test:ci
npm run test:smoke
npm run test:smoke:live -- --dry-run
```

`npm test` and `npm run test:ci` are equivalent deterministic repository gates. The `pretest`
lifecycle builds every workspace once, then the runner executes unit, contract, integration,
platform, and release suites in that order. Focused suite commands do not perform a full build;
run `npm run build` first when validating compiled output or package metadata after a source change.

Pass supported `node:test` options after `--`:

```bash
npm run test:integration -- --test-name-pattern="queue|worker"
npm run test:list -- --json
```

## Classification Rules

- A normal `*.test.ts` or `*.test.mjs` file belongs to the target's default suite. Runtime
  workspaces default to `unit`; the contracts workspace and repository test directory default to
  `contract`.
- Use `*.integration.test.ts`, `*.platform.test.ts`, or `*.contract.test.ts` when the whole file
  belongs to that boundary.
- Existing mixed or legacy filenames use the small explicit override map in the catalog. An
  override for a missing file fails catalog discovery, so stale entries cannot accumulate.
- Provider-free smoke journeys live under `scripts/smoke_*.mjs`; they are not disguised as ordinary
  `node:test` files. Live provider traffic remains opt-in.
- Every test uses framework temporary directories and owns cleanup for files, ports, processes,
  Workers, terminals, and databases that it creates.
- Package-local `npm test` commands remain supported for focused ownership checks. Root and CI
  gates use the catalog so every repository test is selected exactly once.

## CI And Release

Pull-request CI runs `test:ci` on Node 22.19 and Node 24 across Linux, macOS, and Windows. Native
prerequisites are installed by the platform job before `test:platform`. Provider-free M8 and packed
artifact smoke remain separate steps because they validate executable artifacts rather than test
modules.

Main-branch live smoke runs only after deterministic gates pass. Release CI additionally validates
compatibility policy, all packed platform artifacts, predecessor upgrade/downgrade behavior, and
publication metadata before publishing.

The `test:m2` through `test:m8` commands are retained as compatibility shortcuts for historical
milestone investigations. They are not independent CI gates; their files already belong to the
canonical suites.

## Maintaining The Suite

Before adding a test, choose its execution boundary rather than its product milestone. Prefer one
domain per file and package-local helpers under `test/support`. Do not move reusable production
logic into test helpers or add a second hand-maintained list of all test files.

Large mixed files should be split by existing ownership boundaries while preserving test names and
fixtures. The first targets are gateway queue/approval/session behavior, backend composition,
runtime turn execution, TUI shell interaction, and TUI transcript projection. Splitting them is a
mechanical follow-up; the catalog provides stable suite membership during that work.
