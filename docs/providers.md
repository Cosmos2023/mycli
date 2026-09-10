# Provider Support

mycli uses the provider and model directory from the exact `@earendil-works/pi-ai` version pinned in
both workspace manifests. Dependabot checks for a newer release every day and updates the manifests
and root lockfile through a tested pull request. Stable product routes and the three Qwen Token Plan
catalog routes below are active by default. Other catalog routes remain dormant until they are
explicitly declared, so upgrading pi-ai never silently
activates a new network destination. New models on an already active catalog route become available
after the dependency update passes. Credentials remain owned by mycli through `MYCLI_API_KEY` or the
private `~/.mycli/auth.json` store; pi-ai ambient credentials and OAuth are not used.

The three route tiers are:

- `stable`: product-supported routes with backward-compatible defaults.
- `experimental`: pi-ai catalog routes enabled by the product or a user declaration. Catalog metadata is authoritative,
  but live service support is not claimed without recorded verification.
- `compatible`: explicitly declared routes whose endpoint or model is not supplied by pi-ai.

## Curated Pi-AI Profiles

The following API-key services are first-class Chat Completions profiles. Their defaults are pinned
in mycli and validated against the workspace-pinned pi-ai release.

| Provider | ID | Default model | Default base URL | Default reasoning |
| --- | --- | --- | --- | --- |
| OpenRouter | `openrouter` | `openrouter/auto` | `https://openrouter.ai/api/v1` | `medium` |
| Groq | `groq` | `openai/gpt-oss-120b` | `https://api.groq.com/openai/v1` | `medium` |
| Together | `together` | `moonshotai/Kimi-K2.7-Code` | `https://api.together.ai/v1` | `high` |
| Moonshot AI | `moonshotai` | `kimi-k2.7-code` | `https://api.moonshot.ai/v1` | `high` |
| NVIDIA | `nvidia` | `openai/gpt-oss-120b` | `https://integrate.api.nvidia.com/v1` | disabled |
| Cerebras | `cerebras` | `gpt-oss-120b` | `https://api.cerebras.ai/v1` | `medium` |

Setup writes the model-specific reasoning default, so the first turn does not inherit an
incompatible global effort. A custom model that is not in the compiled catalog starts with
reasoning disabled.

All six profiles support the deterministic baseline of streamed text, tools, usage, canonical
provider state, replay validation, and mycli-owned retries. Pi-ai receives `maxRetries: 0`; the
runtime owns the global and per-provider request/stream retry budgets.

Known models use pi-ai's pinned role, token-field, strict-tool, cache, storage, reasoning, and input
metadata. Mycli does not duplicate those wire facts in provider profiles. An uncatalogued model needs
an explicit declaration for semantic metadata such as images and reasoning; pi-ai automatic
detection, plus an optional validated `compat` override, owns its wire format. Hosted web search
remains a separate Responses-only mycli capability.

Request caching is expressed once as `request.cache_retention = "none" | "short" | "long"`, with
`short` as the default. Mycli passes that preference and the stable session id to pi-ai. Pi-ai maps
them to provider-specific fields, and the provider decides whether a cache entry is stored or hit.
The setting is therefore not a cache-hit guarantee.

## Retry Budgets

Global defaults remain four request retries and five stream retries. Each provider route can
override either budget independently in `config.toml`:

```toml
[request]
request_max_retries = 4
stream_max_retries = 5

[request.request_max_retries_by_provider]
openai = 2
private-relay = 0

[request.stream_max_retries_by_provider]
openai = 3
private-relay = 0
```

Keys identify mycli provider routes, including declared routes, rather than model names or upstream
catalog identities. Each table accepts at most 128 routes with integer values from 0 to 100. An
omitted route uses its corresponding resolved global setting, including environment overrides.
The highest-priority file layer containing a table replaces that whole table; an empty table
clears lower-layer overrides. Project tables participate only for trusted workspaces. `config show`
and `config get` expose these tables and their source; structured tables are not writable through
`config set` or `config unset`.

The effective budgets are copied at provider-step dispatch with the committed request identity.
Changing configuration during backoff cannot affect that step. Request and stream counters persist
across all attempts in the step, so at most `1 + request retries + stream retries` dispatches are
possible. Before output, eligible request failures use the request budget first; eligible failures
can then consume the stream budget. Stream recovery discards incomplete output. Both budgets set
to zero disable retries. Authentication, permission, quota, invalid requests, and context overflow
remain fatal to this retry loop regardless of the configured budget.

Retry-After changes only the cancellable delay, capped at one hour, and never adds budget. Without
Retry-After, the existing jittered exponential backoff grows from 200 ms to a 4-second base delay.
Cancellation during backoff stops recovery before another request. Context compaction is a separate
recovery action that explicitly commits a new logical request and starts its own budgets; ordinary
retries keep the same provider, model, and request and never replay committed tools.

