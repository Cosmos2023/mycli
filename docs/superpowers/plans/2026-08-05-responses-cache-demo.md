# Streaming Responses Cache Demo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert the cache demo to streaming Responses with append-only multi-turn full replay.

**Architecture:** Each turn appends a user item to one logical input list and sends a copied full replay with `stream=True`. A stream consumer forwards text deltas, requires `response.completed`, extracts cache usage and completed output items, and appends those output items before the next turn.

**Tech Stack:** Python 3.13, OpenAI Python SDK 2.30+, argparse, pytest, ruff, mypy

---

### Task 1: Specify Streaming And Append-Only Behavior

**Files:**
- Modify: `tests/unit/scripts/test_demo_responses_cache.py`
- Modify: `scripts/demo_responses_cache.py`

- [ ] **Step 1: Replace synchronous fakes with iterable stream events**

Use a fake `responses.create` that records each request and returns an iterator
containing a text delta followed by a completed response:

```python
def stream_events(*, cached_tokens: int, text: str) -> list[dict[str, Any]]:
    output = {
        "type": "message",
        "role": "assistant",
        "status": "completed",
        "content": [{"type": "output_text", "text": text}],
    }
    return [
        {"type": "response.output_text.delta", "delta": text},
        {
            "type": "response.completed",
            "response": {
                "usage": {
                    "input_tokens": 2_048,
                    "input_tokens_details": {"cached_tokens": cached_tokens},
                },
                "output": [output],
            },
        },
    ]
```

- [ ] **Step 2: Write failing tests for streaming events and append-only replay**

The tests must assert all of these behaviors:

```python
def test_consume_stream_forwards_deltas_and_returns_completion() -> None:
    deltas: list[str] = []

    completion = consume_response_stream(
        iter(stream_events(cached_tokens=1_920, text="hello")),
        emit_delta=deltas.append,
    )

    assert deltas == ["hello"]
    assert completion.usage.cached_tokens == 1_920
    assert completion.output_items[0]["type"] == "message"


def test_run_cache_probe_uses_streaming_append_only_full_replay() -> None:
    client = FakeClient([0, 1_920])
    lines: list[str] = []
    deltas: list[str] = []

    hit = run_cache_probe(
        client.responses.create,
        model="gpt-test",
        attempts=3,
        delay_seconds=0,
        emit=lines.append,
        emit_delta=deltas.append,
        sleep=lambda _seconds: None,
    )

    assert hit is True
    assert len(client.responses.calls) == 2
    assert all(call["stream"] is True for call in client.responses.calls)
    assert all("previous_response_id" not in call for call in client.responses.calls)
    assert len(client.responses.calls[0]["input"]) == 1
    assert len(client.responses.calls[1]["input"]) == 3
    assert deltas == ["turn-1", "turn-2"]
    assert lines[-1] == "CACHE HIT"


def test_consume_stream_rejects_missing_completed_event() -> None:
    with pytest.raises(StreamProtocolError, match="response.completed"):
        consume_response_stream(
            iter([{"type": "response.output_text.delta", "delta": "partial"}]),
            emit_delta=lambda _text: None,
        )


def test_main_requires_at_least_two_streaming_turns(capsys: Any) -> None:
    exit_code = main(
        ["--attempts", "1"],
        environ={"OPENAI_API_KEY": "test-key"},
    )

    assert exit_code == 2
    assert "--attempts must be at least 2" in capsys.readouterr().err
```

- [ ] **Step 3: Run the focused tests and verify RED**

Run:

```bash
.venv/bin/pytest tests/unit/scripts/test_demo_responses_cache.py -q
```

Expected: collection fails because `consume_response_stream` and
`StreamProtocolError` do not exist.

### Task 2: Implement Streaming Full Replay

**Files:**
- Modify: `scripts/demo_responses_cache.py`
- Modify: `tests/unit/scripts/test_demo_responses_cache.py`

- [ ] **Step 1: Add typed streaming request and completion contracts**

Add these contracts and SDK types:

```python
class ResponseCreator(Protocol):
    def __call__(
        self,
        *,
        model: ResponsesModel,
        instructions: str,
        input: str | ResponseInputParam,
        tools: Iterable[ToolParam],
        tool_choice: ToolChoiceOptions,
        prompt_cache_key: str,
        max_output_tokens: int,
        store: bool,
        stream: Literal[True],
    ) -> Iterable[object]: ...


class CacheProbeRequest(TypedDict):
    model: ResponsesModel
    instructions: str
    input: ResponseInputParam
    tools: list[FunctionToolParam]
    tool_choice: ToolChoiceOptions
    prompt_cache_key: str
    max_output_tokens: int
    store: bool
    stream: Literal[True]


@dataclass(frozen=True, slots=True)
class StreamCompletion:
    usage: CacheUsage
    output_items: tuple[ResponseInputItemParam, ...]


class StreamProtocolError(RuntimeError):
    pass
```

- [ ] **Step 2: Implement the stream consumer**

Normalize SDK models through `model_dump`, forward
`response.output_text.delta`, and require a completed response:

```python
def consume_response_stream(
    stream: Iterable[object],
    *,
    emit_delta: Callable[[str], None],
) -> StreamCompletion:
    try:
        for raw_event in stream:
            event = _to_dict(raw_event)
            if event.get("type") == "response.output_text.delta":
                delta = event.get("delta")
                if isinstance(delta, str) and delta:
                    emit_delta(delta)
            if event.get("type") == "response.completed":
                response = event.get("response")
                if not isinstance(response, dict):
                    break
                output = response.get("output")
                output_items = tuple(
                    cast(ResponseInputItemParam, dict(item))
                    for item in output if isinstance(item, dict)
                ) if isinstance(output, list) else ()
                return StreamCompletion(
                    usage=extract_cache_usage(response),
                    output_items=output_items,
                )
    finally:
        close = getattr(stream, "close", None)
        if callable(close):
            close()
    raise StreamProtocolError("Responses stream ended before response.completed")
```

- [ ] **Step 3: Implement append-only turns**

Maintain `logical_input: ResponseInputParam`, append a typed user message,
stream a copied request, append completed output items, and only report a hit
after turn two:

```python
logical_input: ResponseInputParam = []
for round_index in range(1, attempts + 1):
    logical_input.append(user_message(round_index))
    stream = create_response(
        **build_request_body(model=model, input_items=logical_input)
    )
    completion = consume_response_stream(stream, emit_delta=emit_delta)
    logical_input.extend(completion.output_items)
    if round_index >= 2 and completion.usage.cached_tokens > 0:
        emit("CACHE HIT")
        return True
```

- [ ] **Step 4: Handle stream protocol failures in `main`**

Catch `(OpenAIError, StreamProtocolError)` and print only the exception type:

```python
except (OpenAIError, StreamProtocolError) as exc:
    print(f"error: provider request failed ({type(exc).__name__})", file=sys.stderr)
    return 1
```

Change the attempts validation to reject values below two:

```python
if args.attempts < 2:
    print("error: --attempts must be at least 2", file=sys.stderr)
    return 2
```

- [ ] **Step 5: Run the focused tests and verify GREEN**

Run:

```bash
.venv/bin/pytest tests/unit/scripts/test_demo_responses_cache.py -q
```

Expected: all demo tests pass.

### Task 3: Verify Offline And Against The Gateway

**Files:**
- Verify: `scripts/demo_responses_cache.py`
- Verify: `tests/unit/scripts/test_demo_responses_cache.py`

- [ ] **Step 1: Run offline quality checks**

```bash
.venv/bin/ruff format --check scripts/demo_responses_cache.py tests/unit/scripts/test_demo_responses_cache.py
.venv/bin/ruff check scripts/demo_responses_cache.py tests/unit/scripts/test_demo_responses_cache.py
.venv/bin/mypy src scripts/demo_responses_cache.py
.venv/bin/pytest tests/unit/scripts/test_demo_responses_cache.py tests/unit/scripts/test_check_sub2api_cache.py -q
```

Expected: every command exits 0.

- [ ] **Step 2: Run the streaming demo with the supplied gateway credentials**

Inject the API key through a no-echo stdin read and run:

```bash
.venv/bin/python scripts/demo_responses_cache.py --attempts 6 --delay-seconds 0.5
```

Expected: text is emitted before each per-turn summary, at least two turns run,
one completed event reports positive cached tokens, and the process prints
`CACHE HIT` with exit status 0.

- [ ] **Step 3: Preserve the user's no-commit requirement**

Run `git status --short` and verify the demo, tests, design, and plan remain
uncommitted. Do not run `git add` or `git commit`.
