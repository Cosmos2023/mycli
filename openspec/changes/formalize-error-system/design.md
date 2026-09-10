## Context

This change implements the following cross-layer error contract. The motivating
limitations below describe the system before this change.

The runtime has 17 broad `RuntimeErrorCode` values. Tools also use free-form
`errorKind`, gateway requests use independent string codes, and local exceptions
carry information that is not always transferred to those public envelopes.

The current path has several concrete inconsistencies:

- `contracts/src/gateway/runtime-errors.ts` and `diagnostics.ts` maintain separate
  recovery mappings. They disagree about `unsupported_capability`.
- `providers/src/errors.ts` intentionally separates internal `message` from
  `publicDetail`, but local capability guards often populate only the former.
  Their specific cause disappears during canonicalization.
- `runtime/src/workers/agent-worker-provider-rpc.ts` and the provider-attempt
  schema have closed failure shapes. Adding a field to `RuntimeFailure` alone
  does not propagate it through the system.
- Committed terminal events, transcript display records, gateway notices, and
  TUI replay have independent projection steps. A presentation-only fix misses
  persisted failures and retry history.
- A gateway admission rejection proves that a request did not start. A lost
  gateway connection after admission does not prove that the work failed or
  that Shell commands had no effects.

The motivating image incident crossed all these boundaries: `view_image`
successfully produced a PNG, it entered history, and the next provider step
rejected image input locally for the text-only `deepseek-v4-flash` model. The
display suggested validating configuration instead of identifying the image
capability mismatch. Retrying the same history and model cannot correct it.

Constraints: retain Node/TypeScript package boundaries, canonical JSON Schema
and generated types, existing lifecycle/effect ownership, append-only history,
private diagnostics, and the current gateway flow-control protections. Add no
dependencies. TUI consumes contracts and gateway APIs, not backend modules.

## Goals / Non-Goals

**Goals:**

- Give each known failure an evidence-backed reason, stable identity, reporting
  source, operation scope, and explicit execution/effect outcome.
- Produce consistent public summaries, safe detail, recovery suggestions, and
  diagnostics from one reason catalog.
- Make automatic recovery depend on actual operation state and capabilities.
- Preserve the error through Worker boundaries, retries, durable terminal
  commits, live events, history loading, headless output, and TUI rendering.
- Prevent unsupported image-tool calls before IO and explain incompatible
  existing history without rewriting it.
- Make missing classification, unsafe recovery, schema drift, and duplicate
  presentation detectable in tests.

**Non-Goals:**

- A universal exception superclass, a new event bus, a new logging service, or
  replacing the existing turn/attempt/tool lifecycle state machines.
- Automatically repairing configuration, changing models, deleting images,
  relaxing sandbox policy, or replaying operations with uncertain effects.
- New TUI navigation, a general recovery scripting engine, additional provider
  calls to explain errors, or changes to the gateway batching fix.
- Treating an empty search result, a normal process exit, or a user decision as
  an internal runtime crash.

## Decisions

### 1. Add one typed context to existing error envelopes

Add `schemas/error-context.schema.json` and generated types in `contracts`.
Implement small modules under `contracts/src/errors/` for catalog metadata,
validation/redaction, legacy mapping, and public presentation. Existing exports
remain compatibility facades during migration.

The conceptual shape is below; JSON Schema owns the actual discriminated union,
including the exact `details` shape for each reason. This is not permission to
use an unbounded `Record<string, unknown>` in the new contract.

```ts
type FailureScope =
  | { readonly kind: "provider_attempt"; readonly id: string }
  | { readonly kind: "tool_call"; readonly id: string }
  | { readonly kind: "request"; readonly id: string }
  | { readonly kind: "turn"; readonly id: string }
  | { readonly kind: "session"; readonly id: string }
  | { readonly kind: "connection"; readonly id: string }
  | { readonly kind: "application"; readonly id: string };

interface FailureOutcome {
  readonly state: "not_started" | "failed" | "cancelled" | "completed" | "unknown";
  readonly effects: "none" | "possible" | "confirmed";
}

type ErrorOccurrenceV1 = ErrorReasonDetails & {
  readonly id: string;
  readonly source: FailureSource;
  readonly scope: FailureScope;
  readonly outcome: FailureOutcome;
};

type ErrorContextV1 = ErrorOccurrenceV1 & {
  readonly version: 1;
  readonly causes?: readonly ErrorOccurrenceV1[];
};
```

