# Permission Grant Contract

> Runtime-owned temporary permissions, managed upper bounds, and exact tool enforcement.

## Scenario: Requesting And Applying Additional Permissions

### 1. Scope / Trigger

- Trigger: changing `request_permissions`, execution-policy resolution, managed configuration,
  file-root authorization, network authorization, approval continuation, or child-agent policy
  inheritance.
- The model describes required access. The user selects `turn`, `session`, or rejection scope;
  provider arguments never select grant duration or bypass managed constraints.

### 2. Signatures

- Experimental provider tool: `request_permissions({ permissions, reason? })`.
- Feature controls: `[features].request_permissions_tool` or
  `MYCLI_REQUEST_PERMISSIONS_TOOL`; default is `false`.
- Permission fields: `network.enabled`, `file_system.read[]`, and `file_system.write[]`.
- Managed file: `~/.mycli/managed_config.toml`, table `[execution_policy]`.
- Managed fields: `network`, `readable_roots`, `writable_roots`, and
  `allowed_network_domains`.
- Network patterns: an exact host or one leading `*.` wildcard.

### 3. Contracts

- The ordinary `workspace` profile enables networking without a temporary grant and retains its
  canonical workspace write roots. `read-only` starts offline. Shell launch, `web_fetch`, model
  policy context, child inheritance, and permission-selector defaults use the effective profile.
- Managed configuration is loaded independently from user and project configuration and is passed
  to runtime only as an upper-bound constraint layer. Ordinary configuration cannot override it.
- Startup validates managed configuration before resolving ordinary model configuration or
  creating user-owned runtime files. An invalid administrator policy must reject startup without
  leaving a concurrent config/bootstrap task writing under `~/.mycli`.
- `request_permissions` remains registered for durable recovery, but its provider schema is
  exposed only when the experimental feature is explicitly enabled. The default provider,
  subagent, gateway, and compaction tool inventories omit it; per-operation approvals remain the
  normal permission path.
- Restricted policy roots and managed writable roots are intersected pairwise. When one canonical
  root contains the other, the effective root is the narrower path; disjoint roots contribute no
  authority. A workspace root constrained to one nested directory must therefore retain that
  directory instead of becoming either workspace-wide or empty.
- Permission requests normalize existing filesystem roots before approval. Runtime constrains the
  approved request again before registering a turn or session grant.
- Turn grants are deleted when their owning turn finishes. Session grants live only for the current
  runtime process unless a future explicit durable-revocation design is added.
- `Read` accepts an outside target only under unrestricted filesystem access or an exact canonical
  `readableRoots`/`writableRoots` boundary. Write/Edit/Patch use the corresponding writable roots.
- Writable roots are the complete write allowlist, not additions to an implicitly writable
  workspace. Empty roots deny all mutations; a narrowed managed/granted root authorizes only its
  descendants (or the exact file). Approval and actual file operations enforce this independently,
  including symlink targets, Patch move sources/destinations, and runtime-owned approval overrides.
- Only standalone file adapters without an execution policy default to workspace writes. An
  explicitly empty list must survive every projection without becoming an omitted value.
- An approved sandbox override uses the runtime-owned override policy. Managed roots and network
  constraints still cap it; the approval boolean alone never constructs unrestricted access.
- `web_fetch` checks the initial URL and every redirect against the effective domain list. Exact
  entries match one host. `*.example.com` matches subdomains only, not the apex.
- Domain-constrained Shell uses a process-owned HTTP/CONNECT proxy: macOS Seatbelt permits
  only its loopback TCP port; Windows WFP binds that port to the runner's unique logon SID.
  Linux rejects enabled, non-empty domain policies with `network_proxy_unavailable`. Disabled/empty policies stay offline;
  raw sandbox launches without a proxy stay offline on every platform.
- File-system full access does not discard network constraints. A model escalation request alone
  retains the original policy; an approved fallback without an explicit override preserves any
  existing domain bound. See [Network Proxy Contract](./network-proxy-contract.md).
- Subagent spawn snapshots preserve readable roots, writable roots, and network domains. The child
  runtime installs them as runtime constraints and seeds only the inherited effective grants.

### 4. Validation & Error Matrix

