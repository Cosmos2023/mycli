# Mycli TUI Review Against Local Codex Source

Date: 2026-09-08. Status: F1-F6 implemented and verified.

## Implementation And Codex Comparison

| Finding | Implemented behavior | Codex comparison and regression evidence |
| --- | --- | --- |
| F1 | `terminalContent` preserves SGR colors, consumes terminal commands/control strings, and renders bare CR as another log line before Shell layout | Like Codex's parsed output lines, external content cannot position the host cursor. Cell tests cover native/ordinary and expanded/collapsed Shell output, colors, clear-screen, clipboard OSC, and progress output |
| F2 | Rollback touches only the selected setting/catalog row if its optimistic value is still current; session revisions reject stale failures; keymap errors preserve the current shell state | Codex applies status-line configuration after persistence; Mycli retains its existing optimistic preview while enforcing the same failure isolation. Deferred tests preserve new messages, Shell completion, and newer setting values |
| F3 | Local history stores text and image metadata; undo captures text/cursor, attachments, and paste payloads; restore installs metadata before change callbacks | Matches Codex's structured local-history ownership. Tests cover recall, undo, equal text with different images, and session draft isolation; completed submission/session switch clears obsolete undo |
| F4 | Allocate an unused label, prune deleted images, and atomically relabel remaining bindings without moving the cursor or creating another undo unit | Matches the ordinary Codex deletion/renumbering flow. Tests delete an earlier image, add another, and remove either survivor; submitted paths match the retained image. Literal unbound labels reserve their number |
| F5 | Model/provider/reasoning/scope lists use actual available height; compact spacing and a minimum-height guard prevent hidden selection; native full/incremental frames compare identical bounded rows | Matches Codex's available-area list budgeting. Terminal-cell tests exercise 12/16/24/40-row resize/navigation in both modes; an oversized-component renderer test protects the common frame boundary |
| F6 | Login blocks duplicate submits and matches selector, submission generation, and session revision before applying completion; Back invalidates the attempt | Corresponds to Codex's active-login identity checks. Deferred success/failure and cancel/retry tests prove old results cannot reopen a menu, steal focus, or complete a newer attempt |

The comparison checks the behavioral invariants behind the six bugs. Mycli keeps
its TypeScript renderer and local-image attachment callbacks. It does not adopt
Ratatui or claim complete parity with Codex's richer text-element/remote-image
model. Codex references below were reread after implementation; they come from
the same local source snapshot, not a verified latest release.

## Original Findings (Pre-Fix)

Four P1 issues and two P2 issues were reproduced before these changes. No P0 was
established. The following descriptions and line references preserve that audit
baseline, including the preceding model/provider authentication fixes. They are
not six still-open defects; current behavior is recorded in the table above.

### F1. P1: Shell Output Can Overwrite The Surrounding Terminal UI

Trigger: a Shell output event contains a bare carriage return, cursor movement,
or a clear-screen sequence. For example, the escaped test input was
`first line\n\x1b[H\x1b[2JUNTRUSTED OUTPUT`.

The Shell reducer preserves the output and `BashExecutionComponent` wraps it as
ANSI text. The renderer then writes the control bytes to the host terminal.
The xterm emulator lost the preceding user message and Shell headers in both
native-scrollback and ordinary rendering modes, although those rows still
existed in the logical component output. `progress 10%\rprogress 20%` also
overwrote the Shell gutter, placing the progress text at column zero.

- Mycli: `tui/mycli-shell/src/components/bash-execution.ts:40` and `:181`;
  `tui/mycli-shell/src/tui-core/components/text.ts:74`;
  `tui/mycli-shell/src/tui-core/tui.ts:1421`.
- Upstream trace: `backend/apps/mycli/src/node-runtime/node-gateway-shell-controller.ts:274`
  bounds output length; `backend/packages/storage/src/transcript/shell-transcript-store.ts:158`
  also only bounds output. Neither removes terminal commands from output.
- Codex: `codex-rs/tui/src/exec_cell/render.rs:138` converts each output line
  with `ansi_escape_line`; `codex-rs/ansi-escape/src/lib.rs:41` parses ANSI into
  Ratatui text before rendering. This provides a structured content boundary.
- Recommendation: normalize external output before layout. Preserve supported
  styling, handle carriage-return progress within the output content, and prevent
  cursor, screen, and terminal-mode commands from reaching the main terminal.
- Acceptance: send controls through Shell events and transcript replay, then
  assert surrounding terminal cells and renderer cursor state remain intact.