`ErrorReasonDetails` is a union such as
`{reason: "capability.image_input_unsupported", details: {model, input_origin}}`.
`input_origin` distinguishes `user`, `tool`, and `history`; model identifiers are
bounded and sanitized. Reasons without useful parameters omit `details`.

`FailureSource` identifies the boundary that first classified the occurrence:
`config`, `provider`, `tool`, `policy`, `integration`, `worker_rpc`, `runtime`,
`storage`, `gateway`, or `tui`. A reporting source is not a claim about fault;
for example a local provider guard can report a capability failure without
sending an HTTP request.

The scope identifies the operation whose outcome is described. It is not
overwritten by intermediate transports. Its ID is the existing attempt, call,
RPC occurrence, turn, session, or connection identity. Parent ownership remains
in the existing envelope. A turn can therefore fail with a provider-attempt
context while retaining its own terminal lifecycle identity.

`state` describes the scoped operation. `completed` covers a completed operation
whose result could not be delivered; it does not mean that the error envelope
is a success. `effects` concerns requested filesystem/process/external effects,
not the fact that a model request consumed tokens. `not_started` requires
`effects=none`. A failed/cancelled operation can have confirmed partial effects.
Missing execution evidence is `unknown`, not an inferred `not_started`.

Create the error ID once at classification and preserve it through conversions.
Retries have separate attempt/error IDs. A distinct aggregate failure such as
retry exhaustion gets its own ID and retains the last concrete failure in
`causes`. This array contains at most three non-recursive snapshots, ordered
from immediate cause toward the root; if longer, preserve the immediate and
root causes and record a bounded omitted count in wrapper details. Do not embed
stacks, whole attempts, or arbitrary exception chains.

Use `errorContext` on internal `RuntimeFailure` and tool adapter/results, and
`error_context` at existing snake-case gateway/result/metadata boundaries. The
nested context is the same schema everywhere, without renaming its fields.
Existing `code`, `errorKind`, `retryable`, and JSON-RPC `error.code` remain for
compatibility. Category, severity, rendered text, and recovery choices are
derived; they are not additional competing identity fields.

Alternative: replace every exception and envelope with one large `AppError`.
Rejected because it would merge request, tool, and turn ownership and cause an
unnecessary migration of successful paths.

### 2. Use a reason catalog with evidence and compatibility mappings

Each registered reason owns its public summary, allowed detail schema,
diagnostic category, default presentation severity, supported operation scopes,
recovery candidates, and mappings to applicable legacy boundary codes. The
catalog is exhaustive over generated reason types. No independent per-package
message or recovery switch is added.

Initial coverage follows existing emitters. The examples below establish the
names and distinctions; implementation inventory must account for every known
emitter, including explicit generic fallbacks where evidence is insufficient.

