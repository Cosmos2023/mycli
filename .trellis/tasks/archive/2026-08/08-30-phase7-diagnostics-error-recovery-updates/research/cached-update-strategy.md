# Cached Update Strategy

## Comparable behavior

The local Codex implementation in `codex-rs/tui/src/updates.rs` uses a deliberately conservative
startup contract:

- read the previous cache synchronously;
- show only information already present in that cache for the current startup;
- refresh a missing or older-than-20-hours cache in a background task;
- preserve `dismissed_version` across refreshes;
- treat every network or cache failure as non-fatal;
- suppress a popup when the exact latest version was dismissed;
- choose update guidance from the detected installation method.

Codex doctor separately reports cached state, installation context, latest-version probe results,
and target mismatches. Update reachability is useful support context but never masks local failures.

## mycli constraints

- The published CLI package is `@mycli/app`; its version is available as `MYCLI_VERSION`.
- The package already depends on Node 22.19+, so built-in `fetch`, `AbortSignal.timeout`, and URL APIs
  are available without adding a dependency.
- `backend/packages/config/src/private-file-writer.ts` provides locked, atomic, mode-0600 updates and
  is suitable for `~/.mycli/version.json`.
- The current config schema does not recognize an `[updates]` table. An opt-out setting must be
  added to the canonical config schema rather than hidden in TUI-only state.
- mycli currently ships through npm packages, but source checkouts and vendored/package-manager
  wrappers are valid launch contexts. An update command must not assume that the running binary is
  the npm global target.

## Selected cache contract

Use `~/.mycli/version.json`, versioned and bounded:

```ts
interface UpdateCacheRecord {
  readonly schemaVersion: 1;
  readonly packageName: "@mycli/app";
  readonly latestVersion: string;
  readonly lastCheckedAt: string;
  readonly dismissedVersion?: string;
}
```

- Freshness is 20 hours, matching Codex and staying inside the roadmap's 20-24 hour range.
- Fetch `https://registry.npmjs.org/@mycli%2Fapp/latest` with a five-second timeout and accept only a
  bounded object containing a strict semantic version.
- A malformed or unreadable cache behaves as missing. A failed refresh does not overwrite the last
  valid cache.
- Concurrent refreshes are serialized by the existing private-file writer; only validated records
  can replace the target.
- Startup returns cached status immediately and starts refresh without awaiting it. Newly fetched
  information becomes visible on the next startup, so first paint and current UI state never depend
  on the network.
- Dismissal changes only `dismissedVersion`; a future latest version becomes eligible again.
- `[updates].check_on_startup = false` disables both notice projection and background refresh.

## Installation guidance

Detection is evidence-based and side-effect free:

- npm user-agent or an npm-managed package-root marker: `npm install -g @mycli/app@latest`;
- pnpm user-agent: `pnpm add -g @mycli/app@latest`;
- Yarn user-agent: `yarn global add @mycli/app@latest`;
- Bun user-agent: `bun add -g @mycli/app@latest`;
- otherwise: report `unknown` and show the npm command as guidance, clearly labeled as a manual
  fallback.

Phase 7 never launches the package manager or elevates privileges.

## Relevant files

- `/Users/cosmos/Downloads/codex-main/codex-rs/tui/src/updates.rs`
- `/Users/cosmos/Downloads/codex-main/codex-rs/cli/src/doctor/updates.rs`
- `backend/packages/config/src/private-file-writer.ts`
- `backend/packages/config/src/config-schema.ts`
- `backend/apps/mycli/src/version.ts`
- `backend/apps/mycli/src/node-runtime/node-settings-catalog.ts`

