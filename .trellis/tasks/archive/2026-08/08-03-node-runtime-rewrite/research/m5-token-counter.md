# M5 Token Counter Selection

## Requirement

Python uses `tiktoken` with the `o200k_base` encoding and falls back to
`ceil(ascii_chars / 4) + non_ascii_chars`. M5 needs equivalent Node behavior for compaction
thresholds and bounded rehydration without adding a native build requirement.

## Compared Packages

- `js-tiktoken` 1.0.21: MIT, pure JavaScript, one `base64-js` dependency, roughly 22 MB unpacked.
- `@dqbd/tiktoken` 1.0.22: MIT, WASM-backed OpenAI tiktoken port, roughly 24 MB unpacked.
- `gpt-tokenizer` 3.4.0: MIT, broader tokenizer package, roughly 53 MB unpacked.

Version and package metadata were read from the npm registry on 2026-08-04. Implementation must
lock the chosen compatible version through `package-lock.json`; these observed versions are not a
floating dependency policy.

## Decision

Use `js-tiktoken` behind a small `TokenCounter` interface with `o200k_base`. It most closely matches
the Python encoding choice while remaining ordinary cross-platform JavaScript with no WASM or
native binary lifecycle. If encoder initialization fails, use the exact Python fallback estimator.

Tests compare a fixed ASCII, CJK, mixed-text, tool-result, and code fixture corpus against Python.
Compaction boundary tests allow no trigger-decision drift even if a low-level token count differs
on an encoding edge case.

The expected corpus counts were produced on 2026-08-04 by importing
`mycli.services.context.token_counter.TokenCounter` through the repository's `uv run python`
environment. In fixture order (ASCII, CJK, mixed, code, tool output), Python returned
`[2, 3, 7, 18, 17]`; the Node test asserts those exact values.
