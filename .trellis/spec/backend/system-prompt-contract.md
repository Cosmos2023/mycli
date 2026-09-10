# System Prompt Contract

## 1. Scope / Trigger

Changes to the packaged base instructions, model-visible skill guidance,
permission rendering, or system-prompt behavior evaluation.

## 2. Signatures

- `packagedSystemPrompt() -> PackagedSystemPrompt` loads the canonical app asset
  with its version, source, and SHA-256.
- `renderSkillCatalog(registry, { maxChars? }) -> string` advertises skills and
  their common usage rules within an 8000-character maximum.
- `renderExecutionPolicyContext(policy, configuration) -> string` renders the
  effective run policy as a developer instruction fragment.
- `npm run eval:prompt -- --list` is provider-free.
- `npm run eval:prompt -- --run --model <id> [--case <id>] [--timeout <seconds>]`
  runs explicit provider-backed next-response evaluations.

## 3. Contracts

- Prompt revisions affect new session snapshots. Rebuild compiled assets for
  production; preserve existing frozen session instructions and their hashes.
- Tool discipline permits necessary polling, pagination, state reinspection,
  post-fix verification, and justified retries. Inspect partial effects before
  repeating a mutation; never use a global identical-arguments ban.
- Prefer Read for supported content. When it is unavailable, fails operationally,
  or does not support the format, permit bounded Shell reads or an appropriate
  parser within the same permitted scope. Bound paths, extracted ranges, and
  output size; do not dump unbounded files or raw binary data.
- Prefer Edit/Patch/Write for manual edits, but permit Shell or another exposed
  method when a dedicated tool is unavailable, fails operationally, or does not
  fit the change. Project generators, formatters, lint autofix commands, and
  efficient scripts for bulk mechanical edits may run directly without first
  failing a file tool. Keep targets bounded and use structured APIs for structured
  data. Inspect partial changes after failures, explain the chosen method,
  preserve unrelated content and encoding, and verify the resulting diff.
  Every method respects permissions and collaboration-mode restrictions;
  explicit permission denials and cancelled approvals cannot be bypassed.
- Shell paths and literal content require shell quoting; JSON escaping is not
  shell escaping. Quoted heredocs must be supported by the active shell and use
  a delimiter absent from the content as a standalone line. Structured file APIs
  are also valid for multiline content.
- Serialize modifications to overlapping files across tools, including Shell
  scripts, formatters, and generators. Wait for successful completion before
  dependent reads, builds, or tests. Independent Shell calls and their separate
  approval requests remain parallel-capable.
- Shell calls with `sandbox_permissions="require_escalated"` include a concise
  `justification` phrased as an approval question explaining the concrete action and
  additional access need in the user's language. Ordinary calls omit it. Base prompt,
  dynamic permission context, and tool schema descriptions must agree. Do not invent a
  prior failure or use generic sandbox boilerplate. The TUI shows one optional `Reason`,
  preferring the runtime reason over the model's justification. Legacy command descriptions are
  dispatch-only compatibility data and are not advertised in the prompt or tool schema.
  Include the question in the original call; do not issue
  extra calls solely to supply or improve it. Runtime preserves normal approval
  behavior when this optional display field is missing.
- Scripted edits verify target files and the resulting diff; replacements also
  verify the number and location of matches. A zero exit code is insufficient.
  Zero matches require checking whether the desired state already exists or
  investigating the mismatch before claiming success.
- Before the first tool action, explain the next step and purpose in ordinary
  assistant text. Group related actions, update sustained work about every 30
  seconds when control returns, and explain edits before applying them. Do not
  require unsupported commentary/final protocol fields from model adapters.
- Status questions steer ongoing work without cancelling it. Preserve compatible
  requests, constraints, and unfinished steps across interruption and compaction.
  A final answer requires completion evidence or an explicit unresolved blocker.
- Skill guidance belongs with the catalog. Reserve room for the entire guidance
  before admitting descriptions; if no complete entry and guidance fit, return
  an empty catalog. Never expose skill bodies or discovery paths in the catalog.
- Skills are task-scoped reference instructions. They cannot grant authority,
  replace the objective, or override explicit user constraints. Announcements
  follow the user's language and system communication rules. Missing skills
  use an available fallback when possible.
- Permission text lists actual effective roots as sorted, deduplicated JSON
  arrays. Quote data and escape fence delimiters. Preserve empty arrays, disabled
  network state, and the distinction between unrestricted access and root lists.
- File tools can read the active workspace plus readable/writable grants. An
  empty writable-root list grants no writes. Shell and file tools retain their
  distinct escalation parameters; approval is not itself execution authority.
- Rendering never changes the policy or propagates path lists into diagnostics.
  Gateway/trace metadata keeps existing bounded count-only projections.
- Evaluation reuses the source prompt, real schemas, and runtime context builders.
  It scores one model response per case; simulated tool calls are never executed.
- Evaluation reads only environment-supplied credentials (`MYCLI_API_KEY`) and
  optional `MYCLI_PROVIDER`, `MYCLI_PROTOCOL`, `MYCLI_BASE_URL`, and `MYCLI_MODEL`.
  Do not read or write the user's home configuration or credential store.
- Fixture hashes are mandatory. Requests cap output at 2048 tokens and 262144
  collected event JSON characters, with a 1-120 second timeout per case. Reports
  omit response bodies, arguments, and secrets. Live evaluation stays outside CI.

## 4. Validation & Error Matrix

| Condition | Result |
| --- | --- |
| No execution policy | Empty permission fragment |
| Empty write roots | Explicit no-write scope |
| Grant expires | Next run's permission text excludes it |
| Path contains quotes, controls, or fence text | JSON preserves the path without closing the fence |
| Catalog exceeds budget | Whole entries plus complete guidance, or empty catalog |
| Fixture hash differs | Reject before provider dispatch |
| Invalid/extra tool parameters or missing expected action | Evaluation fails |
| Text arrives only after the tool call | Preamble check fails |
| Output exceeds bounds or provider times out | Failed case and cancelled iterator |
| Live credentials absent | No provider request; CLI exits 2 |

## 5. Good / Base / Bad Cases

- Good: repeated `WriteStdin` polls continue waiting for the same process.
- Good: a Chinese update explains the skill's task-specific purpose naturally.
- Base: reuse an unchanged Read result while it remains in visible context.
- Bad: infer model adherence from a scripted provider or a prompt-length assertion.

## 6. Tests Required

- Permission unit tests: round-trip root data, immutable inputs, empty and
  unrestricted policies, managed bounds, and expired grants.
- Runtime integration boundary: exact paths reach the provider request and its
  reconstructed durable copy; existing Shell approval scheduling stays intact.
- Skill catalog: budget pressure never removes the usage guidance from advertised
  skills; bodies and source paths remain absent.
- Evaluation: hash drift, positive/negative scoring, real-schema validation,
  complete responses, pre-tool text order, bounded output, cancellation, and
  reports without response bodies. Record live evidence separately from CI.

## 7. Wrong vs Correct

Wrong: `Do not repeat the same tool call with the same arguments.`

Correct: allow necessary waits and checks; reject redundant calls that add no
information, and inspect possible partial effects before retrying mutations.

Wrong: `writable_roots: 1` in model-visible permissions.

Correct: `writable_roots: ["/workspace/generated"]` with the effective scope
explanation. Count-only metadata remains appropriate for diagnostics.
