## ADDED Requirements

### Requirement: Agent planning must be grounded in observed evidence
`mycli` MUST bias runtime planning toward files, paths, modules, and facts that have already been established by tool results or user-provided context, rather than assuming common repository structures.

#### Scenario: Accessing an unverified path
- **WHEN** the model attempts to read or traverse a path that has not been established by prior evidence
- **THEN** the runtime MUST treat the attempt as ungrounded for policy evaluation and include that signal in trace or runtime reminders

#### Scenario: Planning references known evidence
- **WHEN** the runtime evaluates whether to continue exploration
- **THEN** it MUST be able to reference the recent tool evidence used to justify the next step

### Requirement: Runtime enforces exploration budget by task shape
`mycli` MUST enforce an exploration budget that can vary by task shape so that overview-style requests do not consume the same depth budget as debugging or implementation tasks.

#### Scenario: Overview task uses lower budget
- **WHEN** the user asks for a repository overview, entrypoint summary, or brief module summary
- **THEN** the runtime MUST use a lower exploration budget than it would for debugging or implementation work

#### Scenario: Budget exhaustion triggers controlled stop
- **WHEN** the runtime reaches the exploration budget for the active turn
- **THEN** it MUST either request a summary-oriented next step from the model or stop the turn with a budget-related stop reason

### Requirement: Runtime detects repeated or low-yield exploration
`mycli` MUST detect repeated tool usage or repeated exploration patterns that do not add meaningful new evidence and use that signal to steer or stop the turn.

#### Scenario: Repeated read or list operations
- **WHEN** the turn repeatedly reads the same file, lists the same directory, or retries the same exploration pattern without meaningful new evidence
- **THEN** the runtime MUST mark the pattern as repeated exploration for policy handling

#### Scenario: Loop handling escalates before hard stop
- **WHEN** repeated exploration is detected
- **THEN** the runtime MUST first attempt to steer the model toward summarizing known evidence before terminating the turn for `loop_detected`

### Requirement: Runtime determines when evidence is sufficient to answer
`mycli` MUST evaluate whether the evidence gathered during the turn is sufficient for the user’s request and prefer answering once the minimum evidence threshold is met.

#### Scenario: Overview request has enough evidence
- **WHEN** the runtime has enough evidence to identify the repository entrypoint, major module areas, and the user asked for a brief summary
- **THEN** it MUST prefer producing an answer over continuing broad exploration

#### Scenario: Insufficient evidence allows continued exploration
- **WHEN** the current evidence does not cover the user’s core question
- **THEN** the runtime MAY continue exploration within the remaining budget
