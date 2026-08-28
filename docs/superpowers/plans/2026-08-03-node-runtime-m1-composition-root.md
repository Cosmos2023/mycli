# Node Runtime M1 Composition Root Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a compiled Node.js CLI that owns terminal and process lifecycle while running the
existing Python runtime as an explicit, temporary JSON-RPC sidecar.

**Architecture:** Keep the current gateway contract and TUI behavior, but inject the RPC streams
used by the TUI instead of binding them permanently to Node stdin/stdout. The Node composition
root spawns one Python sidecar with piped stdin/stdout, verifies `runtime.ready`, the extension
manifest, and protocol version before any turn, then runs the existing TUI in the same Node
process. The existing Python-parent launcher remains available as the explicit rollback path.

**Tech Stack:** Node.js 22.19+, TypeScript 5.9 ESM, npm workspaces, Node child processes, Node test
runner, Python 3.13, line-delimited JSON-RPC, Ajv contracts, pytest, Ruff, and mypy.

---

## Scope Boundaries

M1 changes process ownership only. Python continues to own every provider, turn, tool, session,
configuration, and integration capability. No request may switch backend after startup, and a
sidecar failure must never trigger a second Python process or replay a turn.

The new npm CLI supports the interactive TUI path plus `--help` and `--version`. Existing Python
management commands remain on `uv run mycli` until their capability slices migrate. Selecting an
unavailable native Node runtime fails explicitly; it does not fall back to Python.

The M1 live API result is `not applicable`: lifecycle inversion does not change provider request
or response behavior.

## Target File Map

- `apps/mycli/src/cli.ts`: npm executable, argument parsing, backend selection, exit codes.
- `apps/mycli/src/backend-router.ts`: explicit runtime backend decision without fallback.
- `apps/mycli/src/sidecar/python-sidecar.ts`: child spawn, bounded stderr, shutdown escalation,
  and orphan prevention.
- `tui/mycli-shell/src/adapters/gateway-transport.ts`: one-time RPC stream injection for either
  Python-parent compatibility or Node-parent sidecar mode.
- `tui/mycli-shell/src/adapters/gateway-handshake.ts`: readiness and manifest compatibility
  checks performed before session bootstrap.
- `src/mycli/cli/node_tui/stdio.py`: Python stream-backed gateway peer.
- `src/mycli/cli/sidecar.py`: Python module entry point that builds the existing `TurnService`
  and serves JSON-RPC only on stdin/stdout.

---

### Task 1: Make Gateway Transport Injectable

**Files:**
- Create: `tui/mycli-shell/src/adapters/gateway-transport.ts`
- Create: `tui/mycli-shell/test/gateway-transport.test.ts`
- Modify: `tui/mycli-shell/src/gateway.ts`
- Modify: `tui/mycli-shell/package.json`

- [x] **Step 1: Write failing one-time transport configuration tests**

Cover the default Python-parent streams, injected sidecar streams, injected close callback, and
duplicate configuration rejection:

```typescript
test("gateway transport defaults to process protocol streams", () => {
  const transport = gatewayTransport();
  assert.equal(transport.input, process.stdin);
  assert.equal(transport.output, process.stdout);
});

test("gateway transport accepts one sidecar stream pair", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let closed = 0;
  configureGatewayTransport({ input, output, close: async () => { closed += 1; } });
  assert.equal(gatewayTransport().input, input);
  await closeGatewayTransport();
  assert.equal(closed, 1);
});
```

Expose a test-only reset function from an internal test export so tests do not leak singleton
state. Production code must never reset or replace a configured transport.

- [x] **Step 2: Run the focused test and verify the adapter is absent**

Run:

```bash
node --import tsx --test tui/mycli-shell/test/gateway-transport.test.ts
```

Expected: FAIL because `gateway-transport.ts` does not exist.

- [x] **Step 3: Implement the minimal transport registry**

Use this public shape:

```typescript
export type GatewayTransport = {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  close?: () => void | Promise<void>;
};

export function configureGatewayTransport(transport: GatewayTransport): void;
export function gatewayTransport(): GatewayTransport;
export async function closeGatewayTransport(): Promise<void>;
```

