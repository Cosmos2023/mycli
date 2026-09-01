# Troubleshooting

Start with a provider-free diagnostic:

```bash
npm run mycli -- doctor
npm run mycli -- doctor --json
```

Doctor reads configuration, storage, package contracts, process support, and extension state. The
default command and `--fix` preview do not call a model provider or repair files. Apply only an
unchanged preview with `mycli doctor --fix --confirm <plan-id>`. Generate a private redacted artifact
for offline support with `mycli doctor --support-bundle`; mycli does not upload it.

## Interactive UI Does Not Start

- Confirm `node --version` is at least 22.19.
- Confirm stdin and stdout are attached to a real terminal. Interactive startup intentionally
  rejects pipes; management commands remain available in non-TTY automation.
- Run the compiled entry after `npm run build`; stale `dist` output can preserve old help or imports.
- Use Ctrl+C once to interrupt an active turn and twice only when the UI reports the exit prompt.

## Provider Failure

- Check `MYCLI_PROVIDER`, `MYCLI_PROTOCOL`, `MYCLI_MODEL`, and `MYCLI_BASE_URL` as a unit.
- Confirm `MYCLI_API_KEY` or the configured `auth_ref` exists without printing its value.
- Responses endpoints must support the request and streaming event shape used by the selected
  model. A compatible Chat Completions endpoint must be configured with `chat_completions`.
- Set retry limits deliberately during diagnosis. Do not repeat paid smoke requests after an
  unavailable-service exit `77` in the same verification run.

## Native PTY Failure

- Reinstall from the lockfile with `npm ci`.
- When no prebuilt `node-pty` binary is available, install the platform compiler prerequisites and
  rerun npm install.
- Run `npm run smoke:package`; it exercises the PTY from a clean packed installation.
- On Windows, verify ConPTY is available and use PowerShell 7, Windows PowerShell, or CMD.

## Sandbox Unavailable

- Start with `mycli sandbox status`; add `--json` for automation.
- macOS restricted profiles require executable `/usr/bin/sandbox-exec`. Restore it through the
  operating system; mycli does not install or replace system components.
- Linux restricted profiles require `bwrap`. Install bubblewrap through the distribution package
  manager, then rerun status; mycli never invokes the package manager.
- Windows restricted profiles require the packaged `mycli-windows-sandbox.exe`.
- On first use, approve the Windows UAC prompt so mycli can initialize the dedicated sandbox identity
  and offline firewall policy. Canceling or failing setup keeps the command blocked; retrying the
  restricted command starts setup again.
- To recover explicitly, run `mycli sandbox setup`, review the privilege/effects preview, then rerun
  with `--confirm`. If Windows state is corrupt, preview and confirm `mycli sandbox reset`, then set up
  again. Reset retains the restricted account and network restrictions; it clears only mycli setup
  markers and encrypted credential state.
- Use `mycli doctor --verbose` with the stable readiness/recovery code. The CLI intentionally omits
  native stderr, executable paths, stacks, and setup credentials from both human and JSON output.
- Missing isolation fails closed. Select `danger-full-access` only as an explicit user decision;
  do not replace the helper with an unsandboxed fallback.

## Session Or Pending Input Recovery

- Do not start two mycli processes on the same active session.
- Resume only after the previous process has exited and released its owner records.
- Pending approval or clarification is re-emitted after restart. Respond to the same displayed
  request instead of submitting a new turn.
- A recovered `unknown` effect state is intentionally not replayed; inspect changes and logs before
  deciding how to continue.
- Back up `~/.mycli` before maintenance or package rollback.

## Slash Command Failure

- Use `Ctrl+P` for the searchable command palette, `/help` for shortcuts and command groups, and
  [commands.md](commands.md) for hidden aliases and argument rules.
- Commands marked unavailable during a turn must wait until the active turn is terminal.
- Old `--runtime-backend` invocations are invalid in M8. Remove the flag instead of replacing its
  value.

## Removed Python Entrypoint

The former Python console script and wheel are no longer shipped. Install dependencies with
`npm ci`, build with `npm run build`, and launch with `npm run mycli`; there is no compatibility
fallback or manual session-data migration in the retirement step.

## Extension Failure

- Use `hooks/plugins/mcp/subagents list --json` before starting the interactive runtime.
- Raw TypeScript and Python plugin source are not executed. Compile Plugin API v2 entries to ESM.
- A legacy Python plugin reports `migration_required`; follow
  [migration/python-plugins-to-v2.md](migration/python-plugins-to-v2.md).
- Extension startup, timeout, protocol, and capability failures are isolated and bounded. Inspect
  the stable category rather than exposing worker stdout/stderr or environment values.

## Safe Diagnostic Sharing

Share the doctor status/category and command exit code. Do not share API keys, auth files, request
headers, prompts, provider responses, raw tool output, shell commands, private paths, session
database contents, or plugin environment values.
