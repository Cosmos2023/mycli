# Working Remains Active After Text Stops

## Observations

On September 7, recent successful turns ended at 20:24:47, 20:26:23, and
20:33:28 (Asia/Shanghai). Existing diagnostics reconstruct final-text-to-provider
tails of approximately 10.48, 8.52, and 4.67 seconds. SQLite completion to the
derived `conversation.saved` artifact took 0.338, 0.380, and 0.360 seconds.
The measurements place most of the wait inside the provider step, but do not
distinguish upstream terminal delivery from SDK exit or attempt persistence.

Working clears on `turn.completed`; stopping text is not a successful terminal
signal. Existing tests verify that a valid Responses terminal completes without
waiting for upstream EOF or remote cancellation acknowledgement.

## Instrumentation

New runs append timing to the existing private file:
`~/.mycli/traces/<session-id>-trace.jsonl`. Existing `trace.export` gateway RPC
also returns these allowlisted fields. Rebuild and restart mycli before using
the instrumentation; already-running processes do not reload compiled modules.

Each `model_stream_diagnostics` row contains the following optional fields.
Offsets share that attempt's monotonic start, after its initial attempt record
is committed; retries start a new clock and row.

| Field | Meaning |
| --- | --- |
| `last_text_delta_ms` | Offset of the last nonempty canonical text delta |
| `response_terminal_ms` | First terminal observed by the SSE body parser |
| `sdk_terminal_ms` | Pi-ai `done` or `error` received by the adapter |
| `completed_event_ms` | Canonical provider completion received by runtime |
| `stream_settled_ms` | Provider iteration exited, including awaited cleanup |
| `terminal_persist_ms` | Duration of terminal attempt persistence and Worker acknowledgement |
| `text_tail_ms` | Last nonempty text delta through attempt diagnostic finalization |
| `elapsed_ms` | Total attempt duration, including terminal persistence |

`response_terminal_ms` covers Responses completed/incomplete/failed/error,
Anthropic stop/error, and Chat DONE/error or an accepted clean EOF. It is absent
when the transport does not pass through the SSE observer. SDK/runtime fields
remain useful for native and other pi-ai providers. No terminal field means
unobserved, not zero latency or success.

For a successful turn, `turn_completion_diagnostics` adds `commit_ms`,
`continuation_ms`, `snapshot_ms`, `publish_ms`, `elapsed_ms`, and
`snapshot_written`. These measure the canonical completion transaction,
continuation state, snapshot queue/write, and runtime completion callback.
The snapshot duration includes queue waiting and failed writes. Auxiliary
memory work after publication is outside these measurements.

## Reading The Result

- A late `response_terminal_ms` locates delay before the parsed terminal reaches
  the SDK. It includes upstream/transport buffering and local reader scheduling.
- A large `sdk_terminal_ms - response_terminal_ms` locates SDK processing or
  scheduling after the terminal frame has already been parsed.
- A large `stream_settled_ms - completed_event_ms` identifies iteration cleanup
  after runtime has seen canonical completion.
- A large `terminal_persist_ms` identifies the attempt journal/Worker round trip.
- A large turn `snapshot_ms` identifies derived snapshot work after SQLite commit.

The parser can observe a terminal frame in a buffered chunk before pi-ai emits
earlier text from that chunk. Do not assume its offset follows the last text
delta. Timing does not prove remote socket arrival, client event receipt, or TUI
render latency. Failed requests can have terminal-frame timing and remain failures.

Timing observers are best effort and contain no request/response contents. They
do not change completion, retries, cancellation, or the Working display. This
change improves diagnosis; it does not itself remove the reported delay.

## Live Framework Reproduction

On September 7, eight bounded live requests ran through the actual
`ProviderRegistry`, pi-ai transport, `projectProviderRequest`, and
`ProviderAgentLoop`. Three isolated two-step loops requested a synthetic tool,
replayed its result and provider state, and returned a final answer. Two
additional text-only requests measured the terminal envelope. All eight
requests succeeded. The endpoint, provider, model (`gpt-5.6-sol`), and reasoning
(`xhigh`) matched the affected workspace's resolved configuration.

The probe deliberately has no TUI, session database, Worker RPC, shell, or
user-file access. It preserves the real provider and loop completion rules.
Every invocation permits at most four requests, 1,024 output tokens per request,
a 45-second request timeout, and zero retries. It uses only synthetic prompts
and in-memory tool results; it does not replay an existing user session.

