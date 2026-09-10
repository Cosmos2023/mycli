# Configuration And UX Release Evidence

This report maps the eight Definition of Done outcomes in
`.omx/plans/mycli-configuration-and-ux-optimization-plan.md` to shipped contracts. It records
stable repository evidence, not prompts, credentials, provider bodies, command output, or local
absolute paths.

The provider-free baseline is versioned in
`tests/fixtures/configuration_ux/baseline.json`. The installed-artifact matrix is owned by
`.github/workflows/release-compatibility.yml`; tag publication repeats the strict compatibility
journey in `.github/workflows/release.yml`.

## Outcome Evidence

| # | Definition of Done outcome | Primary evidence |
| ---: | --- | --- |
| 1 | A fresh install reaches a ready, trusted, authenticated composer through one guided flow | `backend/apps/mycli/test/setup.test.ts`; `tui/mycli-shell/test/components/selectors/setup-wizard.test.ts`; `tui/mycli-shell/test/application/shell-app.test.ts` test `fresh startup completes the ordered keyboard journey without requiring connectivity` |
| 2 | Project configuration stays inactive until workspace trust is granted | `backend/packages/config/test/configuration/settings.test.ts` test `keeps untrusted project configuration disabled without reading it`; `backend/apps/mycli/test/node-backend.integration.test.ts` trust activation/revocation tests |
| 3 | Config inspection and settings agree on effective value, source, scope, and lock state | `backend/packages/config/test/terminal/shell-settings.test.ts`; `backend/apps/mycli/test/node-settings-catalog.test.ts`; generated `docs/reference/configuration.md`; `npm run test:ux-contracts` |
| 4 | Session-only choices do not mutate user defaults | `backend/apps/mycli/test/node-backend.integration.test.ts` test `Node backend separates session model choices from user defaults`; `tui/mycli-shell/test/components/selectors/model-selector.test.ts` scope tests |
| 5 | Config, auth, provider, sandbox, and session failures produce one actionable redacted diagnostic | `tui/mycli-shell/test/state/runtime-state.test.ts` test `runtime adapter renders one actionable diagnostic for representative root failures`; `backend/apps/mycli/test/doctor-redaction.test.ts`; `backend/apps/mycli/test/management-services.test.ts` |
| 6 | Upgrades and migrations are previewable, reversible, and cross-platform tested | `scripts/smoke_release_compatibility.mjs`; `scripts/smoke_packed_cli.mjs`; `docs/upgrading.md`; the three-platform `release-compatibility` workflow |
| 7 | Help, completions, slash palette, settings, docs, and contracts cannot drift silently | `npm run config:check`; `npm run contracts:check`; `npm run test:ux-contracts`; `scripts/test/release-scripts.test.mjs` |
| 8 | The TUI stays responsive, cancelable, width-safe, IME-safe, and legible | `docs/terminal-accessibility.md`; `backend/packages/config/test/terminal/terminal-capabilities.test.ts`; `tui/mycli-shell/test/application/shell-app.test.ts`; `tui/mycli-shell/test/tui-core/stdin-buffer.test.ts`; `tui/mycli-shell/test/shell-terminal-stress.test.ts` |

## Delivered Work Packages

The implementation is split into seven archived or active Trellis children so each contract keeps
focused acceptance evidence:

1. `08-31-ux-baseline-drift-gates`
2. `08-31-config-migration-reference`
3. `08-31-unified-onboarding-auth`
4. `08-31-sandbox-setup-platform-recovery`
5. `08-31-diagnostic-repair-support-bundle`
6. `08-31-terminal-accessibility-nontty`
7. `08-31-release-compatibility-rollout`

The first six task records are archived under `.trellis/tasks/archive/2026-08` or
`.trellis/tasks/archive/2026-09`. The seventh owns this final packed-artifact convergence gate.

## Release Verification

Run the deterministic local gates in this order:

```bash
npm run release:compatibility
npm run contracts:check
npm run config:check
npm run lint
npm test
npm run typecheck
npm run smoke:package
npm run smoke:release-compatibility -- --evidence release-evidence/local.json
```

