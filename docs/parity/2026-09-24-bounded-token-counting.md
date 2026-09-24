# Bounded Token Counting For Unbroken Runs

## Problem

`TokenCounter` handed a whole string to one `js-tiktoken` call. That library
merges a single pre-tokenizer piece by repeatedly scanning every part of the
piece and merging the cheapest pair, so one call costs roughly the square of the
longest piece. Ordinary prose, code and JSON are unaffected because the pattern
breaks them into short pieces, but a run the pattern keeps whole - a Chinese
paragraph with no punctuation, a long separator line, a repeated character -
blocks the event loop:

| input | length | before | after |
| --- | --- | --- | --- |
| CJK sentence, no punctuation | 13,500 | 96.9 s | 0.87 s |
| CJK sentence, no punctuation | 3,250 | 5.6 s | 0.21 s |
| `-` repeated | 8,000 | 3.2 s | 0.06 s |
| `x` repeated | 16,000 | 12.8 s | 0.11 s |

Measured on this encoder, one call costs about `6e-5 ms` per squared UTF-8
byte, which is where the limit below comes from. The cost is per piece, not per
string, so the trigger is a long unbroken run rather than a long input: a
63,704 character file of ordinary prose encodes in 9 ms.

## What was considered

`gpt-tokenizer` is 60-200x faster on the pathological shapes and matched
`js-tiktoken` on 30,000 random strings without U+FEFF. It was still rejected:
its BPE merges U+FEFF into tokens `5416, 123` where Python `tiktoken` 0.14.0 and
`js-tiktoken` both produce the single token `5574`, so `"\ufeffdmi"` counts as 4
instead of 3. The counter exists to mirror Python `o200k_base`, and a byte order
mark is common in files, so that divergence is not worth the constant factor.
The comparison is recorded here so a future change can revisit it with data.

## Change

`backend/packages/runtime/src/context/token-counter.ts` now estimates two costs
before it counts anything:

- `mergeWork(text)` walks the text once and sums the estimated work of every run
  of letters, punctuation or whitespace as `(bytes + 2)^2`, and of every digit
  run as `ceil(bytes / 3) * 25`, because the pattern emits digits in pieces of at
  most three characters. The two spare bytes per run cover the characters a
  piece may absorb from a neighbouring run. Pieces are one run each, so this
  approximates the pieces the encoder will build.
- It returns that sum twice: `direct` for one call over the whole text, and
  `windowed` for the same text cut into `TOKEN_COUNT_WINDOW_CHARS` windows.

The counter then:

- counts the text in one exact call when `direct` is under
  `EXACT_MERGE_WORK_LIMIT` (about 100 ms of merge work), and
- also counts it in one exact call when windowing would not at least halve the
  estimate. Windowing only helps when a piece is far longer than a window; text
  whose cost comes from many short pieces - a large Chinese document with
  punctuation, say - costs the same either way, so it is not worth trading
  accuracy for it.
- Otherwise it counts window by window, each at most
  `TOKEN_COUNT_WINDOW_CHARS` characters, and sums the results.

Windows cut where the pre-tokenizer already breaks, which is what keeps ordinary
text exact even when it is windowed:

- A space or tab never binds backwards, so the cut goes in front of it. The
  pattern's `[^\r\n\p{L}\p{N}]?\p{L}+` binds that whitespace to the word after
  it, and ` ?[^\s\p{L}\p{N}]+` binds it to the punctuation after it; either way
  both windows see the pieces the whole text would have produced.
- A newline is absorbed by the punctuation run in front of it through
  `[\r\n/]*`, so that cut goes after the last newline of the run instead of
  before it. Cutting in front of a newline costs one token per cut; this was the
  difference between a 1.4% drift and an exact count on TypeScript sources.
- When a window has no such boundary the cut falls at the limit, adjusted by one
  code unit when it would split a surrogate pair.

## Verification

`backend/packages/runtime/test/context/token-counter.test.ts` adds four tests:
ordinary text and whitespace-free JSON stay in one call, every encoder call
stays inside the window and the windows reassemble into the original text, a
window cut never splits a surrogate pair, and a 13,500 character CJK run stays
within 2% of the Python count of 8100 while finishing in bounded time.

On a corpus of ten synthetic shapes and seven repository files (60,000
characters each where longer), the counter spends 1.7 s where the unguarded
encoder spends 116.2 s. Only the two unbroken CJK runs drift, by 0.52% and
0.69%; every repository file, the whitespace-free JSON, the base64 blob, the
minified source and the punctuated CJK text count exactly. The whole runtime
suite passes 650/650, lint, build and typecheck pass, and
`node-backend.integration.test.ts` passes 65/65.

## Limits

Windowed counting is not exact by construction. A cut inside a run that offers
no boundary splits a piece, which costs a fraction of a token and makes the sum
slightly high. The measured drift is under 0.7% and only appears on inputs the
pattern keeps whole for thousands of characters, where the previous behaviour
was a multi-second stall rather than a count.

Text made of many pieces that are each tens of bytes still costs what it always
did - about 2.2 s for 300,000 characters of punctuated Chinese - because
windowing cannot shrink a piece that already fits in a window. An encoder whose
merge loop is not quadratic, such as Rust `tiktoken` through WASM or a
priority-queue merge, would fix both that and the windowing drift. It is worth
doing only if those costs start to matter, since it changes the dependency and
the loading model.