| Domain | Initial reasons | Evidence / important distinction |
| --- | --- | --- |
| Configuration | `config.invalid`, `config.model_unavailable` | Validated configuration/catalog result, not arbitrary exception text |
| Authentication/access | `auth.credentials_missing`, `auth.credentials_rejected`, `auth.model_access_denied` | Missing credential, structured auth rejection, or explicit account access result |
| Capability | `capability.image_input_unsupported`, `capability.tool_calls_unsupported`, `capability.hosted_search_unsupported`, `capability.reasoning_unsupported`, `capability.deferred_response_unsupported`, `capability.auth_flow_unavailable`, `capability.unspecified` | Separate model input, protocol behavior, and unavailable authentication flows |
| Provider/request | `provider.invalid_request`, `provider.context_limit`, `provider.rate_limited`, `provider.quota_exceeded`, `provider.overloaded`, `provider.service_failed`, `provider.tool_protocol_invalid`, `provider.failure_unclassified` | Preserve current status/code/type precedence and bounded provider evidence |
| Transport | `transport.connect_failed`, `transport.timed_out`, `transport.stream_interrupted`, `transport.gateway_disconnected`, `transport.output_stalled` | Preserve transport cause, operation phase, and source; do not infer admission from a lost reply |
| Gateway/request | `gateway.admission_rejected`, `gateway.output_capacity_exceeded`, `gateway.message_too_large`, `gateway.protocol_incompatible`, `gateway.invalid_request`, `gateway.state_conflict`, `gateway.failure_unclassified` | Inbound admission pressure differs from failure delivering accepted work |
| Tool/file/process | `tool.invalid_arguments`, `tool.not_found`, `tool.path_not_found`, `tool.path_unreadable`, `tool.image_invalid`, `tool.image_decoder_unavailable`, `tool.process_start_failed`, `tool.process_exited`, `tool.timed_out`, `tool.failure_unclassified` | Nonzero exit and timeout retain process/effect status and are normally tool-local |
| Policy/sandbox | `policy.approval_denied`, `policy.access_denied`, `policy.sandbox_unavailable`, `policy.sandbox_initialization_failed` | User rejection, policy decision, unsupported platform, and startup failure are different |
| Storage/session | `storage.busy`, `storage.capacity_exceeded`, `storage.write_failed`, `storage.data_invalid`, `storage.version_unsupported`, `storage.session_unavailable`, `storage.failure_unclassified` | Distinguish failed durable commit from failed readable projection |
| Runtime/lifecycle | `runtime.user_cancelled`, `runtime.interruption_unspecified`, `runtime.worker_exited`, `runtime.retry_exhausted`, `runtime.tool_budget_exceeded`, `runtime.continuation_unavailable`, `runtime.effect_outcome_unknown`, `runtime.internal_error` | Cancellation and an uncertain effect are not generic provider failures |
| Integration/client | `integration.unavailable`, `integration.protocol_invalid`, `integration.failure_unclassified`, `tui.render_failed`, `tui.terminal_unavailable` | Extension failures stay at their owning boundary; TUI fatal reporting remains outside conversation state |

Adapters classify structured evidence before rendering. Preserve current
provider precedence, including context overflow before invalid request, quota
before rate limit, and overload before generic service errors. Known local
guards supply typed reasons directly. Keep the existing narrowly documented
SDK compatibility fallbacks; do not expand classification by matching arbitrary
error sentences.

Every existing runtime code and every known tool/gateway code gets an explicit
legacy mapping or documented fallback in a checked coverage fixture. A legacy
`unsupported_capability` alone maps to `capability.unspecified`; it does not
prove an image mismatch. An old `interrupted` alone does not prove the user
pressed Ctrl+C. Retain legacy scope identities when deriving deterministic
display IDs; never hash rendered text to merge separate failures.

Alternative: add many new values directly to `RuntimeErrorCode`. Rejected as
the primary mechanism because classification count alone would not preserve
causes, solve recovery contradictions, or cover tool/RPC errors.

### 3. Keep recovery decisions with the operation owner

Contracts define recovery IDs, labels, and required inputs. Runtime supplies a
pure resolver with current state: committed lifecycle, attempt budget, tool
effect ledger, input compatibility, pending operation ownership, and available
capabilities. Gateway and TUI only expose the resulting supported choices;
executing a choice revalidates its preconditions through existing handlers.

Existing recovery IDs are reused. Add only needed actions with concrete
destinations, notably `select_compatible_model` through `/model` and
`inspect_execution` through existing status/Shell inspection. A client lacking
the handler gets text guidance, not a clickable no-op or a made-up command.
Action metadata cannot contain arbitrary executable Shell supplied by a model
or remote error body. Explaining an error requires no extra provider call.

| Situation | Owning recovery behavior |
| --- | --- |
| Provider connection fails before executable output is accepted | Existing bounded request retry if eligible |
| Provider stream fails after partial text, without dispatched effects in that attempt | Existing rollback and stream retry if eligible |
| Rate limit / overload | Respect capped delay and request/stream budgets; render retry activity until exhausted |
| Credentials, quota, invalid input, capability mismatch | User correction; no identical automatic retry loop |
| Gateway explicitly rejects before admission | Request-local notice; accepted turn remains unchanged; any retry uses the same request identity |
| Gateway disconnects after submission | Reconcile accepted turn/Shell state using existing APIs before offering resubmission |
| Ordinary recoverable tool failure | Return one bounded tool result to the model and keep the agent loop running |
| Tool timeout or Worker loss after possible effects | Inspect committed effects/Shell state; no automatic command replay |
| Storage commit fails | Report persistence uncertainty; do not claim a committed terminal turn |
| Readable projection fails after terminal commit | Report the projection problem without replacing the committed turn outcome |
| User cancels during retry or execution | Cancel retry timers; use interrupted lifecycle, with uncertain effects retained separately |