The final command installs the real `@cosmos2023/app@0.1.0` predecessor. A successful evidence file
contains only schema version, status, platform/architecture/Node identity, package identities, and
fixed check ids. Registry/network unavailability is `blocked_external`; candidate, migration,
downgrade, and rollback failures are `failed`.

Local execution proves only the current host. The GitHub matrix owns macOS, Ubuntu, and Windows
evidence and uploads one artifact per platform containing separate packed-journey and
upgrade/downgrade JSON summaries. Until that workflow runs for the candidate commit, cross-platform
status is pending rather than inferred from a single workstation.

## Pi-ai Provider Cutover

Local macOS arm64 verification on 2026-09-02 covered the installed application artifact under Node
22.19.0 and 24.14.1. On both versions, the app-only packed smoke completed all nine installed
journeys, including local-mock Responses, Chat Completions, and Anthropic Messages streams through
the installed `ProviderRegistry`. The registry-backed predecessor/candidate compatibility smoke
also passed all five fixed checks on both Node versions.

The current-platform packed smoke reached the platform package stage on both Node versions, where
the pinned macOS arm64 ripgrep GitHub asset failed with `UND_ERR_CONNECT_TIMEOUT`. This is an
external asset-download blocker; it did not waive or hide a candidate packaging, provider,
migration, downgrade, or rollback failure. The three-platform GitHub matrix remains the authority
for macOS, Ubuntu, and Windows release evidence.

The pi-ai size and startup comparison used a temporary `git archive HEAD` checkout as the legacy
transport baseline. Both application tarballs were built and packed locally, then installed with
development dependencies, optional platform packages, and lifecycle scripts omitted. Startup
samples launched a new installed CLI or provider-import process each time, discarded one warmup,
and compared the median of the next ten runs.

| Measurement | Legacy baseline | Pi-ai candidate | Change |
| --- | ---: | ---: | ---: |
| Application tarball | 1,040,638 B | 1,058,440 B | +17,802 B (+1.7%) |
| Application unpacked content | 5,257,531 B | 5,345,905 B | +88,374 B (+1.7%) |
| Production `node_modules` | 161,412 KiB | 238,456 KiB | +77,044 KiB (+47.7%) |
| Installed package instances | 154 | 234 | +80 |
| Installed `mycli --help` median | 140.454 ms | 140.971 ms | +0.517 ms (+0.4%) |
| Provider package import median | 153.519 ms | 169.337 ms | +15.819 ms (+10.3%) |

The install-size increase is explained by pi-ai's published runtime dependency set: its package,
telemetry, AWS/Smithy, Google/Protobuf, and provider SDK dependencies. Mycli no longer installs a
second direct OpenAI SDK for hosted search; the OpenAI SDK in the graph is owned by pi-ai. The
candidate adds no new native binary, installed production package declares no `os` or `cpu`
restriction, and the
retained Responses, Chat Completions, and Anthropic implementations are selected through pi-ai's
lazy API subpaths. No unsupported platform import or unexplained startup regression was found.

Final capability review confirmed the following boundaries:

- `@earendil-works/pi-ai` is pinned at `0.84.4`. The Anthropic and OpenAI SDKs exist only below pi-ai
  in the dependency graph; mycli has no direct provider SDK dependency.
- The public `@mycli/providers` declarations expose canonical mycli failures, `ModelProvider`, and
  `ProviderRegistry`. They do not expose `PiAiProvider`, pi-ai stream/model/context/event types, or
  the internal OpenAI registry.
- Attempt evidence retains only status and bounded Retry-After/request-id headers. Provider tests
  cover secret, header, body, stack, and local-exception redaction.
- The shared replay limit is 1,048,576 JSON characters and is enforced when pi-ai state is created,
  when canonical requests are projected, and again at storage boundaries. Legacy
  Responses, Anthropic, and DeepSeek readers degrade malformed or foreign state to canonical data.
- Live Responses web search is injected as a provider-native tool through pi-ai. The pinned pi-ai version does
  not expose its native search lifecycle/replay, so new turns preserve final output without search
  progress rows; historical persisted rows remain readable.

Bounded live requests passed through the user-configured routes without recording response content:
DeepSeek Chat and OpenAI Responses with hosted search disabled emitted text, provider-state, usage,
and completion events, while live Responses search completed through the same pi-ai-backed
`ProviderRegistry`.
