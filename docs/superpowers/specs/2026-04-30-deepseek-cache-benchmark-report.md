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

## Real mycli Agent Long-Cycle Run

After the synthetic request-shape benchmark, a real `mycli` agent run was executed against an isolated temporary Python repository. The run used:

- 3 user turns in the same session,
- real DeepSeek `deepseek-v4-flash`,
- real `mycli` tool loop execution,
- 14 model requests total,
- read/search/list/shell-style tool activity,
- no API key output.

Turn activity:

| Turn | Activity Events | Progress Updates | Pending Decision | Result |
| --- | ---: | ---: | --- | --- |
| 1 | 35 | 8 | false | completed |
| 2 | 18 | 3 | false | completed |
| 3 | 53 | 14 | false | completed |

Observed raw response usage:

| Request | Prompt Tokens | Cache Hit | Cache Miss | Hit Ratio |
| ---: | ---: | ---: | ---: | ---: |
| 1 | 2039 | 256 | 1783 | 0.1256 |
| 2 | 2196 | 256 | 1940 | 0.1166 |
| 3 | 3308 | 1536 | 1772 | 0.4643 |
| 4 | 2490 | 256 | 2234 | 0.1028 |
| 5 | 3564 | 1664 | 1900 | 0.4669 |
| 6 | 3942 | 1664 | 2278 | 0.4221 |
| 7 | 3605 | 256 | 3349 | 0.0710 |
| 8 | 4703 | 1664 | 3039 | 0.3538 |
| 9 | 4807 | 1664 | 3143 | 0.3462 |
| 10 | 4807 | 4736 | 71 | 0.9852 |
| 11 | 5577 | 1664 | 3913 | 0.2984 |
| 12 | 5533 | 1664 | 3869 | 0.3007 |
| 13 | 4091 | 1664 | 2427 | 0.4067 |
| 14 | 5364 | 1664 | 3700 | 0.3102 |

### Real-Run Diagnosis

The real agent benchmark confirms that the provider can cache warmed stable shapes, but the live runtime still has cache-hostile behavior in long tool loops:

1. Replay window sliding changes the early provider messages.
   - The live requests do not keep an append-only replay prefix.
   - Older messages are dropped as `recent_message_count` shifts.
   - This changes provider message index 1 onward across tool-loop requests.

2. Force-answer requests remove the tool schema.
   - Normal tool-loop requests send `tools=16`.
   - Some final-answer requests send `tools=0`.
   - This changes provider request body shape and defeats tool-schema cache reuse.

3. Tool results include absolute temporary paths.
   - This is expected for real file tools, but it makes replay evidence highly volatile.
   - The important fix is not to duplicate this evidence elsewhere; replay itself will still grow.

4. Some assistant messages replay DSML-style tool-call text as assistant content.
   - These messages are model-generated and become part of replay.
   - They should be preserved if provider requires them, but the runtime should avoid generating parallel summaries of them.

### Next Required Fixes

The remaining runtime work is:

- Make provider replay prefix append-only within a session until explicit compaction, instead of using a sliding recent-message window for provider payloads.
- Keep native tool schema stable even when runtime wants to force a final answer; enforce no-more-tools at the runtime/policy layer rather than removing `tools`.
- Add request-shape diagnostics to real runtime logs with provider usage, so cache regressions can be caught without parsing raw model response files.
