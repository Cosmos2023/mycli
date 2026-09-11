# Pi-AI Provider Catalog Release Evidence

This report records deterministic and opt-in live verification for the pi-ai provider directory,
provider-scoped model selection, and the curated OpenRouter, Groq, Together, Moonshot AI, NVIDIA,
and Cerebras routes. It does not contain credentials, prompts, response text, response IDs,
request headers, endpoint payloads, or local paths.

## Live Credential Audit

On 2026-09-02, `npm run smoke:providers -- --dry-run` ran on macOS arm64 with Node 24.14.1.
The existing private auth path contained no usable credential for any newly curated provider, so no
live request was sent for those six routes. Separate bounded live verification already exercised the
locally configured DeepSeek Chat and OpenAI Responses routes. A final redacted request through the
configured OpenAI Responses relay and `ProviderRegistry` made one upstream attempt, confirmed the
native `web_search` payload injection, and returned text, provider state, usage, and completion
without recording request or response content.

| Provider | Credential | Live request | Live status |
| --- | --- | --- | --- |
| OpenRouter | missing | not sent | not live-verified |
| Groq | missing | not sent | not live-verified |
| Together | missing | not sent | not live-verified |
| Moonshot AI | missing | not sent | not live-verified |
| NVIDIA | missing | not sent | not live-verified |
| Cerebras | missing | not sent | not live-verified |

The ignored local structural evidence is
`release-evidence/pi-ai-provider-catalog-live.json`. A later authorized run may replace these rows
only when `smoke:providers` reports `status=passed` for the matching provider.

## Deterministic Evidence

The normal credential-free suites cover all six provider profiles, setup and auth references,
catalog defaults, known and unknown model payloads, developer authority, optional request controls,
reasoning validation, text, tools, usage, provider state, completion, failures, retry ownership,
abort behavior, and replay identity.

On 2026-09-02, the repository-root gates passed on macOS arm64 with Node 24.14.1:

| Gate | Result |
| --- | --- |
| `npm run lint` | passed |
| `npm run typecheck` | passed for all workspaces |
| `npm run contracts:check` | passed |
| `npm run config:check` | passed |
| `git diff --check` | passed |
| `npm test` | passed, 2,480 of 2,480 tests |

The root test total consists of the following deterministic suite counts:

| Suite | Passed | Failed |
| --- | ---: | ---: |
| `@cosmos2023/mycli` | 407 | 0 |
| `@mycli/config` | 136 | 0 |
| `@mycli/contracts` | 49 | 0 |
| `@mycli/core` | 59 | 0 |
| `@mycli/integrations` | 108 | 0 |
| `@mycli/providers` | 96 | 0 |
| `@mycli/runtime` | 389 | 0 |
| `@mycli/storage` | 311 | 0 |
| `@mycli/tools` | 245 | 0 |
| `mycli-shell-tui` | 657 | 0 |
| release scripts | 23 | 0 |
| **Total** | **2,480** | **0** |

## Packed Artifact Evidence

The root build and `npm run smoke:package -- --app-only` passed under Node 24.14.1. The same root
build and packed smoke also passed under the minimum supported Node 22.19.0, using an isolated local
npm cache. Both packed runs installed the generated application tarball into a temporary prefix and
reported the same structural result:

| Check | Node 22.19.0 | Node 24.14.1 |
| --- | --- | --- |
| Root TypeScript build | passed | passed |
| Packed application install | passed | passed |
| Installed startup and management journeys | 9 passed | 9 passed |
| Installed curated provider profiles/defaults | 6 passed | 6 passed |
| Installed custom OpenRouter model | 1 passed | 1 passed |
| Mock HTTP connectivity | all 6 passed | all 6 passed |
| Pi-ai package version | `0.84.4` | `0.84.4` |
| Full pi-ai catalog imported on provider demand | yes | yes |
| Full pi-ai catalog imported during provider-free startup | no | no |
| Awaited network operations before first paint | 0 | 0 |

The installed provider registry exercised Responses, Chat Completions, Anthropic Messages, every
curated default, and an uncatalogued OpenRouter model against a local mock server. Each curated
route produced canonical text, usage, provider state, and exactly one completion.

The runtime module hook observed `providers/all` and each selected provider factory only after the
provider protocol smoke demanded catalog resolution. It rejected concrete Google, AWS, Azure, and
Mistral SDK imports. Pi-ai's OpenRouter factory statically loads `auth/oauth/load.js`, which contains
only lazy dynamic loaders; the packed gate allows that loader but rejects every concrete OAuth flow
module. The separate provider-free M8 startup loaded neither `providers/all`, a curated provider
module, nor any pi-ai OAuth module.

## Compatibility Boundary

- `@earendil-works/pi-ai` remains pinned exactly to `0.84.4`.
- Pi-ai receives `maxRetries: 0`; mycli runtime retry budgets remain authoritative.
- Production code dynamically imports `@earendil-works/pi-ai/providers/all` only when provider
  directory or catalog resolution is requested. Provider-free startup does not load it.
- Installed catalog entries are discoverable, but routes outside the stable set remain inactive
  until `~/.mycli/models.json` explicitly supplies an accepted route, protocol, model policy, and
  mycli credential reference.
- `provider.list` is the provider-directory boundary, and `model.list` requires one exact activated
  route. Same-named models and user overrides do not cross provider routes.
- Hosted web search remains disabled for the six curated Chat Completions profiles. Live Responses
  search uses pi-ai payload injection; mycli has no direct OpenAI dependency or compatibility
  transport.
- The pinned pi-ai version consumes hosted-search lifecycle events without exposing canonical progress/replay.
  Mock and redacted live evidence verify the final text and completion path; new turns do not
  promise search progress rows or native search-call replay.
- Google, Vertex, Bedrock, Mistral, Azure, OAuth, cloud credential chains, and new wire protocols
  remain outside this change.
