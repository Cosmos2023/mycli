# Implementation Boundaries

## Considered approaches

### A. Replace all errors with one new exception type

This would make the public shape uniform, but it would discard useful local exception ownership,
duplicate mature provider/config classification, and create a high-risk migration across runtime,
storage, tools, integrations, gateway, and TUI.

### B. Add projection adapters over existing authoritative errors (selected)

Keep provider, config, storage, sandbox, and gateway error types in their owning modules. Add one
small public diagnostic vocabulary and adapt into it only at process/user-interface boundaries.

Benefits:

- preserves current retry and persistence guarantees;
- keeps configuration file/range metadata authoritative;
- allows doctor, CLI JSON, gateway, and TUI to share categories and recovery actions;
- can be delivered and tested in coherent batches without a flag day.

Cost:

- adapters remain necessary because not every local error has the same source fields;
- compatibility fields need to stay during this milestone.

### C. Limit Phase 7 to rendering changes

This would improve appearance quickly but leave request identity, doctor JSON, update cache safety,
and backend recovery ownership unresolved. It does not satisfy the approved roadmap.

## Selected implementation batches

1. **Diagnostic vocabulary and request identity**
   - closed categories, severities, and recovery-action ids in contracts;
   - exhaustive runtime and gateway mappings;
   - one occurrence id across JSON-RPC rejection and `gateway.error`;
   - TUI consumes safe structured metadata and deduplicates by identity.
2. **Doctor and support report**
   - enrich rows with category, stable code, bounded details, remediation, and duration;
   - add terminal and update collectors while keeping provider calls disabled;
   - expose verbose human output and the same redacted JSON payload;
   - add a bounded support manifest to JSON output rather than a raw archive containing user data.
3. **Cached update status**
   - canonical config opt-out;
   - atomic cache, strict semver, timeout, and background refresh;
   - install guidance, status, and exact-version dismissal;
   - settings/TUI notice projection without blocking startup.
4. **Documentation and cross-layer verification**
   - troubleshooting/update guidance;
   - contracts, config, gateway, doctor, and TUI regression tests;
   - full lint, typecheck, contract drift, and workspace tests.

## Failure and evolution sweep

- Offline, timeout, invalid JSON, registry error, unwritable cache, and concurrent refresh are
  non-fatal and retain a previous valid cache.
- Cache timestamps in the future are treated as stale/corrupt rather than indefinitely fresh.
- Prerelease or non-semantic versions are never advertised by the stable update channel.
- Dismissal is exact-version only and does not disable future update checks.
- Support output excludes prompts, model/provider bodies, commands, tool content, environment
  values, credential fragments, and raw stacks.
- The diagnostic vocabulary leaves room for future migration and connectivity checks, but Phase 7
  does not implement config migration or live provider probing.

