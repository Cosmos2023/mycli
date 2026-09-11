# Node-Only Runtime Rollout

## Release Boundary

M8 established Node as the only npm runtime after a final black-box capability audit. The current
release also retires the former Python package, wheel, tests, and toolchain, leaving one maintained
product and one release gate.

The current CLI:

- starts `startNodeBackend` unconditionally for interactive use;
- rejects the retired `--runtime-backend` flag;
- ignores the retired backend-selection environment variable;
- contains no alternate runtime startup, executable probe, or wheel path;
- uses the existing TUI and terminal interaction model rather than redesigning it.

## Retained Surface

M8 retains provider protocols, transcript/session operations, approvals, clarifications, queues,
compaction, memory, file tools, persistent shells, integrations, subagents, management commands,
doctor, diagnostics, signals, shutdown, and all 36 Node-owned built-in slash commands.

The current subagent implementation uses durable agent threads supervised entirely by Node. Agent
state, mailbox delivery, frozen permissions, restart recovery, readable artifacts, and TUI
projection are described in [node-agent-runtime.md](node-agent-runtime.md).

The final pre-retirement gateway baseline contained 33 RPCs and 42 events. Later contract work
added shell controls and explicit `session.new`, so the current contract contains 38 RPCs and 42
events. The sanitized M2-M7 fixture corpus remains under
`tests/fixtures` and is checksum-protected by the M8 audit.

Intentional Node-surface retirements:

- `LS`, `Glob`, and `Grep`; `Read` owns bounded discovery.
- implicit subagent budgets; Node budgets are opt-in.
- Python plugin source compatibility; Plugin API v2 is compiled ESM.
- same-build alternate backend fallback.

The repository no longer ships the former Python console script or package metadata. Existing
users move to the npm install and launch commands; retirement does not migrate, rewrite, or delete
healthy schema-v12 session data.

## Offline Release Gate

Run from a clean Node install:

```bash
npm ci
npm run contracts:check
npm run lint
npm run test:ci
npm run typecheck
npm run smoke:m8
npm run smoke:package
```

CI runs this gate on Linux, macOS, and Windows with Node 22.19 and Node 24. The packed smoke creates
workspace tarballs plus the current platform's ripgrep package, installs them in a clean directory,
checks the compiled CLI and native PTY, executes management commands with a clean home, and makes
Python import/invocation/probing fail the test. Before publishing every platform package, run
`npm run smoke:package -- --all-platforms` to download and inspect all six ripgrep artifacts.

`smoke:m8` is provider-free. It starts the real backend with a disposable home and workspace,
waits for `runtime.ready`, bootstraps a session, loads the 16-command visible TUI projection, and
shuts down. The audit test separately freezes all 35 built-in commands, including hidden controls.
Its output is one structural JSON line with no paths, prompts, credentials, endpoint, provider
payload, or tool output.

## Credential-Gated Responses Smoke

Run one paid-service smoke only after the offline gate passes:

```bash
MYCLI_API_KEY=... \
MYCLI_BASE_URL=... \
MYCLI_MODEL=... \
MYCLI_PROVIDER=openai \
node scripts/smoke_node_m5_state.mjs --protocol responses
```

The smoke uses a disposable home/workspace/database, zero retries, bounded output, and sanitized
structural reporting. Missing credentials or an unavailable configured service return exit `77`;
success returns `0`; a structural failure returns `1`. Do not retry an unavailable paid-service
request in the same release run.

## Rollout Procedure

1. Back up `~/.mycli` before upgrading a production workstation.
2. Finish or interrupt active turns and resolve pending approvals/clarifications.
3. Stop background shells and child tasks.
4. Install the current npm package and run `mycli doctor`.
5. Start one provider-free management command and one disposable session.
6. Run the credential-gated Responses smoke only if the offline gates are green.
7. Promote the release after platform jobs and cleanup checks pass.

Do not run two package versions concurrently against the same active session database. Durable
schema compatibility does not make live process or continuation ownership shareable.

The doctor report must include a healthy `model_input_ledger` row before resuming migrated
sessions. The check is read-only and detects incomplete manifests, missing immutable references,
content-hash mismatches, and invalid provider-step lifecycle chains. It never repairs records in
place; restore from backup or remain on the prior release when the ledger is corrupt.

## Failure And Rollback

A failed Node turn reports its actual terminal state. It is never replayed through another runtime,
because replay could duplicate provider calls, approvals, file mutations, plugin effects, or
process launches.

Rollback means reinstalling the previous package release; the M8 build has no backend selector.
Before rollback:

1. finish or interrupt the current turn;
2. resolve or reject pending user input;
3. stop all background shells and subagents;
4. close mycli and back up `~/.mycli`;
5. install the previous release;
6. resume only after checking the target session with that release's doctor/status flow.

Never add an unadvertised alternate runtime or diagnostic executable probe. A rollback is a
package-level operator decision made between turns, not an automatic retry path.

## Troubleshooting

Use `mycli doctor --json` for automation and [troubleshooting.md](troubleshooting.md) for TTY,
provider, native PTY, sandbox, extension, session, and shutdown failures. Diagnostic output must
remain bounded and must not contain credentials, headers, prompts, commands, raw provider data,
raw tool output, or private file contents.
