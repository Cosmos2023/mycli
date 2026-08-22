## 1. Baseline And Contracts

- [x] 1.1 Capture canonical root and child turn fixtures for provider manifests, transcripts, tool lifecycles, approval/clarification, steering, mailbox delivery, usage, and terminal gateway ordering.
- [x] 1.2 Add adapter-neutral AgentLoop, broker, lease, job, provider-step, tool-attempt, context-bootstrap, context-delta, and terminal-result TypeScript contracts without changing production execution.
- [x] 1.3 Add one shared contract test suite that can run against in-process and Worker-backed AgentLoop adapters.
- [x] 1.4 Document feature-gate, pre-turn adapter selection, rollout, and rollback invariants.

## 2. AgentLoop Extraction

- [x] 2.1 Separate provider/tool decision-loop state from coordinator-owned storage, approvals, effects, gateway publication, and terminalization in `NodeTurnRuntime`.
- [x] 2.2 Implement the in-process coordinator broker adapter and preserve current root and subagent behavior.
- [x] 2.3 Move provider-step commit acknowledgement ahead of provider dispatch through the broker contract and retain existing append-only manifest/lifecycle semantics.
- [x] 2.4 Run runtime, storage, provider, integration, gateway, and transcript parity tests with only the in-process adapter enabled.

## 3. Worker Protocol And Fencing

- [x] 3.1 Define bounded discriminated message schemas and validators for bootstrap, delta, provider, tool, approval, clarification, steering, cancellation, progress, usage, and terminal messages.
- [x] 3.2 Implement compound fencing with protocol version, coordinator epoch, Worker generation, lease ID, job ID, session ID, turn ID, timeline window/version, and monotonic sequence.
- [x] 3.3 Add ABA-safe timeline window replacement and monotonic high-water validation for steering, compaction, continuation reset, and recovery.
- [x] 3.4 Add coordinator-issued idempotency identities and durable deduplication for provider and external tool attempts.
- [x] 3.5 Add malformed, oversized, duplicate, reordered, stale-generation, stale-lease, prior-job, prior-window, and hash-mismatch tests with zero-side-effect assertions.

## 4. Elastic Agent Worker Pool

- [x] 4.1 Implement the compact Agent Worker entrypoint without SQLite, TUI, integrations, tool implementations, or other coordinator-only module imports.
- [x] 4.2 Implement exclusive Worker leases, bounded priority/FIFO queues, startup/shutdown timeouts, warm capacity, and lazy growth using Node 24 `worker_threads`.
- [x] 4.3 Implement lease fencing, release cleanup, idle retirement, Worker failure detection, and replacement.
- [x] 4.4 Add tests proving four-way root/child Worker concurrency, one job per Worker, priority ordering, bounded capacity, and no Worker retention for idle logical sessions.

## 5. Coordinator Broker And Context Delivery

- [x] 5.1 Implement coordinator broker handlers for model-input commit, provider lifecycle, tool execution, approvals, clarifications, steering, usage, terminalization, and gateway publication.
- [x] 5.2 Implement one-time committed context bootstrap plus contiguous same-window deltas, including Worker-side high-water validation and resynchronization.
- [x] 5.3 Keep complete tool output in coordinator-owned artifacts and send bounded provider-visible projections with stable references.
- [x] 5.4 Add bounded content-addressed instruction/tool snapshot caching and prove that complete conversations and lease secrets are cleared on release.
- [x] 5.5 Add hash-parity tests proving Worker-dispatched provider requests equal the coordinator's committed canonical requests and are never sent before commit acknowledgement.

## 6. Subagent Worker Migration

