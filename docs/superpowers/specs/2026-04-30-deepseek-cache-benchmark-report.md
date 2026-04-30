# DeepSeek Cache Benchmark Report

Date: 2026-04-30

## Configuration

- Provider: `deepseek`
- Protocol: `chat_completions`
- Model: `deepseek-v4-flash`
- Endpoint: `https://api.deepseek.com`
- Output budget: `max_tokens=8`
- Temperature: `0`
- Tool schema: native `tools` payload with `tool_choice=none`

API keys were read from local config and were not printed.

## Results

### Short Stable Shape

This uses a short stable system prompt, stable tool schema, replay transcript, current intent, and compact volatile context.

| Case | Prompt Tokens | Cache Hit | Cache Miss | Hit Ratio |
| --- | ---: | ---: | ---: | ---: |
| warmup exact | 307 | 0 | 307 | 0.0000 |
| repeat exact | 307 | 256 | 51 | 0.8339 |
| changed tail | 310 | 0 | 310 | 0.0000 |
| repeat changed tail | 310 | 256 | 54 | 0.8258 |

Short prompts have a fixed miss floor, so ratios are not representative of complex agent tasks.

### Long Stable Shape

This uses a longer stable prefix similar to a complex agent session.

| Case | Prompt Tokens | Cache Hit | Cache Miss | Hit Ratio |
| --- | ---: | ---: | ---: | ---: |
| warmup exact | 3733 | 0 | 3733 | 0.0000 |
| repeat exact | 3733 | 3712 | 21 | 0.9944 |
| changed tail | 3736 | 0 | 3736 | 0.0000 |
| repeat changed tail | 3736 | 3712 | 24 | 0.9936 |

Repeated complex request shapes exceed 99% cache hit ratio after warmup.

### Tool-Loop Replay Append Shape

This simulates a tool loop where stable system, stable tool schema, and previous replay remain the same, then new replay evidence is appended before the same current intent.

| Case | Prompt Tokens | Cache Hit | Cache Miss | Hit Ratio |
| --- | ---: | ---: | ---: | ---: |
| base warmup | 2571 | 0 | 2571 | 0.0000 |
| base repeat | 2571 | 2560 | 11 | 0.9957 |
| append replay once | 2596 | 0 | 2596 | 0.0000 |
| append replay repeat | 2596 | 2560 | 36 | 0.9861 |

The first short append shape did not reuse cache, but the repeated appended shape did.

### Long Tool-Loop Replay Append Shape

This uses a longer stable prefix and longer replay transcript.

| Case | Prompt Tokens | Cache Hit | Cache Miss | Hit Ratio |
| --- | ---: | ---: | ---: | ---: |
| long append base warmup | 5340 | 0 | 5340 | 0.0000 |
| long append base repeat | 5340 | 5248 | 92 | 0.9828 |
| long append replay once | 5382 | 5248 | 134 | 0.9751 |
| long append replay repeat | 5382 | 5376 | 6 | 0.9989 |

For long complex tasks, repeated appended replay shapes can exceed 99.8% after warmup.

## Findings

- The runtime v2 cache-first request shape can reach greater than 99% DeepSeek cache hit ratio for warmed complex request shapes.
- A brand-new request shape can still produce 0% hit on its first call. This is provider behavior, not a local runtime ordering bug.
- Appending replay evidence can reuse a large cached prefix in long contexts, but the first appended shape may still have provider-dependent miss behavior.
- Short prompts have a fixed miss floor, so ratios can appear low even when the cache is working.

## Remaining Practical Limit

The system can make repeated complex shapes hit above 99%, but it cannot guarantee 99% for the first occurrence of a new user query, a new replay layout, or a changed tool schema. The best control surface remains:

- keep stable system content fixed,
- keep native tool schema deterministic,
- keep replay authoritative,
- avoid duplicating memory/evidence/tool text in volatile context,
- keep volatile context compact and late.