The default is `{input: process.stdin, output: process.stdout}`. Configuration is one-shot and
must happen before importing `gateway.ts` in Node-parent mode.

- [x] **Step 4: Switch the TUI gateway client to the registry**

Replace direct `process.stdin` / `process.stdout` client construction with the resolved transport.
Call `closeGatewayTransport()` from `stopLocalRuntime()` after the graceful `shutdown` response
and after `client.stop()`. Preserve the current Python-parent behavior when no transport is
configured. Add a development export for `mycli-shell-tui/gateway-transport` so the composition
root can configure the singleton without importing and starting `gateway.ts`.

- [x] **Step 5: Run transport and complete TUI tests**

Run:

```bash
node --import tsx --test tui/mycli-shell/test/gateway-transport.test.ts
npm test --workspace mycli-shell-tui
npm run typecheck --workspace mycli-shell-tui
```

Expected: transport tests pass; the existing Node 22.19 suite remains green. On Node 24, only the
documented native-readline `ESC[1A` baseline may fail.

- [x] **Step 6: Commit injectable transport**

```bash
git add tui/mycli-shell/src/adapters/gateway-transport.ts tui/mycli-shell/test/gateway-transport.test.ts tui/mycli-shell/src/gateway.ts tui/mycli-shell/package.json
git commit -m "refactor(tui): inject gateway transport"
```

### Task 2: Add A Python Stdio Sidecar Entry Point

**Files:**
- Create: `src/mycli/cli/node_tui/stdio.py`
- Create: `src/mycli/cli/sidecar.py`
- Create: `tests/unit/cli/node_tui/test_stdio.py`
- Create: `tests/unit/cli/test_sidecar.py`
- Modify: `src/mycli/cli/node_tui/gateway.py`
- Modify: `src/mycli/cli/node_tui/__init__.py`

- [x] **Step 1: Write failing stream-peer gateway tests**

Use `io.StringIO` to prove the sidecar emits `runtime.ready`, processes bootstrap and shutdown,
returns zero, and never writes diagnostics to protocol stdout:

```python
def test_run_stdio_gateway_processes_bootstrap_and_shutdown(tmp_path: Path) -> None:
    incoming = StringIO(
        '{"jsonrpc":"2.0","id":"1","method":"session.bootstrap",'
        '"params":{"protocol_version":1}}\n'
        '{"jsonrpc":"2.0","id":"2","method":"shutdown","params":{}}\n'
    )
    outgoing = StringIO()
    result = run_stdio_gateway(
        service=cast(TurnService, FakeService(tmp_path)),
        input_stream=incoming,
        output_stream=outgoing,
    )
    assert result == 0
    assert '"method":"runtime.ready"' in outgoing.getvalue()
    assert '"id":"1"' in outgoing.getvalue()
```

- [x] **Step 2: Run the focused tests and verify the API is absent**

Run:

```bash
uv run pytest tests/unit/cli/node_tui/test_stdio.py tests/unit/cli/test_sidecar.py -q
```

Expected: FAIL because the stdio runner and sidecar entry point do not exist.

- [x] **Step 3: Extract the gateway loop behind the existing peer protocol**

Keep `run_node_tui_gateway(service, process)` as a compatibility wrapper. Move the shared loop to
a private function accepting the existing `start`, `read_line`, `write_line`, `wait`, and
`terminate` protocol. `StdioGatewayPeer` implements that protocol without starting or terminating
another process:

```python
class StdioGatewayPeer:
    def __init__(self, input_stream: TextIO, output_stream: TextIO) -> None: ...
    def start(self) -> None: ...
    def read_line(self) -> str: ...
    def write_line(self, line: str) -> None: ...
    def wait(self) -> int: ...
    def terminate(self) -> None: ...
```

Closing the peer must not close global `sys.stdin`, `sys.stdout`, or `sys.stderr` objects.

- [x] **Step 4: Implement the sidecar module entry point**

