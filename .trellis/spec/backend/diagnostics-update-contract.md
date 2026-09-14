# Diagnostics And Cached Update Contract

## Scenario: Provider-Free Diagnostics And Non-Blocking Updates

### 1. Scope / Trigger

- Trigger: changing diagnostic categories, doctor collectors/rendering, update configuration,
  update cache IO, startup refresh ownership, gateway update payloads, or the TUI update notice.
- This is a cross-layer contract spanning config, app lifecycle, gateway, contracts, and TUI. Keep
  classification and version decisions in backend owners; the TUI only validates and projects the
  bounded payload.
- Runtime-turn error ownership remains in [error-handling.md](./error-handling.md). This contract
  owns provider-free doctor and cached package-update behavior.

### 2. Signatures

- Canonical user setting: `updates.check_on_startup: boolean`, default `true`.
- Management commands:
  - `mycli doctor [--verbose] [--json] [--fix [--confirm <plan-id>] | --support-bundle]`
  - `mycli update [status|check|dismiss <stable-version>] [--json]`
- Doctor repair/support responses:
  - repair plan: `{schemaVersion: 1, planId, confirmationRequired, actions}`
  - repair execution: `{schemaVersion: 1, mode, status, code, plan, results}`
  - support receipt: `{schemaVersion: 1, location, bytes, sha256}`
  - `planId`: `doctor-plan-v1-` plus 64 lowercase hexadecimal characters.
  - `location`: `.mycli/support/diagnostic-support.json`.
- TUI command: `/update [check|dismiss <stable-version>]`.
- Gateway RPCs:
  - `update.status({}) -> {update}`
  - `update.dismiss({version}) -> {ok, dismissed_version, update}`
  - `session.bootstrap(...) -> {..., update?}`
- Failed gateway RPC projection:
  - response error data: `{category, recovery_actions?, occurrence_id}`
  - matching `gateway.error` params: `{code, message, method, category, recovery_actions?, occurrence_id}`
  - `occurrence_id`: `rpc:` plus 64 lowercase hexadecimal characters.
- Cache: `~/.mycli/version.json`, schema version `1`:

```typescript
interface UpdateCacheRecord {
  readonly schemaVersion: 1;
  readonly packageName: "@mycli/app";
  readonly latestVersion: string;
  readonly lastCheckedAt: string;
  readonly dismissedVersion?: string;
}
```

- Lifecycle owner:

```typescript
const startupStatus = await updates.status(config.updatesCheckOnStartup);
const gateway = createNodeGateway({ updateStatus: startupStatus, updateCommands, ...options });
updates.startBackgroundRefresh(config.updatesCheckOnStartup);

// Backend shutdown: abort and await before closing persistent resources.
await updates.close();
```

### 3. Contracts

- Doctor is provider-free by default. Collectors may inspect authoritative local configuration,
  credential readiness, sandbox/terminal support, storage/session ownership, extensions, and the
  cached update status. They must not call a model provider.
- Plain Doctor and `doctor --fix` without `--confirm` are read-only. A fix preview lists bounded,
  value-free actions, effects, and configuration changes. Apply is available only through
  `--confirm <plan-id>` and only for deterministic actions delegated to the service that owns the
  state; the initial action is canonical user-config migration.
- All Doctor modes discover MCP/plugin metadata without starting transports or Plugin API v2 hosts.
  Preserve trust filtering, disabled entries, migration, invalid manifests, and missing environment
  diagnostics. Mark these rows `runtime=not_probed`; metadata success is not live runtime readiness.
  Explicit `mycli mcp inspect <id>` owns live discovery and process cleanup. Compiled-CLI tests must
  assert absent startup markers during Doctor, preview, and support collection, then prove a live
  inspect still starts and closes its server.
- A repair plan hashes the complete projected action plus its owning migration expected version.
  Apply rebuilds the plan before mutation. A different plan id returns `version_conflict` and does
  not apply the replacement plan. Each action reports its own applied, failed, not-needed, or
  conflict result; mixed success is `partial_failure`. Diagnostics rerun only after an action says
  it changed state.
- Doctor repair never calls a provider, executes arbitrary shell, installs packages, requests
  elevation, edits credentials, or removes the legacy config. The config owner retains lock,
  backup, validation, atomic replacement, and rollback semantics.
- `doctor --support-bundle` is the only support-export mutation. It atomically replaces
  `~/.mycli/support/diagnostic-support.json` under a mode-`0700` directory and mode-`0600` file on
  permission-bearing platforms. It never uploads the artifact.
- Support data is built from an allowlisted DTO, not rendered report text or copied logs. It may
  contain bounded runtime versions, diagnostic rows, config layer metadata, sandbox/session/
  extension readiness, and recognized relative log references. It excludes log bodies, prompts,
  commands, tool content, provider bodies, credentials, headers, session ids, stacks, arbitrary
  object fields, local paths, and control characters.