- [x] 6.1 Implement a Worker-backed `AgentThreadRuntimeHandle` whose active `run` or `runMailbox` obtains one pool lease while durable agent/task/mailbox ownership stays in `AgentSupervisor` and the coordinator.
- [x] 6.2 Preserve foreground/background spawn, progress, usage, send, follow-up, wait, approval/clarification, interrupt, unload/reload, and automatic parent completion delivery.
- [x] 6.3 Add real concurrent root plus multiple-child tests, including independent context windows, tools, approvals, usage, and terminal reports.
- [x] 6.4 Enable Worker-backed subagents behind an explicit gate, run adapter parity and real-provider smoke tests, then make the path default only after acceptance evidence is recorded.

  The explicit gate, independent child lane override, mixed topology coverage, canonical parity,
  and explicit `in_process` rollback pass. On 2026-08-13, local DeepSeek `chat_completions` smoke
  completed with an in-process root plus Worker subagents and again with both lanes on Worker. The
  sanitized evidence covers two child reads, completion delivery, send/follow-up/two waits,
  targeted interruption, durable listing, mailbox/tree persistence, session/backend reload, and
  `python_started=false`. Worker-backed subagents are now the default.

## 7. Targeted Interruption And Recovery

- [x] 7.1 Implement lease fencing followed by cooperative cancellation, bounded coordinator-owned effect cleanup, targeted Worker termination, durable terminalization, and replacement.
- [x] 7.2 Persist exactly one interrupted turn and one terminal result per started tool, using `effect_outcome_unknown` when a mutating outcome cannot be proven.
- [x] 7.3 Add race and fault-injection tests for late provider deltas, late tool completions, approval responses during cancellation, duplicate terminal messages, Worker crashes, and replacement reuse.
- [x] 7.4 Increase and narrow the outer backend watchdog so ordinary Agent Worker interruption never changes coordinator generation.

## 8. Root Agent Worker Migration

- [x] 8.1 Route root turn execution through the same pool and broker while retaining coordinator-owned session, queue, persistence, tools, approvals, gateway, and TUI behavior.
- [x] 8.2 Add tests proving root hard interruption does not stop independently running children and child hard interruption does not stop the root or siblings.
- [x] 8.3 Validate session resume/fork/new, slash commands, steering/follow-up, compaction, provider continuation, MCP refresh, permissions, and TUI transcript behavior with Worker-backed root execution.
- [x] 8.4 Make Worker-backed root execution default only after in-process/Worker canonical parity and rollback tests pass.

  Local canonical parity, default Worker-to-explicit-in-process restart rollback, independent lane
  overrides, and the no-gate shared-pool topology pass. The same 2026-08-13 DeepSeek smoke completed
  with a Worker root plus in-process children and with both lanes on Worker. Worker-backed root
  execution is now the default; `MYCLI_AGENT_EXECUTION_ADAPTER=in_process` remains the supported
  pre-turn rollback path.

## 9. Memory Governance

- [x] 9.1 Add measured V8 `resourceLimits`, bounded Worker protocol payloads, immutable-cache byte/entry limits, and redacted per-Worker heap/event-loop metrics.
- [x] 9.2 Implement idle timeout, job-count, age, large-context, heap-growth, and protocol-health recycling while preventing active-lease reclamation.
- [x] 9.3 Implement process RSS soft/hard pressure behavior that retires idle Workers, disables speculative warming, queues lower-priority work, and returns explicit capacity outcomes without hidden context truncation.
- [x] 9.4 Benchmark zero/one/four Worker idle memory, one/four active Agent workloads, large histories, large tool outputs, repeated leases, and post-idle memory recovery on macOS, Linux, and Windows CI where available.

  Nine provider-free scenarios and one production-entrypoint loopback Responses soak now run in
  isolated processes. The 1,000-lease soak verifies forced-GC steady-state heap/external slopes,
  job-count recycling, zero released-lease listeners, and pool-close recovery. Local macOS
  arm64/Node 24.14.1 evidence is recorded in `docs/node-agent-runtime.md`. The workflow can upload
  Linux, macOS, and Windows JSONL artifacts, but paid hosted runners are not available for this
  worktree. On 2026-08-14 the project owner explicitly accepted the complete local macOS evidence
  and waived hosted Linux/Windows/macOS execution for this change. This is an acceptance waiver,
  not a claim that those runners executed. Follow-up local memory hardening added schema-v8-compatible indexed
  bounded reads for resumable/artifact transcript snapshots plus bounded Worker-capacity/idle-timeout
  startup overrides. Complete filtered transcript history remains available through the existing
  paginated RPC. A three-boundary 2,000-turn macOS benchmark proved that provider resume used only the
  latest replacement plus 20 retained turns, did not immediately compact again, and reduced resume
  from 346.08 ms with a complete in-memory transcript to 103.94 ms with the bounded prepared snapshot.
  The repeatable long-history benchmark now also reports the first 500-item transcript page
  separately from explicit all-page loading and includes a 500-boundary, 8,000-character-summary
  `compact_stress` profile. With memory enabled, the local macOS run completed `session.resume` in
  73.92 ms, its first page in 16.07 ms, and all seven pages in 91.78 ms; provider input contained
  only the latest replacement plus 20 retained turns and excluded the oldest session summary.
  A final local macOS revalidation completed all ten memory scenarios; four active Workers measured
  about 48.3 MiB peak RSS delta, the soak and post-idle scenarios ended with zero Workers, active
  leases, and queued requests, and the 500-compaction profile completed resume in 78.49 ms and all
  seven transcript pages in 88.16 ms.