`python -m mycli.cli.sidecar` accepts only `--session` and `--model`, uses `Path.cwd()` and the
normal environment, builds the existing `TurnService`, and serves stdin/stdout. Failures write one
sanitized line to stderr and return exit code 2. The service is always closed in `finally`.

```python
def main(argv: list[str] | None = None) -> int:
    args = vars(build_sidecar_parser().parse_args(argv))
    service = build_turn_service(args)
    try:
        return run_stdio_gateway(service=service, input_stream=sys.stdin, output_stream=sys.stdout)
    finally:
        service.close()
```

- [x] **Step 5: Verify Python compatibility paths**

Run:

```bash
uv run pytest tests/unit/cli/node_tui/test_stdio.py tests/unit/cli/test_sidecar.py tests/unit/cli/node_tui/test_gateway.py tests/integration/test_node_tui_gateway.py -q
uv run ruff check src/mycli/cli/sidecar.py src/mycli/cli/node_tui tests/unit/cli/test_sidecar.py tests/unit/cli/node_tui
uv run mypy src/mycli
```

Expected: all commands pass and the existing Python-parent Node launcher remains compatible.

- [x] **Step 6: Commit the Python sidecar**

```bash
git add src/mycli/cli/sidecar.py src/mycli/cli/node_tui/stdio.py src/mycli/cli/node_tui/gateway.py src/mycli/cli/node_tui/__init__.py tests/unit/cli/test_sidecar.py tests/unit/cli/node_tui/test_stdio.py
git commit -m "feat(sidecar): serve runtime gateway over stdio"
```

### Task 3: Gate Startup On Readiness And Capability Handshake

**Files:**
- Create: `tui/mycli-shell/src/adapters/gateway-handshake.ts`
- Create: `tui/mycli-shell/test/gateway-handshake.test.ts`
- Modify: `tui/mycli-shell/src/gateway.ts`
- Modify: `tui/mycli-shell/src/adapters/gateway-client.ts`
- Modify: `tui/mycli-shell/test/gateway-client.test.ts`

- [x] **Step 1: Write failing handshake tests**

Cover a compatible manifest, wrong schema version, missing RPC/event names, and timeout before
`runtime.ready`. Error messages contain stable codes and counts only, never full manifests:

```typescript
test("handshake accepts the canonical Python gateway surface", () => {
  assert.doesNotThrow(() => verifyGatewayManifest({
    schema_version: 1,
    rpc_methods: gatewayContractCatalog.rpcMethods.map((name) => ({ name })),
    event_streams: gatewayContractCatalog.eventStreams.map((name) => ({ name })),
  }));
});

test("handshake rejects an incompatible schema version without dumping payload", () => {
  assert.throws(() => verifyGatewayManifest({ schema_version: 999 }), /incompatible_protocol/);
});
```

- [x] **Step 2: Run tests and verify the handshake module is absent**

Run:

```bash
node --import tsx --test tui/mycli-shell/test/gateway-handshake.test.ts
```

Expected: FAIL because `gateway-handshake.ts` does not exist.

- [x] **Step 3: Implement bounded compatibility checks**

Export:

```typescript
export const GATEWAY_PROTOCOL_VERSION = 1;
export const GATEWAY_MANIFEST_SCHEMA_VERSION = 1;
export function verifyGatewayManifest(value: unknown): void;
export function sidecarStartupTimeoutMs(env: NodeJS.ProcessEnv): number;
```

The manifest must contain the canonical M0 RPC and event names. Extra future names are allowed.
The timeout defaults to 10 seconds, is bounded to 1-60 seconds, and may be overridden only by
`MYCLI_SIDECAR_START_TIMEOUT_MS`.

- [x] **Step 4: Perform handshake before session bootstrap**

After `GatewayClient.start()`, await canonical `runtime.ready`, request `extension.manifest`,
verify it, then send `session.bootstrap(protocol_version=1)`. Add a close callback to
`GatewayClient` so an unexpected input close stops the UI and exits nonzero; `client.stop()` must
not trigger the unexpected-close callback.