| Condition | Required behavior |
| --- | --- |
| Managed file absent | Start without a managed constraint layer |
| Invalid TOML or managed field type | Fail startup as `config_error` |
| Invalid managed policy during startup | Reject before ordinary configuration creates runtime state |
| Feature absent or false | Omit `request_permissions` from every model-visible tool inventory |
| Feature true | Expose the tool without changing its grant or managed-policy constraints |
| Managed writable root nested under a policy root | Retain only the nested managed root |
| Policy writable root nested under a managed root | Retain only the narrower policy root |
| Disjoint policy and managed writable roots | Retain neither root |
| Requested path outside a managed root | Return a constrained grant without that path |
| Read under a granted readable root | Execute and keep normal bounded output rules |
| Read outside all effective roots | Return `workspace_escape` |
| Write/Edit/Patch with read-only or empty writable roots | Return `workspace_escape`; no file or history effects |
| Write grant narrowed to a workspace subdirectory | Deny other workspace files, including through symlinks |
| Approved override with managed writable roots | Recheck those exact roots before committing |
| Initial web host outside allowlist | Return `network_domain_denied`; make no request |
| Redirect outside allowlist | Return `network_domain_denied`; do not fetch the redirect target |
| Enabled, non-empty domain-constrained Shell on macOS / restricted Windows | Use a frozen per-process proxy and deny direct egress |
| Enabled, non-empty domain-constrained Shell on Linux | Return `network_proxy_unavailable`; start no process |
| Network-disabled, empty domain list, or raw launch without a proxy | Preserve offline sandbox enforcement |
| Child requests broader roots/domains | Reject with `AgentAuthorityError` |

### 5. Good/Base/Bad Cases

- Good: workspace mode plus managed `/repo/generated` write access produces exactly
  `/repo/generated` as the effective writable root.
- Good: managed policy validation completes before model catalog/config resolution begins.
- Base: a managed `/repo` root and a workspace policy rooted at `/repo/project` preserve the
  already narrower `/repo/project` policy root.
- Bad: filter only for policy roots contained by managed roots. That incorrectly turns
  workspace `/repo` plus managed `/repo/generated` into an empty set.
- Bad: union policy and managed roots. That expands an upper bound into additional authority.
- Bad: resolve managed and ordinary configuration with `Promise.all`; early managed rejection can
  leave ordinary configuration writing after startup has already failed.

### 6. Tests Required

- Managed config absence, valid independent parsing, malformed TOML, invalid enums, and invalid
  bounded arrays.
- App startup rejects invalid managed policy before config/model bootstrap side effects and permits
  immediate deterministic cleanup of the temporary home directory.
- Feature default-off, TOML/environment opt-in, provider exposure, subagent inheritance, and
  hidden-tool durable approval recovery.
- Writable-root intersection covers a managed root nested under the workspace root, the inverse
  nesting order, and disjoint roots; both normal profiles and sandbox overrides use the result.
- Turn/session grant resolution, managed read/write filtering, network-disabled filtering, and
  turn-grant cleanup.
- External Read success under a readable root and rejection without it.
- Exact host, wildcard subdomain, wildcard apex rejection, and cross-domain redirect rejection.
- macOS, Linux, and Windows process-launch projection for domain-constrained policies.
- Shell and file-mutation sandbox overrides remain inside the runtime-provided override policy.
- Subagent narrowing and durable spawn-config round trips preserve all policy constraints.

### 7. Wrong vs Correct

#### Wrong

```typescript
const roots = policyRoots.filter((root) =>
  managedRoots.some((allowed) => pathWithinRoot(allowed, root)),
);
```

This keeps only one nesting direction and drops a valid managed subdirectory of a broader policy
root.

#### Correct

```typescript
const roots = policyRoots.flatMap((policyRoot) =>
  managedRoots.flatMap((managedRoot) => {
    if (pathWithinRoot(policyRoot, managedRoot)) return [managedRoot];
    if (pathWithinRoot(managedRoot, policyRoot)) return [policyRoot];
    return [];
  }),
);
```

The narrower canonical root represents the set intersection without granting either broader root.

For startup ordering, do not race an authoritative upper bound with side-effecting configuration:

```typescript
// Wrong: the second task may continue writing after the first task rejects.
const [config, managed] = await Promise.all([
  resolveModelRuntimeConfig(options),
  loadManagedExecutionPolicy(options),
]);

// Correct: validate the administrator boundary before ordinary config bootstrap.
const managed = await loadManagedExecutionPolicy(options);
const config = await resolveModelRuntimeConfig(options);
```

Managed `denied_read_roots` / `denied_read_globs` are immutable upper bounds. Normalize/copy them in
run snapshots and child-agent authority, union them when restoring current managed constraints,
and reject grants for protected targets. Full Access cannot erase them. Glob resolution must use
the original workspace even when a stdio MCP or plugin process launches from a different directory.
