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

## Runtime v2 Follow-up Validation

After the runtime changes for append-only provider replay, stable force-answer tool schema, and provider usage diagnostics, a second real `mycli` DeepSeek run was executed on 2026-04-30 against an isolated temporary Python repository.

Run shape:

- 3 user turns in one session.
- `recent_message_count=1` to stress the old sliding-window failure mode.
- Real DeepSeek `deepseek-v4-flash`.
- Real tool-loop execution.
- 13 model requests total.
- API key was read from local config and was not printed.

Turn outcomes:

| Turn | Activity Events | Progress Updates | Pending Decision | Stop Reason |
| --- | ---: | ---: | --- | --- |
| 1 | 53 | 13 | false | assistant_completed |
| 2 | 25 | 4 | false | max_steps_reached |
| 3 | 3 | 0 | false | assistant_completed |

Runtime trace diagnostics:

| Request | Prompt Tokens | Cache Hit | Cache Miss | Hit Ratio | First Changed Provider Message | Tool Schema |
| ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 1 | 2026 | 1664 | 362 | 0.8213 | n/a | stable |
| 2 | 2205 | 1664 | 541 | 0.7546 | 2 | stable |
| 3 | 3193 | 1664 | 1529 | 0.5211 | 4 | stable |
| 4 | 3918 | 1664 | 2254 | 0.4247 | 10 | stable |
| 5 | 5017 | 2432 | 2585 | 0.4848 | 15 | stable |
| 6 | 5017 | 4992 | 25 | 0.9950 | n/a | stable |
| 7 | 6930 | 1664 | 5266 | 0.2401 | 2 | stable |
| 8 | 6930 | 6912 | 18 | 0.9974 | n/a | stable |
| 9 | 6930 | 6912 | 18 | 0.9974 | n/a | stable |
| 10 | 7682 | 1664 | 6018 | 0.2166 | 30 | stable |
| 11 | 7923 | 4096 | 3827 | 0.5170 | 32 | stable |
| 12 | 8358 | 5248 | 3110 | 0.6279 | 34 | stable |
| 13 | 8984 | 4096 | 4888 | 0.4559 | 30 | stable |

Follow-up findings:

- The old `tools=0` force-answer drift is gone: all 13 requests used one stable tool schema hash.
- Provider usage now reaches `cache_shape_diagnostic`, so cache regressions can be inspected from runtime trace without parsing raw response files.
- Repeated identical request shapes reached 99.50% and 99.74% cache hit ratio.
- New appended replay shapes still cannot guarantee 99% on first occurrence; DeepSeek commonly reuses only part of the prefix until an identical shape is repeated.
- `first_changed_provider_message_index` now points to append/replay growth instead of tool schema drift, which is the expected remaining volatility for multi-turn tool loops.

## Runtime v3 Real 8-Turn Validation

After the runtime v3 split and the DeepSeek thinking-mode replay fixes, a real 8-turn
`mycli` session was executed on 2026-04-30 against the actual repository.

Run shape:

- 8 user turns in one session.
- Real DeepSeek `deepseek-v4-flash`.
- Real native tool-loop execution through the CLI.
- Read-only repository analysis task.
- 44 model requests total.
- Real `list_directory`, `read_file`, `read_file_range`, and `search_text` tool calls.
- API key was read from local config and was not printed.
- No raw model error files were written.
- No `reasoning_content` HTTP 400 was observed.
- No `Native tool call arguments were not valid JSON` session failure was observed.

Full-session weighted result:

| Requests | Cache Hit | Cache Miss | Weighted Hit Ratio |
| ---: | ---: | ---: | ---: |
| 44 | 719616 | 30202 | 95.97% |

Per-user-turn weighted result:

| Turn | Requests | Cache Hit | Cache Miss | Weighted Hit Ratio |
| ---: | ---: | ---: | ---: | ---: |
| 1 | 6 | 11904 | 1687 | 87.59% |
| 2 | 6 | 35200 | 7045 | 83.32% |
| 3 | 6 | 70400 | 4919 | 93.47% |
| 4 | 6 | 99712 | 5738 | 94.56% |
| 5 | 6 | 129280 | 4896 | 96.35% |
| 6 | 6 | 148992 | 1874 | 98.76% |
| 7 | 3 | 76544 | 1273 | 98.36% |
| 8 | 5 | 147584 | 2770 | 98.16% |