`retryable` is compatibility evidence, not sufficient authority to repeat an
operation. A provider-attempt `effects=none` does not mean earlier tools in the
turn had no effects. The resolver also checks the enclosing turn's ledger and
reuses completed tool results. It never replays the entire turn just because
the final model request is retryable. Read-only/idempotent recovery can proceed
only when the operation contract establishes it, within existing retry budgets.

When retry budgets run out, the final summary includes the retained reason,
for example `Provider retry budget exhausted: connection timed out.` It does
not discard the last failure in favor of only `retry_exhausted`.

Alternative: derive actions solely from broad codes in the TUI. Rejected
because the TUI cannot establish whether the backend already executed a tool.

### 4. Preserve identity and lifecycle through durable boundaries

Update failure transfer as one vertical path:

```text
boundary classifier -> runtime/tool result -> Worker RPC
  -> attempt/effect record -> atomic terminalization and lifecycle outbox
  -> gateway event or transcript load -> shared public projection
  -> TUI / headless
```

Failures do not all become failed turns. Request handlers reject one RPC;
tools return failed results; the runtime owns turn finalization. Only the
existing terminalization owner can publish a committed terminal outcome. It
stores the same validated context in the turn result, lifecycle outbox, and
display metadata in its current transaction. Tool contexts travel with durable
tool results and completed effect attempts. Attempt contexts use the existing
attempt ledger. No separate error table or global error queue is needed.

Wrappers preserve the incoming context unless a distinct failure occurs. If
persistence of an original failure itself fails, the storage error retains
the original as a bounded cause and uses the existing emergency diagnostic
path. It must not recursively attempt to persist its own persistence error or
overwrite a previously committed outcome.

Gateway disconnect diagnostics preserve the first causal backend failure
through supervisor cleanup; a subsequent pipe-close error is secondary. A
connection notice is resolved by authoritative state after reconnection, not
converted into an invented failed turn. A local TUI rendering failure restores
the terminal through the existing fatal path and never mutates session history.

Alternative: store only rendered error sentences. Rejected because replay
would lose classification and make future recovery depend on parsing text.

### 5. Share public projection while keeping live recovery current

One contracts formatter supplies the headline, bounded concrete detail,
severity, and diagnostic identity. One recovery resolver supplies suggestions.
The old hint helpers delegate to this path during migration and are removed
from active consumers once callers are migrated.

Default TUI presentation is a concise summary with at most two useful detail
or recovery lines. Technical reason/source IDs belong in the existing details
view and private log. Keep clear error/warning markers in addition to color,
fit the actual content width, and reuse the existing transcript gutter and
notice components. Do not create nested error cards or a new modal workflow.

Illustrative messages, using the app's current English UI:

```text
The selected model cannot read images.
  Model: deepseek-v4-flash. This conversation contains a tool image.
  Select a model with image input. (/model)

Runtime connection lost.
  The last operation's outcome has not been confirmed.
  Check session and Shell status before submitting it again.

Shell could not start its sandbox.
  macOS rejected sandbox initialization. The command did not start.
  Check sandbox availability. (mycli doctor)
```

These details are emitted only when evidence supports them. A generic
disconnect cannot claim no command started, and `Operation not permitted`
alone is not enough to classify a sandbox initialization failure.

Live and restored views keep the same summary, cause, original model, scope,
and occurrence identity. Recovery choices are reevaluated against current
state, so switching models can change the available action without rewriting
the historical error. A retry timer is transient and does not append a final
failure on each redraw. Terminal notice deduplication retains the existing
turn identity; request notices use occurrence identity, never message text.
Ctrl+C cancellation is one interruption notice, not a second generic failure
plus `Retry cancelled` plus an artificial completion line.

Alternative: freeze actionable buttons in persisted text. Rejected because a
restored session may have different model capability, permissions, or ownership.

### 6. Enforce image capability at exposure and dispatch

