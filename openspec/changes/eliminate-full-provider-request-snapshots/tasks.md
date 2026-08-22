## 1. Reconstruction Contract

- [x] 1.1 Add storage tests that reconstruct exact compact-V3 requests from instruction/tool snapshots and timeline prefixes without loading a logical request blob.
- [x] 1.2 Add corruption, later-append, compaction-window, retry, and unconfirmed-step recovery tests with zero-dispatch failure assertions.
- [x] 1.3 Implement shared-projector request reconstruction and validate the reconstructed request against the committed relational hash.
- [x] 1.4 Add core validation and hashing for constant-size V3 manifests without ordered event/reference prefix arrays.

## 2. Fresh Schema V12

- [x] 2.1 Add schema-v12 shape tests proving provider manifests retain the request hash but have no logical request blob ownership column or reference.
- [x] 2.2 Implement fresh schema-v12 creation and model-input ledger commit without full request blob writes.
- [x] 2.3 Make production runtime dispatch create/accept v12 and fail closed on v11 without migration or writes.

## 3. Runtime And Recovery Parity

- [x] 3.1 Update request-pipeline common-prefix and provider-step commit behavior to use reconstructed append-only prefixes.
- [x] 3.2 Add Worker/in-process, restart, prepared-step, compaction, continuation, and multi-agent parity coverage.
- [x] 3.3 Update doctor, maintenance, runtime fixtures, schema constants, and documentation for the fresh-only v12 boundary.
- [x] 3.4 Normalize blank terminal subagent reports so completion repair cannot block session resume.

## 4. Storage Acceptance

- [x] 4.1 Extend the tool-heavy benchmark to report provider-step count, request-hash rows, logical-request blob ownership count, and database bytes.
- [x] 4.2 Add an acceptance test proving hundreds of growing provider steps create zero full-request content references and reconstruct exact requests.

## 5. Verification

- [x] 5.1 Run focused core, storage, runtime, backend, gateway, doctor, corruption, and Worker recovery suites.
- [x] 5.2 Run build, lint, typecheck, `git diff --check`, strict OpenSpec validation, and a fresh-v12 startup smoke without provider dispatch.
