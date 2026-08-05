# Node Runtime Stack Research

## Scope

This note evaluates implementation choices for a Node-only mycli runtime using the repository's
current constraints. It is based on the checked-in Python and TypeScript implementations plus
local Node.js 24.14.1 behavior. It does not claim external package-version verification.

## Repository Constraints

- Final distribution is an npm CLI requiring Node.js 22.19 or newer.
- The existing TUI is strict TypeScript, ESM, npm, and the Node test runner.
- Existing TOML configuration, auth JSON, and SQLite schema must remain readable.
- macOS, Linux, and Windows shell/sandbox behavior must remain supported.
- Python and Node backends coexist temporarily and share session data.
- Process-boundary and persisted data use canonical JSON Schema contracts.

## Recommended Baseline

| Concern | Recommendation | Reason |
| --- | --- | --- |
| Workspace | npm workspaces | Extends the existing npm/package-lock toolchain without churn. |
| Build | `tsc` project references | Produces ordinary ESM JavaScript and keeps package boundaries explicit. |
| Tests | Node test runner | Already used by the TUI and adequate for unit/contract/integration tests. |
| Contract source | JSON Schema Draft 2020-12 | Language-neutral during Python/Node coexistence. |
| Runtime validation | Ajv behind a contract package | Mature boundary validation and stable structured errors. |
| TS generation | `json-schema-to-typescript` | Deterministic declarations avoid duplicate request/event types. |
| Providers | Official provider SDKs behind local adapters | Keeps transport details outside runtime orchestration and allows fakes. |
| SQLite | A `SessionStore` adapter using `better-sqlite3` | Closely matches current Python transaction semantics and keeps SQL explicit. |
| PTY | `node-pty` behind a `ShellTransport` interface | Established Unix PTY and Windows ConPTY behavior; defer until shell phase. |
| Process execution | `node:child_process` with explicit abort/process-tree control | Standard-library default for non-PTY tools and sidecar lifecycle. |
| Logging | Structured JSONL writer using Node filesystem APIs | Preserves current local-first observability without a logging framework. |

## SQLite Decision

The local runtime exposes `node:sqlite`, but importing it on Node.js 24.14.1 emits an
`ExperimentalWarning`. The migration targets Node.js 22.19+, so relying directly on this API
would couple persistence to an experimental surface across the supported range.

Recommended approach:

1. Define `SessionStore` in `packages/storage` independently of a driver.
2. Keep the current SQL schema and transaction boundaries explicit.
3. Use `better-sqlite3` for the migration release while keeping its types private to the adapter.
4. Run the same database fixtures against Python and Node readers/writers.
5. Re-evaluate `node:sqlite` only after its supported API is stable across the minimum Node line.

The synchronous API is intentional for a local single-user CLI: it simplifies transaction and
ordering semantics. Model streaming and long-running tools remain asynchronous and must not hold
database transactions open.

## Provider Boundary

Use one local `ModelProvider` contract for Responses and Chat Completions. Provider adapters own:

- request serialization;
- SDK/HTTP stream mapping;
- provider-specific reasoning and tool-call fields;
- retryability classification;
- continuation/capability state;
- raw provider diagnostics with credential redaction.

The runtime owns:

- turn identity and idempotency;
- retry policy decisions;
- cancellation;
- normalized runtime events;
- persistence ordering;
- tool-loop progression.

This prevents the OpenAI-compatible Chat adapter from becoming a second agent loop. Tests inject
a fake transport and replay captured, sanitized event sequences.

## Shell And Sandbox

The current implementation has three distinct process sandbox wrappers:

- macOS `sandbox-exec`/Seatbelt;
- Linux Bubblewrap;
- a packaged Windows restricted-token helper.

These are process protocols rather than Python-specific business logic. Node can construct the
same argv/request payloads and invoke the same external mechanisms. The Windows helper can remain
a packaged native asset; eliminating Python does not require rewriting that security helper.

PTY should migrate late. A `node-pty` adapter is the practical replacement for Unix PTY and
Windows ConPTY, but it adds a native npm dependency and needs platform CI for resize, interrupt,
process-tree cleanup, UTF-8 chunking, and background-session behavior.

## Dependency Rules

- Keep all third-party SDKs behind local interfaces.
- Do not expose Ajv, SQLite-driver, provider-SDK, or PTY types from domain packages.
- Pin runtime dependencies in the lockfile and test the minimum supported Node version.
- Fail closed when sandbox or contract validation is unavailable.
- Never log auth payloads, provider headers, or raw secret-bearing configuration.
