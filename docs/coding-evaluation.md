# Coding Evaluation

The versioned corpus in `tests/fixtures/coding-evaluation/` measures three small
coding workflows: inclusive-range repair, a shared normalization contract, and
three-level AGENTS guidance. Every task JSON file is pinned by SHA-256 in the
manifest. These are initial regression tasks, not a comprehensive measure of
coding quality or evidence that mycli matches another agent.

```bash
npm run build
npm run eval:coding -- --list
npm run eval:coding -- --run --model <model> --output results.json
npm run eval:coding -- --run --task layered-guidance --json
```

Listing never starts a provider. Live runs require explicit `--run` and an
environment-provided `MYCLI_API_KEY`; `MYCLI_PROVIDER`, `MYCLI_PROTOCOL`, and
`MYCLI_BASE_URL` select a compatible provider. Credentials are not accepted in
argv or included in reports. A task defaults to 120 seconds, configurable with
`--timeout` up to 3600 seconds. Live calls may incur provider charges and are
never part of `npm test`.

Each task receives a new temporary Git repository and home directory. The runner
trusts only that temporary task cwd, supplies fixture files and the public
prompt, then invokes `mycli exec --json -`. Existing user configuration is not
copied. The nested-guidance task starts in `backend/service` so its ancestors
must be discovered from the Git root. Workspaces and homes are removed after
the attempt, including failures and cancellation. The source repository and
user trust store are not modified.

For another agent, `--agent-command <file>` accepts a JSON argv array, for example
`["/absolute/path/to/agent", "exec", "--json", "-"]`. It runs directly without a
shell, receives the task on stdin, and uses the isolated cwd/home. Configure that
agent through its supported environment variables; an existing home credential
store is not inherited. Use identical task ids, corpus hashes, and timeouts for
comparisons. Tool and token metrics are available only for recognized JSONL
events; absent usage is unknown rather than zero.

The runner scores exported behavior and JSON artifacts using assertions held
outside the agent workspace. AGENTS files are also checked for modifications.
A grader runs in its own bounded subprocess without provider credentials and
must return every expected check with a per-run token; an early successful exit
does not pass. This protects against accidental grader termination, but is not
a security sandbox for hostile generated code. Run untrusted agent commands in
an OS-isolated environment.

Reports contain task success, check results, duration, exit code, interaction and
tool counts, and provider-reported usage when available. They exclude prompts,
agent stdout/stderr, and secret values. Exit codes are `0` when every task passes,
`1` for scored failures, `2` for runner/input errors, and `130` for interruption.

Deterministic repository tests run the corpus against unchanged fixtures and a
fake fixing agent. They verify scoring, hash drift, timeout/output bounds, and
missing grader results without contacting a model.

## System Prompt Behavior

`eval:prompt` evaluates the next model response to seven fixed conversation
scenarios: an initial preamble, repeated Shell polling, a status question during
unfinished work, independent Shell approval requests, a missing skill, a natural
Chinese skill announcement, and an already granted write directory.

```bash
npm run eval:prompt -- --list
npm run eval:prompt -- --run --model <model>
npm run eval:prompt -- --run --model <model> --case repeated-shell-wait
```

Live runs require `MYCLI_API_KEY`; `MYCLI_PROVIDER`, `MYCLI_PROTOCOL`, and
`MYCLI_BASE_URL` optionally select the provider. The runner does not read the
user's configuration or credential store. It uses the current source prompt,
real tool schemas, runtime permission rendering, and skill catalog instructions.
Each selected case makes one bounded provider request, with a 45-second default
timeout (`--timeout` accepts 1-120 seconds) and at most 2048 output tokens.

All paths, conversation history, and tool results are synthetic. Proposed tool
calls are validated and scored but never executed. Reports contain case ids,
check outcomes, durations, model identity, and prompt/corpus hashes; they exclude
response text, tool arguments, and credentials. The corpus is pinned in
`tests/fixtures/system-prompt-evaluation/manifest.json`. Listing is provider-free.

Checks require the expected next actions with schema-valid arguments, a completed
response, and, where applicable, text before tool calls in the user's language.
These are narrow behavioral checks, not a full language-quality assessment or
an end-to-end TUI/approval test. The existing Shell integration suite covers
approval scheduling. Deterministic scorer tests use scripted responses and do
not establish that a live model follows the prompt. Live results are separate
from `npm test`, may incur provider charges, and apply to the tested model only.

The packaged prompt is now `2026-09-codex-style-base-v16`. Rebuild and restart
mycli, then create a new session to use the updated base instructions. Existing
sessions retain their frozen instruction snapshot; they are not rewritten.

For a Shell call with `sandbox_permissions="require_escalated"`, the model includes
`justification` as an approval question in the user's language, explaining the concrete
action and additional access need. Ordinary Shell calls omit it. The approval UI shows
one optional `Reason`: the runtime reason takes precedence, followed by the model's
justification. Neither available means no reason line. Normal approval proceeds without
an extra model request to supply the reason.

The base prompt prefers Edit/Patch/Write for manual file changes. If a dedicated
editing tool is unavailable, fails operationally, or does not fit the change,
the model may use Shell or another available method. Project generators,
formatters, lint autofix commands, and efficient scripts for bulk mechanical
edits may run directly without a failed file-tool attempt first. Keep targets
bounded, use structured APIs for structured data, inspect possible partial
changes after failures, and verify the resulting diff. Every method preserves
the active mode, permissions, and approval decisions.

Read is preferred for supported files. If it is unavailable, fails operationally,
or does not support the format, bounded Shell reads or an appropriate parser are
allowed within the same permitted scope. Limit paths, extracted ranges, and
output size; do not dump unbounded files or raw binary data.

Literal content passed through Shell requires shell quoting; JSON escaping is
not sufficient. Multiline content may use a supported quoted heredoc with a
non-colliding delimiter or a structured file API. Serialize modifications that
target overlapping files, then wait for completion before dependent reads,
builds, or tests. Independent Shell commands and approval requests retain their
parallel behavior. Scripted edits must verify target files, replacement matches,
and the actual diff, not just a zero exit code. Zero matches require checking
whether the desired state already exists or investigating the mismatch before
claiming success.
