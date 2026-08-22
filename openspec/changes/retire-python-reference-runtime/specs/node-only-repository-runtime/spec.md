## ADDED Requirements

### Requirement: Node owns every production runtime asset
The repository SHALL build and run the mycli product from Node-owned source, prompt assets,
generated contracts, workspace packages, and native helpers without reading or writing a Python
runtime tree.

#### Scenario: Source and production builds run after Python removal
- **WHEN** a clean checkout contains no `src/mycli` Python package
- **THEN** both the source development entry and compiled production build load the same canonical
  system prompt and complete without a Python import, executable probe, or generated Python target

#### Scenario: Contract generation is Node-owned
- **WHEN** contract generation and drift checking run
- **THEN** they generate and validate canonical Node declarations without creating or checking
  files under a Python package path

### Requirement: The Python product and toolchain surface are removed
The repository SHALL NOT ship or maintain a Python mycli console script, wheel, runtime package,
reference test suite, evaluation suite, compatibility writer, dependency lock, build hook, or
Python reference CI gate.

#### Scenario: Node development requires no Python product environment
- **WHEN** a contributor installs dependencies and runs the documented build, lint, typecheck, test,
  and smoke commands
- **THEN** the commands use the Node workspace and do not require `uv`, pytest, ruff, mypy, Hatch,
  or Python package dependencies

#### Scenario: Removed Python entrypoint is a breaking boundary
- **WHEN** a former Python-runtime user upgrades to the retired release
- **THEN** current documentation directs the user to the npm CLI and no hidden sidecar, fallback,
  wheel, or `uv run mycli` entrypoint remains

### Requirement: Node regression and native assets survive retirement
The system SHALL preserve every language-neutral fixture, native helper, and packaged asset still
referenced by Node runtime, storage, provider, TUI, capability-audit, or release tests.

#### Scenario: Frozen parity corpora remain verified
- **WHEN** the M8 capability audit and package test suites run after Python deletion
- **THEN** all referenced M2-M7 JSON corpora remain present with their expected checksums and no
  Python harness is needed to consume them

#### Scenario: Native release helpers remain Node-owned
- **WHEN** platform-sensitive npm build and package checks run
- **THEN** required PTY, ripgrep, and sandbox helper assets remain available without copying an
  artifact into a Python wheel

### Requirement: Retirement does not rewrite session data
Removing the Python product SHALL NOT migrate, delete, normalize, or rewrite existing mycli session
databases or readable artifacts.

#### Scenario: Existing schema-v12 sessions remain usable
- **WHEN** the Node-only release starts against an existing healthy schema-v12 `sessions.db`
- **THEN** normal Node startup and resume behavior continue without a Python compatibility reader or
  retirement migration

### Requirement: Active repository guidance is Node-only
Active repository guidance SHALL describe only the Node product across developer instructions, CI,
installation, architecture, rollout, Windows, troubleshooting, and command documentation, while
distinguishing external Python commands from a mycli runtime dependency.

#### Scenario: Active reference scan has only explicit exceptions
- **WHEN** repository hygiene checks scan active source, package metadata, scripts, CI, and current
  documentation
- **THEN** no maintained Python-runtime reference remains except negative no-Python probes,
  external Shell/exec-policy handling, legacy-plugin migration diagnostics, Trellis-owned tooling,
  and immutable historical records
