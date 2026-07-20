# Native Scrollback Streaming Stability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep full startup history in native terminal scrollback without replaying that history during assistant token streaming.

**Architecture:** Consume the transcript viewport's full-history render after its first use. When that first render exceeds the terminal height, rebase the TUI differential state onto the visible tail that the terminal actually displays, so subsequent bounded viewport frames compare against the correct baseline.

**Tech Stack:** TypeScript, Node.js test runner, vendored pi-tui differential renderer

---

### Task 1: Reproduce Native Scrollback Streaming Replay

**Files:**
- Test: `tui/mycli-shell/test/shell-app.test.ts`

- [ ] **Step 1: Write the failing regression test**

Add a test that starts `MycliShellRuntime` with `nativeScrollback = true`, a 16-row terminal, a transcript longer than the terminal, and a final assistant stream item. Verify the initial terminal output contains the oldest history item. Then verify the live frame excludes that oldest item, stream one update into the assistant item, and assert that the update neither replays the oldest history item nor increments `runtime.ui.fullRedraws`.

```typescript
test("mycli shell bounds native scrollback after initial history during assistant streaming", async () => {
	const terminal = new TestTerminal();
	terminal.nativeScrollback = true;
	terminal.rows = 16;
	const history = Array.from({ length: 20 }, (_, index) => ({
		id: `history-${index}`,
		role: index % 2 === 0 ? "user" as const : "assistant" as const,
		text: `history message ${index}`,
	}));
	const initial = {
		...sampleState(),
		messages: [...history, { id: "assistant-stream", role: "assistant" as const, text: "streaming" }],
		tools: [],
		bash: [],
		transcript: undefined,
		pendingNotice: undefined,
	};
	const runtime = new MycliShellRuntime({ initialState: initial, terminal });

	runtime.start();
	await setTimeout(25);
	assert.match(stripAnsi(terminal.output), /history message 0/);
	const liveFrame = stripAnsi(runtime.ui.render(terminal.columns).join("\n"));
	assert.doesNotMatch(liveFrame, /history message 0/);
	assert.match(liveFrame, /streaming/);

	const redrawsAfterStart = runtime.ui.fullRedraws;
	terminal.output = "";
	runtime.setState({
		...initial,
		messages: [
			...history,
			{ id: "assistant-stream", role: "assistant", text: "streaming token" },
		],
	});
	await setTimeout(25);

	assert.doesNotMatch(stripAnsi(terminal.output), /history message 0/);
	assert.equal(runtime.ui.fullRedraws, redrawsAfterStart);
	assertNativeScrollbackSafeOutput(terminal.output);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
cd tui/mycli-shell
npm test -- --test-name-pattern="bounds native scrollback after initial history"
```

Expected: FAIL because the live frame still contains the oldest history item.

### Task 2: Consume Full History and Rebase Differential State

**Files:**
- Modify: `tui/mycli-shell/src/shell-runtime.ts:189-205`
- Modify: `tui/mycli-shell/src/tui-core/tui.ts:1157-1185`
- Test: `tui/mycli-shell/test/shell-app.test.ts`

- [ ] **Step 1: Consume the one-time full transcript render**

In `TranscriptViewportComponent.render()`, set `this.renderFullOnce = false` before returning the complete transcript lines.

```typescript
if (this.renderFullOnce) {
	this.renderFullOnce = false;
	this.scrollOffset = 0;
	return lines;
}
```

- [ ] **Step 2: Rebase native full renders onto their visible tail**

After `fullRender()` writes and positions the cursor, detect a native-scrollback frame taller than the terminal. Slice `newLines` to its final `height` rows for `previousLines`, translate cursor rows by the same start offset, reset `previousViewportTop` to zero, collect Kitty image IDs only from the visible baseline, and request one normal render to stabilize the bounded live frame. Preserve the existing state updates for all other frames.

```typescript
const baselineStart = this.terminal.nativeScrollback
	? Math.max(0, newLines.length - height)
	: 0;
const baselineLines = baselineStart > 0 ? newLines.slice(baselineStart) : newLines;
if (baselineStart > 0) {
	this.cursorRow = Math.max(0, this.cursorRow - baselineStart);
	this.hardwareCursorRow = Math.max(0, this.hardwareCursorRow - baselineStart);
	this.maxLinesRendered = baselineLines.length;
	this.previousViewportTop = 0;
}
this.previousLines = baselineLines;
this.previousKittyImageIds = this.collectKittyImageIds(baselineLines);
if (baselineStart > 0) {
	this.requestRender();
}
```

- [ ] **Step 3: Preserve transcript visibility in one-row viewports**

When the auto-following transcript slice contains only visually blank padding,
move the slice upward to the nearest visible line. If a one-row transcript already
contains messages, omit the turn activity spinner so it cannot replace the latest
message.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```bash
cd tui/mycli-shell
npm test -- --test-name-pattern="bounds native scrollback after initial history"
```

Expected: PASS.

- [ ] **Step 5: Run TUI verification**

Run:

```bash
cd tui/mycli-shell
npm test
npm run typecheck
```

Expected: all tests pass and TypeScript reports no errors.

- [ ] **Step 6: Run repository verification**

Run:

```bash
uv run pytest -q
uv run ruff check src tests
uv run mypy src
```

Expected: all Python tests pass, Ruff reports no issues, and mypy reports no issues.

- [ ] **Step 7: Commit the fix**

```bash
git add tui/mycli-shell/src/shell-runtime.ts tui/mycli-shell/src/tui-core/tui.ts tui/mycli-shell/test/shell-app.test.ts
git commit -m "fix: stabilize native scrollback streaming"
```
