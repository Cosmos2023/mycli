# Headless Coding Workflow Contract

## Scope And Interfaces

- `parseHeadlessCommand(kind, args) -> HeadlessCommand` uses Node `parseArgs`.
- `runHeadlessCommand(options) -> Promise<number>` owns input, output-schema
  validation, signal/timeout lifetime, backend cleanup, and stdout projection.
- `runHeadlessSession(options) -> Promise<HeadlessResult>` uses the canonical
  gateway bootstrap/submit protocol; it never imports the TUI or owns an agent loop.
- `StartNodeBackendOptions.executionMode = review` disables all integration
  discovery and restricts local tool exposure to Read. The supervisor propagates
  this option and `reviewRevision` across the Worker boundary.
- `StartNodeBackendOptions.approvalMode = suspend` is set by exec/review and forwarded by the
  supervisor. Pending decisions can be recorded before exit 3; the next cold activation interrupts
  that unanswered turn before accepting a new prompt. Interactive backends use live per-call
  approval scheduling, and client reattachment keeps the existing runtime's requests.
- `loadGitReviewContext` pins refs to commit ids, uses argv-safe read-only Git
  commands, includes nonignored untracked files, and rejects oversized context.
- `GitReviewReadTool` reads bounded blobs from the selected historical revision.

## Behavior

- Exec and review branch before the interactive TTY gate. Prompt input is bounded
  to 1 MiB; schema input to 64 KiB; final answers to 4 MiB. No real provider call
  is part of validation tests or evaluation listing.
- Root-to-cwd guidance, frozen run policies, provider retry ownership, durable
  session state, tool execution, and compaction use the ordinary runtime.
- Bootstrap must report a trusted workspace. Unknown trust, live pending
  decisions, active/recoverable work, approval, or clarification returns exit 3
  without submitting duplicate work or answering a decision.
- No headless approval flags bypass policy. Review's Read-only tool exposure is
  enforced before adapter dispatch, including unsupported provider tool calls.
  Extension discovery and hooks are disabled even for trusted workspaces.
- JSONL objects have `version: 1`. `exec.result` is the terminal command result;
  turn completion alone does not imply output-schema validation succeeded.
- Preserve provider usage; do not fabricate absent metrics. Do not project raw
  tool arguments, approval previews, question content, or startup exceptions.
- Human diagnostics go to stderr. Output files are replaced atomically only
  after schema validation succeeds. Validation is local, not constrained decoding.
- Timeouts use 124; SIGINT uses 130; SIGTERM uses 143. Supervisor startup is
  abortable and owns Worker termination. The session client releases all listeners
  and pending RPCs, and the command awaits bounded backend cleanup.
- Review's Git modes are combined worktree, merge-base-to-HEAD, or first-parent
  commit. Findings must use changed paths and bounded ranges from diff hunks.
  Empty changes return a successful empty report without backend startup.
- Evaluation fixtures live under tests/fixtures, are hash-checked, and run in
  temporary repositories/homes. Assertions remain outside the task workspace.
  The grader has no provider credentials and must report every expected check.
  All started subprocesses have timeout/output limits and group cleanup.

## Required Verification

- Unit: parser boundaries, stdin, provisional events, schema failure/file
  preservation, required interactions, failures, timeouts, and signals.
- Integration: real gateway and supervisor completion, layered prompt data,
  usage, interruption of historical approvals before a new prompt, and rejection of writes during
  review. Reattaching to a still-running service must preserve valid requests.
- Git: untracked/staged/unstaged files, deletion/rename, unborn/initial commit,
  historical reads, invalid refs, and excessive context.
- Evaluation: positive fake fixes, negative unchanged baselines, fixture drift,
  missing grader output, process limits, and provider-free listing.
- CLI catalog, help, completion, documentation, production build, packed entry,
  and repository quality gates must agree.
