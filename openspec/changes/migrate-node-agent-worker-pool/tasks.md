## 1. Baseline And Contracts

- [ ] 1.1 Capture canonical root and child turn fixtures for provider manifests, transcripts, tool lifecycles, approval/clarification, steering, mailbox delivery, usage, and terminal gateway ordering.
- [ ] 1.2 Add adapter-neutral AgentLoop, broker, lease, job, provider-step, tool-attempt, context-bootstrap, context-delta, and terminal-result TypeScript contracts without changing production execution.
- [ ] 1.3 Add one shared contract test suite that can run against in-process and Worker-backed AgentLoop adapters.
- [ ] 1.4 Document feature-gate, pre-turn adapter selection, rollout, and rollback invariants.

## 2. AgentLoop Extraction

- [ ] 2.1 Separate provider/tool decision-loop state from coordinator-owned storage, approvals, effects, gateway publication, and terminalization in `NodeTurnRuntime`.
- [ ] 2.2 Implement the in-process coordinator broker adapter and preserve current root and subagent behavior.
- [ ] 2.3 Move provider-step commit acknowledgement ahead of provider dispatch through the broker contract and retain existing append-only manifest/lifecycle semantics.
- [ ] 2.4 Run runtime, storage, provider, integration, gateway, and transcript parity tests with only the in-process adapter enabled.

## 3. Worker Protocol And Fencing

- [ ] 3.1 Define bounded discriminated message schemas and validators for bootstrap, delta, provider, tool, approval, clarification, steering, cancellation, progress, usage, and terminal messages.
- [ ] 3.2 Implement compound fencing with protocol version, coordinator epoch, Worker generation, lease ID, job ID, session ID, turn ID, timeline window/version, and monotonic sequence.
- [ ] 3.3 Add ABA-safe timeline window replacement and monotonic high-water validation for steering, compaction, continuation reset, and recovery.
- [ ] 3.4 Add coordinator-issued idempotency identities and durable deduplication for provider and external tool attempts.
- [ ] 3.5 Add malformed, oversized, duplicate, reordered, stale-generation, stale-lease, prior-job, prior-window, and hash-mismatch tests with zero-side-effect assertions.

## 4. Elastic Agent Worker Pool

- [ ] 4.1 Implement the compact Agent Worker entrypoint without SQLite, TUI, integrations, tool implementations, or other coordinator-only module imports.
- [ ] 4.2 Implement exclusive Worker leases, bounded priority/FIFO queues, startup/shutdown timeouts, warm capacity, and lazy growth using Node 24 `worker_threads`.
- [ ] 4.3 Implement lease fencing, release cleanup, idle retirement, Worker failure detection, and replacement.
- [ ] 4.4 Add tests proving four-way root/child Worker concurrency, one job per Worker, priority ordering, bounded capacity, and no Worker retention for idle logical sessions.

## 5. Coordinator Broker And Context Delivery

- [ ] 5.1 Implement coordinator broker handlers for model-input commit, provider lifecycle, tool execution, approvals, clarifications, steering, usage, terminalization, and gateway publication.
- [ ] 5.2 Implement one-time committed context bootstrap plus contiguous same-window deltas, including Worker-side high-water validation and resynchronization.
- [ ] 5.3 Keep complete tool output in coordinator-owned artifacts and send bounded provider-visible projections with stable references.
- [ ] 5.4 Add bounded content-addressed instruction/tool snapshot caching and prove that complete conversations and lease secrets are cleared on release.
- [ ] 5.5 Add hash-parity tests proving Worker-dispatched provider requests equal the coordinator's committed canonical requests and are never sent before commit acknowledgement.

## 6. Subagent Worker Migration

- [ ] 6.1 Implement a Worker-backed `AgentThreadRuntimeHandle` whose active `run` or `runMailbox` obtains one pool lease while durable agent/task/mailbox ownership stays in `AgentSupervisor` and the coordinator.
- [ ] 6.2 Preserve foreground/background spawn, progress, usage, send, follow-up, wait, approval/clarification, interrupt, unload/reload, and automatic parent completion delivery.
- [ ] 6.3 Add real concurrent root plus multiple-child tests, including independent context windows, tools, approvals, usage, and terminal reports.
- [ ] 6.4 Enable Worker-backed subagents behind an explicit gate, run adapter parity and real-provider smoke tests, then make the path default only after acceptance evidence is recorded.

## 7. Targeted Interruption And Recovery

- [ ] 7.1 Implement lease fencing followed by cooperative cancellation, bounded coordinator-owned effect cleanup, targeted Worker termination, durable terminalization, and replacement.
- [ ] 7.2 Persist exactly one interrupted turn and one terminal result per started tool, using `effect_outcome_unknown` when a mutating outcome cannot be proven.
- [ ] 7.3 Add race and fault-injection tests for late provider deltas, late tool completions, approval responses during cancellation, duplicate terminal messages, Worker crashes, and replacement reuse.
- [ ] 7.4 Increase and narrow the outer backend watchdog so ordinary Agent Worker interruption never changes coordinator generation.

## 8. Root Agent Worker Migration

- [ ] 8.1 Route root turn execution through the same pool and broker while retaining coordinator-owned session, queue, persistence, tools, approvals, gateway, and TUI behavior.
- [ ] 8.2 Add tests proving root hard interruption does not stop independently running children and child hard interruption does not stop the root or siblings.
- [ ] 8.3 Validate session resume/fork/new, slash commands, steering/follow-up, compaction, provider continuation, MCP refresh, permissions, and TUI transcript behavior with Worker-backed root execution.
- [ ] 8.4 Make Worker-backed root execution default only after in-process/Worker canonical parity and rollback tests pass.

## 9. Memory Governance

- [ ] 9.1 Add measured V8 `resourceLimits`, bounded Worker protocol payloads, immutable-cache byte/entry limits, and redacted per-Worker heap/event-loop metrics.
- [ ] 9.2 Implement idle timeout, job-count, age, large-context, heap-growth, and protocol-health recycling while preventing active-lease reclamation.
- [ ] 9.3 Implement process RSS soft/hard pressure behavior that retires idle Workers, disables speculative warming, queues lower-priority work, and returns explicit capacity outcomes without hidden context truncation.
- [ ] 9.4 Benchmark zero/one/four Worker idle memory, one/four active Agent workloads, large histories, large tool outputs, repeated leases, and post-idle memory recovery on macOS, Linux, and Windows CI where available.

## 10. Quality Gate And Cleanup

- [ ] 10.1 Run protocol property/fuzz tests, runtime/storage/provider/integration/TUI suites, typecheck, lint, contracts check, package smoke, PTY smoke, agent smoke, and `git diff --check`.
- [ ] 10.2 Run environment-provided real Responses API smoke tests for root, foreground/background child, parallel children, approval, tool execution, steering, and targeted interruption without logging secrets.
- [ ] 10.3 Update runtime, interruption, subagent, storage, memory, troubleshooting, rollout, and architecture documentation with measured defaults and failure categories.
- [ ] 10.4 Remove transitional duplicate orchestration only after both root and child Worker paths meet acceptance criteria, while retaining the supported in-process rollback adapter for the documented compatibility window.
