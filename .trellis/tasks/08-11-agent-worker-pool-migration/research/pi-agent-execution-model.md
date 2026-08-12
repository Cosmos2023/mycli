# pi-agent execution model research

## Question

How does pi-agent/coding-agent schedule turns, tools, and optional subagents, and
which parts should influence the Node mycli Worker Pool design?

## Sources inspected

Local source tree: `/Users/cosmos/Downloads/pi-main`, package version `0.78.1`.

- `packages/agent/src/agent.ts:294-310,324-411,451-556`
- `packages/agent/src/agent-loop.ts:95-268,275-387,395-516,562-760`
- `packages/agent/src/types.ts:242-276,371-384`
- `packages/coding-agent/src/core/agent-session.ts:341-344,505-524,1410-1417`
- `packages/coding-agent/src/core/tools/bash.ts:60-125`
- `packages/coding-agent/src/modes/rpc/rpc-client.ts:54-165`
- `packages/coding-agent/src/utils/image-resize.ts:21-109`
- `packages/coding-agent/examples/extensions/subagent/index.ts:213-230,261-423,454-692`
- `packages/coding-agent/examples/extensions/subagent/README.md`
- `packages/coding-agent/README.md:451-503`

## Core execution model

pi-agent's core agent runtime is a single JavaScript event-loop design:

- An `Agent` permits at most one `activeRun`. Calling `prompt()` while a run is
  active throws and the caller must use steering/follow-up queues instead.
- A run owns one `AbortController`; `abort()` only signals it and
  `waitForIdle()` awaits the same active Promise.
- The provider/tool loop is an async function. It is not submitted to a
  `worker_threads` pool and cannot be forcefully terminated independently.
- State reduction and event listeners are awaited in order. Completed messages
  are appended to the in-memory transcript on `message_end`.
- coding-agent subscribes to those events and appends regular messages to its
  JSONL session on `message_end`.

The package does use a Node Worker for image resizing so WASM/CPU work cannot
block the TUI. That Worker is created per resize request and terminated in a
`finally`; it is not an agent scheduler.

## Tool concurrency

The low-level loop supports sequential or parallel tool batches:

- `toolExecution: "sequential"` serializes the batch.
- A tool declaring `executionMode: "sequential"` forces the entire batch to be
  sequential.
- Otherwise prepared tool calls are started concurrently with `Promise.all`.
- Tool-result messages are emitted afterward in the assistant's original tool
  call order.

This is asynchronous concurrency on one JavaScript thread. It improves overlap
for provider, filesystem, and subprocess waits but does not make CPU-bound or
non-cooperative JavaScript independently interruptible.

Shell execution is an OS child process. The bash adapter passes the run's
`AbortSignal`, kills the process tree on abort or timeout, and awaits the child
exit. This is the same effect boundary mycli should retain.

## Subagent model

pi deliberately has no built-in subagent system. Its README recommends tmux,
extensions, or packages. The repository's official subagent extension is an
example, not a core runtime contract.

That extension uses a process-per-invocation design:

1. Discover an agent profile from user/project Markdown.
2. Spawn a separate `pi --mode json -p --no-session` OS process.
3. Parse JSONL events from stdout and aggregate assistant messages, tool
   results, usage, errors, and final output.
4. Run at most four child processes concurrently, with eight tasks per batch.
5. On parent abort, send `SIGTERM`, then attempt `SIGKILL` after five seconds.

Each child therefore has a separate heap, event loop, context window, and
process-failure boundary. The parent receives only structured progress and the
bounded final result. The example does not provide mycli-style durable child
session identity, shared approval ownership, mailbox/resume semantics, or a
single append-only coordinator.

pi's RPC client follows the same process-isolation option for external clients:
it spawns a complete `pi --mode rpc` process and communicates using strict
JSONL over stdio. This is useful as a public embedding boundary, not evidence
of an internal thread pool.

## Comparison

| Property | pi core | pi subagent example | proposed mycli |
|---|---|---|---|
| Agent host | main JS event loop | one OS process per invocation | reusable Node Worker per active turn |
| Hard-stop boundary | none for arbitrary JS | child process | target Worker lease |
| Concurrency | Promise/tool overlap | bounded child-process pool | bounded single-job Worker Pool |
| Durable child session | not built in | disabled by `--no-session` | coordinator-owned |
| Shared approvals/mailbox | not built in | not built in | coordinator-owned |
| Tool effects | local adapters/child processes | inside each child process | coordinator broker/child processes |
| Isolation cost | lowest | highest | intermediate |

## What mycli should adopt

- Keep one active run per execution host. A Worker lease must never run two
  turns concurrently.
- Keep isolated model context per logical agent and return only structured,
  bounded progress/result payloads to the parent.
- Use a bounded FIFO/priority concurrency limiter instead of unbounded spawn.
- Preserve source order when concurrent tool results become model-visible.
- Propagate cancellation into provider calls and external process trees.
- Track usage, model, terminal reason, and diagnostics independently per child.
- Keep process/Worker protocol framing strict and reject malformed, stale, or
  late messages.
- Treat CPU-heavy helpers such as image processing as separate Worker jobs when
  they would otherwise block agent/TUI event loops.

## What mycli should not copy

- Do not spawn the full mycli CLI for every subagent. Reinitializing providers,
  prompts, tools, plugins, and storage per task is expensive and makes shared
  state ordering harder.
- Do not disable child persistence. mycli requires durable subagent sessions,
  task records, mailboxes, usage, and resume.
- Do not let child execution hosts own SQLite or approval state. A central
  coordinator must remain the sole durable/effect owner.
- Do not rely on `AbortController` alone for a blocked agent loop. After a short
  cooperative grace period, terminate and replace only the leased Worker.
- Do not use a five-second hard-stop grace period for interactive interruption;
  retain the Codex-inspired short grace period and bounded cleanup path.

## Recommendation

The existing coordinator plus reusable single-job Agent Worker Pool remains the
best fit. It is closer to Codex's lightweight task scheduling than pi's
process-per-subagent extension, while giving Node a real termination boundary
that Promises lack.

Use pi's subagent extension as the reference for protocol ergonomics,
concurrency limiting, progress streaming, bounded parent-visible results, and
per-agent usage accounting. Use Codex as the reference for task-scoped
cancellation, durable terminal ordering, and short cooperative-to-hard abort.

An optional process-host adapter may be considered later for untrusted plugins
or stronger crash isolation, but it should implement the same coordinator
broker protocol rather than become the default subagent architecture.
