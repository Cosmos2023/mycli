# Errors And Recovery

mycli displays the error's concrete cause in the TUI. A failed tool stays on
its tool row; a failed turn produces one notice. A rejected gateway request
does not end a different running turn. The details view contains the reason,
source, and stable diagnostic identity. Explaining an error makes no model call.

| Example reason | Meaning | Next step |
| --- | --- | --- |
| `capability.image_input_unsupported` | The selected model cannot accept an image already in this conversation | Select an image-capable model with `/model` |
| `auth.credentials_missing` | The provider has no usable credential | Configure the provider's credentials |
| `auth.model_access_denied` | The account cannot use this model | Check access or select another model |
| `provider.quota_exceeded` | The account has exhausted its quota | Check provider billing |
| `provider.rate_limited` | The provider is throttling requests | Respect the displayed bounded retry delay |
| `runtime.retry_exhausted` | Automatic retries have stopped | Inspect the retained underlying cause |
| `policy.sandbox_initialization_failed` | The Shell sandbox could not start | Run `mycli doctor` and inspect platform readiness |
| `gateway.admission_rejected` | This request was refused before execution | Wait for capacity and retry the request |
| `gateway.output_capacity_exceeded` | Accepted work exceeded transport output capacity | Inspect `/status` and `/ps` before resubmitting |
| `runtime.worker_exited` | A runtime Worker exited unexpectedly | Inspect execution and run `mycli doctor` |
| `storage.write_failed` | Session state or its readable projection could not be saved | Check storage diagnostics and the recorded operation phase |
| `tui.render_failed` | The terminal interface failed locally | Inspect the private TUI log and run `mycli doctor` |

An unknown execution outcome means a command may already have run. mycli does
not automatically replay the entire turn based on an error's `retryable` field.
Completed tool effects and accepted images remain in history. Switching models
does not execute completed tools again or silently discard their images.

Normal errors appear in live output and loaded history. Recovery suggestions
are refreshed for the current session and model, so a historical image error
can remain visible after its model incompatibility has been corrected.

Fatal TUI/connection diagnostics are written to
`~/.mycli/logs/tui-errors.log` with private file permissions. They include a
bounded error context and redacted stack. The terminal is restored before the
fallback stderr message; local UI failures do not add conversation records.
Runtime storage emergencies also use the existing private runtime trace.

## Compatibility

Version 1 defines 66 concrete reasons across 12 domains. Existing runtime
records retain their 17 broad error codes. Old `unsupported_capability` records
do not prove an image mismatch, and old `interrupted` records do not prove a
user cancellation.

Current runtime stores use database format 14. Opening format 12 or 13 advances
the format transactionally without rewriting transcript events. This small
forward migration follows the existing runtime-store opening path; it does not
create an automatic backup. Take a consistent backup before upgrading when an
executable rollback may be needed. Never copy an active SQLite database without
its required WAL state.

Older executables refuse the newer format before opening a writable store.
Rolling back the executable requires a matching pre-upgrade backup or a
separately reviewed export. Changing the version marker or deleting error
metadata is not a supported downgrade. Transcript snapshot v2 remains readable
because the extension uses its existing optional metadata field.

Gateway protocol 1 negotiates enriched errors during bootstrap. Older clients
receive the legacy envelope. Worker protocol 2 requires matching runtime
modules. Unknown optional error extensions fall back to the broad error without
inventing a cause or a retry action.
