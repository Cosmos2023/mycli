# Responses Prompt Cache Demo Design

## Goal

Add a minimal Python script that demonstrates mycli's streaming OpenAI
Responses path, append-only multi-turn replay, and a provider-side prompt cache
hit.

## Scope

- Add `scripts/demo_responses_cache.py`.
- Call `OpenAI.responses.create` directly, matching the SDK path used by
  `OpenAIResponsesClient`.
- Set `stream=True` and consume typed Responses stream events.
- Read the API key, base URL, and model from environment variables.
- Keep the model, instructions, input prefix, tools, and `prompt_cache_key`
  stable across requests.
- Maintain append-only logical input. Each turn appends a user item, streams a
  response, and appends the completed response output items before the next
  request.
- Do not send `previous_response_id`, so Responses continuation cannot be
  mistaken for a prompt cache hit and HTTP-only gateways can use full replay.
- Make the stable prefix long enough to exceed the provider's prompt-cache
  minimum used by this repository's existing probe.

## Runtime Behavior

The script sends at least two and up to six streaming Responses requests. It
prints `response.output_text.delta` content as it arrives. It requires a
terminal `response.completed` event and reads:

```text
usage.input_tokens
usage.input_tokens_details.cached_tokens
```

It appends `response.completed.response.output` items to the logical input for
the next turn. It prints bounded per-turn token statistics without printing the
API key or request headers. A positive `cached_tokens` value after at least two
turns is the only success signal. The script prints `CACHE HIT` and exits with
status 0 after that signal. It exits with status 1 when all turns complete but
none report cached tokens. A missing completion event, provider failure, or
invalid configuration produces a concise non-zero exit.

## Interface

Configuration uses these environment variables:

- `OPENAI_API_KEY`: required.
- `OPENAI_BASE_URL`: optional; defaults to `https://api.openai.com/v1`.
- `OPENAI_MODEL`: optional; defaults to the repository's documented Responses
  model.

Command-line options control the maximum turns and delay between turns
without changing the stable cache prefix.

## Testing

Unit tests use fake iterable Responses streams and cover:

- `stream=True` on every request and no `previous_response_id`;
- live forwarding of `response.output_text.delta` text;
- extraction of completed output items and
  `input_tokens_details.cached_tokens`;
- append-only input growth across turns;
- success only after a positive cached-token count on a multi-turn request;
- failure when a stream ends without `response.completed`;
- failure when the configured turns never hit the cache;
- rejection of missing API-key configuration.

The implementation follows test-driven development: each behavior is first
observed as a focused failing test, then implemented minimally.