- Human, verbose, and JSON doctor output derive from one typed report. Each row carries category,
  stable code, summary, bounded details, remediation, recovery actions, and duration. JSON adds only
  a bounded support manifest of runtime versions, platform identity, diagnostic codes, and safe log
  references.
- Diagnostic payloads exclude secret values, prompts, commands, tool content, raw provider bodies,
  stacks, and unnecessary absolute paths. Boundary owners classify failures; renderers do not parse
  raw exception text.
- Every failed gateway RPC receives a fresh random occurrence id at the projection boundary. The
  JSON-RPC error and matching `gateway.error` event reuse that exact id; ids must not be derived
  from a request id, method, code, or message because any of those values can repeat. The TUI hashes
  the occurrence id into its notice id and deduplicates only matching occurrences.
- Doctor treats collector rows as untrusted runtime values. It bounds and redacts strings, replaces
  malformed names/statuses, and reconstructs recovery actions from recognized ids. Collector-owned
  labels or commands never cross the report boundary.
- Startup reads cached update state before the refresh begins and freezes that snapshot for
  bootstrap, settings, and the startup notice. A background result is first advertised on a later
  startup. An explicit `update check` may refresh the current gateway status and render its result.
- Refresh starts only after gateway readiness and is never awaited by startup. The backend owns the
  refresh promise; repeated close calls share one promise, abort first, and await settlement before
  stores or other stateful resources close.
- Cache freshness is 20 hours. Registry requests time out after five seconds, read at most 64 KiB,
  and accept only an object whose `version` is strict stable semantic version text. Cache files are
  at most 16 KiB and use the private locked atomic writer.
- Cache replacement reads the current file only within the 16 KiB boundary. An oversized current
  file is invalid state, not a reason to block a validated atomic replacement or read it fully into
  memory.
- Missing, malformed, future-dated, unreadable, offline, timed-out, oversized, and unwritable state
  is non-fatal. A failed refresh never replaces an older valid record. A delayed older concurrent
  refresh cannot overwrite a record with a later `lastCheckedAt`.
- Dismissal is exact-version only and never disables future checks. `check_on_startup=false`
  suppresses startup notice and background network access; explicit `update check` remains allowed.
- The gateway projects snake-case update fields. The TUI renders one transient notice only when
  `availability=available`, using stable id `startup-update-notice`, install guidance, and
  `/update dismiss <version>`. A successful dismissal removes that notice without persisting it.
- Update surfaces report package-manager guidance only. They must not run an installer, mutate the
  application package, or request privilege escalation.

### 4. Validation & Error Matrix

| Condition | Required behavior |
| --- | --- |
| Cache missing or stale | Return cached/unknown startup state immediately; refresh in background |
| Startup checks disabled | Return `availability=disabled`; perform no background request |
| Registry returns prerelease, malformed JSON, non-2xx, or oversized body | Preserve prior cache; return failed refresh outcome |
| Existing cache exceeds 16 KiB | Read only to the bound, treat it as invalid, and permit a validated atomic replacement |
| Cache contains a future timestamp or wrong package/schema | Treat as stale/invalid; never keep it fresh indefinitely |
| Dismiss version is not strict semver | `invalid_update_version` / gateway `invalid_params` |
| Dismiss version is not the advertised version | `update_version_unavailable` / gateway `invalid_params` |
| Atomic dismissal write fails | `update_cache_write_failed`; retain the previous file |
| One refresh is still active during shutdown | Abort it and keep close pending until it settles |
| Bootstrap availability is current, dismissed, disabled, or unknown | Render no startup update notice |
| Doctor collector throws or times out | Emit one bounded failed row; continue remaining collectors |
| Doctor collector supplies malformed fields or a forged recovery label | Normalize the row and rebuild only recognized recovery action ids |
| `doctor --fix` has no confirmation | Return a preview or `not_needed`; perform no write |
| Repair preview omits or truncates its change list | Return `repair_preview_failed`; expose no confirmable action |
| Confirmation id is malformed | Reject as CLI usage before service or runtime startup |
| Confirmed plan differs from the freshly rebuilt plan | Return `version_conflict`; apply no replacement action |
| One repair fails after another changed state | Return per-action results and `partial_failure`; never expose the exception |
| Support config or sandbox metadata lookup fails | Export with the bounded trust/readiness fallback |
| Support artifact is oversized or cannot be atomically written | Return `support_bundle_write_failed` and no raw filesystem error |
| Support text contains secrets, credential URLs, control bytes, or local paths | Redact or replace them before serialization |
| Two failed requests reuse a method/code/message | Generate distinct occurrence ids and render two diagnostics |

