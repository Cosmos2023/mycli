# Assertion Audit (Round 1, 2026-09-18)

## Scope And Method

Round 1 audits the load-bearing claims in the Windows sandbox, release and
security docs:

- `.trellis/spec/backend/shell-execution-policy-contract.md`
- `.trellis/spec/backend/plugin-runtime-contract.md`
- `.trellis/spec/backend/release-contract.md`
- `.trellis/spec/backend/network-proxy-contract.md`
- `.trellis/spec/backend/quality-guidelines.md`
- `docs/windows.md`, `docs/releasing.md`
- `docs/parity/windows-sandbox-{feature-parity,local-verification,psec-verification,host-optimization}.md`

Claims were extracted with an empirical pattern (`proves|proven|verified|has
passed|zero skips|all N|N/N pass`) and each was classified by evidence:

- `verified-today`: reproduced in this session with a retained log.
- `artifact-located`: a repository log or test exists and contains the claimed counts.
- `artifact-weak`: the log exists but is malformed, partial or names a different run.
- `no-artifact`: no repository artifact was located for the claim.
- `stale`: the claim contradicts the current implementation (fixed when found).
- `documented-open`: the document already states the item is unverified.

This is not a full claim-by-claim proof of every sentence. Historical logs live
under `native/windows-sandbox-helper/build/` and are local, untracked artifacts.

## Round 1 Results

| Claim | Location | Status | Evidence |
| --- | --- | --- | --- |
| Native Release build and CTest 4/4 | feature-parity `Local results` | verified-today | `build/ctest-aligned-final.log` (100% tests passed, 4/4) |
| Strict Windows gate 13/13 plus PSEC 7/7, zero skips | feature-parity, release-contract | verified-today | `build/windows-sandbox-aligned2.log` |
| M7 passes 6/6 with plugin plus workspace-wide hook | feature-parity | verified-today | `build/extensions-m7-aligned2.log` |
| Plugin platform suite 3/3, PSEC parity 7/7 | feature-parity | verified-today | `build/plugin-final.log`, `build/parity-final.log` |
| Lint and workspace typecheck pass | feature-parity | verified-today | `build/lint-aligned.log`, `build/typecheck-aligned.log` |
| Sandboxed processes cannot create hardlinks | shell-execution-policy-contract | verified-today | `experiments/psec-hardlink-creation.mjs` plus native `--link-fresh` regression in the 4/4 CTest run |
| Plugin suite 61/61, zero skips | feature-parity | artifact-located | `build/extensions-plugins.log` |
| Storage package 373/373, zero skips | feature-parity | artifact-located | `build/alignment-storage-final.log` |
| Changed integrations fixtures 16/16 | feature-parity | artifact-located | `build/alignment-integrations-tests.log` |
| Release suite passed (38 cases) | feature-parity | artifact-weak | `build/extensions-release-tests.log` contains the passing dots and `[test:release] passed in 3.6s`, but also a PowerShell `NativeCommandError` banner above it |
| Release and catalog suite 44/44 | feature-parity (elsewhere) | artifact-located | `build/parity-release-tests.log` (44 tests, 44 pass) |
| Complete package smoke 10/10 | feature-parity | verified-today | Current candidate `f38d05b5...` completes 10/10 journeys with fresh setup and ready status; `build/aligned-release-evidence/windows-package-smoke.json` |
| Installed candidate journey | feature-parity | verified-today | Covered by the completed smoke above, including the sandboxed compiled-plugin journey |
| Repository unit and contract groups passed | feature-parity | verified-today | Round 2: 372 unit files pass (`build/r2-unit-pinned.log`), 31 contract files pass (`build/r2-contract.log`), catalog 472 files (`build/r2-test-list.json`) |
| Integration groups | feature-parity | verified-today | Round 2 ran the canonical integration suite: 56 files pass in 554.8s (`build/r2-integration.log`); the older per-workspace counts in the report are historical |
| Seven emitter/catalog tests pass | feature-parity | artifact-located | `build/extensions-inventory-catalog.log` (7 tests, 7 pass) |
| Host-to-sandbox loopback ingress unsupported, cause unconfirmed | feature-parity, network-proxy-contract | documented-open | repro command and probe results are recorded; WFP diagnosis still needs elevation |
| Clean-OS and legacy-only acceptance unavailable | feature-parity | documented-open | matches the task acceptance criteria |
| Helper-required release verification passed | feature-parity | artifact-located | `build/alignment-release-verify.log` ("Verified release 0.1.1 (7 publishable packages).") |

## Stale Claims Found And Fixed

The per-command PSEC alignment invalidated three assertions that still described
the removed rejection rule:

- `docs/parity/windows-sandbox-feature-parity.md` said the PSEC suite "rejects a
  narrower overlapping writer or changed denied-read policy". It now states that
  divergent writers and deny sets are admitted per command.
- The same file said a live plugin "rejects an overlapping writer before its
  effects". It now states that overlapping and independent writers both run under
  their own command policies.
- `.trellis/spec/backend/plugin-runtime-contract.md` listed "Native lease rejects
  the new command before its effects" for an overlapping divergent writer. It now
  names the legacy ACL backend as the exclusive one and PSEC as per command.

## Structural Gaps

- Fixed 2026-09-18: `scripts/verify-release.mjs` now requires an x64 PE header and a
  matching `mycli-windows-sandbox.sha256` manifest. A tampered manifest fails with
  `release_windows_sandbox_helper_hash_mismatch`.
- Fixed 2026-09-18: promotion runs through `npm run promote:windows-sandbox-helper`,
  which copies the helper, records the hash and re-vendors
  `backend/apps/mycli/dist/node_modules`. The strict runner refuses to start when
  that copy drifts (`windows_sandbox_vendored_helper_stale`).
- Several evidence logs mix harness noise into passing runs, and the installed
  journey log retains only a single marker line, so a reader cannot confirm the
  claim from the named artifact alone.

## Recommended Next Actions

1. Re-run the unlocated groups (repository unit/contract, integration groups,
   emitter/catalog count) or drop the specific numbers from the report.
2. Name every retained log with the claim it proves, or regenerate the affected
   evidence for the current candidate (the helper changed, so the old candidate
   hash is no longer valid).
3. Keep the two `documented-open` items visible; do not restate them as parity.