Resolve the effective model capabilities once in the frozen turn configuration
and use that same result for provider preflight, tool schema exposure, and tool
execution options. Reconcile the current `supportsImages`, pi-ai model inputs,
and `imageDetailOriginalSupported` paths deliberately; unknown metadata must
not be advertised as positive capability by a UI-only default.

- Do not expose `view_image` when the selected model cannot accept images.
- Also validate required capability during dispatch, including stale catalog
  calls and resumed approvals. Return a failed tool result with
  `capability.image_input_unsupported` before file read/decoding or image
  attachment. Do not rely solely on hiding the tool definition.
- Keep original-detail fallback to high when image input is supported; lack of
  original detail is not lack of image input.
- Preserve provider preflight for incompatible user attachments and existing
  image-bearing history. Return the concrete capability reason before provider
  IO and offer explicit compatible-model selection. Do not drop image blocks,
  change the selected model automatically, or change accepted user history.
- An MCP/plugin tool can return images conditionally after execution. If its
  capabilities were not knowable before dispatch, preserve the result and
  effects; use the provider preflight with the same precise reason. Do not
  turn an already executed operation into a claimed pre-dispatch rejection,
  silently discard its images, or automatically execute it again.

Update `.trellis/spec/backend/multimodal-input-contract.md` during implementation:
its current provider-only tool-image failure rule becomes early rejection for
known image tools plus the retained provider safeguard for historical/dynamic
images. This is an intentional behavioral change, not just a message change.

Alternative: catch the provider error and hide the image. Rejected because
that alters the model's evidence and can misrepresent completed tool output.

### 7. Define compatibility before writing enriched records

**Existing histories:** New readers accept records without an error context.
They derive conservative legacy presentation, without inventing a specific
cause or replay safety. Do not backfill or rewrite transcript events.

**Durable new writes:** Update all closed parsers before enabling the writer,
including provider-attempt failure, lifecycle payload, runtime-state snapshots,
tool/effect replay, and terminalization. Use the next database schema version
as a format fence before writing enriched payloads, even if storage stays in
existing JSON columns. Older binaries must reject that database at version
inspection before parsing or modifying new records. This is a small forward
migration, not a claim of backward readability. Version independently exported
closed snapshots when their shape changes. Test the previous reader's refusal
on a temporary database. Preserve normal backup/dry-run migration behavior.

**Gateway:** Retain protocol version 1 for the legacy envelope. Negotiate the
optional context extension with `supported_error_context_versions: [1]` in
bootstrap/initialize and `error_context_version: 1` in the reply. Absence means
legacy projection. Emit enriched events, RPC errors, and transcript/attempt
pages only after selection, and omit the extension for legacy clients at every
nested location. Pre-handshake failures use the legacy envelope. Verify that
the previous backend accepts the optional request field; on an explicit
unknown-parameter rejection before bootstrap succeeds, retry only the handshake
without that field. A timeout or lost connection is not permission to replay
submitted work.

**Workers:** The provider Worker protocol is version checked and its failure
parser is closed. Upgrade the same-release sender/receiver together and bump
the existing Worker protocol version. Reject a stale Worker before provider or
tool dispatch with a typed protocol error; do not retry incompatible work.

**Unknown optional context:** Producers validate against the strict known
schema. Consumer adapters extract and bound the optional context before
validating the legacy envelope. Unsupported versions/reasons or invalid
optional detail produce generic presentation with no speculative recovery;
record a safe validation diagnostic. Do not reject an otherwise valid terminal
event just because its optional error extension cannot be displayed. Invalid
authoritative lifecycle/ownership fields still fail validation normally. The
same policy applies to display of persisted optional context; it does not
rewrite the record or authorize replay.

**Version evolution:** Reason schemas are closed. New reason sets or incompatible
detail changes require a new context version and explicit downgrade mapping;
existing reason strings retain their meanings. New code emits a supported
older generic reason when negotiation selects an older context version.

Implementation uses database format 14 and Worker protocol 2. No closed
runtime-state payload needs a new field: errors reside in attempts, effects,
terminal results and lifecycle/display metadata. Independently exported
transcript snapshot v2 already has extensible metadata and keeps its version;
its reader validates optional contexts before degraded recovery. Runtime store
opening follows the existing transactional v12/v13 upgrade convention without
creating an automatic backup. User rollback guidance explicitly requires a
consistent pre-upgrade backup. Safe scope IDs remain exact; unsafe or oversized
opaque IDs are hashed by `failureScope()` instead of causing error reporting to
throw another identity-validation failure.

