# Error System Fixtures

`failures.json` is the language-neutral public error baseline. Its SHA-256
sidecar is checked by Node contract tests and its facts are rendered by TUI
tests. Do not put provider bodies, secrets, paths or encoded image payloads in
this fixture.

`emitters.json` records first-party source paths, syntax boundaries, legacy
codes or typed reasons, expected scopes, and deliberate generic fallbacks.
`scripts/error-emitter-inventory.mjs` uses the TypeScript parser to discover
constructors, result fields and tool failure helpers. Duplicate occurrences at
the same source boundary are grouped. This is a maintenance coverage check,
not a claim that arbitrary exception text can identify a concrete cause.

`previous-v12-reader.mjs` freezes the storage admission gate from commit
`1598f84ba11e5274b54404d104e9a0da2ec62e04`, adapting imports and injecting the
writable-store constructor. Its isolated test proves that a previous reader
refuses a format-14 database containing enriched records before any writable
store construction, and that current readers still load the original rows.