Important interpretation:

- The session does not reach 99% weighted cache hit overall. Claiming success from the
  highest single request would be misleading.
- Warmed repeated requests do reach 99%+ inside the session, but new user turns and new
  appended tool evidence still introduce misses.
- The remaining misses are dominated by transcript growth: new user messages, new assistant
  tool calls, new DeepSeek `reasoning_content`, and new `role=tool` results.
- Runtime v3 now avoids the earlier fatal DeepSeek thinking-mode replay failure and keeps
  the tool schema stable, so the remaining miss rate is mostly legitimate appended
  conversation state rather than request-shape churn.

Additional hardening added after this validation:

- Native tool-call argument decoding now accepts strict JSON and common Python-literal
  object strings, such as `{'path': 'README.md'}`.
- Unrepairable native tool-call argument strings are preserved as a tool call with empty
  arguments plus parse-error metadata instead of throwing a fatal model response error.
- Tool validation failures are returned to the model as failed `role=tool` results, so the
  ReAct loop can recover in the next model call instead of failing the whole session.

## Qwen Responses Continuation Validation

Qwen `responses` was validated on 2026-05-01 with:

- Provider: `qwen`
- Protocol: `responses`
- Model: `qwen3.6-plus`
- Endpoint: `https://dashscope.aliyuncs.com/compatible-mode/v1`
- Real `previous_response_id` continuation.
- Real tool loop with `list_directory`, `read_file`, `read_file_range`, and `search_text`.
- API key was read from local config and was not printed.

### Before Strict Delta

The first Qwen `responses` run already sent `previous_response_id`, but each continuation
request still appended a provider-visible contextual user item containing workspace facts
and runtime policy. This was not the old conversation summary, but it was still extra
non-transcript text.

Observed shape:

| Metric | Value |
| --- | ---: |
| Requests | 14 |
| Responses | 14 |
| Continuation requests using `previous_response_id` | 13 |
| Total input tokens | 64215 |
| Total cached tokens | 0 |
| Weighted cache hit | 0.00% |

Raw request symptoms:

- Request 1 sent `system`, `developer`, current `user`, and contextual runtime facts.
- Continuation requests sent `function_call_output` or new `user` plus contextual runtime facts.
- Provider-visible input did not include repeated `Conversation summary`, but it did include
  repeated `Runtime policy` and `Workspace root` text.

### After Responses Delta Whitelist

The `responses` request shape was tightened so provider-visible input no longer includes
cache-hostile contextual user sections such as runtime policy, environment facts,
conversation summary, or plan state. With `previous_response_id`, the delta input is now
only:

- the first request's stable `system`/`developer` plus current user query,
- model-visible workspace, memory, or skill context when explicitly active,
- later tool results as `function_call_output`,
- later user turns as the new `user` message.

Observed shape:

| Metric | Value |
| --- | ---: |
| Requests | 14 |
| Responses | 14 |
| Continuation requests using `previous_response_id` | 13 |
| Total input tokens | 46754 |
| Total cached tokens | 0 |
| Weighted cache hit | 0.00% |

Raw request verification:

| Request | Previous Response | Input Items | Provider-Visible Extra Context |
| ---: | --- | ---: | --- |
| 1 | no | 3 | none |
| 2 | yes | 1 | none |
| 3 | yes | 1 | none |
| 4 | yes | 1 | none beyond tool output |
| 5-8 | yes | 1 | none beyond tool output |
| 9 | yes | 2 | one tool output plus new user query |
| 10-14 | yes | 1 | none beyond tool output |

Important interpretation:

- The local runtime bug was real: Qwen `responses` continuation was not bloating with
  repeated conversation summary anymore, but it was still bloating with repeated runtime
  context. That is now removed.
- Qwen still reports `input_tokens_details.cached_tokens=0` for this run. Therefore there is
  no evidence of provider-side cache hit, even though local request delta shape is now correct.
- Qwen input tokens still grow across requests because `previous_response_id` causes the
  provider to continue from accumulated server-side response state. The raw request body is
  small, but the provider usage includes prior state.
- Qwen response objects may include provider-generated reasoning `summary_text` items. Those
  summaries are in the provider response/state, not text that the local runtime re-sends as
  request input.