## Setup And Credentials

Interactive setup lists every first-class profile:

```bash
mycli setup
```

For automation, pass the API key on stdin. This example assumes the shell variable is already set
without printing it:

```bash
printf '%s\n' "$GROQ_API_KEY" | \
  mycli setup --non-interactive --provider groq --with-api-key --json
```

Use `--model` and `--base-url` to retain a first-class provider identity with an explicit model or
endpoint:

```bash
printf '%s\n' "$OPENROUTER_API_KEY" | \
  mycli setup --non-interactive --provider openrouter \
  --model openrouter/auto --base-url https://openrouter.ai/api/v1 \
  --with-api-key --json
```

Provider-specific ambient variables such as `OPENROUTER_API_KEY` are not read automatically. The
examples pass them through setup stdin; runtime resolution uses only `MYCLI_API_KEY`, the selected
mycli `auth_ref`, or the supported legacy user setting. Pi-ai OAuth and credential stores are not
part of the runtime credential chain.

## Provider-scoped Model Selection

`/model` loads the provider directory, resolves the current route, and opens that route's models
directly. Press Enter to apply the highlighted model to this session with its default reasoning, or
Tab to choose reasoning and whether the selection applies to this session or becomes the user
default. Use `[` and `]` to load the previous or next activated provider without leaving the model
list. Esc opens the searchable provider list when more than one route is available.

When no current route can be resolved, the provider list opens first. A route without a stored
credential remains visible and opens the masked login flow before its model catalog is loaded. With
one activated route the provider list is skipped.

`/model <name>` searches only the active provider. It never switches to another provider that has a
model with the same name. Use `[`/`]` or the searchable provider list to switch routes. A model
selection is validated by route, protocol, model id, and normalized endpoint before session or user
defaults are changed.

### Pi-AI Qwen Catalogs

These pi-ai Qwen routes are available in `/model` without a `models.json` declaration:

| Provider | Route ID | Models in pi-ai 0.84.4 |
| --- | --- | --- |
| Qwen Token Plan | `qwen-token-plan` | 18 |
| Qwen Token Plan CN | `qwen-token-plan-cn` | 18 |
| Qwen Token Plan Individual | `qwen-token-plan-individual` | 8 |

Open `/model`, use Esc to open the provider list, and choose the appropriate Qwen Token Plan route.
The first selection opens login when its API key is missing. The full matching-protocol pi-ai
catalog supplies the model IDs, reasoning levels, image support, token limits, and endpoint.
These routes retain the `experimental` support tier; enabling the directory does not assert live
account access to every catalog model.

Each route defaults to its own credential reference. Existing v2 declarations can override that
reference, endpoint, or model metadata; only `model_policy: "subset"` restricts the catalog.
Directory loading does not write `models.json`. New models follow pi-ai dependency updates.

The existing `qwen` route remains ordinary DashScope, with its original endpoint, credentials, and
fallback models. Token Plan routes use the SDK's separate endpoints and do not reuse ordinary
DashScope credentials automatically.

## Experimental Catalog Routes

Activate an additional API-key route in `~/.mycli/models.json`. Catalog-backed routes use all models
for the selected protocol from the pinned pi-ai catalog by default. A `models` object overrides
matching catalog metadata or adds explicitly described uncatalogued models; it does not become an
implicit allowlist:

```json
{
  "version": 2,
  "providers": {
    "fireworks": {
      "source": "pi_ai_builtin",
      "protocol": "chat_completions",
      "auth_ref": "fireworks-primary"
    }
  }
}
```

Restart mycli, run `/model`, choose `fireworks`, and enter the key in the login flow. The key is
stored under `fireworks-primary`; it is not written to `models.json` or `config.toml`.

To intentionally expose only named catalog models, opt into the subset policy explicitly:

```json
{
  "version": 2,
  "providers": {
    "deepseek": {
      "protocol": "chat_completions",
      "model_policy": "subset",
      "models": {
        "deepseek-v4-flash": {},
        "deepseek-v4-pro": {}
      }
    }
  }
}
```

Without `model_policy: "subset"`, a later pi-ai package update can add newly catalogued DeepSeek
models to `/model` without rewriting this file. Existing legacy flat catalogs retain their original
explicit-subset behavior.

A pi-ai provider that exposes multiple supported protocols or requires an endpoint needs an explicit
route alias. This keeps one protocol and endpoint bound to one route identity:

```json
{
  "version": 2,
  "providers": {
    "cloudflare-chat": {
      "catalog_provider": "cloudflare-ai-gateway",
      "protocol": "chat_completions",
      "base_url": "https://gateway.example/v1/account/gateway",
      "auth_ref": "cloudflare-chat"
    }
  }
}
```

Unsupported pi-ai protocols, providers without API-key auth, and empty catalogs remain
`unserviceable`. Merely storing a key does not activate a route.

## Compatible Endpoints

Use `compatible` for an OpenAI-compatible service that is not in the first-class set. Configure its
protocol, endpoint, model, and credential explicitly:

```toml
[model]
provider = "compatible"
protocol = "chat_completions"
name = "custom-code-model"
api_base_url = "https://provider.example/v1"
auth_ref = "compatible"
supports_images = false

[request]
cache_retention = "none"

[reasoning]
enabled = false
reasoning_effort = "none"
```

`compatible` provides generic OpenAI-compatible behavior, not a claim that mycli has verified the
service's auth, model catalog, reasoning dialect, replay details, or optional controls. Google
Generative AI, Vertex AI, Amazon Bedrock, Mistral Conversations, Azure Responses, provider OAuth,
cloud credential chains, service accounts, and other new-protocol providers are deferred. They are
not enabled by pi-ai merely being present in the dependency graph.

For a named custom route instead of the shared `compatible` profile, declare the complete route and
model metadata in `models.json`:

```json
{
  "version": 2,
  "providers": {
    "private-gateway": {
      "source": "pi_ai_declared",
      "protocol": "chat_completions",
      "base_url": "https://gateway.example/v1",
      "auth_ref": "private-gateway",
      "capabilities": { "images": false },
      "compat": {
        "supportsDeveloperRole": false,
        "supportsStore": false,
        "maxTokensField": "max_tokens"
      },
      "models": {
        "private-code-model": {
          "limits": {
            "context_window_tokens": 64000,
            "max_output_tokens": 8192
          },
          "compat": { "supportsDeveloperRole": true }
        }
      }
    }
  }
}
```

Use `compat` only when a private relay differs from pi-ai's catalog metadata or automatic
detection. Values are validated against the selected API before traffic. Model values override
route values, which override pi-ai defaults. Unknown keys, invalid values, and fields from another
API fail as bounded configuration errors. This is an escape hatch for transport facts, not a place
to declare product capabilities; keep images, reasoning choices, limits, and hosted search in their
existing model declaration fields.

Mycli still owns API-key lookup, base URL routing, model selection, session state, and observable
retries. Pi-ai owns developer/system role selection, cache and storage fields, reasoning dialect,
output-token field names, strict-tool behavior, and session-affinity headers. The only request-body
hook mycli retains is insertion of the native `web_search` tool for live Responses search.

Native searches appear in the TUI as `Searching the web` while running and
`Searched the web for ...` when complete. Mycli observes these activities alongside pi-ai's
assistant events; they are not local function calls. Completed searches from successful provider
steps are saved with session history. Multiple queries retain their bounded metadata while the
compact row displays the first query followed by an ellipsis. Failed-attempt searches are removed
when the provider retries.

## Rollback

An older mycli release does not recognize the six new provider IDs. Before downgrading, convert the
active profile to `compatible` while preserving `chat_completions`, the endpoint, model, and
`auth_ref`. For example, a Groq rollback configuration is:

```toml
[model]
provider = "compatible"
protocol = "chat_completions"
name = "openai/gpt-oss-120b"
api_base_url = "https://api.groq.com/openai/v1"
auth_ref = "groq"
supports_images = false
```

For an experimental route, use the same conversion but copy its exact protocol, endpoint, model,
and `auth_ref` into the `compatible` profile first. This does not rewrite credentials or
transcripts. Back up `~/.mycli` before changing package versions, and do not run two versions
concurrently against the same session database.

## Opt-In Live Verification

The normal test suite uses mock HTTP transports and requires no external credentials. To inspect
stored credentials without traffic:

```bash
npm run smoke:providers -- --dry-run
```

To test every curated provider that has a key under its default private auth reference:

```bash
npm run smoke:providers -- --evidence release-evidence/providers-live.json
```

To test one provider with a launch-scoped key instead of stored auth:

```bash
MYCLI_API_KEY="$GROQ_API_KEY" \
  npm run smoke:providers -- --provider groq \
  --evidence release-evidence/groq-live.json
```

The runner sends one fixed, non-secret, tool-free prompt with no adapter retry. A pass requires
canonical text, usage, matching provider state, and exactly one completion. Output and optional
mode-`0600` evidence contain only provider/model identity, credential source, structural booleans,
and a bounded error code. Missing credentials are `skipped` with exit `77`; a provider failure is
not relabeled as a skip. A provider is live-verified only when its recorded row is `passed`.
