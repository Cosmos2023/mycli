# Adopt pi-ai Provider Directory

## Goal

Make pi-ai's installed providers and provider-scoped model catalogs the authoritative source for mycli provider integration, while keeping mycli's security, runtime, canonical event, replay, and persistence boundaries.

## Requirements

- Known provider routes reuse pi-ai built-in providers rather than rebuilding provider transports or compatibility tables.
- `compatible` remains the public explicit path for endpoints not described by pi-ai; stable routes whose selected protocol is absent from the installed catalog also use pi-ai `createProvider` rather than a bespoke mycli transport.
- Stable product provider IDs remain a closed union; runtime route identities use a separately validated bounded type.
- Additional pi-ai providers are discoverable but require explicit activation and a mycli-managed API key.
- Ambient pi-ai credentials, OAuth, AWS/Google credential chains, and hidden SDK retries remain disabled.
- A request captures an immutable provider/model/capability snapshot before streaming.
- `/model` resolves provider first and then loads only that provider route's models.
- `/model` immediately loads the current provider's models; Enter applies the model to the session with default reasoning, Tab opens advanced reasoning/scope choices, bracket keys cycle providers, and Esc exposes the searchable provider list.
- Provider models come from the exact pinned pi-ai catalog, merged with provider-local user
  overrides. Existing v2 declarations inherit newly catalogued models unless they explicitly set
  `model_policy: "subset"`; legacy flat catalogs retain subset semantics.
- `/model <name>` never falls back silently to another provider.
- The current custom model remains selectable when it is absent from the installed pi-ai catalog.
- OpenAI Responses hosted search is injected as a provider-native tool through pi-ai; no direct
  OpenAI transport or SDK dependency remains in mycli.
- The pinned pi-ai version may consume hosted-search lifecycle and heartbeat frames without exposing them as
  assistant events. New turns therefore retain final text, usage, response identity, and supported
  replay state, but do not promise canonical search progress rows or native search-call replay.

## Acceptance Criteria

- [x] Every installed provider route selected by mycli delegates streaming to its pi-ai built-in provider.
- [x] Pi-ai `createProvider` is used only when the installed catalog does not describe the selected route/protocol; it still supplies the protocol implementation.
- [x] Pi-ai SDK retries remain `maxRetries: 0` and runtime retry tests still pass.
- [x] Normal startup does not eagerly load pi-ai's complete provider catalog.
- [x] Provider directory entries distinguish stable, experimental, and custom routes and do not auto-activate new upstream entries.
- [x] `model.list` requires a provider route and returns no models owned by another route.
- [x] `/model` loads provider-scoped models, supports an explicit provider switch, and preserves current/session/user selection semantics.
- [x] The common current-provider model switch requires one confirmation while advanced reasoning, user scope, login, loading, retry, and provider switching remain available.
- [x] Known catalog models retain pi-ai compatibility metadata; user overrides remain authoritative and provider-local.
- [x] Existing catalog-backed v2 declarations expose newly installed pi-ai models without rewriting
  `models.json`, while an explicit subset policy remains available.
- [x] Missing credentials produce an explicit login path without removing unrelated provider directory entries.
- [x] Replay rejects a route/model/transport mismatch without exposing endpoint credentials or raw provider data.
- [x] Live Responses hosted search uses the same pi-ai transport, tolerates heartbeat/search frames,
  and non-Responses protocols reject it before provider traffic.
- [x] Provider, config, gateway, TUI, runtime, storage, packed CLI, lint, typecheck, contracts, and Node 22.19/24 gates pass.

## Definition Of Done

- OpenSpec proposal, design, delta specs, and task checklist are complete.
- Focused unit and integration tests cover all changed boundaries.
- Documentation explains stable, experimental, and compatible provider support.
- Full quality gates pass without real external credentials; live verification status is stated explicitly.
- Rollback preserves existing configuration, credentials, sessions, and the persisted `provider` field.

## Technical Approach

