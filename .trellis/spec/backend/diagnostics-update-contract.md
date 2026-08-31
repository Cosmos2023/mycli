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
  - `mycli doctor [--verbose] [--json]`
  - `mycli update [status|check|dismiss <stable-version>] [--json]`
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
| Two failed requests reuse a method/code/message | Generate distinct occurrence ids and render two diagnostics |

### 5. Good / Base / Bad Cases

- Good: bootstrap advertises yesterday's cached `0.2.0`, starts a refresh, and remains stable even
  if `0.3.0` is fetched before the TUI loads settings; the next process advertises `0.3.0`.
- Good: `/update dismiss 0.2.0` atomically records that exact version and removes the transient row;
  a later cached `0.3.0` is still shown.
- Base: no cache exists and the registry is offline; startup is unaffected and no notice is shown.
- Bad: await registry fetch before emitting `runtime.ready` or recompute settings from the newly
  written cache during the same automatic startup sequence.
- Bad: infer update availability in the TUI, persist the notice into session history, or execute the
  package-manager command.
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
  canonical recovery actions from untrusted rows, and bounded support manifest.
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
