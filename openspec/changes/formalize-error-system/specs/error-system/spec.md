## ADDED Requirements

### Requirement: Shared structured error context

The system SHALL define a versioned error context in canonical JSON Schema and
generate its TypeScript types. A context MUST contain an occurrence ID, a
registered concrete reason, the original reporting source, a typed operation
scope with identity, and an execution/effect outcome. Reason-specific details
and bounded non-recursive causal snapshots SHALL follow the same contract
across runtime, tools, Workers, storage, gateway, and presentation boundaries.
Existing runtime codes, tool error kinds, and RPC error codes SHALL remain
available as compatibility fields.

#### Scenario: A failure crosses multiple adapters

- **WHEN** a classified provider failure passes through Worker RPC, runtime terminalization, the gateway, and TUI projection
- **THEN** its occurrence ID, reason, source, scope, outcome, and safe details SHALL survive unchanged
- **AND** intermediate wrappers SHALL NOT replace its source with their own merely because they transported it

#### Scenario: A failed operation has partial effects

- **WHEN** a Shell operation fails after making a confirmed filesystem change
- **THEN** the context SHALL report a failed execution with confirmed effects
- **AND** failure status SHALL NOT imply that no work occurred

### Requirement: One reason catalog owns public definitions

The system SHALL maintain one exhaustive catalog for supported reasons,
reason-specific detail schemas, public summaries, diagnostic categories,
presentation severity, allowed scopes, recovery candidates, and legacy
mappings. Active consumers MUST NOT maintain independent competing message or
recovery-hint mappings. A new reason MUST represent a meaningful explanation,
recovery, ownership, or diagnostic distinction.

#### Scenario: Image capability has one recovery definition

- **WHEN** `capability.image_input_unsupported` is rendered through any supported public surface
- **THEN** the explanation SHALL identify image-input incompatibility
- **AND** its recovery candidates SHALL include compatible-model selection when available
- **AND** it SHALL NOT recommend configuration validation as the default remedy for a known text-only model

#### Scenario: A catalog entry is incomplete

- **WHEN** a supported reason lacks a detail validator, public summary, recovery definition, or applicable legacy mapping
- **THEN** the contract coverage check SHALL fail

### Requirement: Classification uses structured evidence

Boundary classifiers SHALL use typed local guards and documented structured
SDK, HTTP, transport, process, policy, or storage evidence. Provider classifiers
SHALL preserve established context/quota/overload precedence and bounded
compatibility fallbacks. They MUST NOT infer new causes from arbitrary rendered
exception text. Unknown external failures SHALL use a registered generic reason
without inventing a specific cause or automatic recovery permission.

#### Scenario: Several errors share the same old runtime code

- **WHEN** image input, hosted search, reasoning configuration, or deferred responses fail a known local capability guard
- **THEN** each guard SHALL supply its corresponding concrete capability reason
- **AND** a legacy `unsupported_capability` value SHALL NOT erase that reason during normalization

#### Scenario: Only an old broad code is known

- **WHEN** historical data contains only `unsupported_capability` and a generic message
- **THEN** the reader SHALL use `capability.unspecified`
- **AND** it SHALL NOT claim that an image caused the failure

#### Scenario: Remote evidence distinguishes quota from throttling

- **WHEN** a structured provider response reports exhausted quota with a status also used for rate limiting
- **THEN** the classifier SHALL select the quota reason
- **AND** recovery SHALL require account correction rather than repeated cooldown retries

### Requirement: Public error context is bounded and safe

Public summaries SHALL come from the catalog. Public detail SHALL use allowed
reason-specific fields plus the existing sanitized remote-detail channel.
The encoded context MUST be at most 8 KiB, causal snapshots at most three,
identifiers at most 256 characters, and remote detail at most 1,000 characters.
Public context MUST exclude raw bodies, credentials, environment dumps, file
contents, command payloads, stacks, image bytes, terminal control sequences,
and private absolute paths. Private diagnostics SHALL also redact secrets and
bound technical data.

#### Scenario: A provider returns unsafe error content

- **WHEN** provider evidence includes an authorization value, local path, terminal escape sequence, or image data
- **THEN** public context and private diagnostic output SHALL omit or redact the unsafe material
- **AND** safe structured status and request identity SHALL remain available when valid

#### Scenario: Error detail exceeds its budget

- **WHEN** untrusted detail or a cause chain exceeds the context limits
- **THEN** the classifier SHALL emit a bounded context retaining the concrete reason and useful immediate/root cause information
- **AND** the oversize detail SHALL NOT cause a second user-facing serialization failure

### Requirement: Recovery depends on execution state

