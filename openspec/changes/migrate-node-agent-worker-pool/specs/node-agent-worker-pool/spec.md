## ADDED Requirements

### Requirement: Elastic single-job Agent Worker Pool
The system SHALL provide a coordinator-owned elastic pool of reusable Node Workers, and each Worker lease SHALL execute at most one active agent turn.

#### Scenario: Root and child turns run concurrently
- **WHEN** the configured pool capacity is four and one root turn plus three child turns are runnable
- **THEN** the system leases four distinct active Workers and no Worker executes two turns concurrently

#### Scenario: Idle logical agent consumes no Worker
- **WHEN** a durable agent thread is idle or unloaded without an active turn
- **THEN** its session, mailbox, and history remain durable without retaining a Worker lease

### Requirement: Bounded priority scheduling
The pool SHALL enforce bounded active and queued capacity, SHALL prioritize interactive root work over background child work, and SHALL preserve FIFO ordering within one priority class.

#### Scenario: Root work arrives behind background work
- **WHEN** all Workers are leased and interactive root work arrives while background child work is queued
- **THEN** the next available compatible lease is assigned to the root work before later background work without preempting an already active turn

#### Scenario: Queue capacity is exhausted
- **WHEN** active leases and the bounded queue have reached their configured capacity
- **THEN** the request returns an explicit agent-pool capacity outcome and creates no partial turn or lease

### Requirement: Targeted interruption and Worker replacement
The system SHALL attempt cooperative cancellation first and SHALL terminate and replace only the Worker leased to a non-cooperative target turn after the configured grace period.

#### Scenario: Child Worker does not cooperate with cancellation
- **WHEN** one child turn remains active after cooperative cancellation expires
- **THEN** the system fences and terminates only that child's Worker, preserves root and sibling leases, persists one interrupted child terminal state, and creates a replacement Worker when allowed

#### Scenario: Root Worker is hard interrupted
- **WHEN** the root turn requires targeted Worker termination
- **THEN** independently running child Workers remain active unless an explicit parent-child policy separately interrupts them

### Requirement: Coordinator watchdog remains a last resort
The outer backend supervisor SHALL treat whole-backend restart as a coordinator failure path and SHALL NOT use it for a routine Agent Worker interruption that completes within the targeted cleanup bound.

#### Scenario: Targeted interruption completes
- **WHEN** the coordinator fences, cleans up, terminalizes, and replaces an Agent Worker within the bounded interruption path
- **THEN** the backend coordinator generation remains unchanged

#### Scenario: Coordinator becomes unresponsive
- **WHEN** the coordinator itself fails to acknowledge the outer watchdog within its longer timeout
- **THEN** the outer supervisor may terminate and recover the backend using the existing durable recovery path

### Requirement: Worker failures are isolated and recoverable
The pool SHALL detect Worker startup, protocol, runtime, and exit failures, SHALL invalidate the active lease before accepting further messages, and SHALL replace failed Workers unless shutdown or resource policy forbids replacement.

#### Scenario: Worker crashes during a child turn
- **WHEN** an Agent Worker exits abnormally while leased to a child turn
- **THEN** the coordinator closes that turn and its started tool lifecycles according to durable recovery policy without interrupting unrelated Workers

#### Scenario: Idle Worker exits
- **WHEN** an idle Worker exits unexpectedly
- **THEN** no session state changes and the pool restores capacity lazily or immediately according to configured warm capacity

### Requirement: Adapter-parity staged migration
The system SHALL retain an in-process execution adapter while Worker-backed execution is introduced and SHALL select one adapter before a turn begins without switching adapters inside the active turn.

#### Scenario: Subagent migration is enabled first
- **WHEN** Worker-backed subagent execution is enabled while root migration remains disabled
- **THEN** child turns use Worker leases, root turns use the in-process adapter, and both paths preserve the same durable and gateway contracts

#### Scenario: Worker-backed start fails before reservation
- **WHEN** a Worker-backed turn cannot obtain or initialize a lease before provider or tool dispatch
- **THEN** the system returns a typed startup/capacity failure or uses an explicitly configured pre-turn fallback, and it does not silently switch after side effects begin
