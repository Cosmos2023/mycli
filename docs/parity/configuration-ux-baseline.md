# Configuration And UX Baseline

## Provider-free journey baseline

The versioned manifest at `tests/fixtures/configuration_ux/baseline.json` is the reviewable source
of truth for the configuration and terminal UX baseline. It links each journey to exact Node test
declarations instead of introducing another end-to-end harness. The evidence runs without a model
provider, real credentials, telemetry, or writes outside test-owned temporary directories.

| Journey | Deterministic evidence boundary |
| --- | --- |
| Fresh install | Setup state, provider selection, redacted persistence, cancellation, and setup-wizard completion |
| Missing credential | Bootstrap readiness, side-effect-free rejection, credential recovery, and draft preservation |
| Malformed user config | Bounded TOML diagnostics and management exit behavior |
| Untrusted project config | Project configuration remains unread until trust permits it |
| Session model scope | Session selection survives resume without changing the user default |
| Permission switch | Gateway policy reconfiguration and explicit Full Access confirmation |
| Resume repair | Provider-free preview, metadata revision check, and explicit repair application |
| Narrow/CJK/IME | Sixty-column rendering, CJK width, and hardware-cursor anchoring |
| Windows sandbox readiness | Setup-incomplete and handshake states without executing an untrusted command |

The manifest records all-platform evidence for `darwin`, `linux`, and `win32`; Windows-only sandbox
behavior remains scoped to `win32`. Paths are repository-relative and evidence names must match an
exact `test("...")` declaration.

## Baseline Measurements

The checked-in measurements are structural so CI results stay stable across machines:

| Measurement | Current baseline | Counting rule |
| --- | --- | --- |
| Awaited network operations before first paint | `0` | Startup update refresh begins only after the gateway is ready and is never awaited by first paint |
| Configured and trusted startup to ready composer | `0` confirmations | No trust, credential, or repair selector owns the editor |
| Fresh install to ready composer | `7` confirmations and `1` credential text entry | Six default-path setup confirmations plus one first-workspace trust confirmation; navigation and credential characters are not counted |

Elapsed startup timing is deliberately local and opt-in. Run the compiled or source CLI with
`MYCLI_STARTUP_PROFILE=1`; mycli writes an allowlisted stage-only snapshot to
`~/.mycli/logs/startup-profile.json`. The snapshot contains scope, stage names, and elapsed
milliseconds only. It excludes environment values, configuration payloads, paths, credentials,
session identifiers, prompts, transcript text, tool content, and provider output.

Wall-clock timing is not asserted in the provider-free CI gate because host load and native terminal
startup vary materially. The deterministic gate instead freezes the zero-blocking-network contract
and the five-second native PTY readiness ceiling. A release benchmark may tighten a numeric timing
budget only by updating this report and the versioned manifest together.

## UX Budgets

| Contract | Budget |
| --- | ---: |
| Awaited network work before first paint | `0` operations |
| Primary diagnostics for one root failure | At most `1` |
| Selector filtering for the supported catalog | At most `100 ms` |
| Supported terminal width | At least `60` columns |
| Destructive action default | `cancel` |
| Pending selector cancellation | `Esc` is required |
| Composer draft after cancellation | Preserve |
| Native PTY readiness | At most `5000 ms` |

The selector value is a product budget, not a wall-clock assertion in a shared runner. Functional
filtering, deterministic catalog size, width safety, cancellation, and draft preservation remain
provider-free test contracts; final packed-artifact release verification owns performance sampling.

## Drift Gate

Run:

```sh
npm run test:ux-contracts
```

The focused gate validates:

- manifest schema version, journey order, platform coverage, privacy rules, and exact evidence;
- management parser names against root help and the management command table;
- canonical slash commands and aliases against this command reference;
- every `SHELL_SETTING_DESCRIPTORS` configuration key against the settings documentation;
- the generated gateway catalog against the frozen M8 gateway evidence.

Adding a journey, management command, slash command, setting, or gateway contract requires updating
its canonical registry and documented evidence in the same change. Bump `schema_version` when the
manifest shape changes. Never add captured prompts, local absolute paths, credentials, raw tool
content, provider bodies, or secret-shaped values to the fixture or this report.
