# Session goals

A goal is one durable objective attached to a session. A completed assistant turn
can leave that objective active; the backend then admits another ordinary turn.
The working model verifies results and calls `update_goal` to finish. There is no
extra evaluator model, required MCP server, implicit goal creation, or hidden
maximum number of rounds.

## Controls

| Command | Behavior |
| --- | --- |
| `/goal <objective>` | Create an active goal and start work when the session is idle |
| `/goal --tokens <n> <objective>` | Create with an explicitly chosen positive token budget |
| `/goal` | Show objective, status, reported usage, elapsed time, and controls |
| `/goal pause` | Stop automatic continuation and interrupt an active turn |
| `/goal resume` | Resume a stopped goal with a fresh blocker audit |
| `/goal edit <objective>` | Replace the objective, invalidate stale turn authority, and reset the audit |
| `/goal budget <n>` | Set a positive total budget; already consumed tokens are retained |
| `/goal budget off` | Remove the token limit |
| `/goal clear` | Remove the current goal and interrupt its active work; transcript history remains |

Editing an active goal invalidates the current goal turn. The next admitted turn
uses the edited goal. Editing a stopped goal leaves it paused until explicit resume.
Editing a completed goal reopens it as paused, retaining its usage. Create a new
goal after completion or clear the old one for a fresh budget and identity.

The local tools are `create_goal({ objective, token_budget? })`, `get_goal({})`, and
`update_goal({ status })`. They are exposed only in interactive root runtimes.
The model may create only on explicit user intent. It may mark complete or blocked,
or pause on an explicit human request; resume and budget editing are user controls.
An unfinished goal cannot be silently overwritten. Natural-language intent and
completion evidence are model responsibilities, not deterministic classifiers.

## Status and execution

| Status | Meaning |
| --- | --- |
| `active` | Eligible to continue when the session is idle |
| `paused` | User interruption, explicit pause, or restored execution requires resume |
| `blocked` | The model reports an impasse, or a turn has a terminal execution failure |
| `usage_limited` | Provider quota is exhausted |
| `budget_limited` | The token budget is consumed, or budgeted usage cannot be determined |
| `complete` | The working model has verified the objective and reported completion |

The backend requires at least three goal turns in the current run before accepting
a model-reported blocker. The model must also verify that the *same* blocker
persisted consecutively and no independent useful work remains. Resuming resets
this audit without resetting usage. Execution errors stop immediately and use the
existing error and retry system.

User follow-ups, steers, interactive requests, and session transitions take
precedence over automatic admission. Goal work uses the existing session execution
claim, turn reservation, provider retries, tool policies, and Worker lease.
Duplicate idle notifications cannot start two turns. Goal id and revision prevent
old turns from changing a replacement or resumed objective. Goals grant no new
filesystem, network, or approval permissions.

The work summary above the input shows Goal state and, when space allows, token usage and
the relevant `/goal` control. It shares a row with task progress and background Shell count,
and remains visible when the session footer is off. The full record is available with `/goal`.
Automatic turns are shown as “Continuing goal”, including after history reload;
they are not rendered as new human messages. Closing a popup alone does not pause
a goal. A real interruption pauses before normal cancellation releases execution.

## Accounting and recovery

Goal tokens are uncached input (including cache writes) plus output. Cache reads
are excluded; this is a token budget, not a price estimate. Provider-specific
cache shapes are normalized before accounting. Usage checkpoints are cumulative
per provider attempt and commit atomically with the goal and its audit event, so
repeated observations and replay do not double-charge. Attributed child work and
compaction are included. Creation during a turn starts its accounting baseline
at creation; the earlier request that created the goal is excluded.

Each child run captures its initiating goal separately, so reusing an idle agent
for a later goal does not reuse the earlier goal's accounting. Parent turn
references remain available after settlement for deferred child admission.

Limits apply at observable model-step boundaries. A request or retries already in
flight can overshoot before a boundary is reached. Work remains subject to ordinary
provider and agent limits. Missing usage is marked `usage_incomplete`; the shown
count is a lower bound, and a budgeted goal stops rather than assuming free work.
If goal persistence fails, automatic admission stops and cancellation still
releases the running turn and its execution state.
Elapsed time covers live goal turns, excluding process downtime and gaps between
turns. Reads and settlement flush elapsed observations; no UI accounting timer is
an execution authority.

Goals persist in session database format 15. Opening a format 12, 13, or 14 runtime
database upgrades it transactionally without rewriting conversation history.
Older binaries must reject format 15; use a database backup for rollback.
`session_goal` stores the current snapshot, `session_goal_usage` stores cumulative
usage checkpoints, and non-model-visible goal activity records preserve the audit.
Clear removes the current snapshot and retains history.

Cold restore leaves an active goal paused. Forks inherit the goal snapshot at their
fork boundary with a new identity and stopped execution. Reattaching to an existing
live backend reflects its actual work. Goal-only sessions are retained by cleanup.
Compaction rehydrates the goal through retained context; live accounting updates do
not rewrite prior provider requests or repeatedly alter the system prompt.

Goals do not provide daemon or scheduled execution after mycli exits. Headless
`exec` and `review` keep their existing one-turn settlement contract.
