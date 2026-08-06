# M8 Promotion And Retention Inventory

## Verified Baseline

| Area | Python reference | Current Node ownership | M8 status |
| --- | --- | --- | --- |
| Live user message | Gateway emits committed item lifecycle | Message is durable, but the Node gateway omits the lifecycle event consumed by the TUI | Blocker: fix first |
| Transcript resume | SQLite history and transcript projection | Node session coordinator projects persisted history | Retained; add live/resume equivalence test |
| Slash registry | `src/mycli/cli/slash_command_registry.py` | Node `command.list` exposes shell/integration commands only | Blocker: port retained registry |
| Slash dispatch | Python registry plus dispatch/presenters | Node gateway handles `/ps`, `/stop`, and contributed integration commands | Blocker: close command matrix |
| TUI client actions | Python command result routes actions to the existing TUI | TUI action handlers already exist | Retain existing UI; drive it from Node results |
| Runtime composition | Python launcher and Node parent coexist | npm CLI selects Node or `python-sidecar` | Remove only after parity closure |
| Sidecar lifecycle | Python compatibility transport | `apps/mycli/src/sidecar/` and router paths remain imported | Retire in Task 4 |
| Python package | `src/mycli`, `pyproject.toml`, lock and Python tests | Node packages own migrated npm capabilities | Retain as independent Python reference |
| CI | Python and Node checks plus cross-backend parity | M8 Node matrix plus Python 3.13 reference matrix | Retain both gates |
| npm artifact | Compiled ESM CLI exists | Packed smoke proves no sidecar/import/probe | Keep npm artifact Python-independent |

## Slash Command Reference Surface

The Python registry is the final executable reference while it remains available. Its retained
surface includes command families for model/mode, permissions/sandbox, sessions, status/usage,
context/compaction, skills/tools/resources, memory, agents/tasks/processes, changes/undo,
trace/view, TUI controls, login/trust/help, and quit. It also carries aliases, visibility,
argument policy, per-surface ownership, running-turn availability, and presentation mode.

M8 must not reduce parity to a comparison of command names. The executable matrix needs to compare:

- canonical id and name;
- visible and hidden aliases;
- argument policy and hint;
- CLI versus TUI availability;
- availability while a turn is running;
- TUI client action versus backend execution;
- structured display/presentation shape;
- invalid argument, unavailable state, and unknown command errors.

Plugin-contributed commands remain additive and must not override built-ins or make the built-in
manifest dependent on plugin discovery success.

## User Message Failure Path

1. `turn.submit` reserves and persists the user input in the Node backend.
2. The TUI keeps submitted input as temporary local state.
3. The reducer appends a visible transcript user row only for a completed user-message item.
4. The Node gateway streams assistant events but currently emits no corresponding committed
   user-message lifecycle item.
5. The live screen therefore shows adjacent assistant messages, while resume can rebuild the
   missing user rows from durable history.

The fix belongs at the Node gateway/runtime event boundary. Adding a TUI-only optimistic row would
create conflicting durability semantics and duplicate risk during replay.

## Promotion Ordering

1. Fix user lifecycle and command registry gaps with failing tests first.
2. Run and archive the final cross-backend comparison.
3. Freeze Python parity fixtures as Node-owned golden/regression fixtures while retaining the
   cross-backend harnesses.
4. Remove sidecar routing and make the Node backend unconditional.
5. Preserve Python production, packaging, dependency, tests, and CI as an independent reference.
6. Validate a packed artifact in an environment where Python execution/probing fails the test.

## Retention Guardrails

- Do not remove native Windows sandbox assets used by `@mycli/tools`.
- Do not treat configured external commands that happen to invoke Python as a mycli runtime
  dependency.
- Do not keep Python imports or executable probes in doctor, setup, package smoke, or startup.
- Do not delete the final sanitized parity corpus; move ownership to Node tests where needed.
- Do not delete Python source, packaging, tests, or the independent `uv run mycli` entrypoint.
- Do not include unrelated untracked cache-demo work in M8 commits.

## Final Task 3 Audit

The final executable audit is
`apps/mycli/test/fixtures/node-runtime-m8-capability-audit.json`, enforced by
`apps/mycli/test/node-runtime-m8-capability-audit.test.ts`.

| Area | Final disposition | Evidence |
| --- | --- | --- |
| Bootstrap, status, transcript, turn, queue, approval and clarification | Fixed | Node gateway/runtime/storage tests plus real backend restart tests |
| Slash registry and TUI client/backend ownership | Fixed | 36-command, 12-prefix frozen matrix |
| Provider, tools, compaction, memory, shell and integrations | Fixed | Sanitized M2-M7 corpora and lifecycle gates |
| Management, diagnostics and shutdown | Fixed | Provider-free CLI/doctor and process-lifecycle tests |
| `LS`, `Glob`, `Grep` | Explicitly retired | M3/M4 tool contract; `Read` owns bounded discovery |
| Implicit Python subagent budgets | Explicitly retired | M7 extension contract; Node budgets are opt-in |
| Python plugin source compatibility | Explicitly retired | Plugin API v2 migration guide |
| Python cross-backend runners | Test-only | Corpus checksums are now owned by the Node M8 audit |

The final Python and Node gateway probes matched at 33 RPCs and 42 events. The audit found that
three already-implemented shell control RPCs were missing from both advertised catalogs; the
canonical contract now advertises `shell.list`, `shell.stop`, and `shell.stop_all`, yielding the
frozen Node-only total of 36 RPCs and 42 events. No retained-capability row remains unresolved.