### F2. P1: Failed Settings Writes Restore Stale Transcript State

Trigger: start a persistent settings change, receive a new assistant message or
turn update while the save is pending, then let the save fail.

`applySettingsChange` retains the entire old `MycliShellState`. Its error handler
calls `setState(previousState)`, reverting unrelated updates. The reproduction
observed message IDs `[u1, new-answer]` become `[u1]`, and the newly received
completed footer state disappear. The same rollback pattern exists in keymap
reset. This is loss of current UI state; durable backend transcript loss was
neither observed nor implied. A later gateway refresh can restore the content.

- Mycli: `tui/mycli-shell/src/shell-runtime.ts:3824`, `:3869`, and `:3813`.
- Codex: `codex-rs/tui/src/app/event_dispatch.rs:1986` handles status-line
  persistence by updating the relevant configuration on success or appending
  an error on failure. It does not restore a historical chat-widget snapshot.
- Recommendation: roll back only the affected setting fields on the current
  state, with operation/session ownership checks where applicable.
- Acceptance: delay and reject a save after message, tool, and turn-completion
  updates. Those updates must remain visible while the setting itself reverts.

### F3. P1: History Recall And Undo Restore Image Labels Without Images

Trigger A: drop an image, submit, press Up to recall the submission, and submit
again. Trigger B: drop an image, delete it with Ctrl+U, undo with Ctrl+-, and submit.

Both restore `[image #1]` visibly, but the subsequent submission contains
`localImages: []`. The first submission in trigger A contains the expected image.
Editor history and undo store text/editor state while attachment paths live in
the runtime's separate `pendingLocalImages` array. Submission clears that array;
deletion prunes it permanently. Neither restore path rehydrates it.

- Mycli: `tui/mycli-shell/src/shell-runtime.ts:3248`, `:3304`, and `:3318`;
  `tui/mycli-shell/src/tui-core/components/editor.ts:427`, `:486`, and `:1990`.
- Codex: `codex-rs/tui/src/bottom_pane/chat_composer_history.rs:27` stores
  structured local history including image paths and text elements;
  `codex-rs/tui/src/bottom_pane/chat_composer.rs:2719` records those fields and
  `:1420` restores them together. This comparison establishes local-history
  behavior, not persistent-history or undo parity for every attachment type.
- Recommendation: make attachment metadata part of restorable composer state.
  A visible attachment must remain bound to its payload through recall and undo.
- Acceptance: verify submission payloads after recall, undo, and draft switching,
  including actual attachments and plain text that resembles a placeholder.

### F4. P1: Reused Image Numbers Keep A Deleted Image In The Submission

Trigger: drop images A and B; delete A; drop image C. Both surviving images
receive `[image #2]`. Delete one of those placeholders and submit.

The keyboard-only reproduction leaves one visible `[image #2]` but submits both
B and C. `registerDroppedImageFile` assigns `pendingLocalImages.length + 1`,
which collides with retained labels after a deletion. Retention and submission
then use `text.includes(placeholder)`, so either matching token keeps both paths.
`gateway.ts:454` forwards every retained path in a normal turn submission.

- Mycli: `tui/mycli-shell/src/shell-runtime.ts:3308`, `:3318`, and `:3294`.
- Codex: `codex-rs/tui/src/bottom_pane/chat_composer/attachment_state.rs:207`
  removes deleted element payloads and relabels the remaining image elements;
  `:226` updates both attachment labels and textarea elements.
- Recommendation: use collision-free attachment identity and keep displayed
  numbering synchronized with editor elements. Deletion must identify one image.
- Acceptance: delete an earlier image, insert another, then delete either
  survivor. The submitted image paths must exactly match the visible attachments.

### F5. P2: Model Menus Exceed Terminal Height And Corrupt Incremental Frames

Trigger: open `/model` with 30 model choices in an 80-column terminal with 12 or
16 rows. Both provider and model lists reserve a fixed ten entries without a
height budget. The overall component tree produces 24 rows even in these
shorter terminals.

Ordinary rendering clips the title/search; at 12 rows the initial selected
model is invisible, but Enter still selects it. Native rendering initially
paints the top portion, while the next incremental frame compares tail rows.
After seven Down presses, list fragments overwrite the old user message and
menu title; Enter selects `model-07` although its complete row is not displayed.
The 24-row and 40-row control cases display the selected row correctly.