The operation owner SHALL resolve recovery using the reason, current
capabilities, committed lifecycle, retry budgets, and applicable tool effect
ledger. A legacy `retryable` flag alone MUST NOT authorize another execution.
Unknown outcomes SHALL be explicit. Automatic replay of possibly or confirmed
effectful operations MUST require an existing operation-specific idempotency or
recovery guarantee; otherwise the system SHALL offer inspection and await an
explicit user-directed continuation.

#### Scenario: A Worker exits after a Shell was dispatched

- **WHEN** no committed result proves whether a dispatched Shell completed
- **THEN** recovery SHALL report an unknown outcome with possible effects
- **AND** it SHALL NOT automatically execute the Shell command again
- **AND** it SHALL use available Shell/effect state to guide inspection

#### Scenario: Earlier tools completed before a model request failed

- **WHEN** a retryable provider attempt has no effects but earlier calls in the same turn have completed
- **THEN** recovery SHALL reuse the committed tool results
- **AND** it SHALL NOT replay the whole turn or those completed calls

### Requirement: Recovery actions are executable and revalidated

Recovery definitions SHALL reference supported action IDs and existing command
or inspection handlers. Client projections SHALL expose only supported actions
and SHALL use text guidance when an action has no handler. Execution MUST
revalidate current ownership, session generation, capabilities, and effect
state. Error explanation SHALL require no additional model invocation. An
error payload MUST NOT supply arbitrary executable commands.

#### Scenario: A recovery choice becomes stale

- **WHEN** a user selects recovery after switching sessions or after another operation changed the relevant state
- **THEN** the owning handler SHALL revalidate the request against current state
- **AND** it SHALL reject stale ownership without executing the old operation

#### Scenario: The UI supports model selection

- **WHEN** an image capability error offers compatible-model selection
- **THEN** it SHALL use the existing model-selection flow
- **AND** it SHALL NOT silently change the model or invoke another provider to generate an explanation

### Requirement: Retry lifecycle retains the concrete cause

Request and stream retries SHALL retain their existing bounded budgets,
backoff, interruption, and incomplete-output rollback rules. Retry exhaustion
SHALL preserve the final concrete attempt failure as a structured cause.
Transient retry activity MUST NOT create a durable failed-turn notice for each
attempt, timer tick, redraw, or unrelated keypress.

#### Scenario: Connection retries are exhausted

- **WHEN** all eligible retries fail with structured connection timeouts
- **THEN** the terminal error SHALL describe exhausted retries and retain the timeout reason, source, and final attempt identity
- **AND** replay SHALL show the same concrete cause

#### Scenario: A partial provider response can be retried

- **WHEN** a stream fails after partial text without dispatching effects in the incomplete attempt
- **THEN** runtime SHALL apply its stream-retry policy and rollback the incomplete visible attempt
- **AND** the retry SHALL NOT be treated as a fresh user message or successful completed turn

### Requirement: Tool and request failures retain local ownership

Recoverable tool errors SHALL be returned as bounded tool results without
automatically failing the enclosing turn. RPC rejection SHALL affect the
rejected request without terminalizing an already accepted unrelated turn.
Empty search results and ordinary successful tool outcomes SHALL NOT be
promoted into errors. Nonzero process exit SHALL retain exit/effect evidence
and remain tool-local unless the runtime encounters an independent fatal
condition.

#### Scenario: A read target does not exist

- **WHEN** a read tool receives a missing path
- **THEN** it SHALL return a failed tool result with `tool.path_not_found`
- **AND** the agent SHALL be able to correct the call within the current turn

#### Scenario: A stale approval request is rejected

- **WHEN** a gateway request targets an approval that is no longer pending
- **THEN** the request SHALL receive a state-conflict error associated with its occurrence
- **AND** the rejection SHALL NOT append a new user message or fail another active turn

### Requirement: Cancellation is distinct from system failure

Explicit user cancellation SHALL use the interrupted lifecycle and its own
reason, stop pending retry timers, and retain any uncertain tool effect state.
It MUST NOT be rendered as a provider configuration failure, successful
completion, or multiple terminal notices for the same turn. An interruption
without evidence of user cancellation SHALL retain an unspecified or specific
non-user cause.

#### Scenario: Ctrl+C cancels a retry delay

- **WHEN** the user interrupts a turn waiting for a provider retry
- **THEN** the retry timer SHALL be cancelled and one interruption notice SHALL be rendered
- **AND** no additional generic failure or successful completion record SHALL be created

#### Scenario: Historical interruption has no cancellation evidence

- **WHEN** replay loads only a legacy interrupted record
- **THEN** it SHALL preserve the interrupted lifecycle
- **AND** it SHALL NOT claim that the user pressed Ctrl+C

### Requirement: Gateway pressure distinguishes admission from delivery

