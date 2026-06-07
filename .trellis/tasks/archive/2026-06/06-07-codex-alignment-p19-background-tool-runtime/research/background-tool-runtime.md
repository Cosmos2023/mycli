# P19 Research: Background Tool Runtime

## Current state

- Shell background jobs are represented by `ShellProcessRegistry` rows from P17. They include shell id, process state, status, started_at, last_observed_at, timeout, terminal state, cleanup result, and output counters.
- Sub-agent background jobs are held in `SubAgentService._running_background` and recent summaries. They support running, completion, failure, concurrency limit, and shutdown failure.
- There is no shared background job model that can describe shell and sub-agent background work together.
- Doctor can inspect shell process diagnostics, but not generic background jobs.

## Gap

P19 should standardize the local diagnostic surface for background jobs before adding heavier long-running runtimes. This does not require distributed workers or cron. The immediate value is consistent job ids, owner turn ids, states, started/last event timestamps, terminal summaries, and doctor detection of running/stale/missing-terminal states.

## Direction

- Add a domain `BackgroundJobSummary` model with bounded metadata.
- Project shell registry rows into `BackgroundJobSummary`.
- Project sub-agent running/recent summaries into `BackgroundJobSummary`.
- Expose `SubAgentService.background_jobs()`.
- Add doctor background job diagnostics that summarize shell jobs and can be unit-tested through the summary function; do not require live provider/API.
- Keep raw command, raw prompt, and raw tool output out of summaries.

## Non-goals

- No cron/background maintenance productization.
- No distributed worker.
- No remote agent/swarm.
- No compact/rehydration changes.