- [x] **Step 5: Run handshake, client, and TUI tests**

Run:

```bash
node --import tsx --test tui/mycli-shell/test/gateway-handshake.test.ts tui/mycli-shell/test/gateway-client.test.ts
npm run typecheck --workspace mycli-shell-tui
```

Expected: all focused tests pass.

- [x] **Step 6: Commit startup handshake**

```bash
git add tui/mycli-shell/src/adapters/gateway-handshake.ts tui/mycli-shell/test/gateway-handshake.test.ts tui/mycli-shell/src/adapters/gateway-client.ts tui/mycli-shell/test/gateway-client.test.ts tui/mycli-shell/src/gateway.ts
git commit -m "feat(tui): verify sidecar handshake"
```

### Task 4: Implement The Python Sidecar Process Controller

**Files:**
- Create: `apps/mycli/src/sidecar/python-sidecar.ts`
- Create: `apps/mycli/test/python-sidecar.test.ts`
- Create: `apps/mycli/test/fixtures/fake-sidecar.mjs`
- Create: `apps/mycli/package.json`
- Create: `apps/mycli/tsconfig.json`
- Modify: `package.json`
- Modify: `package-lock.json`

- [x] **Step 1: Write failing process-controller tests**

Inject `spawn` and timers. Cover command construction on POSIX/Windows, piped protocol streams,
bounded/redacted stderr, normal exit, crash exit, graceful shutdown, timeout escalation, and
idempotent cleanup.

```typescript
test("python sidecar never inherits the terminal", () => {
  const sidecar = startPythonSidecar({ spawn: fakeSpawn, env: {}, cwd: "/repo", args: [] });
  assert.deepEqual(lastSpawnOptions.stdio, ["pipe", "pipe", "pipe"]);
  assert.equal(sidecar.transport.input, child.stdout);
  assert.equal(sidecar.transport.output, child.stdin);
});
```

- [x] **Step 2: Run the focused test and verify the controller is absent**

Run:

```bash
node --import tsx --test apps/mycli/test/python-sidecar.test.ts
```

Expected: FAIL because the app workspace and controller do not exist.

- [x] **Step 3: Implement command resolution and sidecar ownership**

Use `MYCLI_PYTHON` as an optional executable override and otherwise select `python` on Windows and
`python3` elsewhere. The command is:

```text
<python> -m mycli.cli.sidecar [--session <id>] [--model <model>]
```

Spawn with `{stdio: ["pipe", "pipe", "pipe"], windowsHide: true}`. Do not use a shell. Reject
missing stdin/stdout as `sidecar_spawn_failed`.

Register `apps/*` in the root workspace list and run `npm install --package-lock-only` so the app
workspace is available to the focused test and type-check commands in this task.

- [x] **Step 4: Implement bounded lifecycle and diagnostics**

Expose:

```typescript
export type PythonSidecar = {
  transport: GatewayTransport;
  completion: Promise<number>;
  close: () => Promise<void>;
};

export function startPythonSidecar(options: StartPythonSidecarOptions): PythonSidecar;
```

Keep at most 8 KiB of sanitized stderr, redact secret-like assignments and bearer/API-key forms,
and never forward stderr into the RPC parser. `close()` closes stdin, waits up to two seconds,
sends termination, then uses a final kill only if the child still has not exited. Multiple closes
share one promise.

- [x] **Step 5: Run controller tests and type checking**

Run:

```bash
node --import tsx --test apps/mycli/test/python-sidecar.test.ts
npm run typecheck --workspace @cosmos2023/app
```

Expected: all focused tests pass.

- [x] **Step 6: Commit sidecar controller**

```bash
git add apps/mycli/package.json apps/mycli/tsconfig.json apps/mycli/src/sidecar/python-sidecar.ts apps/mycli/test/python-sidecar.test.ts apps/mycli/test/fixtures/fake-sidecar.mjs package.json package-lock.json
git commit -m "feat(node-cli): manage Python sidecar lifecycle"
```

### Task 5: Add The Node Composition Root And Backend Router