Gateway errors SHALL distinguish rejected admission, outgoing capacity
exhaustion, message size violations, stalled output, protocol mismatch, and
connection loss. They SHALL retain existing bounded queue/drain behavior and
lossless notification batching. Missing replies MUST NOT be treated as proof
that a request never started. Supervisor cleanup SHALL preserve the first
causal diagnostic instead of replacing it with a secondary pipe closure.

#### Scenario: Capacity rejects a request before dispatch

- **WHEN** the gateway admission limiter explicitly rejects a new request
- **THEN** its context SHALL use `gateway.admission_rejected` with `not_started` and `none`
- **AND** accepted work SHALL retain its existing state

#### Scenario: The output queue fails while work is active

- **WHEN** the writer cannot deliver accepted work because its queue capacity or drain deadline is exceeded
- **THEN** the system SHALL retain the output-capacity or output-stall reason
- **AND** a disconnected client SHALL treat unconfirmed work as unknown until reconciled
- **AND** it SHALL NOT label that work as rejected before admission or automatically resubmit it

### Requirement: Durable terminal state owns final outcomes

The existing terminalization transaction SHALL commit the same validated
context to the failed turn result, lifecycle outbox, and display record before
projecting a committed terminal event. Tool/effect and provider-attempt records
SHALL retain their applicable contexts through their existing durable paths.
Each accepted turn SHALL have at most one authoritative terminal outcome.

#### Scenario: A client reconnects after commit but before notification

- **WHEN** a failure commits and the client disconnects before receiving its terminal event
- **THEN** transcript/state recovery SHALL restore the committed occurrence and concrete reason
- **AND** a later delivery of that same event SHALL NOT create another terminal notice

#### Scenario: A readable projection fails after completion

- **WHEN** the turn is durably completed but writing its readable projection fails
- **THEN** the system SHALL report the projection problem with the storage source and owning session identity
- **AND** it SHALL NOT change the completed turn into a failed or interrupted turn

### Requirement: Persistence failure has a bounded fallback

Failure to commit an error SHALL produce a storage failure retaining the
original cause in bounded form. The fallback MUST NOT recursively persist its
own persistence failure or claim that an uncommitted terminal outcome exists.
Existing private/emergency diagnostics SHALL be used when durable reporting is
unavailable.

#### Scenario: Storage rejects terminalization

- **WHEN** a storage failure prevents the original provider error from being committed
- **THEN** the report SHALL identify persistence failure and retain the original provider cause
- **AND** it SHALL distinguish the uncommitted outcome from a normal committed failed turn
- **AND** reporting SHALL terminate without a recursive persistence loop

### Requirement: Known image tools validate model capability before IO

The frozen turn's effective model capabilities SHALL consistently drive tool
exposure, required-capability validation during dispatch, and provider preflight.
`view_image` SHALL be absent when image input is unsupported. A stale, explicit,
or restored call MUST still fail locally before image read/decoding or image
attachment, with a recoverable tool result. Original-detail fallback SHALL
remain independent of general image-input support.

#### Scenario: A text-only model calls a stale image tool

- **WHEN** `view_image` is dispatched for a text-only selected model despite stale tool exposure
- **THEN** it SHALL return `capability.image_input_unsupported` scoped to the tool call
- **AND** no image file SHALL be read or decoded and no image block SHALL enter model history from that call
- **AND** the enclosing agent loop SHALL remain able to continue with a failed tool result

#### Scenario: Images are supported but original detail is unavailable

- **WHEN** an image-capable model lacks original-detail support
- **THEN** the tool SHALL retain the existing high-detail fallback
- **AND** it SHALL NOT classify the call as unsupported image input

### Requirement: Incompatible existing images retain their history

Provider preflight SHALL reject unsupported images already present in user,
tool, or restored conversation input before provider IO with a precise reason
and input origin. Recovery SHALL offer an explicit supported-model path when
available. It MUST NOT silently discard images, rewrite accepted history, or
retry the same incompatible input indefinitely. A dynamic integration result
produced after execution SHALL preserve its effect evidence and images.

#### Scenario: The affected session is resumed with a text-only model

- **WHEN** history already contains a tool image and the selected model accepts only text
- **THEN** preflight SHALL report that this model cannot read the image-bearing history before sending a provider request
- **AND** the UI SHALL offer compatible-model selection instead of a generic configuration-validation hint
- **AND** the persisted image and conversation SHALL remain intact

#### Scenario: An integration returns an unexpected image

- **WHEN** a tool with no declared image requirement returns a valid image after executing
- **THEN** its durable result and effects SHALL be retained
- **AND** incompatible provider input SHALL fail with the precise capability reason
- **AND** the system SHALL NOT claim the tool never ran or automatically execute it again

### Requirement: Optional context compatibility is explicit

New readers SHALL accept legacy records without contexts and derive
conservative presentation. Enriched durable writes SHALL be gated behind
updated closed parsers and a database format version that incompatible older
binaries reject before mutation. Closed exported snapshots SHALL be versioned
when their format changes. Existing transcript events MUST NOT be backfilled
or rewritten merely to add error context.