- Mycli: `tui/mycli-shell/src/components/model-selector.ts:565` and `:589`;
  `tui/mycli-shell/src/shell-runtime.ts:1604`;
  `tui/mycli-shell/src/tui-core/tui.ts:1362` and `:1395`.
- Codex: `codex-rs/tui/src/bottom_pane/list_selection_view.rs:1155` reserves
  footer space within its actual area; `:1250` renders list rows using the
  resulting `list_area.height`.
- Recommendation: give menus an available-height contract and scroll to keep
  the selected row visible. Full and incremental native frames must use the
  same bounded rows even if a component violates that contract.
- Acceptance: check physical terminal cells after opening, navigating, and
  resizing at 12/16/24/40 rows in both rendering modes.

### F6. P2: A Dismissed Login Reopens A Model Menu After Save Completion

Trigger: submit an API key in standalone login while its save is pending, press
Esc twice to return to the composer, and begin another draft. Resolve the save.

The late completion runs `done()`, `mountMain()`, and `openModelSelector()` without
checking whether the login interaction remains active. The model menu reopens
and steals input focus. The reproduction preserved draft text; draft deletion
was not observed. This finding concerns stale navigation, not undoing a
credential write that was already submitted.

- Mycli: `tui/mycli-shell/src/components/login-flow.ts:99`;
  `tui/mycli-shell/src/shell-runtime.ts:3916` and `:3926`.
- Codex reference: `codex-rs/tui/src/onboarding/auth.rs:914` only applies a
  browser/device-login completion when the active state has the matching login
  ID. This is an ownership pattern, not an identical multi-provider API-key flow.
- Recommendation: associate async completion with the owning selector instance;
  dismissing or replacing it must invalidate subsequent navigation callbacks.
- Acceptance: delay success and failure, dismiss or replace the dialog, then
  finish the request. Current focus and the newer draft must remain unchanged.

## Original Evidence

- Reviewed Mycli HEAD: `1598f84ba11e5274b54404d104e9a0da2ec62e04`, including the
  existing dirty working tree. HEAD alone does not identify this baseline.
- Codex reference: `/Users/cosmos/Downloads/codex-main`, an unpacked source tree
  without `.git`, workspace version `0.0.0`. No latest-release parity claim is made.
- Reproductions use the real Mycli reducer/components/runtime and
  `@xterm/headless` terminal cells, synthetic image paths, and deferred callbacks.
  They do not call a live provider or modify real credentials/configuration.
- Temporary commands used to reproduce the original failures, run from this repository:

  ```sh
  node --conditions=mycli-source --import tsx /tmp/mycli-tui-review-2026-09-08.mts
  node --conditions=mycli-source --import tsx /tmp/mycli-model-selector-probe.mts
  ```

- Eight existing test files passed: `editor-attachments`, `model-selector`,
  `login-flow`, `shell-layout`, `tui-renderer`, `screen-buffer`, `shell-app`, and
  `runtime-state`. Command prefix: `node --conditions=mycli-source --import tsx
  --test --test-reporter=dot`, followed by these files under `tui/mycli-shell/test/`.
- Those passing suites did not cover the reproduced combinations. The temporary
  scripts contain pre-fix observations/assertions and are not current regression gates.
- The initial review changed no production code. The subsequent implementation
  is documented above. No Codex build/test, real-provider image delivery, or
  cross-platform terminal verification was run.
- Unverified async-selector/session races and other control-sequence entry
  points are not counted as additional confirmed findings.

## Fix Verification

- Added 24 regression cases across `terminal-content.test.ts`,
  `tui-review-regressions.test.ts`, `model-selector.test.ts`, and `tui-renderer.test.ts`.
  Focused runs passed, including existing Shell runtime, model, login, and renderer suites.
- `npm run build`, `npm run lint`, `npm run typecheck`, `npm run contracts:check`,
  `npm run config:check`, and `git diff --check` passed.
- `npm test --ignore-scripts` passed all 358 test files in 170.7 seconds:
  301 unit, 22 contract, 29 integration, 5 platform, and 1 release test file.
  The full run permitted local loopback servers, Workers, and PTY tests; it did
  not use live providers or real credentials.
- Current targeted regression command:

  ```sh
  node --conditions=mycli-source --import tsx --test tui/mycli-shell/test/terminal-content.test.ts tui/mycli-shell/test/tui-review-regressions.test.ts tui/mycli-shell/test/model-selector.test.ts tui/mycli-shell/test/tui-renderer.test.ts
  ```