**Files:**
- Create: `apps/mycli/src/backend-router.ts`
- Create: `apps/mycli/src/cli.ts`
- Create: `apps/mycli/test/backend-router.test.ts`
- Create: `apps/mycli/test/cli.test.ts`
- Modify: `apps/mycli/package.json`
- Modify: `package.json`

- [x] **Step 1: Write failing backend selection tests**

Define one M1 backend and explicit failures:

```typescript
test("M1 defaults to the Python sidecar", () => {
  assert.equal(selectRuntimeBackend({ argv: [], env: {} }), "python-sidecar");
});

test("native Node selection fails without fallback", () => {
  assert.throws(
    () => selectRuntimeBackend({ argv: ["--runtime-backend", "node"], env: {} }),
    /runtime_backend_unavailable/,
  );
});
```

Support `--runtime-backend python-sidecar` and `MYCLI_RUNTIME_BACKEND=python-sidecar`. Reject
conflicting or unknown values. Command-line selection wins over the environment.

- [x] **Step 2: Write failing CLI ownership tests**

Inject the sidecar starter and dynamic TUI importer. Assert that `--help` and `--version` do not
start Python, interactive startup configures the sidecar transport before importing the TUI,
spawn failure returns 2, unexpected sidecar exit returns 1, and unavailable Node backend returns
2 without starting Python.

- [x] **Step 3: Run focused tests and verify the composition root is absent**

Run:

```bash
node --import tsx --test apps/mycli/test/backend-router.test.ts apps/mycli/test/cli.test.ts
```

Expected: FAIL because the router and CLI do not exist.

- [x] **Step 4: Implement the backend router**

Use a closed string union:

```typescript
export type RuntimeBackend = "python-sidecar";
export function selectRuntimeBackend(options: {
  argv: readonly string[];
  env: NodeJS.ProcessEnv;
}): RuntimeBackend;
```

Do not represent unavailable `node` as a valid `RuntimeBackend`; return a stable, user-facing
selection error instead.

- [x] **Step 5: Implement the executable composition root**

`cli.ts` has a Node shebang, validates TTY before sidecar startup, handles help/version locally,
starts exactly one sidecar, calls `configureGatewayTransport`, and only then dynamically imports
`mycli-shell-tui/gateway`. It registers a final synchronous child kill for abnormal process exit,
while normal shutdown remains gateway RPC followed by `PythonSidecar.close()`.

Do not print child stderr unless startup fails. When printed, use only the controller's bounded,
redacted diagnostic summary.

- [x] **Step 6: Add root development commands**

Add:

```json
{
  "scripts": {
    "dev": "node --import tsx apps/mycli/src/cli.ts",
    "mycli": "node --import tsx apps/mycli/src/cli.ts"
  }
}
```

The package `bin` points to `dist/cli.js`; production never points to source or `tsx`.

- [x] **Step 7: Run app tests and a fake-sidecar process smoke**

Run:

```bash
npm test --workspace @cosmos2023/app
npm run typecheck --workspace @cosmos2023/app
```

Expected: all app tests pass, including the real child-process fixture.

- [x] **Step 8: Commit composition root**

```bash
git add apps/mycli/src/backend-router.ts apps/mycli/src/cli.ts apps/mycli/test/backend-router.test.ts apps/mycli/test/cli.test.ts apps/mycli/package.json package.json package-lock.json
git commit -m "feat(node-cli): add runtime composition root"
```

### Task 6: Produce Compiled ESM Packages

**Files:**
- Create: `apps/mycli/tsconfig.build.json`
- Create: `packages/contracts/tsconfig.build.json`
- Create: `tui/mycli-shell/tsconfig.build.json`
- Modify: `apps/mycli/package.json`
- Modify: `packages/contracts/package.json`
- Modify: `tui/mycli-shell/package.json`
- Modify: `package.json`
- Modify: `tests/unit/cli/node_tui/test_package_scripts.py`
- Create: `apps/mycli/test/package.test.ts`