#### Scenario: A legacy failure is restored

- **WHEN** a new reader loads an error record lacking concrete cause and outcome evidence
- **THEN** it SHALL retain readable legacy information and stable existing identities
- **AND** it SHALL NOT invent a cause or authorize automatic effect replay

#### Scenario: An older binary opens an enriched database

- **WHEN** a binary that cannot parse enriched records opens a database with the new format version
- **THEN** it SHALL refuse the unsupported format before altering records
- **AND** documentation SHALL identify that executable rollback requires a compatible reader or pre-migration backup

### Requirement: Live context extensions are negotiated

Gateway bootstrap SHALL negotiate supported error-context versions while
retaining the legacy protocol envelope. Without successful selection, all
events, RPC errors, attempt pages, and transcript records SHALL use legacy
projection, including nested fields and recovery actions. Worker senders and
receivers SHALL use a matching upgraded protocol and reject stale peers before
provider or tool execution.

#### Scenario: An older gateway client connects

- **WHEN** the client does not advertise an error-context version
- **THEN** the gateway SHALL omit new error-context fields at every nesting level
- **AND** it SHALL provide supported legacy codes and recovery presentation

#### Scenario: A new client connects to an older backend

- **WHEN** bootstrap succeeds without selecting an error-context version
- **THEN** the new client SHALL use legacy behavior
- **AND** an explicit unknown-parameter rejection SHALL allow only a legacy handshake fallback, not replay of submitted work

#### Scenario: A Worker has an incompatible failure protocol

- **WHEN** a Worker protocol version does not match the upgraded sender/receiver contract
- **THEN** the runtime SHALL return a bounded protocol-incompatibility reason before dispatch
- **AND** it SHALL NOT send executable work repeatedly to the incompatible Worker

### Requirement: Unreadable optional error detail does not destroy valid lifecycle state

Producers SHALL emit strictly validated supported contexts. Consumers SHALL
bound and validate optional error context independently from authoritative
envelope state. An unsupported version, unknown reason, or malformed optional
detail SHALL produce generic safe presentation and a bounded diagnostic,
without speculative recovery. Invalid authoritative identity or lifecycle
fields MUST still fail normal validation.

#### Scenario: A future error context accompanies a valid terminal event

- **WHEN** a valid terminal event contains an optional context the reader cannot interpret
- **THEN** the reader SHALL apply the valid terminal state using its legacy fields
- **AND** it SHALL omit untrusted optional detail and unsafe recovery actions
- **AND** it SHALL NOT leave the turn visually running because of that optional context

### Requirement: Live and restored presentation remain consistent

TUI, readable transcript, and headless projections SHALL share public summary,
concrete cause, original operation identity, and safe detail definitions.
Recovery availability SHALL be evaluated against current state without
rewriting historical facts. TUI SHALL use existing notice/gutter/details
components, bounded wrapped text, and markers independent of color. Technical
IDs SHALL be available in details and diagnostics without dominating the main
notice. TUI fatal errors SHALL use the existing terminal-restoration path and
MUST NOT mutate conversation history.

#### Scenario: The same occurrence arrives from live and history paths

- **WHEN** a turn failure is received live and then loaded again through transcript pagination or resume
- **THEN** both projections SHALL show the same summary and concrete cause under one terminal notice
- **AND** separate request failures with identical wording SHALL retain distinct occurrence identities

#### Scenario: A long error is rendered in a narrow terminal

- **WHEN** a notice includes long model identifiers, safe detail, or CJK text
- **THEN** the text SHALL fit its content width without overlapping neighboring transcript or composer content
- **AND** the marker and important reason SHALL remain visible without relying only on color

### Requirement: Coverage gates enforce the complete error path

Repository checks SHALL validate schema/type drift, catalog completeness,
known-emitter/legacy mappings, redaction, and recovery preconditions. Shared
serialized fixtures SHALL cover backend-to-TUI and live-to-restored behavior.
Fault-injection regressions SHALL verify capability mismatch, gateway
admission/delivery failures, retry exhaustion/cancellation, uncertain effects,
and persistence failures. Tests MUST use isolated data and simulated services.

#### Scenario: A new known error bypasses the catalog

- **WHEN** a typed first-party emitter lacks an explicit reason or documented conservative mapping
- **THEN** the coverage gate SHALL fail with the affected boundary identified
- **AND** adding a generic message alone SHALL NOT satisfy the missing classification contract

#### Scenario: Transport drops concrete error data

- **WHEN** a Worker, terminalization, or gateway conversion omits a context field required by the shared fixture
- **THEN** the end-to-end error-path regression SHALL fail
- **AND** a passing formatter unit test alone SHALL NOT count as complete validation