Run the code-analysis loop:

```sh
node --conditions=mycli-source --import tsx scripts/probe_provider_latency.mjs --scenario review
```

`--scenario tool --runs 2` runs two minimal fixed-value tool loops, and
`--scenario text` makes one small text-only request. Each invocation prints a
private temporary `evidence.json` path. Evidence contains timing, counts, safe
request IDs, allowlisted SSE event names, and selected JSON field sizes. It
does not contain credentials, URLs, request/response text, or tool payloads.
Evidence files use mode `0600` inside a private temporary directory.

### Reproduced Tail

The code-analysis loop's final request started at `2026-09-07T13:47:01.543Z`.
The following offsets share the probe step's monotonic start:

| Observation | Offset or duration |
| --- | --- |
| Last raw `response.output_text.delta` | 8,341.885 ms |
| `response.output_text.done` | 8,420.091 ms |
| `response.output_item.done` | 8,420.128 ms |
| Complete `response.completed` parsed | 10,440.928 ms |
| Framework loop returned | 10,443.395 ms |
| Last raw text to complete terminal | 2,099.043 ms |
| Pending body reads during that tail | 2,097.748 ms |
| Largest local delay before requesting the next tail read | 0.667 ms |
| Terminal parsed to loop return | 2.467 ms |
| Total probe parser work | 2.391 ms |
| Maximum event-loop delay over the whole step | 12.083 ms |

After `response.output_item.done`, three body chunks of 4,090, 16,384, and
6,791 bytes arrived before the next parsed SSE event, `response.completed`.
Those chunks resolved at 8,581.312, 10,085.617, and 10,440.586 ms. Mycli had
already requested the next read during those waits. This reproduces a
seconds-long completion tail without database, TUI, or turn-finalization work.

The two fixed-value loops had smaller terminal tails of 363.343 and
523.513 ms. Their terminal-to-return time was 2.625 and 2.661 ms. The two
text-only requests had tails of 325.261 and 850.722 ms, with approximately
2.1 ms from the complete terminal to loop return.

### Large Terminal Envelope

Both text-only requests returned a `response.completed` JSON data payload of
23,942 bytes despite producing only seven output tokens. JSON-encoded response
field sizes were:

| Response field | Bytes |
| --- | --- |
| `instructions` | 21,522 |
| `output` | 236 |
| `usage` | 998 |
| `tools` | 2 |

The final probe also measured the outgoing request at the injected fetch
boundary: the entire body was only 436 bytes, including 202 bytes of `input`,
and it had no top-level `instructions` field. Therefore the large returned
instructions field was introduced somewhere in the remote processing chain.
It was not sent by this mycli request. This evidence does not identify which
remote component added it.

### Conclusion And Remaining Boundary

For the reproduced delay, the client was waiting for enough response-body bytes
to assemble the final SSE event. It was not spending those seconds in pi-ai
terminal handling, consumer scheduling, or local persistence. The oversized
terminal envelope is an observed source of extra transfer, but its size alone
does not prove the cause of the variable transfer delays.

Fetch body-read timing is not a packet capture. Distinguishing slow upstream
delivery, relay buffering, and the relay-to-client network requires correlated
relay timestamps for upstream terminal first/last bytes and downstream
write/flush. The aggregate usage export does not contain these timestamps.
Next work belongs at that boundary: measure both directions, then remove
unnecessary echoed instructions/tool definitions from the client-facing
terminal envelope if the measured delay is on that segment. Preserve terminal
status, output, usage, and error semantics. Removing fields only after the
relay receives the full upstream terminal cannot fix delays before that point.

Do not finish a mycli turn on `output_text.done` or `output_item.done`; later
terminal status and usage still matter. No production completion behavior was
changed by this experiment.

The read observer was calibrated with a delayed synthetic source and a delayed
consumer. It attributed a 140 ms source delay to the pending read and a 222 ms
consumer delay to time before the next read, respectively. Cancellation with
an open source and omission of payload text from evidence also passed. These
checks validate the measurement boundary; they are not a full TUI reproduction.

Byte-exact forwarding, request/terminal field-size accounting, EOF cleanup,
payload redaction, and private evidence-file permissions were also verified.
Focused provider-loop, SSE-boundary, and instrumented-fetch tests passed, as
did repository lint, workspace typechecking, script syntax, and whitespace
checks. No full-suite rerun or production rebuild was needed for this standalone
probe and incident-note addition.