## 10. Quality Gate And Cleanup

- [x] 10.1 Run protocol property/fuzz tests, runtime/storage/provider/integration/TUI suites, typecheck, lint, contracts check, package smoke, PTY smoke, agent smoke, and `git diff --check`.

  Local property/fuzz, runtime, storage, provider, integration, app, TUI, build, typecheck, lint,
  contracts, package, PTY, benchmark, and diff gates pass. The DeepSeek `chat_completions` agent
  smoke passes for mixed and all-Worker lanes. The separately tracked Responses API acceptance
  evidence is recorded in 10.2.
- [x] 10.2 Run environment-provided real Responses API smoke tests for root, foreground/background child, parallel children, approval, tool execution, steering, and targeted interruption without logging secrets.

  The credential-free runner, unavailable-path redaction, and allowlisted `failure_stage`
  diagnostics pass. On 2026-08-13, the default-adapter Responses probe against the local DeepSeek
  configuration exited 77 with `status=unavailable` and `failure_stage=not_run`, without provider,
  tool, or Python execution. DeepSeek provides `chat_completions` here, so the successful rollout
  smoke is intentionally not recorded as Responses acceptance evidence. An environment-provided
  OpenAI-compatible Responses endpoint then completed the default Worker root/background-child
  runner with four spawns, two overlapping children, three waits, steering, send/follow-up,
  targeted interruption, child reads, durable tree/mailbox state, and backend/session reload. The
  foreground compatibility runner separately completed with a Worker lease and durable provider
  manifest. M7 and M4 live Responses runs added two approval continuations, MCP/plugin execution,
  and a persisted file mutation. All summaries omitted credentials, endpoints, prompts, responses,
  and local paths, and every runner reported `python_started=false`.
- [x] 10.3 Update runtime, interruption, subagent, storage, memory, troubleshooting, rollout, and architecture documentation with measured defaults and failure categories.
- [x] 10.4 Remove transitional duplicate orchestration only after both root and child Worker paths meet acceptance criteria, while retaining the supported in-process rollback adapter for the documented compatibility window.

  After the owner-approved hosted-runner waiver completed 9.4, the unused generic
  `AgentLoopAdapter`/in-process forwarding wrapper, coordinator protocol handler, and separate
  commit-and-dispatch gate were removed. Production now has one coordinator orchestration path in
  `NodeTurnRuntime`; it selects the retained `InProcessProviderStepExecutor` or the leased
  `WorkerProviderStepExecutor` before a turn segment starts. The runtime package's 340 tests and
  typecheck pass after cleanup, including adapter selection, canonical commit-before-dispatch,
  root/child Worker leases, provider RPC fencing, targeted interruption, and explicit
  `in_process` rollback coverage.
