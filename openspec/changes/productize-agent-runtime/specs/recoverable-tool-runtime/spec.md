## ADDED Requirements

### Requirement: File and directory tool failures return structured results
`mycli` MUST represent expected file and directory tool failures as structured tool results instead of raising turn-terminating exceptions by default.

#### Scenario: Reading a nonexistent file
- **WHEN** the model asks to read a file that does not exist
- **THEN** the tool MUST return a structured failure result indicating the path was not found

#### Scenario: Listing a non-directory path
- **WHEN** the model asks to list a path that is not a directory
- **THEN** the tool MUST return a structured failure result explaining that the path cannot be listed as a directory

### Requirement: Structured tool failures remain available to the model and runtime
Structured tool failures MUST be available to runtime policy, trace logging, and the model so the turn can continue reasoning from the error instead of losing that context.

#### Scenario: Model receives recoverable tool failure
- **WHEN** a tool call fails with a recoverable structured error
- **THEN** the runtime MUST pass the failure result back through the normal tool-result path so the model can revise its plan

#### Scenario: Trace records structured failure metadata
- **WHEN** a recoverable tool failure occurs
- **THEN** trace and workspace logging MUST persist a machine-readable summary of the failure category and message

### Requirement: System errors remain distinguishable from recoverable tool failures
`mycli` MUST distinguish between recoverable tool-domain failures and true runtime or infrastructure failures so that genuine system errors are not silently downgraded.

#### Scenario: Tool-domain error stays recoverable
- **WHEN** a tool fails because of path absence, permission denial, encoding limits, or invalid directory assumptions
- **THEN** the runtime MUST treat it as a recoverable tool result unless policy decides to stop for another reason

#### Scenario: Runtime failure remains terminal
- **WHEN** the failure is caused by runtime orchestration bugs, provider communication failure, or corrupted internal state
- **THEN** the runtime MUST classify it as a runtime or model error rather than a recoverable tool result
