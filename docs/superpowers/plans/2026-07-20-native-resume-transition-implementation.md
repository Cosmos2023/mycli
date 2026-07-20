# Codex-Style Native History Replay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replay native startup and resumed transcript history exactly once without committing or overlaying fixed TUI chrome inside assistant content.

**Architecture:** Split the transcript into a committed prefix and a bounded visible tail. Queue the prefix in the generic TUI renderer, then atomically scroll it above a freshly painted bounded frame; keep selectors mounted until asynchronous Resume loading has prepared that replay.

**Tech Stack:** TypeScript, Node.js test runner, ANSI synchronized output, native terminal scrollback

---

### Task 1: Reproduce Chrome Contamination and Selector Flicker

**Files:**
- Test: `tui/mycli-shell/test/shell-app.test.ts`

- [ ] **Step 1: Strengthen the native startup history test**

In `mycli shell writes full initial history when terminal has native scrollback`,
verify the oldest history row is emitted before the only header write:

```ts
const output = stripAnsi(terminal.output);
const oldestHistory = output.indexOf("history message 0");
const header = output.indexOf("mycli ctrl+p commands");
assert.ok(oldestHistory >= 0);
assert.ok(header > oldestHistory);
assert.equal(output.match(/mycli ctrl\+p commands/g)?.length, 1);
```

- [ ] **Step 2: Strengthen the native Resume history test**

After selection completes, assert the transcript prefix precedes the one live
header and the visible tail follows it:

```ts
const output = stripAnsi(terminal.output);
const oldestHistory = output.indexOf("resumed history 0");
const header = output.indexOf("mycli ctrl+p commands");
const visibleTail = output.indexOf("resumed history 28");
assert.ok(oldestHistory >= 0);
assert.ok(header > oldestHistory);
assert.ok(visibleTail > header);
assert.equal(output.match(/mycli ctrl\+p commands/g)?.length, 1);
assert.equal(output.match(/resumed history 0/g)?.length, 1);
assert.doesNotMatch(output, /Resume Session/);
assertNativeScrollbackSafeOutput(terminal.output);
```

- [ ] **Step 3: Add an asynchronous selector lifetime test**

Use a manually released Promise in `onSessionSelect`. After pressing Enter but
before releasing it, assert the rendered UI still contains `Resume Session`.
After release, assert the selector is gone:

```ts
test("mycli shell keeps the session selector mounted until resume history is ready", async () => {
	const terminal = new TestTerminal();
	let releaseLoad: (() => void) | undefined;
	const load = new Promise<void>((resolve) => {
		releaseLoad = resolve;
	});
	const runtime = new MycliShellRuntime({
		initialState: sampleState(),
		terminal,
		onSessionSelect: async () => load,
	});

	runtime.start();
	await setTimeout(25);
	runtime.showSessionSelector();
	await setTimeout(25);
	terminal.input?.("\r");
	await setTimeout(25);
	assert.match(stripAnsi(runtime.ui.render(terminal.columns).join("\n")), /Resume Session/);

	releaseLoad?.();
	await setTimeout(25);
	assert.doesNotMatch(stripAnsi(runtime.ui.render(terminal.columns).join("\n")), /Resume Session/);
});
```

- [ ] **Step 4: Run focused tests and verify RED**

Run:

```bash
cd tui/mycli-shell
node --import ./node_modules/tsx/dist/esm/index.mjs \
  --test \
  --test-name-pattern="writes full initial history|session selection inserts loaded history|keeps the session selector mounted" \
  --test-reporter=dot \
  test/shell-app.test.ts
```

Expected: startup and Resume ordering/header-count checks fail because the full
component tree is replayed before stabilization; selector lifetime fails because
`done()` currently runs before the async load.

### Task 2: Split Transcript Prefix From the Live Tail

**Files:**
- Modify: `tui/mycli-shell/src/shell-runtime.ts:155-205`
- Test: `tui/mycli-shell/test/shell-app.test.ts`