- [x] **Step 1: Write failing production-entrypoint tests**

Assert that the app bin targets `dist/cli.js`, every runtime workspace has a `build` script,
package exports point to JavaScript/declarations under `dist`, and production manifests do not
mention `tsx`, `--import`, or `.ts` entrypoints.

- [x] **Step 2: Run package tests and verify compiled metadata is absent**

Run:

```bash
node --import tsx --test apps/mycli/test/package.test.ts
uv run pytest tests/unit/cli/node_tui/test_package_scripts.py -q
```

Expected: FAIL because the build scripts and dist exports do not exist.

- [x] **Step 3: Add build configurations**

Each build config extends the package type-check config and sets `noEmit: false`, `declaration:
true`, `rootDir: "src"`, `outDir: "dist"`, and `rewriteRelativeImportExtensions: true`. Exclude
tests. Build order is contracts, TUI, then app.

- [x] **Step 4: Point runtime exports at compiled artifacts**

Contracts exports `dist/index.js`; TUI exports `./gateway` and `./gateway-transport`; app exposes
the `mycli` bin. Type declarations point to matching `dist/*.d.ts` files. Source-loaded test
commands remain development-only.

- [x] **Step 5: Add deterministic root build and clean-pack checks**

Root scripts include:

```json
{
  "build": "npm run build --workspace @mycli/contracts && npm run build --workspace mycli-shell-tui && npm run build --workspace @cosmos2023/app",
  "pretest": "npm run build"
}
```

Do not introduce a platform shell cleanup command. TypeScript overwrites deterministic outputs;
CI performs a clean checkout/install before build.

- [x] **Step 6: Build and run the compiled executable**

Run:

```bash
npm run build
node apps/mycli/dist/cli.js --help
node apps/mycli/dist/cli.js --version
npm pack --workspace @cosmos2023/app --dry-run
```

Expected: build succeeds; help/version exit zero without Python; the package contains compiled JS,
declarations, package metadata, and no TypeScript source-loader requirement.

- [x] **Step 7: Run workspace tests and type checks**

Run:

```bash
npm run contracts:check
npm run lint
npm test
npm run typecheck
```

Expected: all supported Node 22.19 checks pass. Record the known Node 24 readline baseline if the
local current-version TUI suite is used.

- [x] **Step 8: Commit compiled packaging**

```bash
git add apps/mycli/tsconfig.build.json apps/mycli/package.json apps/mycli/test/package.test.ts packages/contracts/tsconfig.build.json packages/contracts/package.json tui/mycli-shell/tsconfig.build.json tui/mycli-shell/package.json package.json package-lock.json tests/unit/cli/node_tui/test_package_scripts.py
git commit -m "build(node-cli): compile publishable ESM"
```

### Task 7: Verify Crash, Timeout, Signal, And Orphan Cleanup

**Files:**
- Create: `apps/mycli/test/lifecycle.integration.test.ts`
- Create: `apps/mycli/test/fixtures/stalling-sidecar.mjs`
- Create: `apps/mycli/test/fixtures/crashing-sidecar.mjs`
- Modify: `apps/mycli/src/sidecar/python-sidecar.ts`
- Modify: `apps/mycli/src/cli.ts`
- Modify: `.github/workflows/cross-platform.yml`

- [x] **Step 1: Write failing real-process lifecycle tests**

Spawn fixtures as real children and prove:

- readiness timeout exits nonzero and removes the child;
- crash before handshake exits nonzero with bounded diagnostics;
- crash after handshake closes the gateway and exits nonzero;
- normal shutdown returns the sidecar exit code zero;
- SIGTERM requests graceful shutdown then escalates within the bound;
- a parent test process exit leaves no probeable child PID;
- child stderr never appears on RPC stdout;
- no test issues a provider request.

Use temporary directories and PID files. Poll with a bounded deadline; never use an unbounded
sleep.

- [x] **Step 2: Run the lifecycle tests and verify missing cases fail**

Run:

```bash
node --import tsx --test apps/mycli/test/lifecycle.integration.test.ts
```