Rollback means disabling new context emission and using the prior presentation
on the new reader. Once enriched durable writes exist, rolling the executable
back requires a matching pre-migration backup or a separately reviewed export;
do not reset database version numbers or erase errors to force compatibility.

Alternative: assume an optional TypeScript field is universally compatible.
Rejected because closed Worker, attempt, and lifecycle validators disprove it.

### 8. Bound safe context and make coverage a maintenance gate

Use reason-specific allowed properties, not a blacklist-only sanitizer. Public
summary comes from catalog text, never raw exception text. Public remote detail
continues through the existing sanitizer and 1,000-character limit. Safe IDs
are limited to 256 characters; HTTP status, errno, sizes, exit status, and retry
delay have typed numeric/token bounds. Cap the entire encoded context including
causes at 8 KiB. Oversized/untrusted fields are omitted with a safe diagnostic;
they must not cause a second user-facing serialization failure.

Never copy provider bodies, headers, environment dumps, commands, file contents,
base64, stack traces, or private absolute paths into public context. The normal
tool record remains the place for the authorized command preview. Private
diagnostics can retain bounded technical stack frames after secret/path
redaction, but are not a permission to log raw requests or credentials.

CI validates schema generation, complete registry metadata, legacy coverage,
reason-specific redaction, recovery preconditions, and shared serialized
fixtures consumed by backend and TUI. Source inventories must identify emitter
locations; an unexplained fallback for a known typed error is a coverage failure.
Unknown external errors intentionally map to a generic reason and are counted
in existing diagnostics so the catalog can grow from evidence.

Alternative: an exhaustive enum with no boundary tests. Rejected because an
exhaustive formatter cannot detect dropped fields or misclassified SDK events.

## Risks / Trade-offs

- Cross-layer propagation can drop a field -> land schema/reader changes first
  and verify one failure end to end before migrating all emitters.
- A growing catalog can become a renamed list of exceptions -> add a reason
  only when it changes explanation, ownership, recovery, or useful diagnosis;
  retain generic fallbacks for unknown external evidence.
- Legacy errors lack outcome evidence -> use unknown outcomes and read-only
  inspection guidance instead of guessing or silently replaying effects.
- Capability catalogs can conflict with effective provider settings -> resolve
  once per frozen turn and test tool exposure, dispatch, and provider preflight
  against the same resolved configuration.
- Recovery can become stale between rendering and selection -> validate the
  action again in the owning backend handler with current session generation.
- Database failure can prevent durable reporting -> use one bounded emergency
  report; do not advertise live/replay equivalence for an uncommitted failure.
- Added JSON can increase gateway pressure -> cap contexts and causes, send
  them on failure/state records rather than every text delta, and preserve
  existing queue/drain limits and lossless notification batching.
- Older binaries cannot parse every new durable shape -> enforce the format
  fence and document rollback limits before enabling enriched writes.

## Migration Plan

1. Inventory known emitters and baseline fixtures; implement contracts, registry,
   legacy mappings, strict producer validation, and tolerant optional readers.
2. Upgrade Worker transport, storage readers/format fence, gateway negotiation,
   and public projections while enriched writers remain disabled.
3. Implement runtime recovery resolution and migrate the capability-image path
   as the first complete classification-to-live/replay regression.
4. Migrate provider retries, tool/policy outcomes, gateway/Worker incidents,
   storage/config/integration errors, and existing CLI/TUI fatal reporters.
5. Switch active consumers to the shared formatter/resolver; remove competing
   mappings and temporary rollout branches once compatibility tests pass.
6. Update contracts and user documentation, run relevant regression suites and
   required repository checks, then enable enriched writes for the new format.

Each step is bounded by its task checklist. Implementation is complete only
after live and restored error presentation, replay safety, and mixed-version
fixtures pass, not merely after adding the catalog.

## Open Questions

No user decision blocks this design. Two implementation checks must be settled
before enabling writers: the exact next database format version after concurrent
work, and previous-release bootstrap behavior for optional fields. Both have
defined fallback behavior above and must be tested on isolated fixtures.