- [ ] **Step 1: Extract the bounded visible start calculation**

Add a private helper on `TranscriptViewportComponent` and use it from `render()`:

```ts
	private visibleStart(lines: string[], height: number): number {
		let start = Math.max(0, lines.length - height - this.scrollOffset);
		if (this.scrollOffset === 0) {
			while (start > 0 && lines.slice(start, start + height).every(isVisuallyBlankLine)) {
				start -= 1;
			}
		}
		return start;
	}
```

- [ ] **Step 2: Expose the committed prefix**

Replace `renderFullNext()` and its one-shot state with a method that resets to the
bottom and returns only rows before the visible tail:

```ts
	scrollbackPrefix(width: number): string[] {
		const height = Math.max(1, this.heightForWidth(width));
		const lines = this.content.render(width);
		this.scrollOffset = 0;
		this.lastLineCount = lines.length;
		return lines.slice(0, this.visibleStart(lines, height));
	}
```

Normal `render()` continues to pad and return the bounded visible tail.

- [ ] **Step 3: Run the focused tests**

Run the Task 1 command. Expected: tests still fail because the returned prefix is
not yet queued or inserted.

### Task 3: Add Atomic Native History Insertion

**Files:**
- Modify: `tui/mycli-shell/src/tui-core/tui.ts:270-305`
- Modify: `tui/mycli-shell/src/tui-core/tui.ts:1125-1210`
- Test: `tui/mycli-shell/test/shell-app.test.ts`

- [ ] **Step 1: Add pending history state and queue API**

Add a TUI field and public method:

```ts
	private pendingHistoryLines: string[] | null = null;

	insertHistoryBeforeNextFrame(lines: string[]): void {
		this.pendingHistoryLines = lines;
		this.requestRender();
	}
```

The queue stores transcript rows only; callers do not pass header, editor, status,
or footer lines.

- [ ] **Step 2: Consume queued history in `doRender()`**

After rendering and resetting `newLines`, capture and clear the queue:

```ts
		const pendingHistoryLines = this.pendingHistoryLines;
		this.pendingHistoryLines = null;
		if (pendingHistoryLines && this.terminal.nativeScrollback) {
			this.renderHistoryAndFrame(
				pendingHistoryLines.map((line) => this.applyLineResets([line])[0] ?? ""),
				newLines,
				cursorPos,
				width,
				height,
				prevViewportTop,
				hardwareCursorRow,
			);
			return;
		}
```

If a non-native caller queues history, discard the queue and continue through the
existing renderer.

- [ ] **Step 3: Implement synchronized history and frame rendering**

Add this private method:

```ts
	private renderHistoryAndFrame(
		historyLines: string[],
		frameLines: string[],
		cursorPos: { row: number; col: number } | null,
		width: number,
		height: number,
		prevViewportTop: number,
		hardwareCursorRow: number,
	): void {
		this.fullRedrawCount += 1;
		const currentScreenRow = Math.max(
			0,
			Math.min(height - 1, hardwareCursorRow - prevViewportTop),
		);
		let buffer = "\x1b[?2026h";
		if (currentScreenRow > 0) {
			buffer += `\x1b[${currentScreenRow}A`;
		}
		buffer += "\r";

		if (historyLines.length === 0) {
			buffer += "\x1b[2K";
			for (let row = 1; row < height; row++) {
				buffer += "\r\n\x1b[2K";
			}
		} else {
			for (let index = 0; index < historyLines.length; index++) {
				if (index > 0) buffer += "\r\n";
				buffer += `\x1b[2K${historyLines[index]}`;
			}
			for (let row = 0; row < height; row++) {
				buffer += "\r\n\x1b[2K";
			}
		}

		if (height > 1) {
			buffer += `\x1b[${height - 1}A`;
		}
		buffer += "\r";
		for (let row = 0; row < height; row++) {
			if (row > 0) buffer += "\r\n";
			buffer += "\x1b[2K";
			if (row < frameLines.length) {
				buffer += frameLines[row];
			}
		}
		buffer += "\x1b[?2026l";
		this.terminal.write(buffer);

		this.cursorRow = Math.max(0, frameLines.length - 1);
		this.hardwareCursorRow = Math.max(0, height - 1);
		this.maxLinesRendered = Math.max(height, frameLines.length);
		this.previousViewportTop = 0;
		this.previousLines = frameLines;
		this.previousKittyImageIds = this.collectKittyImageIds(frameLines);
		this.previousWidth = width;
		this.previousHeight = height;
		this.positionHardwareCursor(cursorPos, frameLines.length);
	}
```

The bounded shell frame is expected to fit within terminal height, as it does in
the existing renderer. The method does not emit `CSI 2J`, `CSI 3J`,
alternate-screen, or mouse sequences and does not schedule stabilization.

- [ ] **Step 4: Run focused tests**

Run the Task 1 command. Expected: ordering tests remain red until the runtime
queues prefixes; existing native safety assertions continue to pass.

### Task 4: Coordinate Startup and Resume Replay

**Files:**
- Modify: `tui/mycli-shell/src/shell-runtime.ts:245-260`
- Modify: `tui/mycli-shell/src/shell-runtime.ts:587-600`
- Modify: `tui/mycli-shell/src/shell-runtime.ts:665-685`
- Modify: `tui/mycli-shell/src/shell-runtime.ts:1546-1558`
- Test: `tui/mycli-shell/test/shell-app.test.ts`

- [ ] **Step 1: Add a native transcript replay helper**

```ts
	private queueNativeTranscriptHistory(): void {
		if (!this.ui.terminal.nativeScrollback) return;
		const prefix = this.transcriptViewport.scrollbackPrefix(this.ui.terminal.columns);
		this.ui.insertHistoryBeforeNextFrame(prefix);
	}
```

- [ ] **Step 2: Queue startup history after mounting main content**

Remove the constructor call to `renderFullNext()`. At the end of `mountMain()`,
after `rebuildAll()`, call `queueNativeTranscriptHistory()`. This covers both
immediate startup and startup after the trust gate.

- [ ] **Step 3: Keep the selector mounted while loading Resume state**

Change session selection to restore the editor only after `selectSession()`
settles:

```ts
			onSelect: (session) => {
				void this.selectSession(session.id).finally(done);
			},
```

- [ ] **Step 4: Queue the resumed prefix**

After `onSessionSelect` resolves, replace `renderFullNext()` with:

```ts
		this.queueNativeTranscriptHistory();
```

The queued frame request and `done()` editor restoration coalesce into the same
render interval.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run the Task 1 command. Expected: all three focused tests pass.

### Task 5: Commit Rows That Leave the Live Viewport

**Files:**
- Modify: `tui/mycli-shell/src/shell-runtime.ts:155-220`
- Modify: `tui/mycli-shell/src/shell-runtime.ts:328-338`
- Modify: `tui/mycli-shell/src/tui-core/tui.ts:308-315`
- Test: `tui/mycli-shell/test/shell-app.test.ts`

- [ ] **Step 1: Add a Resume-followed-by-streaming regression test**

Resume a long transcript, submit a new user message, clear captured output, then
grow a multiline assistant response until the user row leaves the live tail:

```ts
test("mycli shell commits a resumed user message before a long streamed tail", async () => {
	const terminal = new TestTerminal();
	terminal.nativeScrollback = true;
	terminal.rows = 16;
	const history = Array.from({ length: 20 }, (_, index) => ({
		id: `resumed-${index}`,
		role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
		text: `resumed history ${index}`,
	}));
	let runtime: MycliShellRuntime;
	runtime = new MycliShellRuntime({
		initialState: sampleState(),
		terminal,
		onSessionSelect: async (sessionId) => {
			runtime.setState({
				...runtime.getState(),
				messages: history,
				tools: [],
				bash: [],
				transcript: undefined,
				footer: { ...runtime.getState().footer, sessionName: sessionId },
			});
		},
	});

	runtime.start();
	await setTimeout(25);
	runtime.showSessionSelector();
	await setTimeout(25);
	terminal.input?.("\r");
	await setTimeout(50);

	const resumed = runtime.getState();
	const user = { id: "new-user", role: "user" as const, text: "train a small model from scratch" };
	runtime.setState({
		...resumed,
		messages: [...history, user],
		footer: { ...resumed.footer, liveState: "Running" },
	});
	await setTimeout(25);
	terminal.output = "";

	const assistant = {
		id: "new-assistant",
		role: "assistant" as const,
		text: Array.from({ length: 40 }, (_, index) => `streamed answer ${index}`).join("\n"),
	};
	runtime.setState({
		...runtime.getState(),
		messages: [...history, user, assistant],
	});
	await setTimeout(25);

	const output = stripAnsi(terminal.output);
	const userRow = output.indexOf(user.text);
	const header = output.indexOf("mycli ctrl+p commands");
	const liveTail = output.indexOf("streamed answer 39");
	assert.ok(userRow >= 0);
	assert.ok(header > userRow);
	assert.ok(liveTail > header);
	assert.equal(output.match(/train a small model from scratch/g)?.length, 1);
	assertNativeScrollbackSafeOutput(terminal.output);
});
```

- [ ] **Step 2: Add a pending-delta ordering test**

Import `TUI` and `Text`, then queue two history batches before the first frame:

```ts
test("native TUI appends history deltas queued before one frame", async () => {
	const terminal = new TestTerminal();
	terminal.nativeScrollback = true;
	terminal.rows = 4;
	const ui = new TUI(terminal);
	ui.addChild(new Text("live frame"));
	ui.insertHistoryBeforeNextFrame(["first history delta"]);
	ui.insertHistoryBeforeNextFrame(["second history delta"]);
	ui.start();
	await setTimeout(25);

	const output = stripAnsi(terminal.output);
	const first = output.indexOf("first history delta");
	const second = output.indexOf("second history delta");
	const frame = output.indexOf("live frame");
	assert.ok(first >= 0);
	assert.ok(second > first);
	assert.ok(frame > second);
});
```

- [ ] **Step 3: Add a width-change watermark test**

Start at width 100, resize to a narrower width, clear resize output, and project
the same state once more:

```ts
test("native history watermark resets after terminal width changes", async () => {
	const terminal = new TestTerminal();
	terminal.nativeScrollback = true;
	terminal.rows = 8;
	terminal.columns = 100;
	const runtime = new MycliShellRuntime({
		initialState: {
			...sampleState(),
			messages: Array.from({ length: 18 }, (_, index) => ({
				id: `history-${index}`,
				role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
				text: `history message ${index}`,
			})),
			tools: [],
			bash: [],
			transcript: undefined,
			pendingNotice: undefined,
		},
		terminal,
	});

	runtime.start();
	await setTimeout(25);
	terminal.columns = 60;
	terminal.resize?.();
	await setTimeout(25);
	terminal.output = "";
	runtime.setState({ ...runtime.getState() });
	await setTimeout(25);

	assert.doesNotMatch(stripAnsi(terminal.output), /history message/);
});
```

- [ ] **Step 4: Run focused tests and verify RED**

```bash
cd tui/mycli-shell
node --import ./node_modules/tsx/dist/esm/index.mjs \
  --test \
  --test-name-pattern="commits a resumed user message|appends history deltas|watermark resets" \
  --test-reporter=dot \
  test/shell-app.test.ts
```

Expected: the user message test fails because no post-Resume prefix delta is
queued; the queue test fails because the second call replaces the first batch.
The width test passes before the watermark exists because no continuous commit is
attempted yet, then guards the new implementation against duplicate reflow rows.

- [ ] **Step 5: Add the transcript commit watermark**

Add these fields to `TranscriptViewportComponent`:

```ts
	private committedPrefixLength = 0;
	private committedPrefixBoundary: string | undefined;
	private committedWidth: number | undefined;
```

Add a helper:

```ts
	private recordCommittedPrefix(lines: string[], start: number, width: number): void {
		this.committedPrefixLength = start;
		this.committedPrefixBoundary = start > 0 ? lines[start - 1] : undefined;
		this.committedWidth = width;
	}
```

Update `scrollbackPrefix()` to call `recordCommittedPrefix()` before returning its
prefix. Then add the incremental method:

```ts
	takeNewScrollbackLines(width: number): string[] {
		if (this.scrollOffset !== 0) return [];
		const height = Math.max(1, this.heightForWidth(width));
		const lines = this.content.render(width);
		this.lastLineCount = lines.length;
		const start = this.visibleStart(lines, height);
		const boundaryChanged =
			this.committedPrefixLength > 0 &&
			lines[this.committedPrefixLength - 1] !== this.committedPrefixBoundary;
		if (
			this.committedWidth !== width ||
			start < this.committedPrefixLength ||
			boundaryChanged
		) {
			this.recordCommittedPrefix(lines, start, width);
			return [];
		}
		const delta = lines.slice(this.committedPrefixLength, start);
		this.recordCommittedPrefix(lines, start, width);
		return delta;
	}
```

- [ ] **Step 6: Queue deltas after each state projection**

After `maybeResetTranscriptScroll()` in `setState()`, call a new helper:

```ts
	private queueNativeTranscriptDelta(): void {
		if (!this.ui.terminal.nativeScrollback || !this.mainMounted) return;
		const delta = this.transcriptViewport.takeNewScrollbackLines(this.ui.terminal.columns);
		if (delta.length > 0) {
			this.ui.insertHistoryBeforeNextFrame(delta);
		}
	}
```

This runs after changed chat components have been rebuilt. Manual transcript
scrolling returns no delta because `scrollOffset !== 0`.

- [ ] **Step 7: Append pending renderer batches**

Change `insertHistoryBeforeNextFrame()` to preserve every batch queued before the
next render:

```ts
	insertHistoryBeforeNextFrame(lines: string[]): void {
		this.pendingHistoryLines = [
			...(this.pendingHistoryLines ?? []),
			...lines,
		];
		this.requestRender();
	}
```

- [ ] **Step 8: Run focused tests and verify GREEN**

Run the Step 4 command. Expected: all three tests pass.

### Task 6: Verify and Commit

**Files:**
- Modify: `tui/mycli-shell/src/shell-runtime.ts`
- Modify: `tui/mycli-shell/src/tui-core/tui.ts`
- Test: `tui/mycli-shell/test/shell-app.test.ts`

- [ ] **Step 1: Run complete verification**

```bash
cd tui/mycli-shell
npm test
npm run typecheck

cd ../..
uv run pytest -q
uv run ruff check src tests
uv run mypy src
```

Expected: all Node and Python tests, lint, and type checks pass.

- [ ] **Step 2: Check scoped diff**

```bash
git diff --check -- \
  tui/mycli-shell/src/shell-runtime.ts \
  tui/mycli-shell/src/tui-core/tui.ts \
  tui/mycli-shell/test/shell-app.test.ts
```

Confirm `.codex/config.toml` and the unrelated 2026-07-17 plan are unchanged and
unstaged.

- [ ] **Step 3: Commit the native replay implementation**

```bash
git add \
  tui/mycli-shell/src/shell-runtime.ts \
  tui/mycli-shell/src/tui-core/tui.ts \
  tui/mycli-shell/test/shell-app.test.ts
git commit -m "fix: commit native history during streaming"
```