Expected: at least timeout, crash propagation, and orphan cleanup tests fail before lifecycle
hardening.

- [x] **Step 3: Implement lifecycle hardening**

Keep signal ownership in the Node composition root. The first SIGINT is left to the active TUI so
it can request turn interruption; SIGTERM and abnormal exits close the sidecar. Cleanup is
idempotent and bounded. Exit-code policy:

- `0`: normal user shutdown;
- `1`: sidecar crash, protocol close, or internal lifecycle failure;
- `2`: CLI/config/backend/spawn validation failure;
- `130`: user interrupt before TUI ownership is established.

- [x] **Step 4: Add lifecycle tests to cross-platform CI**

After root `npm test`, add a named command that runs the app lifecycle integration test on the
existing macOS, Linux, and Windows matrix. Keep Python regression and shell lifecycle checks.

- [x] **Step 5: Run focused cross-language lifecycle verification**

Run:

```bash
npm test --workspace @cosmos2023/app
uv run pytest tests/unit/cli/node_tui tests/unit/cli/test_sidecar.py tests/integration/test_node_tui_gateway.py -q
npm run typecheck
uv run ruff check src/mycli tests
uv run mypy src/mycli
```

Expected: all focused checks pass on the supported Node version.

- [x] **Step 6: Commit lifecycle gates**

```bash
git add apps/mycli/src apps/mycli/test .github/workflows/cross-platform.yml
git commit -m "test(node-cli): gate sidecar lifecycle"
```

### Task 8: Document Rollout, Rollback, And M1 Evidence

**Files:**
- Modify: `README.md`
- Create: `docs/superpowers/reports/2026-08-03-node-runtime-m1-composition-root-smoke.md`

- [x] **Step 1: Document the explicit preview path**

Document:

```bash
npm ci
npm run build
npm run mycli -- --runtime-backend python-sidecar
```

State that `uv run mycli` remains the M1 rollback path, `python-sidecar` is the only implemented
Node-parent backend, selecting `node` fails without fallback, and M1 still requires Python.

- [x] **Step 2: Run the complete M1 regression gate**

Run:

```bash
npm ci
npm run contracts:check
npm run build
npm run lint
npm test
npm run typecheck
uv run pytest -q
uv run ruff check src/mycli tests
uv run mypy src/mycli
```

Expected: supported-version gates pass with existing documented skips only.

- [x] **Step 3: Inspect the packed npm CLI**

Run:

```bash
npm pack --workspace @cosmos2023/app --dry-run
```

Expected: compiled CLI and required package metadata are present; source TypeScript, Python source,
credentials, local environment files, and test fixtures are absent.

- [x] **Step 4: Record sanitized smoke evidence**

The report contains commit SHA, Node/npm/Python versions, exact command outcomes, handshake and
lifecycle case counts, packed-file evidence, rollout/rollback commands, cross-platform CI scope,
and the local Node 24 baseline when applicable. Record `Live API: not applicable` because M1 does
not change provider traffic.

- [x] **Step 5: Commit docs and evidence**

```bash
git add README.md docs/superpowers/reports/2026-08-03-node-runtime-m1-composition-root-smoke.md
git commit -m "docs: record Node composition root rollout"
```

## M1 Completion Gate

M1 is complete only when:

- `apps/mycli` builds a runnable ESM `mycli` executable without `tsx` in production;
- Node owns TTY, signal, backend selection, sidecar lifecycle, and exit codes;
- Python sidecar stdin/stdout contain JSON-RPC only and stderr is bounded and sanitized;
- readiness, manifest, and protocol handshakes finish before any turn request;
- timeout, crash, shutdown, interruption, and orphan cleanup tests pass;
- selecting an unavailable Node-native backend fails without Python fallback;
- the current Python-parent launcher remains an explicit rollback path;
- macOS, Linux, and Windows lifecycle CI passes on Node 22.19;
- the full Python suite, contract drift, lint, type-check, and Node suites pass;
- the M1 report states that live API verification is not applicable.

Do not begin M2 provider work until this gate passes.
