# Node Runtime M8 Retained-Capability Audit

This is the final Python/Node promotion audit. It was captured before making Node unconditional in
the npm CLI; the independently launched Python reference runtime remains in the repository.
The executable source is
`backend/apps/mycli/test/fixtures/node-runtime-m8-capability-audit.json`; the matching Node test rejects an
unresolved row, gateway/catalog drift, slash-command drift, tool retirement drift, or changes to
the sanitized M2-M7 corpus.

## Black-Box Result

- The final cross-backend baseline advertised the same 33 RPC methods and 42 event streams. Later
  contract work added shell controls, explicit `session.new`, settings and update controls, and
  provider connectivity validation, so the Node contract now advertises 41 RPC methods and 43
  event streams.
- The retained slash surface contains 35 commands and 13 argument-prefix aliases. The retired
  agent-profile browser is absent; `/agents` is canonical and `/tasks` remains a compatibility alias.
  Remaining commands keep frozen ownership, surfaces, running-turn policy, argument rules,
  presentation, and client actions.
- Bootstrap/status, live user items, sessions/transcripts, approvals, clarifications, queues,
  provider/tool turns, compaction/memory, persistent shells, integrations/subagents, management,
  diagnostics, interrupts, and shutdown all have Node-owned black-box coverage.
- The sanitized M2-M7 request, provider, storage, tool, mutation, recovery, shell, extension, and
  management corpora remain checked by Node and by the retained cross-backend harnesses.

## Approved Retirements

- `LS`, `Glob`, and `Grep` remain retired; `Read` owns bounded discovery.
- Missing subagent budgets remain unlimited instead of inheriting Python's historical implicit
  eight-turn and no-progress defaults.
- Python plugin source compatibility is retired in favor of Plugin API v2 and the migration guide.
- Cross-backend harness code is test-only and remains available to validate the retained Python
  reference against Node.

There are no unresolved retained-capability rows. Node default promotion is allowed only while
`node-runtime-m8-capability-audit.test.ts` and the M2-M7 parity gates are green; Python source,
packaging, and CI remain preserved by user decision.