Follow DeepSeek Harness's two-layer pattern: expose a pi-ai-backed provider directory, but register only explicitly configured routes. Lazily build an immutable route snapshot from the selected pi-ai provider and explicit catalog/subset policy. Keep mycli's `ModelProvider` interface as the runtime boundary and use provider-scoped gateway requests to drive the TUI selector.

## Decision (ADR-lite)

**Context**: The existing transport migration uses pi-ai for streaming but still reconstructs several known provider definitions, and `/model` reads a global static catalog filtered by credentials.

**Decision**: Pi-ai built-in providers and model catalogs become authoritative for known routes. Mycli retains stable product curation, explicit route activation, credential resolution, retry ownership, canonical events, replay, and persistence. Model selection becomes provider-first and provider-scoped.

**Consequences**: Provider additions no longer require another transport implementation, but provider route identity and gateway contracts must be separated cleanly. Pi-ai upgrades require catalog drift and packed-runtime verification.

## Out Of Scope

- Pi-ai ambient credential discovery, OAuth/login, or cloud credential chains.
- New provider protocols outside OpenAI Completions, OpenAI Responses, and Anthropic Messages.
- Adding canonical hosted-search progress and native search-call replay before pi-ai exposes those
  events through its public stream contract.
- Automatically enabling every provider introduced by a future pi-ai upgrade.

## Technical Notes

- OpenSpec change: `openspec/changes/adopt-pi-ai-provider-directory/`.
- Research: `research/dsh-provider-directory-and-model-flow.md`.
- Existing provider transport contract: `.trellis/spec/backend/provider-transport-contract.md`.
- The user confirmed the provider-first pi-ai direction on 2026-09-02.

## Completion Evidence

- `@earendil-works/pi-ai` remains pinned exactly to `0.84.4`; daily Dependabot checks advance the
  exact pin through reviewed lockfile updates.
- Workspace build, lint, typecheck, configuration-reference drift, contract drift, and
  `git diff --check` passed after the 0.84.4 catalog-following update.
- The root suite passed all 295 discovered test files across unit, contract, integration, platform,
  and release classifications. Focused config/directory tests passed 25 cases, and the real Node
  gateway integration confirmed the existing two-model DeepSeek declaration also exposes the new
  pi-ai visual model.
- Installed application smoke passed on Node 22.19.0 and Node 24.14.1. Both runs completed nine
  installed journeys, six curated routes, one custom model, and all three supported protocols.
  The full pi-ai catalog loaded on explicit provider demand and did not load during provider-free
  startup; concrete OAuth flows and external provider SDKs did not load.
- A read-only load against the existing user v2 declaration returned `deepseek-v4-pro`,
  `deepseek-v4-flash`, and `deepseek-v4-flash-vision-exp`; the visual model retained pi-ai's image,
  1,000,000-context, and 384,000-output metadata without rewriting `models.json`.
- Bounded live DeepSeek Chat and OpenAI Responses requests had existing passing evidence. A final
  redacted request through the configured OpenAI Responses relay and `ProviderRegistry` confirmed
  one upstream attempt, native `web_search` injection, text, provider state, usage, and completion.
  The six newly curated routes had no locally available key and remain explicitly not live-verified;
  their transport coverage is deterministic local mock evidence.

## Rollback And Residual Risk

- Rollback is a package reinstall, not a data migration. Stable `provider` values, credentials,
  sessions, and v2 `models.json` declarations keep their persisted shapes.
- Before downgrading an experimental route, copy its exact protocol, endpoint, model metadata, and
  `auth_ref` into the stable `compatible` route. Credentials do not move or enter model metadata.
- A future pi-ai version can change catalog metadata or module loading, so the exact pin must not be
  changed without rerunning catalog drift, provider, replay, packed Node, and startup gates.
- Newly discovered experimental routes are mock-verified until local credentials are available;
  they remain dormant unless explicitly activated.
- Live hosted Responses search now uses pi-ai payload injection. The pinned pi-ai version does not expose its
  native search lifecycle or search-call replay, so new turns do not show search progress cards and
  replay from canonical assistant content instead.
- Local packed verification covered macOS arm64; the repository release matrix remains responsible
  for installed-artifact coverage on Ubuntu and Windows.