### 5. Good / Base / Bad Cases

- Good: bootstrap advertises yesterday's cached `0.2.0`, starts a refresh, and remains stable even
  if `0.3.0` is fetched before the TUI loads settings; the next process advertises `0.3.0`.
- Good: `/update dismiss 0.2.0` atomically records that exact version and removes the transient row;
  a later cached `0.3.0` is still shown.
- Good: preview one user-config migration, confirm that exact plan id, apply through the config
  transaction, and rerun diagnostics once.
- Good: export one private support JSON file whose receipt exposes only its relative location,
  byte count, and SHA-256 digest.
- Base: no cache exists and the registry is offline; startup is unaffected and no notice is shown.
- Base: no deterministic repair is needed; `doctor --fix` returns `not_needed` without creating a
  config, backup, or support file.
- Bad: await registry fetch before emitting `runtime.ready` or recompute settings from the newly
  written cache during the same automatic startup sequence.
- Bad: infer update availability in the TUI, persist the notice into session history, or execute the
  package-manager command.
- Bad: auto-apply a newly rebuilt plan, copy raw logs into a support archive, or feed repair errors
  into the runtime-turn/TUI diagnostic lane.
- Bad: allow backend integration tests to contact the real npm registry; inject a deterministic
  fetch implementation instead.

### 6. Tests Required

- Config tests: default/opt-out resolution, canonical user mutation, strict semver comparison,
  cache bounds, timeout/failure preservation, atomic permissions, exact dismissal, and concurrent
  refresh ordering.
- Lifecycle tests: backend resolves while fetch is pending; opt-out makes zero requests; close
  aborts and remains pending until fetch cleanup settles; a fetched version appears only after a
  restart.
- Gateway tests: both RPC methods route, bootstrap/settings share the startup snapshot, slash check
  is explicit, dismissal maps bounded errors, and the catalog advertises `/update`.
- TUI tests: one stable notice for available state, none for every other state, repeated bootstrap
  deduplication, width-safe guidance, and successful dismissal removal.
- Doctor tests: provider-free collectors, nested redaction, human/verbose/JSON parity, duration,
  canonical recovery actions from untrusted rows, bounded support manifest, preview/apply/no-op/
  conflict/partial-failure repair outcomes, and text/JSON repair metadata parity.
- Support tests: allowlisted schema shape, deterministic replacement and digest, private modes,
  config/sandbox fallback, write failure containment, and a cross-platform fuzz corpus covering
  nested secrets, credential URLs, C0/C1 controls, POSIX/Windows/UNC/home paths, and unknown fields.
- CLI composition tests must prove Doctor check/fix/support starts no provider, backend, or TUI.
- Diagnostic projection tests: representative auth/provider/config/storage failures render one
  row each; response/event lanes collapse only when they share an occurrence id, while identical
  failures with different ids remain distinct.
- Run lint, type-check, contract drift, the full workspace test suite, and packed application smoke.

### 7. Wrong vs Correct

#### Wrong: Awaited Startup Refresh

```typescript
const latest = await fetchRegistryVersion();
const gateway = createNodeGateway({ updateStatus: latest });
```

This delays readiness and lets network timing change what the current startup displays.

#### Correct: Background Refresh With Owned Shutdown

```typescript
const startupStatus = await updateCache.status(checkOnStartup);
const gateway = createNodeGateway({ updateStatus: startupStatus, updateCommands, ...options });
updateCache.startBackgroundRefresh(checkOnStartup);

const close = async (): Promise<void> => {
  await updateCache.close();
  await closeRuntimeResources();
};
```

The current startup is deterministic, refresh is non-blocking, and shutdown owns every side effect.

#### Wrong: Derived Request Identity

```typescript
const occurrenceId = hash(`${requestId}:${method}`);
```

Request ids and methods may be reused across reconnects or clients, so unrelated failures can
collapse into one row.

#### Correct: Fresh Per-Occurrence Identity

```typescript
const occurrenceId = gatewayRequestOccurrenceId();
emitRpcError({ occurrenceId });
emitGatewayError({ occurrenceId });
```

One failure shares one fresh identity across both delivery lanes; a later failure gets a new one.

#### Wrong: Apply Whatever A Second Preview Returns

```typescript
const preview = await config.previewMigration(signal);
await config.applyMigration(preview.expectedVersion!, signal);
```

This bypasses the user's confirmed action set and lets concurrent state select a different repair.

#### Correct: Rebuild And Match The Confirmed Doctor Plan

```typescript
const execution = await repairs.execute(command.expectedPlanId, signal);
if (execution.status === "version_conflict") return boundedConflict(execution);
```

The repair service binds user confirmation to the value-free plan and delegates the mutation to its
owning transaction only after the current plan still matches.
